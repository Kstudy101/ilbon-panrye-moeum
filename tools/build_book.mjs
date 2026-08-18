// 판례·용어 md 파일들을 하나의 웹 책(book.html)으로 컴파일한다.
// 사용법: node tools/build_book.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'tools', 'node_modules', '용어', '한국비교']);

// 한글 파일명은 NFC/NFD 정규화가 섞여 있을 수 있으므로 정규화 비교로 찾는다
function findEntry(dir, nfcName) {
  const hit = fs.readdirSync(dir).find(n => n.normalize('NFC') === nfcName);
  return hit ? path.join(dir, hit) : path.join(dir, nfcName);
}

// ---------- 수집 ----------

function readMd(p) {
  return fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
}

function parseDoc(md) {
  const lines = md.split(/\r?\n/);
  let title = '';
  let titleIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#\s+(.+)$/);
    if (m) { title = m[1].trim().normalize('NFC'); titleIdx = i; break; }
  }
  const body = lines.filter((_, i) => i !== titleIdx).join('\n');
  // 제목 직후의 메타 표(| 항목 | 내용 |)에서 키-값 추출
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
  return { title, body, meta };
}

function stripMd(s) {
  return s.replace(/[|#>*`\[\]()]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function firstSegment(s) {
  return (s || '').replace(/\*/g, '').split(/[（(]/)[0].trim();
}

// 용어의 「과목」 메타를 목차 카테고리로 정규화한다
function termCat(subject) {
  if (subject === '회사법' || subject === '상법') return '회사법·상법';
  return subject || '기타';
}

function resultChip(conclusion) {
  const c = conclusion || '';
  if (c.includes('위헌')) return { label: '위헌', cls: 'shu' };
  if (c.includes('위법')) return { label: '위법', cls: 'shu' };
  if (c.includes('무효')) return { label: '무효', cls: 'shu' };
  if (c.includes('합헌')) return { label: '합헌', cls: 'ai' };
  return null;
}

// 리스트 파일에서 별칭 순서를 읽어 정렬 기준으로 쓴다
function listOrder(listPath, aliasCol) {
  const order = new Map();
  if (!fs.existsSync(listPath)) return order;
  const lines = readMd(listPath).split(/\r?\n/);
  let n = 0;
  for (const line of lines) {
    const m = line.match(/^\|\s*\d+\s*\|([^|]+)\|/);
    if (m) order.set(m[1].trim().normalize('NFC'), n++);
  }
  return order;
}

const entries = [];

// 과목 폴더의 판례들
const subjects = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory() && !SKIP_DIRS.has(d.name.normalize('NFC')) && !d.name.startsWith('.'))
  .map(d => ({ dir: d.name, name: d.name.normalize('NFC') }));

const caseOrder = listOrder(findEntry(ROOT, '리스트.md'));
for (const subject of subjects) {
  const files = fs.readdirSync(path.join(ROOT, subject.dir)).filter(f => f.endsWith('.md'));
  const docs = files.map(f => {
    const { title, body, meta } = parseDoc(readMd(path.join(ROOT, subject.dir, f)));
    return {
      type: 'case', subject: subject.name,
      file: f.replace(/\.md$/, '').normalize('NFC'),
      id: title || f.replace(/\.md$/, '').normalize('NFC'),
      title: title || f.replace(/\.md$/, '').normalize('NFC'),
      sub: firstSegment(meta['인용']),
      chip: resultChip(meta['결론']),
      raw: body,
    };
  });
  docs.sort((a, b) => {
    const oa = caseOrder.has(a.title) ? caseOrder.get(a.title) : 9999;
    const ob = caseOrder.has(b.title) ? caseOrder.get(b.title) : 9999;
    return oa - ob || a.title.localeCompare(b.title, 'ja');
  });
  entries.push(...docs);
}

// 용어들
const termDir = findEntry(ROOT, '용어');
const termOrder = listOrder(findEntry(ROOT, '용어리스트.md'));
if (fs.existsSync(termDir)) {
  const docs = fs.readdirSync(termDir).filter(f => f.endsWith('.md')).map(f => {
    const { title, body, meta } = parseDoc(readMd(path.join(termDir, f)));
    return {
      type: 'term', subject: '용어',
      cat: termCat(firstSegment(meta['과목'])),
      file: f.replace(/\.md$/, '').normalize('NFC'),
      id: title || f.replace(/\.md$/, '').normalize('NFC'),
      title: title || f.replace(/\.md$/, '').normalize('NFC'),
      sub: firstSegment(meta['읽기']) || firstSegment(meta['과목']),
      chip: null,
      raw: body,
    };
  });
  docs.sort((a, b) => {
    const oa = termOrder.has(a.title) ? termOrder.get(a.title) : 9999;
    const ob = termOrder.has(b.title) ? termOrder.get(b.title) : 9999;
    return oa - ob || a.title.localeCompare(b.title, 'ja');
  });
  entries.push(...docs);
}

// 한국 비교자료 (일본 판례·용어에 대응하는 한국 법리·판례)
const krDir = findEntry(ROOT, '한국비교');
const krOrder = listOrder(findEntry(ROOT, '한국비교리스트.md'));
if (fs.existsSync(krDir)) {
  const docs = fs.readdirSync(krDir).filter(f => f.endsWith('.md')).map(f => {
    const { title, body, meta } = parseDoc(readMd(path.join(krDir, f)));
    return {
      type: 'kr', subject: '한국비교',
      file: f.replace(/\.md$/, '').normalize('NFC'),
      id: title || f.replace(/\.md$/, '').normalize('NFC'),
      title: title || f.replace(/\.md$/, '').normalize('NFC'),
      sub: firstSegment(meta['인용']) || '비교자료',
      chip: resultChip(meta['결론']),
      raw: body,
    };
  });
  docs.sort((a, b) => {
    const oa = krOrder.has(a.title) ? krOrder.get(a.title) : 9999;
    const ob = krOrder.has(b.title) ? krOrder.get(b.title) : 9999;
    return oa - ob || a.title.localeCompare(b.title, 'ko');
  });
  entries.push(...docs);
}

// ---------- 마크다운 → HTML ----------

// 링크는 파일명으로 걸리지만 항목 id는 문서 제목이다.
// 제목에 별칭이 붙은 파일(「議員定数不均衡訴訟（一票の格差）」 등)도 찾아가도록 양쪽을 등록한다.
const aliasMap = new Map();
for (const e of entries) {
  aliasMap.set(e.id, e.id);
  if (e.file && !aliasMap.has(e.file)) aliasMap.set(e.file, e.id);
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function resolveLink(url, text) {
  if (/\.md$/i.test(url)) {
    let name = url.split('/').pop().replace(/\.md$/i, '');
    try { name = decodeURIComponent(name); } catch { /* 그대로 사용 */ }
    name = name.normalize('NFC');
    const id = aliasMap.get(name);
    if (id) return `<a href="#/e/${encodeURIComponent(id)}">${text}</a>`;
    return `<span>${text}</span>`;
  }
  if (/^https?:\/\//.test(url)) {
    return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
  }
  return `<span>${text}</span>`;
}

function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => resolveLink(url, text));
  return s;
}

function renderTable(tbl) {
  const rows = tbl.map(line =>
    line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
  );
  let html = '<div class="tblwrap"><table>';
  rows.forEach((cells, idx) => {
    if (idx === 1 && cells.every(c => /^:?-+:?$/.test(c) || c === '')) return;
    const tag = idx === 0 ? 'th' : 'td';
    html += `<tr>${cells.map(c => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`;
  });
  html += '</table></div>';
  return html;
}

function mdToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  const isBlockStart = l =>
    /^#{1,6}\s/.test(l) || /^\s*\|/.test(l) || /^>\s?/.test(l) ||
    /^---+\s*$/.test(l) || /^\s*[-*]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      const lv = Math.min(m[1].length, 6);
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
      i++; continue;
    }
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*\|/.test(line)) {
      const tbl = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { tbl.push(lines[i]); i++; }
      out.push(renderTable(tbl));
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      out.push(`<ul>${items.map(t => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
      out.push(`<ol>${items.map(t => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }
    const p = [line]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) { p.push(lines[i]); i++; }
    out.push(`<p>${p.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

for (const e of entries) {
  e.html = mdToHtml(e.raw);
  e.search = stripMd(`${e.title} ${e.sub || ''} ${e.raw}`);
  delete e.raw;
}

// ---------- 책 조립 ----------

const groups = [];
for (const subject of subjects) {
  const items = entries.filter(e => e.type === 'case' && e.subject === subject.name).map(e => e.id);
  if (items.length) groups.push({ name: `${subject.name} 판례`, items });
}
// 용어는 과목별 카테고리로 나눈다
{
  const CAT_ORDER = ['헌법', '행정법', '민법', '기초법학', '회사법·상법', '일반지식'];
  const byCat = new Map();
  for (const e of entries.filter(e => e.type === 'term')) {
    if (!byCat.has(e.cat)) byCat.set(e.cat, []);
    byCat.get(e.cat).push(e.id);
  }
  const cats = [...byCat.keys()].sort((a, b) => {
    const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'ko');
  });
  for (const c of cats) groups.push({ name: `${c} 용어`, items: byCat.get(c) });
}
{
  const items = entries.filter(e => e.type === 'kr').map(e => e.id);
  if (items.length) groups.push({ name: '한국 비교', items });
}

const nCases = entries.filter(e => e.type === 'case').length;
const nTerms = entries.filter(e => e.type === 'term').length;
const nKr = entries.filter(e => e.type === 'kr').length;

const DATA = { groups, entries: Object.fromEntries(entries.map(e => [e.id, e])) };
const dataJson = JSON.stringify(DATA).replace(/</g, '\\u003c');

const html = `<title>行政書士 判例帖</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&family=Noto+Serif+KR:wght@600;900&family=Noto+Sans+JP:wght@400;500;700&family=Noto+Serif+JP:wght@600;900&display=swap">
<style>
:root{
  --bg:#FAF9F5; --surface:#FFFFFF; --ink:#24272F; --muted:#6E7380;
  --line:#E5E2DA; --ai:#2E5077; --shu:#B8433D;
  --chip-ai-bg:#E7EDF5; --chip-ai-fg:#2E5077;
  --chip-shu-bg:#F7E8E6; --chip-shu-fg:#A03A34;
  --code-bg:#F0EEE7; --quote-bg:#F3F1EA; --thead-bg:#F4F2EC;
  --nav-active:#EDEAE1; --shadow:0 1px 3px rgba(36,39,47,.08);
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#14161C; --surface:#1B1E26; --ink:#E8E6DF; --muted:#9AA0AD;
    --line:#2B2F3A; --ai:#8FB4DE; --shu:#E08078;
    --chip-ai-bg:#22314A; --chip-ai-fg:#A9C6E8;
    --chip-shu-bg:#43272A; --chip-shu-fg:#EDA49E;
    --code-bg:#242833; --quote-bg:#20242E; --thead-bg:#222633;
    --nav-active:#262B37; --shadow:0 1px 3px rgba(0,0,0,.35);
  }
}
:root[data-theme="dark"]{
  --bg:#14161C; --surface:#1B1E26; --ink:#E8E6DF; --muted:#9AA0AD;
  --line:#2B2F3A; --ai:#8FB4DE; --shu:#E08078;
  --chip-ai-bg:#22314A; --chip-ai-fg:#A9C6E8;
  --chip-shu-bg:#43272A; --chip-shu-fg:#EDA49E;
  --code-bg:#242833; --quote-bg:#20242E; --thead-bg:#222633;
  --nav-active:#262B37; --shadow:0 1px 3px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font-family:'Noto Sans KR','Noto Sans JP','Malgun Gothic','Yu Gothic',sans-serif;
  font-size:15.5px; line-height:1.75;
}
a{color:var(--ai); text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--ai); outline-offset:2px; border-radius:2px}
code{background:var(--code-bg); padding:.1em .35em; border-radius:3px; font-size:.92em}

/* ---- 상단 바 (모바일) ---- */
.topbar{
  display:none; position:sticky; top:0; z-index:30;
  background:var(--bg); border-bottom:1px solid var(--line);
  padding:10px 14px; align-items:center; gap:12px;
}
.topbar .booktitle{font-family:'Noto Serif KR','Noto Serif JP',serif; font-weight:900; font-size:17px}
.menu-btn{
  background:none; border:1px solid var(--line); border-radius:6px;
  color:var(--ink); font-size:18px; line-height:1; padding:7px 10px; cursor:pointer;
}

/* ---- 사이드바 ---- */
.sidebar{
  position:fixed; top:0; left:0; bottom:0; width:300px; z-index:40;
  background:var(--surface); border-right:1px solid var(--line);
  display:flex; flex-direction:column;
}
.side-head{
  padding:20px 18px 12px; border-bottom:1px solid var(--line);
  display:flex; align-items:flex-start; gap:10px;
}
.side-head .titles{flex:1; min-width:0}
.side-head .booktitle{
  font-family:'Noto Serif KR','Noto Serif JP',serif; font-weight:900; font-size:20px;
  letter-spacing:.02em; display:block; color:var(--ink);
}
.side-head .booktitle:hover{text-decoration:none; color:var(--ai)}
.side-head .subtitle{color:var(--muted); font-size:12.5px; margin-top:2px}
.icon-btn{
  flex:none; background:none; border:1px solid var(--line); border-radius:7px;
  color:var(--muted); cursor:pointer; padding:5px 7px; line-height:0;
}
.icon-btn:hover{color:var(--ai); border-color:var(--ai)}
.icon-btn svg{width:16px; height:16px; display:block}
.searchbox{padding:12px 14px; border-bottom:1px solid var(--line)}
.searchbox input{
  width:100%; padding:8px 12px; border:1px solid var(--line); border-radius:6px;
  background:var(--bg); color:var(--ink); font:inherit; font-size:14px;
}
.searchbox input::placeholder{color:var(--muted)}
.nav{flex:1; overflow-y:auto; padding:6px 0 24px}

/* ---- 카테고리 드롭다운 ---- */
.nav-group{border-bottom:1px solid var(--line)}
.nav-group:last-child{border-bottom:0}
.grp{
  width:100%; display:flex; align-items:center; gap:8px;
  background:none; border:0; cursor:pointer; text-align:left;
  padding:11px 18px; color:var(--ink); font:inherit; font-size:13.5px; font-weight:700;
}
.grp:hover{background:var(--nav-active)}
.grp .chev{
  flex:none; width:13px; height:13px; color:var(--muted);
  transition:transform .18s ease;
}
.nav-group.open .grp .chev{transform:rotate(90deg)}
.grp .gname{flex:1; min-width:0}
.grp .cnt{
  flex:none; font-size:11.5px; font-weight:700; color:var(--muted);
  font-variant-numeric:tabular-nums; background:var(--nav-active);
  border-radius:9px; padding:1px 8px;
}
.grp:hover .cnt{background:var(--bg)}
.grp-body{display:none; padding-bottom:6px}
.nav-group.open .grp-body{display:block}
.nav-item{
  display:block; padding:7px 18px 7px 39px; border-left:3px solid transparent; color:var(--ink);
}
.nav-item:hover{background:var(--nav-active); text-decoration:none}
.nav-item[aria-current="page"]{background:var(--nav-active); border-left-color:var(--ai)}
.nav-item .t{display:block; font-size:14px; font-weight:500; line-height:1.45}
.nav-item .s{
  display:flex; align-items:center; gap:6px; color:var(--muted);
  font-size:12px; font-variant-numeric:tabular-nums; margin-top:1px;
}
.chip{
  display:inline-block; font-size:10.5px; font-weight:700; letter-spacing:.04em;
  padding:1px 6px; border-radius:4px; line-height:1.5;
}
.chip.ai{background:var(--chip-ai-bg); color:var(--chip-ai-fg)}
.chip.shu{background:var(--chip-shu-bg); color:var(--chip-shu-fg)}
.no-result{padding:16px 18px; color:var(--muted); font-size:13.5px}
.scrim{display:none; position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:35}

/* ---- 사이드바 열고 닫기 (데스크톱) ---- */
.sidebar{transition:transform .22s ease}
.main{transition:margin-left .22s ease}
body.sb-closed .sidebar{transform:translateX(-100%)}
body.sb-closed .main{margin-left:0}
.sb-open-btn{
  display:none; position:fixed; top:16px; left:16px; z-index:45;
  align-items:center; gap:7px; padding:8px 13px;
  background:var(--surface); border:1px solid var(--line); border-radius:9px;
  color:var(--ink); font:inherit; font-size:13px; font-weight:700;
  cursor:pointer; box-shadow:var(--shadow);
}
.sb-open-btn:hover{color:var(--ai); border-color:var(--ai)}
.sb-open-btn svg{width:15px; height:15px}
body.sb-closed .sb-open-btn{display:flex}

/* ---- 본문 ---- */
.main{margin-left:300px; min-height:100vh}
.page{max-width:46rem; margin:0 auto; padding:44px 32px 80px}

/* 표지 */
.cover{text-align:left; padding-top:9vh}
.cover .seal{
  width:92px; height:92px; background:var(--shu); color:#FAF9F5;
  font-family:'Noto Serif KR','Noto Serif JP',serif; font-weight:900; font-size:26px;
  display:flex; align-items:center; justify-content:center;
  writing-mode:vertical-rl; letter-spacing:.18em;
  border-radius:8px; transform:rotate(-2.5deg); box-shadow:var(--shadow);
  margin-bottom:34px; user-select:none;
}
.cover h1{
  font-family:'Noto Serif KR','Noto Serif JP',serif; font-weight:900;
  font-size:clamp(30px,5vw,42px); line-height:1.25; margin:0 0 10px; text-wrap:balance;
}
.cover .lede{color:var(--muted); font-size:16px; margin:0 0 30px}
.cover .counts{
  display:flex; gap:28px; border-top:1px solid var(--line); border-bottom:1px solid var(--line);
  padding:16px 2px; margin-bottom:34px;
}
.cover .counts b{
  display:block; font-size:26px; font-weight:900; font-variant-numeric:tabular-nums;
  font-family:'Noto Serif KR','Noto Serif JP',serif;
}
.cover .counts span{font-size:12.5px; color:var(--muted); letter-spacing:.05em}
.cover .toc a{
  display:flex; justify-content:space-between; align-items:baseline;
  padding:13px 2px; border-bottom:1px solid var(--line); color:var(--ink); font-size:15.5px;
}
.cover .toc a:hover{color:var(--ai); text-decoration:none}
.cover .toc .n{color:var(--muted); font-size:13px; font-variant-numeric:tabular-nums}

/* 문서 */
.doc-head{margin-bottom:28px}
.doc-head .eyebrow{
  font-size:12px; font-weight:700; letter-spacing:.09em; color:var(--ai);
  text-transform:uppercase; margin-bottom:8px;
}
.doc-head h1{
  font-family:'Noto Serif KR','Noto Serif JP',serif; font-weight:900;
  font-size:clamp(24px,3.6vw,32px); line-height:1.3; margin:0 0 8px; text-wrap:balance;
}
.doc-head .meta-line{color:var(--muted); font-size:14px; display:flex; gap:10px; align-items:center; flex-wrap:wrap}
.doc h2{
  font-family:'Noto Serif KR','Noto Serif JP',serif; font-weight:700; font-size:21px;
  margin:40px 0 12px; padding-bottom:8px; border-bottom:1px solid var(--line); text-wrap:balance;
}
.doc h3{font-size:16.5px; font-weight:700; margin:26px 0 8px}
.doc h4{font-size:15px; font-weight:700; margin:20px 0 6px}
.doc p{margin:0 0 14px}
.doc ul,.doc ol{margin:0 0 14px; padding-left:22px}
.doc li{margin-bottom:4px}
.doc blockquote{
  margin:18px 0; padding:14px 18px; background:var(--quote-bg);
  border-left:3px solid var(--ai); border-radius:0 6px 6px 0;
  font-family:'Noto Serif KR','Noto Serif JP',serif; font-size:15.5px;
}
.doc hr{border:0; border-top:1px solid var(--line); margin:28px 0}
.tblwrap{overflow-x:auto; margin:16px 0; border:1px solid var(--line); border-radius:8px; background:var(--surface)}
.doc table{border-collapse:collapse; width:100%; font-size:13.5px; line-height:1.6}
.doc th{
  background:var(--thead-bg); text-align:left; font-weight:700;
  padding:9px 12px; border-bottom:1px solid var(--line); white-space:nowrap;
}
.doc td{padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; min-width:72px}
.doc tr:last-child td{border-bottom:0}

/* 이전/다음 */
.pager{
  display:flex; justify-content:space-between; gap:14px; margin-top:56px;
  border-top:1px solid var(--line); padding-top:18px;
}
.pager a{
  flex:1; max-width:48%; color:var(--ink); font-size:14px; line-height:1.5;
}
.pager a:hover{color:var(--ai); text-decoration:none}
.pager .dir{display:block; font-size:11.5px; color:var(--muted); letter-spacing:.06em; margin-bottom:2px}
.pager .next{text-align:right; margin-left:auto}

@media (max-width:900px){
  .topbar{display:flex}
  .sidebar{transform:translateX(-100%); transition:transform .22s ease; box-shadow:none; width:min(320px,86vw)}
  .sidebar.open,
  body.sb-closed .sidebar.open{transform:translateX(0); box-shadow:0 0 40px rgba(0,0,0,.25)}
  .scrim.show{display:block}
  .main,
  body.sb-closed .main{margin-left:0}
  body.sb-closed .sb-open-btn{display:none}
  .page{padding:28px 18px 64px}
  .cover{padding-top:4vh}
}
@media (prefers-reduced-motion: reduce){
  .sidebar{transition:none}
}
</style>

<div class="topbar">
  <button class="menu-btn" id="menuBtn" aria-label="목차 열기">☰</button>
  <span class="booktitle">行政書士 判例帖</span>
</div>
<div class="scrim" id="scrim"></div>

<button class="sb-open-btn" id="sbOpen" title="목차 열기">
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 4h12M2 8h12M2 12h12"/></svg>
  목차
</button>

<aside class="sidebar" id="sidebar">
  <div class="side-head">
    <div class="titles">
      <a class="booktitle" href="#/">行政書士 判例帖</a>
      <div class="subtitle">일본 행정서사 판례·용어집</div>
    </div>
    <button class="icon-btn" id="sbClose" aria-label="목차 닫기" title="목차 닫기">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>
    </button>
  </div>
  <div class="searchbox">
    <input id="search" type="search" placeholder="판례·용어 검색  ( / )" aria-label="검색">
  </div>
  <nav class="nav" id="nav" aria-label="목차"></nav>
</aside>

<main class="main"><div class="page" id="page"></div></main>

<script>
const DATA = ${dataJson};
const FLAT = DATA.groups.flatMap(g => g.items);

const $nav = document.getElementById('nav');
const $page = document.getElementById('page');
const $search = document.getElementById('search');
const $sidebar = document.getElementById('sidebar');
const $scrim = document.getElementById('scrim');
const $menuBtn = document.getElementById('menuBtn');
const $sbOpen = document.getElementById('sbOpen');
const $sbClose = document.getElementById('sbClose');

// 접힌 카테고리와 사이드바 상태는 브라우저에 기억시킨다
function store(key, val){
  try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); }
  catch (e) { return null; }
}
const openGroups = new Set((function(){
  try { return JSON.parse(store('hanreicho.groups') || '[]'); } catch (e) { return []; }
})());
function saveGroups(){ store('hanreicho.groups', JSON.stringify([...openGroups])); }

