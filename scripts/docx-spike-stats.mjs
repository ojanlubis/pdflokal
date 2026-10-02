#!/usr/bin/env node
/*
 * Distribution tables from a docx-spike results.csv.
 *   node scripts/docx-spike-stats.mjs path/to/results.csv
 * Prints markdown: per metric, overall and per class, n / min / p10 / p25 / median / p75 / p90 / max.
 */
import fs from 'node:fs';

const [head, ...lines] = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
const cols = head.split(',');
const parse = (l) => { const out = []; let cur = ''; let q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
const rows = lines.map((l) => Object.fromEntries(parse(l).map((v, i) => [cols[i], v])));
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
const f = (x, d = 3) => (x === undefined ? '-' : Number(x).toFixed(d));
function dist(rs, key, d = 3) {
  const v = rs.map((r) => r[key]).filter((x) => x !== '' && x !== undefined).map(Number).filter((x) => !Number.isNaN(x));
  if (!v.length) return `| ${key} | 0 | - | - | - | - | - | - | - |`;
  return `| ${key} | ${v.length} | ${f(Math.min(...v), d)} | ${f(pct(v, 0.1), d)} | ${f(pct(v, 0.25), d)} | ${f(pct(v, 0.5), d)} | ${f(pct(v, 0.75), d)} | ${f(pct(v, 0.9), d)} | ${f(Math.max(...v), d)} |`;
}
const metrics = [['recallLcs', 3], ['recallBag', 3], ['recallLcsPoppler', 3], ['recallBagPoppler', 3], ['recallRendered', 3], ['visGrid', 3], ['visBody', 3], ['visRows', 3], ['inkRatio', 2], ['paraPerLayoutLine', 2], ['wordsPerPara', 1], ['pageRatio', 2], ['bytesRatio', 2], ['ms', 0], ['msPerPage', 0], ['renderMs', 0]];
const groups = [['ALL', rows], ['text-born', rows.filter((r) => r.class === 'text-born')], ['searchable-scan', rows.filter((r) => r.class === 'searchable-scan')], ['scan', rows.filter((r) => r.class === 'scan')],
  ['columns=yes', rows.filter((r) => r.columns === 'yes')], ['tables=yes', rows.filter((r) => r.tables === 'yes')], ['columns=no,tables=no (text-born)', rows.filter((r) => r.class === 'text-born' && r.columns === 'no' && r.tables === 'no')]];
for (const c of new Set(rows.map((r) => r.category))) groups.push([`category=${c || '(none)'}`, rows.filter((r) => r.category === c)]);
for (const [name, rs] of groups) {
  const ok = rs.filter((r) => r.ok === '1');
  console.log(`\n### ${name}: ${rs.length} files, ${ok.length} ok, ${rs.length - ok.length} failed (${((100 * (rs.length - ok.length)) / (rs.length || 1)).toFixed(1)}%), render ok ${rs.filter((r) => r.renderOk === '1').length}`);
  console.log('| metric | n | min | p10 | p25 | median | p75 | p90 | max |\n|---|---|---|---|---|---|---|---|---|');
  for (const [m, d] of metrics) console.log(dist(rs, m, d));
}
const fails = rows.filter((r) => r.ok !== '1');
console.log('\n### failures');
for (const r of fails) console.log(`- ${r.id} (${r.category}, ${r.notes}): ${r.error}`);
const lp = rows.filter((r) => r.linePerParaFlag === '1');
console.log(`\nlinePerParaFlag: ${lp.length} files: ${lp.map((r) => r.id).join(' ')}`);
const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
console.log(`\nbold pdf/docx ${sum('pdfBold')}/${sum('docxBold')}  italic ${sum('pdfItalic')}/${sum('docxItalic')}  images pdf/docx drawings ${sum('pdfImages')}/${sum('docxDrawings')}  stencils(pdf) ${sum('pdfStencils')}`);
