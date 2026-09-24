// Prüft alle Kapiteldaten vor dem Hochladen:  node tools/check-content.mjs
import { readFileSync, existsSync } from 'node:fs';
import { validateManifest, validateLearn, validateQuestions, validateBoss } from '../js/content-loader.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
let problems = 0;
const report = (label, v) => {
  v.errors.forEach((e) => { problems++; console.log(`  ✗ ${e}`); });
  console.log(`${v.ok && !v.errors.length ? '✓' : '!'} ${label}`);
};

const m = validateManifest(read('data/chapters.json'));
report('data/chapters.json', m);
for (const c of m.data?.chapters || []) {
  if (!c.available) continue;
  const dir = `data/${c.id}`;
  for (const [part, fn] of [['learn', validateLearn], ['questions', validateQuestions], ['boss', validateBoss]]) {
    const f = `${dir}/${part}.json`;
    if (!existsSync(new URL(`../${f}`, import.meta.url))) { problems++; console.log(`✗ ${f} fehlt`); continue; }
    report(f, fn(read(f), c.id));
  }
  // Querverweise
  const learn = read(`${dir}/learn.json`);
  const qs = read(`${dir}/questions.json`).questions;
  const bs = read(`${dir}/boss.json`).questions;
  const secIds = new Set(learn.sections.map((s) => s.id));
  const qIds = new Set(qs.map((q) => q.id));
  learn.sections.forEach((s) => { if (s.checkId && !qIds.has(s.checkId)) { problems++; console.log(`  ✗ ${s.id}: checkId ${s.checkId} unbekannt`); } });
  [...qs, ...bs].forEach((q) => { if (q.section && !secIds.has(q.section)) { problems++; console.log(`  ✗ ${q.id}: section ${q.section} unbekannt`); } });
  const overlap = bs.filter((b) => qs.some((q) => q.question === b.question));
  if (overlap.length) { problems++; console.log(`  ✗ Bossfragen doppeln normale Fragen: ${overlap.map((b) => b.id).join(', ')}`); }
  const tl = (arr) => arr.reduce((a, q) => ({ ...a, [q.taxonomyLevel]: (a[q.taxonomyLevel] || 0) + 1 }), {});
  console.log(`  Kapitel ${c.id}: ${learn.sections.length} Abschnitte, ${qs.length} Fragen ${JSON.stringify(tl(qs))}, ${bs.length} Bossfragen ${JSON.stringify(tl(bs))}`);
  if (qs.length < 30) console.log('  ! Normaler Pool unter 30 Fragen');
  if (bs.length < 15) console.log('  ! Bosspool unter 15 Fragen');
}
console.log(problems ? `\n${problems} Problem(e) gefunden.` : '\nAlles sauber.');
process.exit(problems ? 1 : 0);