function groupOf(id){
  for (const g of DATA.groups) if (g.items.indexOf(id) >= 0) return g.name;
  return null;
}

function currentId(){
  const h = location.hash;
  if (h.startsWith('#/e/')) {
    try { return decodeURIComponent(h.slice(4)); } catch { return null; }
  }
  return null;
}

function chipHtml(chip){
  return chip ? '<span class="chip ' + chip.cls + '">' + chip.label + '</span>' : '';
}

function renderNav(){
  const q = $search.value.trim().toLowerCase();
  const cur = currentId();
  let html = '';
  let any = false;
  for (const g of DATA.groups){
    const items = g.items.filter(id => {
      if (!q) return true;
      return DATA.entries[id].search.includes(q);
    });
    if (!items.length) continue;
    any = true;
    // 검색 중에는 결과가 있는 카테고리를 모두 펼쳐 둔다
    const open = q ? true : openGroups.has(g.name);
    html += '<section class="nav-group' + (open ? ' open' : '') + '">' +
      '<button class="grp" type="button" data-g="' + g.name + '" aria-expanded="' + open + '">' +
      '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>' +
      '<span class="gname">' + g.name + '</span>' +
      '<span class="cnt">' + items.length + '</span></button>' +
      '<div class="grp-body">';
    for (const id of items){
      const e = DATA.entries[id];
      html += '<a class="nav-item" href="#/e/' + encodeURIComponent(id) + '"' +
        (id === cur ? ' aria-current="page"' : '') + '>' +
        '<span class="t">' + e.title + '</span>' +
        '<span class="s">' + (e.sub || '') + chipHtml(e.chip) + '</span></a>';
    }
    html += '</div></section>';
  }
  $nav.innerHTML = any ? html : '<div class="no-result">검색 결과가 없습니다.</div>';
}

