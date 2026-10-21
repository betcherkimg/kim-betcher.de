const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../smartadm/office/index.html'), 'utf8');
function section(from, to) {
  const start = html.indexOf(from), end = html.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from);
  return html.slice(start, end);
}
const code = [
  section('  const normalizeName =', '  const ADMIN_SCOPES ='),
  section('  function phoneVorwahl(', '  // Eine Zelle kann mehrere Nummern'),
  section('  function cleanKind(', '  const kindNamen ='),
  html.match(/^  const API_TOPIC_KEYS =[^\n]+/m)[0],
  html.match(/^  const CALL_SCRIPT_PREFIX =[^\n]+/m)[0],
  html.match(/^  const digits =[^\n]+/m)[0],
  section('  function poolPhoneKeys(', '  /* Abgleich mit Sales:'),
  section('  const importPayload =', '  $("poolImportBtn")'),
  'globalThis.subject = { preparePoolImportRows, officeImportMatches, importPayload, poolContactKey };'
].join('\n');
function setup() {
  const state = { adminCalls: { open: [], returned: [], kk: [], archived: [] }, adminPool: [] };
  const context = vm.createContext({ state, asArray: x => Array.isArray(x) ? x : [],
    ADMIN_SCOPES: [['open', 'In Bearbeitung'], ['returned', 'Rückläufer'], ['kk', 'Kein Kontakt'], ['archived', 'Abgeschlossen']] });
  vm.runInContext(code, context);
  return { state, ...context.subject };
}
function row(overrides = {}) {
  return { index: 0, name: 'Muster, Lena', salutation: 'Frau', vorname: 'Lena', nachname: 'Muster',
    phones: ['07361 123456'], topics: ['zuteilung'], place: 'bank-1', ort: 'Filiale A', bsnr: '',
    kind: null, skript: '', due: null, errors: [], notes: [], sales: [], on: true, ...overrides };
}

test('family members sharing a number stay separate and keep all individual data', () => {
  const { preparePoolImportRows, importPayload } = setup();
  const rows = [row({ bsnr: '111', skript: 'Nur Lena' }), row({ index: 1, name: 'Muster, Tom', vorname: 'Tom',
    salutation: 'Herr', bsnr: '222', topics: ['foerderung'], skript: 'Nur Tom' })];
  const before = rows.map(r => JSON.stringify(importPayload(r)));
  const result = preparePoolImportRows(rows);
  assert.equal(result.length, 2);
  result.forEach((r, i) => { assert.equal(r.on, true); assert.equal(JSON.stringify(importPayload(r)), before[i]); });
  assert.match(result[1].notes[0][1], /bleibt eigener Kontakt/);
});

test('same names with different numbers or contracts remain separate', () => {
  const { preparePoolImportRows } = setup();
  const rows = [row({ bsnr: '111' }), row({ index: 1, bsnr: '222' }),
    row({ index: 2, bsnr: '111', phones: ['07361 654321'] })];
  assert.equal(preparePoolImportRows(rows).length, 3);
  assert.ok(rows.every(r => r.on && r.name === 'Muster, Lena' && r.vorname === 'Lena'));
});

test('only identical rows are deselected, remain visible and can be chosen explicitly', () => {
  const { preparePoolImportRows } = setup();
  const rows = [row(), row({ index: 1 }), row({ index: 2 })];
  preparePoolImportRows(rows);
  assert.deepEqual(rows.map(r => r.on), [true, false, false]);
  assert.ok(rows.every(r => r.name === 'Muster, Lena'));
  assert.match(rows[1].notes[0][1], /Identische Importzeile/);
  rows[1].on = true;
  assert.equal(rows.filter(r => r.on).length, 2);
});

test('different branches, subjects, scripts, follow-ups and child data are preserved', () => {
  const { preparePoolImportRows, importPayload } = setup();
  for (const changed of [{ place: 'bank-2' }, { topics: ['foerderung'] }, { skript: 'Eigenes Skript' },
    { due: '2026-12-01' }, { kind: { vorname: 'Lena', art: 'tochter', alter: 15 } },
    { topics: ['neuterminierung'], termArt: 'folge', termDatum: '2026-12-02' }]) {
    const rows = [row(), row({ index: 1, ...changed })], before = rows.map(r => JSON.stringify(importPayload(r)));
    preparePoolImportRows(rows);
    assert.ok(rows.every(r => r.on));
    assert.deepEqual(rows.map(r => JSON.stringify(importPayload(r))), before);
  }
});

test('existing contacts with the same name or number alone are warnings, not duplicates', () => {
  const { state, officeImportMatches, importPayload } = setup();
  state.adminPool = [{ ...importPayload(row()), customer_name: 'Muster, Tom', place: 'bank-1' }];
  assert.equal(officeImportMatches(row()).identical.length, 0);
  assert.ok(officeImportMatches(row()).possible.includes('Paket'));
  state.adminPool = [{ ...importPayload(row()), phones: ['07361 654321'], place: 'bank-1' }];
  assert.equal(officeImportMatches(row()).identical.length, 0);
  state.adminPool = [{ ...importPayload(row({ bsnr: '111' })), place: 'bank-1' }];
  assert.equal(officeImportMatches(row({ bsnr: '222' })).identical.length, 0);
});

test('identical saved contacts are detected across phone formatting and all Office lists', () => {
  const { state, officeImportMatches, importPayload } = setup();
  const contact = { ...importPayload(row()), phones: ['+49 7361 123456'], branch_id: 'bank-1' };
  for (const scope of Object.keys(state.adminCalls)) {
    state.adminCalls[scope] = [contact];
    assert.ok(officeImportMatches(row()).identical.length > 0);
    state.adminCalls[scope] = [];
  }
  state.adminPool = [{ ...contact, place: 'bank-1' }];
  assert.ok(officeImportMatches(row()).identical.includes('Paket'));
});

test('invalid and marketing-blocked rows are never combined with a valid contact', () => {
  const { preparePoolImportRows } = setup();
  const rows = [row({ errors: ['Telefonmarketing abgelehnt'], on: false }), row({ index: 1 })];
  preparePoolImportRows(rows);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].on, false);
  assert.equal(rows[1].on, true);
});
