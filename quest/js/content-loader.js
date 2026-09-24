/* 34i-Quest – Content-Loader
 * Lädt chapters.json und pro Kapitel learn.json / questions.json / boss.json per fetch().
 * Validiert alle Daten, bevor die App sie benutzt, und cached sie im Speicher.
 * Die Validatoren sind reine Funktionen und werden auch von tools/check-content.mjs genutzt.
 */

const DATA_ROOT = 'data';
const PARTS = ['learn', 'questions', 'boss'];

let manifest = null;
const chapterCache = new Map();   // chapterId -> { learn, questions, boss }
const pending = new Map();        // `${chapterId}/${part}` -> Promise

/* ---------- Validatoren ---------- */

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isInt = (v) => Number.isInteger(v);

export function validateManifest(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['chapters.json ist kein Objekt'], data: null };
  if (!isInt(raw.contentVersion)) errors.push('contentVersion fehlt oder ist keine Ganzzahl');
  if (!Array.isArray(raw.chapters)) errors.push('chapters ist kein Array');
  const seen = new Set();
  const chapters = (raw.chapters || []).filter((c, i) => {
    if (!c || !isStr(c.id) || !isStr(c.title)) { errors.push(`Level #${i + 1}: id/title fehlt`); return false; }
    if (seen.has(c.id)) { errors.push(`Level-ID ${c.id} doppelt`); return false; }
    seen.add(c.id);
    return true;
  }).map((c, i) => ({ id: c.id, level: isInt(c.level) ? c.level : i + 1, title: c.title, short: c.short || '', block: c.block || 'questline-1', available: c.available === true }));
  return { ok: errors.length === 0 && chapters.length > 0, errors, data: { contentVersion: raw.contentVersion | 0, blocks: raw.blocks || {}, chapters } };
}

const BLOCK_TYPES = new Set(['text', 'list', 'table', 'compare', 'steps', 'example', 'note']);

export function validateLearn(raw, chapterId) {
  const errors = [];
  if (!raw || !Array.isArray(raw.sections)) return { ok: false, errors: ['learn.json: sections fehlt'], data: null };
  if (raw.chapter !== chapterId) errors.push(`learn.json: chapter "${raw.chapter}" passt nicht zu ${chapterId}`);
  const ids = new Set();
  const sections = raw.sections.filter((s, i) => {
    if (!s || !isStr(s.id) || !isStr(s.title)) { errors.push(`Abschnitt #${i}: id/title fehlt`); return false; }
    if (ids.has(s.id)) { errors.push(`Abschnitt ${s.id} doppelt`); return false; }
    ids.add(s.id);
    return true;
  }).map((s) => ({
    ...s,
    content: (Array.isArray(s.content) ? s.content : []).filter((b, j) => {
      const ok = b && BLOCK_TYPES.has(b.type);
      if (!ok) errors.push(`Abschnitt ${s.id}, Block #${j}: unbekannter Typ "${b && b.type}"`);
      return ok;
    }),
    laws: Array.isArray(s.laws) ? s.laws.filter((l) => l && isStr(l.ref) && isStr(l.text)) : [],
  }));
  return { ok: sections.length > 0, errors, data: { chapter: raw.chapter, title: raw.title || '', sections } };
}

export function validateQuestion(q, { requireStoryOrder }) {
  const e = [];
  if (!q || typeof q !== 'object') return ['kein Objekt'];
  if (!isStr(q.id)) e.push('id fehlt');
  if (q.type !== 'single' && q.type !== 'multi') e.push(`type "${q.type}" ungültig`);
  if (!isStr(q.question)) e.push('question fehlt');
  if (!Array.isArray(q.answers) || q.answers.length < 2 || !q.answers.every(isStr)) e.push('answers: mindestens 2 Texte nötig');
  if (!Array.isArray(q.correct) || q.correct.length === 0) e.push('correct fehlt');
  else {
    const n = Array.isArray(q.answers) ? q.answers.length : 0;
    if (!q.correct.every((c) => isInt(c) && c >= 0 && c < n)) e.push('correct verweist auf nicht vorhandene Antwort');
    if (new Set(q.correct).size !== q.correct.length) e.push('correct enthält Duplikate');
    if (q.type === 'single' && q.correct.length !== 1) e.push('single braucht genau 1 richtige Antwort');
    if (q.type === 'multi' && q.correct.length >= n) e.push('multi: nicht alle Antworten dürfen richtig sein');
  }
  if (!isStr(q.explanation)) e.push('explanation fehlt');
  if (requireStoryOrder && !isInt(q.storyOrder)) e.push('storyOrder fehlt');
  return e;
}