function renderCover(){
  const nCases = ${nCases}, nTerms = ${nTerms}, nKr = ${nKr};
  let toc = '';
  for (const g of DATA.groups){
    toc += '<a href="#/e/' + encodeURIComponent(g.items[0]) + '">' +
      '<span>' + g.name + '</span><span class="n">' + g.items.length + '건</span></a>';
  }
  $page.innerHTML =
    '<div class="cover">' +
    '<div class="seal" aria-hidden="true">判例帖</div>' +
    '<h1>行政書士 判例帖</h1>' +
    '<p class="lede">일본 행정서사 시험 대비 — 판례와 용어를 한 곳에서.</p>' +
    '<div class="counts">' +
    '<div><b>' + nCases + '</b><span>판례</span></div>' +
    '<div><b>' + nTerms + '</b><span>용어</span></div>' +
    (nKr ? '<div><b>' + nKr + '</b><span>한국 비교</span></div>' : '') +
    '</div>' +
    '<div class="toc">' + toc + '</div></div>';
  document.title = '行政書士 判例帖';
}

function renderEntry(id){
  const e = DATA.entries[id];
  if (!e){ renderCover(); return; }
  const idx = FLAT.indexOf(id);
  const prev = idx > 0 ? DATA.entries[FLAT[idx-1]] : null;
  const next = idx < FLAT.length-1 ? DATA.entries[FLAT[idx+1]] : null;
  const meta = [];
  if (e.sub) meta.push('<span>' + e.sub + '</span>');
  if (e.chip) meta.push(chipHtml(e.chip));
  let pager = '<nav class="pager">';
  if (prev) pager += '<a href="#/e/' + encodeURIComponent(prev.id) + '"><span class="dir">← 이전</span>' + prev.title + '</a>';
  if (next) pager += '<a class="next" href="#/e/' + encodeURIComponent(next.id) + '"><span class="dir">다음 →</span>' + next.title + '</a>';
  pager += '</nav>';
  $page.innerHTML =
    '<article>' +
    '<header class="doc-head">' +
    '<div class="eyebrow">' + (e.type === 'term' ? '용어' : e.type === 'kr' ? '한국 비교' : e.subject + ' 판례') + '</div>' +
    '<h1>' + e.title + '</h1>' +
    (meta.length ? '<div class="meta-line">' + meta.join('') + '</div>' : '') +
    '</header>' +
    '<div class="doc">' + e.html + '</div>' +
    pager + '</article>';
  document.title = e.title + ' — 行政書士 判例帖';
  window.scrollTo(0, 0);
}

