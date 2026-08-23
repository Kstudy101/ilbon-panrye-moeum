// 텔레그램 공부 알리미 발송 스크립트.
// GitHub Actions가 20분마다 실행한다: node tools/telegram/send.mjs
//
// 동작 순서:
//  1. config.json을 읽어 토글·발송 시간대를 확인한다 (범위 밖/비활성이면 조용히 종료)
//  2. 용어(용어/*.md)와 OX 퀴즈(quiz-bank.json)를 모아 후보 풀을 만든다
//  3. 매 실행마다 OX 퀴즈 5개 + 용어 카드 5개를 각각 신규:복습 = 70:30 비율로 뽑는다
//     (에빙하우스 망각곡선을 흉내 낸 등차 간격 복습 스케줄 사용)
//  4. 메시지를 하나씩 순서대로 전송하고, state.json에 발송 이력을 남긴다
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readMd, parseDoc, section, pickBullet, bullets,
  mdToTelegramHtml, truncate,
  categoryLabel, koreanGloss, resolveEntry, listMdFiles,
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
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function nowInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find(p => p.type === t).value);
  return { hour: get('hour') === 24 ? 0 : get('hour') };
}

function withinWindow(cfg) {
  const { hour } = nowInTz(cfg.timezone);
  return hour >= cfg.startHour && hour < cfg.endHour;
}

// ---------- 후보 풀 구성 ----------

