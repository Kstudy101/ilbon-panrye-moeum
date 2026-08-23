// 텔레그램 발송 시스템의 공용 파싱·포맷 헬퍼.
// build_book.mjs의 md 파싱 방식(제목/메타 표 추출, NFC 정규화)을 그대로 따른다.
import fs from 'node:fs';
import path from 'node:path';

export function readMd(p) {
  return fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
}

// 제목(H1) + 메타 표(| 항목 | 내용 |) + 본문(body)을 분리한다.
export function parseDoc(md) {
  const lines = md.split(/\r?\n/);
  let title = '';
  let titleIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#\s+(.+)$/);
    if (m) { title = m[1].trim().normalize('NFC'); titleIdx = i; break; }
  }
  const meta = {};
  const tableLines = [];
  let inTable = false;
  for (let i = titleIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|/.test(line)) { inTable = true; tableLines.push(line); }
    else if (inTable) break;
    else if (!/^\s*$/.test(line)) break;
  }
  for (const row of tableLines.slice(2)) {
    const cells = row.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    if (cells.length >= 2) meta[cells[0].replace(/\*/g, '')] = cells.slice(1).join(' | ');
  }
  const body = lines.join('\n');
  return { title, meta, body };
}

// 「## 헤딩」 섹션 하나의 본문 줄들을 반환한다 (다음 「## 」 전까지).
// heading은 '## 💡 수험 팁'처럼 접두사를 붙여도, '💡 수험 팁'처럼 안 붙여도 매치된다.
export function section(body, heading) {
  const lines = body.split(/\r?\n/);
  const target = heading.replace(/^#+\s*/, '');
  const startIdx = lines.findIndex(l => l.trim().replace(/^#+\s*/, '').startsWith(target));
  if (startIdx === -1) return [];
  const out = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

// 「- **라벨**: 내용」 형태의 불릿에서 라벨이 일치하는 내용을 뽑는다.
export function pickBullet(lines, label) {
  const re = new RegExp('^[-*]\\s*\\*\\*' + label + '\\*\\*\\s*[:：]\\s*(.+)$');
  for (const l of lines) {
    const m = l.trim().match(re);
    if (m) return m[1].trim();
  }
  return '';
}

// 일반 불릿(- ...) 목록만 뽑는다.
export function bullets(lines) {
  return lines
    .map(l => l.trim())
    .filter(l => /^[-*]\s+/.test(l))
    .map(l => l.replace(/^[-*]\s+/, ''));
}

// 마크다운 조각(굵게, 링크)을 텔레그램 HTML로 변환한다.
export function mdToTelegramHtml(text) {
  if (!text) return '';
  let s = text;
  // HTML 특수문자 이스케이프 (마크다운 변환 전에 먼저)
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // [텍스트](경로) → 텍스트만 남김 (내부 위키링크는 텔레그램에서 못 씀)
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // **굵게** → <b>굵게</b>
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  return s.trim();
}

export function truncate(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trim() + '…';
}

// 「과목」 메타 문자열에서 대분류/소분류를 뽑아 "[대분류 - 소분류]" 헤더를 만든다.
export function categoryLabel(subject) {
  if (!subject) return '';
  const clean = subject.replace(/\*/g, '');
  const main = clean.split(/[（(]/)[0].trim();
  const innerMatch = clean.match(/[（(]([^）)]+)[）)]/);
  if (!innerMatch) return main;
  const sub = innerMatch[1].split(/[\/—－·,、]/)[0].trim();
  return sub && sub !== main ? `${main} - ${sub}` : main;
}

// 「읽기」 메타(예: "ひょうけんだいり（표현대리）")에서 한글 발음 표기만 뽑는다.
export function koreanGloss(reading) {
  if (!reading) return '';
  const m = reading.match(/[（(]([^）)]+)[）)]/);
  return m ? m[1].trim() : '';
}

// title.md 파일 하나를 읽어 { id(=H1 전체), link } 를 만든다.
export function resolveEntry(rootDir, relPath, siteBaseUrl) {
  const abs = path.join(rootDir, relPath);
  const { title } = parseDoc(readMd(abs));
  const id = title || path.basename(relPath, '.md').normalize('NFC');
  const link = siteBaseUrl.replace(/\/?$/, '/') + '#/e/' + encodeURIComponent(id);
  return { id, link };
}

export function listMdFiles(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.md'));
}