function route(){
  const id = currentId();
  if (id){
    // 지금 보고 있는 항목의 카테고리는 펼쳐 둔다
    const gn = groupOf(id);
    if (gn && !openGroups.has(gn)){ openGroups.add(gn); saveGroups(); }
    renderEntry(id);
  } else renderCover();
  renderNav();
  closeSidebar();
}

function openSidebar(){ $sidebar.classList.add('open'); $scrim.classList.add('show'); }
function closeSidebar(){ $sidebar.classList.remove('open'); $scrim.classList.remove('show'); }

function setCollapsed(collapsed){
  document.body.classList.toggle('sb-closed', collapsed);
  store('hanreicho.sidebar', collapsed ? '1' : '0');
}
if (store('hanreicho.sidebar') === '1') document.body.classList.add('sb-closed');

$menuBtn.addEventListener('click', openSidebar);
$scrim.addEventListener('click', closeSidebar);
$sbClose.addEventListener('click', () => {
  if (window.matchMedia('(max-width: 900px)').matches) closeSidebar();
  else setCollapsed(true);
});
$sbOpen.addEventListener('click', () => setCollapsed(false));

// 카테고리 펼치기·접기
$nav.addEventListener('click', ev => {
  const btn = ev.target.closest('.grp');
  if (!btn) return;
  const name = btn.dataset.g;
  if (openGroups.has(name)) openGroups.delete(name); else openGroups.add(name);
  saveGroups();
  renderNav();
});

$search.addEventListener('input', renderNav);
document.addEventListener('keydown', ev => {
  if (ev.key === '/' && document.activeElement !== $search){
    ev.preventDefault(); openSidebar(); $search.focus();
  }
  if (ev.key === 'Escape') closeSidebar();
});
window.addEventListener('hashchange', route);
route();
</script>
`;

fs.writeFileSync(path.join(ROOT, 'index.html'), html, 'utf8');
console.log(`index.html 생성 완료: 판례 ${nCases}건, 용어 ${nTerms}건, 한국 비교 ${nKr}건, 항목 ${entries.length}개`);