function validatePool(raw, chapterId, label, requireStoryOrder) {
  const errors = [];
  const list = raw && Array.isArray(raw.questions) ? raw.questions : null;
  if (!list) return { ok: false, errors: [`${label}: questions fehlt`], data: null };
  const ids = new Set();
  const questions = list.filter((q, i) => {
    const e = validateQuestion(q, { requireStoryOrder });
    if (q && ids.has(q.id)) e.push('id doppelt');
    if (e.length) { errors.push(`${label} ${q && q.id ? q.id : '#' + i}: ${e.join('; ')}`); return false; }
    ids.add(q.id);
    return true;
  }).map((q) => ({ ...q, chapter: q.chapter || chapterId, difficulty: q.difficulty || 1, taxonomyLevel: q.taxonomyLevel || 1 }));
  return { ok: questions.length > 0, errors, data: { questions, boss: raw.boss || null } };
}

export const validateQuestions = (raw, id) => validatePool(raw, id, 'questions.json', true);
export const validateBoss = (raw, id) => validatePool(raw, id, 'boss.json', false);

/* ---------- Laden ---------- */

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch {
    throw new Error(`Keine Verbindung – ${url} ist auch nicht im Offline-Speicher.`);
  }
  if (!res.ok) throw new Error(`${url} nicht gefunden (HTTP ${res.status}).`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${url} enthält kein gültiges JSON.`);
  }
}

export async function loadManifest() {
  const raw = await fetchJson(`${DATA_ROOT}/chapters.json`);
  const v = validateManifest(raw);
  v.errors.forEach((e) => console.warn('[content]', e));
  if (!v.ok) throw new Error('chapters.json ist ungültig: ' + v.errors.join(' | '));
  manifest = v.data;
  return manifest;
}

export const getManifest = () => manifest;
export const getChapterMeta = (id) => manifest?.chapters.find((c) => c.id === id) || null;

const VALIDATORS = { learn: validateLearn, questions: validateQuestions, boss: validateBoss };

async function loadPart(chapterId, part) {
  const key = `${chapterId}/${part}`;
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    const raw = await fetchJson(`${DATA_ROOT}/${chapterId}/${part}.json`);
    const v = VALIDATORS[part](raw, chapterId);
    v.errors.forEach((e) => console.warn(`[content ${chapterId}]`, e));
    if (!v.ok) throw new Error(`${part}.json enthält für dieses Level keine verwendbaren Daten.`);
    return v.data;
  })();
  pending.set(key, p);
  try {
    return await p;
  } finally {
    pending.delete(key);
  }
}

/**
 * Lädt die angefragten Teile eines Kapitels (Standard: alle drei).
 * Liefert { learn, questions, boss, errors } – fehlende Teile sind null, Fehler stehen in errors.
 * Crasht nie: Die App entscheidet anhand von null, ob ein Modus UNAVAILABLE ist.
 */
export async function loadChapterContent(chapterId, parts = PARTS) {
  const meta = getChapterMeta(chapterId);
  const entry = chapterCache.get(chapterId) || { learn: null, questions: null, boss: null, errors: {} };
  chapterCache.set(chapterId, entry);
  if (!meta || !meta.available) {
    parts.forEach((p) => { entry.errors[p] = 'Dieses Level ist noch nicht freigeschaltet.'; });
    return entry;
  }
  await Promise.all(parts.filter((p) => entry[p] === null).map(async (p) => {
    try {
      entry[p] = await loadPart(chapterId, p);
      delete entry.errors[p];
    } catch (err) {
      entry.errors[p] = err.message;
    }
  }));
  return entry;
}

export const getCachedChapter = (id) => chapterCache.get(id) || null;