function buildTermPool(cfg) {
  const files = listMdFiles(TERM_DIR);
  return files.map(f => {
    const { title, meta, body } = parseDoc(readMd(path.join(TERM_DIR, f)));
    const tipLines = section(body, '## 💡 수험 팁');
    const gistLines = section(body, '## 🎯 요점·예시');
    return {
      id: 'term:' + title, channel: 'term', title,
      category: categoryLabel(meta['과목']),
      gloss: koreanGloss(meta['읽기']),
      core: meta['한줄 정의'] || '',
      concept: pickBullet(gistLines, '요점'),
      example: pickBullet(gistLines, '예시'),
      tips: bullets(tipLines).slice(0, 2),
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

// ---------- 항목 선택 (신규 70% / 복습 30%) ----------

function pickBatch(pool, state, reviewRatio, nowMs, batchSize) {
  const excluded = new Set();
  const picked = [];

  for (let i = 0; i < batchSize; i++) {
    const available = pool.filter(it => !excluded.has(it.id));
    if (!available.length) break;

    const withState = (it) => state.items[it.id];
    const isDue = (it) => {
      const s = withState(it);
      return s && s.nextDueAt && s.nextDueAt <= nowMs;
    };
    const newPool = available.filter(it => !withState(it));
    const duePool = available.filter(isDue);

    let bucket;
    if (newPool.length && duePool.length) bucket = Math.random() < reviewRatio ? duePool : newPool;
    else if (newPool.length) bucket = newPool;
    else if (duePool.length) bucket = duePool;
    else {
      bucket = [...available].sort((a, b) => {
        const sa = withState(a)?.lastSentAt || 0;
        const sb = withState(b)?.lastSentAt || 0;
        return sa - sb;
      });
    }
    if (!bucket.length) break;

    const item = bucket[Math.floor(Math.random() * bucket.length)];
    picked.push(item);
    excluded.add(item.id);
  }
  return picked;
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
}

// ---------- 메시지 포맷 ----------

// 용어 카드: 핵심·개념·수험 팁·예시를 각각 한두 줄로 축약해 3초 안에 훑어보게 한다.
function formatTermMessage(it) {
  const titleLine = it.gloss ? `${it.gloss} (${it.title})` : it.title;
  const header = it.category ? `📌 [${it.category}] ${titleLine}` : `📌 ${titleLine}`;
  const lines = [header, ''];

  lines.push('💡 <b>핵심</b>');
  lines.push(mdToTelegramHtml(truncate(it.core, 140)));

  if (it.concept) {
    lines.push('');
    lines.push('📖 <b>개념</b>');
    lines.push(mdToTelegramHtml(truncate(it.concept, 200)));
  }

  if (it.tips.length) {
    lines.push('');
    lines.push('⚖️ <b>수험 팁</b>');
    for (const t of it.tips) lines.push('• ' + mdToTelegramHtml(truncate(t, 130)));
  }

  if (it.example) {
    lines.push('');
    lines.push('예시 : ' + mdToTelegramHtml(truncate(it.example, 180)));
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
  if (it.citation) { lines.push(''); lines.push('⚖️ ' + mdToTelegramHtml(it.citation)); }
  lines.push('');
  lines.push(`🔗 <a href="${it.link}">자세히 보기</a>`);
  return lines.join('\n');
}

// ---------- 텔레그램 전송 ----------

// 네트워크 일시 오류(ETIMEDOUT 등)는 짧게 재시도해서, GitHub Actions 러너의
// 순간적인 네트워크 흔들림 때문에 그 회차 발송 전체가 죽는 일을 막는다.
async function sendTelegramMessage(text, retries = 2) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
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
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ---------- 메인 ----------

async function main() {
  const cfg = loadJson(path.join(HERE, 'config.json'), {});
  if (!cfg.enabled && !FORCE) {
    console.log('[telegram] 비활성화(config.enabled=false) — 종료');
    return;
  }
  if (!withinWindow(cfg) && !FORCE) {
    console.log(`[telegram] 발송 시간대(${cfg.startHour}~${cfg.endHour}시, ${cfg.timezone}) 밖 — 종료`);
    return;
  }
  if (!TOKEN || !CHAT_ID) {
    throw new Error('TELEGRAM_TOKEN / TELEGRAM_CHAT_ID 환경변수가 설정되지 않았습니다.');
  }

  const statePath = path.join(HERE, 'state.json');
  const state = loadJson(statePath, { items: {}, lastSentId: null, lastRunAt: null });
  const nowMs = Date.now();
  const delayMs = cfg.messageDelayMs ?? 1200;
  const reviewRatio = cfg.reviewRatio ?? 0.3;

  const termPool = buildTermPool(cfg);
  const quizPool = buildQuizPool(cfg);

  const quizBatch = pickBatch(quizPool, state, reviewRatio, nowMs, cfg.quizBatchSize ?? 5);
  const termBatch = pickBatch(termPool, state, reviewRatio, nowMs, cfg.termBatchSize ?? 5);
  const jobs = [
    ...quizBatch.map(it => ({ it, kind: 'quiz', text: () => formatQuizMessage(it) })),
    ...termBatch.map(it => ({ it, kind: 'term', text: () => formatTermMessage(it) })),
  ];

  let sent = 0;
  let failed = 0;
  // 한 항목의 포맷팅·전송이 실패해도(예: 예상 밖 콘텐츠, 순간적 네트워크 오류)
  // 그 항목만 건너뛰고 나머지는 계속 보낸다 — 한 번의 실행이 통째로 멈추지 않게.
  for (const job of jobs) {
    try {
      await sendTelegramMessage(job.text());
      updateState(state, job.it, nowMs);
      sent++;
      console.log(`[telegram] 발송: ${job.kind} / ${job.it.id}`);
    } catch (err) {
      failed++;
      console.error(`[telegram] 실패(건너뜀): ${job.kind} / ${job.it.id} —`, err.message || err);
    }
    if (job !== jobs[jobs.length - 1]) await sleep(delayMs);
  }

  // 하나라도 보냈다면(또는 실패가 있었다면) 지금까지의 진행 상황을 반드시 저장한다.
  if (sent > 0) {
    state.lastRunAt = nowMs;
    saveJson(statePath, state);
  }

  if (!sent && !failed) {
    console.log('[telegram] 보낼 항목이 없습니다.');
    return;
  }
  console.log(`[telegram] 이번 실행: 성공 ${sent}건 / 실패 ${failed}건 (퀴즈 ${quizBatch.length} / 용어 ${termBatch.length})`);
  // 전부 실패했을 때만 워크플로를 실패로 표시해 GitHub이 알림을 보내게 한다.
  if (sent === 0 && failed > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
