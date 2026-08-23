// 텔레그램 공부 알리미 발송 스크립트.
// GitHub Actions가 주기적으로 실행한다: node tools/telegram/send.mjs
//
// 동작 순서:
//  1. config.json을 읽어 토글·발송 시간대를 확인한다 (범위 밖/비활성이면 조용히 종료)
//  2. 용어(용어/*.md)와 OX 퀴즈(quiz-bank.json)를 모아 후보 풀을 만든다
//  3. 퀴즈/용어 채널을 고르고, 그 안에서 신규:복습 = (1-reviewRatio):reviewRatio 비율로 항목을 뽑는다
//     (에빙하우스 망각곡선을 흉내 낸 등차 간격 복습 스케줄 사용)
//  4. 텔레그램 메시지를 만들어 전송하고, state.json에 발송 이력을 남긴다
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readMd, parseDoc, section, pickBullet, bullets,
  mdToTelegramHtml, truncate, categoryLabel, koreanGloss,
  resolveEntry, listMdFiles,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TERM_DIR = path.join(ROOT, '용어');

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FORCE = process.env.FORCE_SEND === 'true';

// 신규 항목이 처음 발송된 뒤, 몇 일 뒤에 다시 복습으로 보여줄지 (회차별 간격, 일 단위)
const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30];

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function nowInTz(tz) {
  // Intl로 지정 타임존의 "지금"을 구성한다 (연-월-일 시:분까지)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find(p => p.type === t).value);
  return {
    hour: get('hour') === 24 ? 0 : get('hour'),
    dateKey: `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}`,
  };
}

function withinWindow(cfg) {
  const { hour } = nowInTz(cfg.timezone);
  return hour >= cfg.startHour && hour < cfg.endHour;
}

// ---------- 후보 풀 구성 ----------

function buildTermPool(cfg) {
  const files = listMdFiles(TERM_DIR);
  return files.map(f => {
    const rel = '용어/' + f;
    const { title, meta, body } = parseDoc(readMd(path.join(TERM_DIR, f)));
    const id = 'term:' + title;
    const pointLines = section(body, '## 💡 수험 팁');
    const exampleLines = section(body, '## 🎯 요점·예시');
    return {
      id, channel: 'term', title, rel,
      category: categoryLabel(meta['과목']),
      gloss: koreanGloss(meta['읽기']),
      core: meta['한줄 정의'] || '',
      example: pickBullet(exampleLines, '예시'),
      tips: bullets(pointLines).slice(0, 2),
      link: cfg.siteBaseUrl.replace(/\/?$/, '/') + '#/e/' + encodeURIComponent(title),
    };
  });
}

function buildQuizPool(cfg) {
  const bank = loadJson(path.join(HERE, 'quiz-bank.json'), []);
  return bank.map(q => {
    const { id: sourceId } = resolveEntry(ROOT, q.sourceFile, cfg.siteBaseUrl);
    const { meta } = parseDoc(readMd(path.join(ROOT, q.sourceFile)));
    return {
      id: 'quiz:' + q.id, channel: 'quiz',
      category: categoryLabel(meta['과목']) || '퀴즈',
      citation: (meta['인용'] || '').replace(/\*/g, ''),
      question: q.question,
      answer: q.answer,
      explanation: q.explanation,
      link: cfg.siteBaseUrl.replace(/\/?$/, '/') + '#/e/' + encodeURIComponent(sourceId),
    };
  });
}

// ---------- 항목 선택 (신규 70% / 복습 30%, 채널별) ----------

