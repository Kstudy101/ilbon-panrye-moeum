// 용어리스트.md의 「상세」 열을, 실제로 존재하는 용어 파일로 자동 채운다.
// 이미 채워진 칸과 「한국 비교」 열은 건드리지 않는다.
// 사용법: node tools/update_lists.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findEntry(dir, nfcName) {
  const hit = fs.readdirSync(dir).find(n => n.normalize('NFC') === nfcName);
  return hit ? path.join(dir, hit) : path.join(dir, nfcName);
}

const termDir = findEntry(ROOT, '용어');
const listPath = findEntry(ROOT, '용어리스트.md');

const existing = new Set(
  fs.readdirSync(termDir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, '').normalize('NFC'))
);

const lines = fs.readFileSync(listPath, 'utf8').split(/\r?\n/);
let filled = 0;
const missing = [];

const out = lines.map(line => {
  // | 번호 | 용어 | 읽기 | 과목 | 핵심 | 상세 | 한국 비교 |
  if (!/^\|\s*\d+\s*\|/.test(line)) return line;
  const cells = line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|');
  if (cells.length < 7) return line;

  const term = cells[1].trim().normalize('NFC');
  const detail = cells[5].trim();

  if (!existing.has(term)) {
    missing.push(term);
    return line;
  }
  if (detail) return line; // 이미 채워져 있으면 유지

  cells[5] = ` [용어/${term}.md](용어/${term}.md) `;
  filled++;
  return '|' + cells.join('|') + '|';
});

fs.writeFileSync(listPath, out.join('\n'), 'utf8');

console.log(`용어리스트.md 갱신: ${filled}개 링크 추가`);
console.log(`용어 파일 총 ${existing.size}개`);
if (missing.length) {
  console.log(`아직 없는 용어 ${missing.length}개:`);
  console.log('  ' + missing.join(', '));
}