function pickItem(pool, state, reviewRatio, nowMs) {
  const withState = (it) => state.items[it.id];
  const isDue = (it) => {
    const s = withState(it);
    return s && s.nextDueAt && s.nextDueAt <= nowMs;
  };
  const newPool = pool.filter(it => !withState(it));
  const duePool = pool.filter(isDue);

  let bucket;
  if (newPool.length && duePool.length) {
    bucket = Math.random() < reviewRatio ? duePool : newPool;
  } else if (newPool.length) {
    bucket = newPool;
  } else if (duePool.length) {
    bucket = duePool;
  } else {
    // 모든 항목을 이미 다 보냈고 복습 예정일도 안 됐다면 -> 가장 오래전에 보낸 것부터 재발송
    bucket = [...pool].sort((a, b) => {
      const sa = withState(a)?.lastSentAt || 0;
      const sb = withState(b)?.lastSentAt || 0;
      return sa - sb;
    });
  }
  if (!bucket.length) return null;

  // 바로 직전에 보낸 항목은 가능하면 피한다
  const filtered = bucket.filter(it => it.id !== state.lastSentId);
  const candidates = filtered.length ? filtered : bucket;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function updateState(state, item, nowMs) {
  const prev = state.items[item.id] || { sendCount: 0 };
  const sendCount = prev.sendCount + 1;
  const dayMs = 24 * 60 * 60 * 1000;
  const stepIdx = Math.min(sendCount - 1, REVIEW_INTERVALS_DAYS.length - 1);
  state.items[item.id] = {
    sendCount,
    lastSentAt: nowMs,
    nextDueAt: nowMs + REVIEW_INTERVALS_DAYS[stepIdx] * dayMs,
  };
  state.lastSentId = item.id;
  state.lastRunAt = nowMs;
}

// ---------- 메시지 포맷 ----------

function formatTermMessage(it) {
  const titleLine = it.gloss ? `${it.gloss} (${it.title})` : it.title;
  const header = it.category ? `📌 [${it.category}] ${titleLine}` : `📌 ${titleLine}`;
  const lines = [header, ''];

  lines.push('💡 핵심 개념');
  lines.push(mdToTelegramHtml(truncate(it.core, 260)));

  if (it.example) {
    lines.push('');
    lines.push('예시 : ' + mdToTelegramHtml(truncate(it.example, 260)));
  }

  if (it.tips.length) {
    lines.push('');
    lines.push('⚖️ 시험 출제 포인트');
    for (const t of it.tips) lines.push('• ' + mdToTelegramHtml(truncate(t, 160)));
  }

  lines.push('');
  lines.push(`🔗 <a href="${it.link}">웹사이트에서 바로가기</a> (클릭)`);
  return lines.join('\n');
}

function formatQuizMessage(it) {
  const header = `📝 [${it.category}] 판례 OX 퀴즈`;
  const answerLabel = it.answer === 'O' ? '⭕ O (맞음)' : '❌ X (틀림)';
  const lines = [
    header, '',
    'Q. ' + mdToTelegramHtml(it.question), '',
    '👉 정답을 보려면 아래를 탭하세요', '',
    `<span class="tg-spoiler">정답: ${answerLabel}\n해설: ${mdToTelegramHtml(it.explanation)}</span>`,
  ];
  if (it.citation) {
    lines.push('');
    lines.push('⚖️ ' + mdToTelegramHtml(it.citation));
  }
  lines.push('');
  lines.push(`🔗 <a href="${it.link}">자세히 보기</a>`);
  return lines.join('\n');
}

// ---------- 텔레그램 전송 ----------

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error('텔레그램 전송 실패: ' + JSON.stringify(data));
  return data;
}

// ---------- 메인 ----------

async function main() {
  const cfg = loadJson(path.join(HERE, 'config.json'), {});
  if (!cfg.enabled && !FORCE) {
    console.log('[telegram] 비활성화(config.enabled=false) — 종료');
    return;
  }
  if (!withinWindow(cfg) && !FORCE) {
    console.log('[telegram] 발송 시간대(' + cfg.startHour + '~' + cfg.endHour + '시, ' + cfg.timezone + ') 밖 — 종료');
    return;
  }
  if (!TOKEN || !CHAT_ID) {
    throw new Error('TELEGRAM_TOKEN / TELEGRAM_CHAT_ID 환경변수가 설정되지 않았습니다.');
  }

  const statePath = path.join(HERE, 'state.json');
  const state = loadJson(statePath, { items: {}, lastSentId: null, lastRunAt: null });
  const nowMs = Date.now();

  const termPool = buildTermPool(cfg);
  const quizPool = buildQuizPool(cfg);

  const useQuiz = quizPool.length > 0 && Math.random() < (cfg.quizRatio ?? 0.25);
  const pool = useQuiz ? quizPool : termPool;

  const item = pickItem(pool, state, cfg.reviewRatio ?? 0.3, nowMs);
  if (!item) {
    console.log('[telegram] 보낼 항목이 없습니다.');
    return;
  }

  const text = item.channel === 'quiz' ? formatQuizMessage(item) : formatTermMessage(item);
  await sendTelegramMessage(text);
  console.log(`[telegram] 발송 완료: ${item.channel} / ${item.id}`);

  updateState(state, item, nowMs);
  saveJson(statePath, state);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
