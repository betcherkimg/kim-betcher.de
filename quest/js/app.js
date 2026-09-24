/* 34i-Quest – App: Screens, Rendering, Spielfluss, Effekte */

import * as Content from './content-loader.js';
import { SaveGame, SaveError, isSupported, createChapterProgress, SAVE_NAME } from './savegame.js';
import { MODES, BOSS_REQUIRES_STORY, MAX_HP, MODE_HP_LOSS, POTIONS, rollQuestionReward, selectQuestions, prepareQuestion, Run, rankFor, ACHIEVEMENTS, Countdown } from './game.js';

/* =========================================================
   Grundgerüst
   ========================================================= */

const save = new SaveGame();
const countdown = new Countdown();
const timeouts = new Set();

const ui = {
  screen: 'terminal',
  busy: false,
  chapterId: null,
  learnIdx: 0,
  check: null,          // Checkpoint-Frage im Lernskript
  run: null,            // aktueller Run
  selected: [],
  answered: false,
  runToken: 0,
  result: null,         // letzte Auswertung
  newAchievements: [],
};

const $ = (id) => document.getElementById(id);
const S = () => save.state;

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** Escaped Text, **Begriff** wird hervorgehoben. */
const rich = (v) => esc(v).replace(/\*\*(.+?)\*\*/g, '<strong class="term">$1</strong>');

function prog(id) {
  const st = S();
  if (!st.progress[id]) st.progress[id] = createChapterProgress();
  return st.progress[id];
}
function lastQ(id) {
  const st = S();
  if (!st.lastQuestions[id]) st.lastQuestions[id] = { story: [], versus: [], boss: [] };
  return st.lastQuestions[id];
}

function levelMeta(id) {
  return Content.getChapterMeta(id) || { id, level: id, title: '' };
}
function levelNo(id) { return levelMeta(id).level ?? id; }
function levelLabel(id) { return `Level ${levelNo(id)}`; }

function playerVitals() {
  const pl = S().player;
  if (!Number.isFinite(pl.maxHp) || pl.maxHp <= 0) pl.maxHp = MAX_HP;
  if (!Number.isFinite(pl.hp)) pl.hp = pl.maxHp;
  pl.hp = Math.max(0, Math.min(pl.maxHp, pl.hp));
  if (!pl.inventory || typeof pl.inventory !== 'object') pl.inventory = { small: 0, medium: 0, large: 0, spark: 0 };
  for (const k of ['small', 'medium', 'large', 'spark']) if (!Number.isFinite(pl.inventory[k]) || pl.inventory[k] < 0) pl.inventory[k] = 0;
  return pl;
}

function healHp(amount, label = 'Heilung') {
  const pl = playerVitals();
  const before = pl.hp;
  pl.hp = Math.min(pl.maxHp, pl.hp + Math.max(0, amount));
  const gained = pl.hp - before;
  if (gained > 0) toast(`${label}: +${gained} HP`, { icon: '❤️', tone: 'gold' });
  return gained;
}

function damageHp(amount, label = 'Schaden') {
  const pl = playerVitals();
  const before = pl.hp;
  pl.hp = Math.max(0, pl.hp - Math.max(0, amount));
  const lost = before - pl.hp;
  let revived = false;
  if (pl.hp <= 0 && pl.inventory.spark > 0) {
    pl.inventory.spark -= 1;
    pl.hp = pl.maxHp;
    revived = true;
    toast('Lebensfunke aktiviert – volle HP!', { icon: POTIONS.spark.icon, tone: 'gold', ms: 5000 });
    sfx('level');
    confetti(70);
  } else if (lost > 0) {
    toast(`${label}: −${lost} HP`, { icon: '💔', tone: 'bad', ms: 3600 });
  }
  return { lost, revived, hp: pl.hp };
}

function usePotion(kind) {
  const item = POTIONS[kind];
  const pl = playerVitals();
  if (!item || kind === 'spark') return;
  if ((pl.inventory[kind] || 0) <= 0) { toast(`${item.label}: keiner im Inventar.`, { icon: item.icon }); return; }
  if (pl.hp >= pl.maxHp) { toast('Deine HP sind bereits voll.', { icon: '❤️' }); return; }
  pl.inventory[kind] -= 1;
  healHp(Math.round(pl.maxHp * (item.heal / 100)), item.label);
  persist();
  renderDashboard();
}

function maybeDropReward(question) {
  const item = rollQuestionReward(question);
  if (!item) return null;
  const pl = playerVitals();
  pl.inventory[item.id] = (pl.inventory[item.id] || 0) + 1;
  toast(`${item.icon} Gefunden: ${item.label}`, { icon: item.icon, tone: 'gold', ms: item.id === 'spark' ? 5200 : 3000 });
  persist();
  return item;
}

/** setTimeout, der automatisch verfällt, sobald ein Run beendet oder verlassen wird. */
function later(fn, ms) {
  const token = ui.runToken;
  const id = setTimeout(() => { timeouts.delete(id); if (token === ui.runToken) fn(); }, ms);
  timeouts.add(id);
}
function clearRunTimers() {
  countdown.stop();
  timeouts.forEach(clearTimeout);
  timeouts.clear();
  ui.runToken += 1;
}

function showScreen(name) {
  document.querySelectorAll('section[data-screen]').forEach((el) => { el.hidden = el.dataset.screen !== name; });
  $('topbar').hidden = name === 'terminal';
  document.body.dataset.view = name;
  ui.screen = name;
  window.scrollTo({ top: 0 });
  const main = $('main');
  if (main && name !== 'run') main.focus({ preventScroll: true });
}

/* =========================================================
   Icons (inline SVG, eigene Zeichnungen)
   ========================================================= */

const I = {
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/><path d="M8 7h8M8 11h6"/></svg>',
  path: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M7 19h6a4 4 0 0 0 0-8h-2a4 4 0 0 1 0-8h6"/></svg>',
  swords: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6M16 16l4 4M19 21l2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4M7 17l-3 3M3 19l2 2"/></svg>',
  seal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.2 2.1 3-.5.9 2.9 2.7 1.4-.9 2.9 1.3 2.7-2.5 1.8-.3 3-3 .3-1.8 2.5-2.7-1.3-2.9.9-1.4-2.7-2.9-.9.5-3L2 12l2.1-2.2-.5-3 2.9-.9L7.9 3.2l2.9.9z"/><path d="M10.5 9.5c0-1 .8-1.5 1.7-1.5s1.8.5 1.8 1.4c0 1.8-3.5 1.4-3.5 3.3 0 1 .9 1.6 1.8 1.6s1.7-.5 1.7-1.5"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3.2 5 6.6 5c2 0 3.4 1.1 4.4 2.5C12 6.1 13.4 5 15.4 5c3.4 0 5.4 3.6 4.1 6.8C19.5 16.4 12 21 12 21z"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z"/></svg>',
  flame: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22c4 0 7-2.7 7-6.8 0-4.4-3.6-6.5-4.5-10.2-2 1.3-3.2 3.6-3 6-1.3-.6-2.2-2-2.4-3.3C7 9.4 5 12 5 15.2 5 19.3 8 22 12 22z"/></svg>',
  soundOn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  soundOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="m17 9 5 6M22 9l-5 6"/></svg>',
  save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-6h8v6"/></svg>',
};

/* =========================================================
   Sound (WebAudio, kein Asset nötig)
   ========================================================= */

let audio = null;
function sfx(kind) {
  if (!S() || !S().settings.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const seq = {
      ok: [[660, 0, 0.08], [990, 0.08, 0.12]],
      bad: [[190, 0, 0.18], [140, 0.12, 0.22]],
      tick: [[1200, 0, 0.03]],
      win: [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.12], [1047, 0.36, 0.3]],
      lose: [[330, 0, 0.18], [262, 0.18, 0.3]],
      level: [[784, 0, 0.1], [988, 0.1, 0.1], [1319, 0.2, 0.25]],
      click: [[880, 0, 0.03]],
    }[kind] || [];
    const t = audio.currentTime;
    seq.forEach(([f, start, dur]) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = kind === 'bad' || kind === 'lose' ? 'sawtooth' : 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + start);
      g.gain.exponentialRampToValueAtTime(kind === 'tick' ? 0.05 : 0.12, t + start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      o.connect(g).connect(audio.destination);
      o.start(t + start);
      o.stop(t + start + dur + 0.02);
    });
  } catch { /* Audio nicht verfügbar – egal */ }
}

/* =========================================================
   Effekte: Toast, Flash, Konfetti
   ========================================================= */

function toast(text, { icon = '', tone = '', action = null, ms = 3600 } = {}) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${tone ? 'toast--' + tone : ''}`;
  el.innerHTML = `${icon ? `<span class="toast__icon">${icon}</span>` : ''}<span class="toast__text">${esc(text)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast__btn';
    b.textContent = action.label;
    b.addEventListener('click', () => { action.run(); el.remove(); });
    el.appendChild(b);
  }
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  if (ms) setTimeout(() => { el.classList.add('toast--out'); setTimeout(() => el.remove(), 300); }, ms);
}

function flash(text, tone) {
  const el = $('flash');
  el.textContent = text;
  el.className = `flash flash--${tone} flash--on`;
  setTimeout(() => { el.className = 'flash'; }, 520);
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function confetti(amount = 140) {
  if (reducedMotion()) return;
  const c = $('confetti');
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#0A6CF5', '#0B2553', '#7FB3FF', '#E9A400', '#0E9F6E', '#FFFFFF'];
  const parts = Array.from({ length: amount }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 12 - 4,
    r: Math.random() * 6 + 3, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
    col: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  c.classList.add('confetti--on');
  (function frame(now) {
    const t = now - t0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts.forEach((p) => {
      p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= 0.99;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.col; ctx.globalAlpha = Math.max(0, 1 - t / 2200);
      ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
      ctx.restore();
    });
    if (t < 2200) requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, innerWidth, innerHeight); c.classList.remove('confetti--on'); }
  })(t0);
}

/* =========================================================
   Fortschritt, XP, Erfolge
   ========================================================= */

function chapterSectionsTotal(id) {
  return Content.getCachedChapter(id)?.learn?.sections.length || 0;
}

function chapterStatus(id) {
  const p = prog(id);
  const total = chapterSectionsTotal(id);
  const done = total ? p.learnCompleted.filter((sid) => Content.getCachedChapter(id).learn.sections.some((s) => s.id === sid)).length : 0;
  const learnDone = total > 0 && done >= total;
  const story = p.storyWins > 0;
  const versus = p.versusWins > 0;
  const boss = p.bossWins > 0;
  const pct = Math.round((total ? (done / total) * 25 : 0) + (story ? 25 : 0) + (versus ? 25 : 0) + (boss ? 25 : 0));
  return { done, total, learnDone, story, versus, boss, pct, mastered: learnDone && story && versus && boss };
}

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function touchDay() {
  const pl = S().player;
  const today = todayKey();
  if (pl.lastDay === today) return;
  const y = new Date(); y.setDate(y.getDate() - 1);
  pl.dayStreak = pl.lastDay === todayKey(y) ? pl.dayStreak + 1 : 1;
  pl.lastDay = today;
  if (pl.dayStreak >= 3) unlock('streak_3');
  renderHeader();
}

function addXp(n) {
  if (!n) return;
  const pl = S().player;
  const before = rankFor(pl.xp).level;
  pl.xp += n;
  const after = rankFor(pl.xp);
  if (after.level > before) {
    sfx('level');
    toast(`Rang aufgestiegen: ${after.title}`, { icon: '⬆️', tone: 'gold', ms: 4500 });
    confetti(90);
  }
  renderHeader();
}

function unlock(id) {
  const list = S().player.achievements;
  if (list.includes(id)) return false;
  list.push(id);
  const a = ACHIEVEMENTS.find((x) => x.id === id);
  if (a) {
    ui.newAchievements.push(a);
    // Während eines Runs nicht einblenden (würde Antworten verdecken) – die Auswertung zeigt sie gesammelt
    if (!ui.run) toast(`Erfolg freigeschaltet: ${a.title}`, { icon: a.icon, tone: 'gold' });
  }
  return true;
}

function checkMastery(id) {
  const p = prog(id);
  if (!chapterStatus(id).mastered || p.levelCompleted) return false;
  p.levelCompleted = true;
  const pl = playerVitals();
  pl.hp = pl.maxHp;
  unlock('master');
  toast(`${levelLabel(id)} abgeschlossen – HP vollständig aufgefüllt!`, { icon: '🏆', tone: 'gold', ms: 5200 });
  confetti(120);
  return true;
}

/**
 * Ein verlorener Run setzt bei einem noch nicht abgeschlossenen Level die
 * Spielmodus-Fortschritte zurück. Lernskript, Bestwerte, XP und Inventar bleiben erhalten.
 */
function resetLevelModesAfterLoss(id) {
  const p = prog(id);
  if (p.levelCompleted) return false;
  const hadProgress = p.storyWins > 0 || p.versusWins > 0 || p.bossWins > 0 ||
    p.stars.story > 0 || p.stars.versus > 0 || p.stars.boss > 0;
  p.storyWins = 0;
  p.versusWins = 0;
  p.bossWins = 0;
  p.stars = { story: 0, versus: 0, boss: 0 };
  return hadProgress;
}

/* =========================================================
   Kopfzeile
   ========================================================= */

function renderHeader() {
  if (!S()) return;
  const pl = S().player;
  const r = rankFor(pl.xp);
  $('rankChip').innerHTML = `
    <span class="rankchip__lv">Rang ${r.level}</span>
    <span class="rankchip__body">
      <span class="rankchip__title">${esc(r.title)}</span>
      <span class="bar bar--xp"><span style="width:${r.pct}%"></span></span>
    </span>
    <span class="rankchip__xp">${pl.xp} XP</span>`;
  $('streakChip').innerHTML = `${I.flame}<span>${pl.dayStreak || 0}</span>`;
  $('streakChip').title = `${pl.dayStreak || 0} Lerntag(e) in Folge`;
  const on = S().settings.sound;
  $('soundBtn').innerHTML = on ? I.soundOn : I.soundOff;
  $('soundBtn').setAttribute('aria-pressed', String(on));
  $('soundBtn').setAttribute('aria-label', on ? 'Ton ausschalten' : 'Ton einschalten');
}

function setSaveChip(status, detail) {
  const chip = $('saveChip');
  const map = {
    saved: ['ok', 'Gespeichert', `Fortschritt liegt in ${SAVE_NAME}`],
    ready: ['ok', 'Bereit', `Speichert in ${SAVE_NAME}`],
    permission: ['warn', 'Speichern erlauben', 'Der Browser braucht deine Zustimmung, um in die Datei zu schreiben. Klicken.'],
    guest: ['muted', 'Demo', 'Demo-Modus: Es wird nichts gespeichert.'],
    error: ['bad', 'Speicherfehler', detail || 'Speichern fehlgeschlagen'],
  };
  const [tone, label, title] = map[status] || map.ready;
  chip.className = `chip chip--save chip--${tone}`;
  chip.innerHTML = `${I.save}<span>${esc(label)}</span>`;
  chip.title = title;
  chip.disabled = status !== 'permission';
  if (status === 'error') toast(`Spielstand konnte nicht gespeichert werden: ${detail}`, { icon: '⚠️', tone: 'bad', ms: 6000 });
}
save.onStatus(setSaveChip);

function persist() {
  save.save();
}

/* =========================================================
   1 · Save-Terminal
   ========================================================= */

function termLine(text, tone = '') {
  const li = document.createElement('li');
  li.className = tone ? `log--${tone}` : '';
  li.style.animationDelay = `${$('termLog').children.length * 110}ms`;
  li.textContent = text;
  $('termLog').appendChild(li);
}

async function bootTerminal() {
  showScreen('terminal');
  termLine('34i-Quest startet …');
  try {
    const m = await Content.loadManifest();
    const avail = m.chapters.filter((c) => c.available).length;
    termLine(`Lerninhalte geladen: Version ${m.contentVersion}, ${avail} von ${m.chapters.length} Leveln spielbar.`, 'ok');
  } catch (err) {
    termLine(`Lerninhalte nicht erreichbar: ${err.message}`, 'bad');
    termLine('Tipp: Die App über http://localhost starten, nicht per Doppelklick auf die Datei.', 'muted');
  }
  termLine(`Spielstand-Datei: ${SAVE_NAME}`);
  if (isSupported()) {
    termLine('Browser kann in Dateien speichern.', 'ok');
    if (await save.hasRemembered()) {
      $('btnResume').hidden = false;
      termLine('Letzter Spielstand gefunden – „Weiterspielen“ öffnet ihn direkt.', 'ok');
    }
    termLine('Wähle SPIELSTAND LADEN oder NEU STARTEN.');
    $('termHint').textContent = 'Der Spielstand liegt nur auf deinem Rechner. Tipp: im Ordner „Dokumente“ ablegen.';
  } else {
    termLine('Dieser Browser kann nicht in Dateien speichern. Bitte Chrome oder Edge verwenden.', 'bad');
    $('termHint').textContent = 'Zum Ausprobieren gibt es den Demo-Modus – dort wird nichts gespeichert.';
    $('btnGuest').hidden = false;
  }
  if (location.hash === '#demo') $('btnGuest').hidden = false;
}

async function withBusy(fn) {
  if (ui.busy) return;
  ui.busy = true;
  document.body.classList.add('is-busy');
  try { await fn(); } finally { ui.busy = false; document.body.classList.remove('is-busy'); }
}

function saveErrorToTerminal(err) {
  if (err?.code === SaveError.ABORTED) { termLine('Abgebrochen.', 'muted'); return; }
  termLine(err?.message || 'Unbekannter Fehler beim Spielstand.', 'bad');
  console.error(err);
}

const saveActions = {
  async new() {
    if (await save.hasRemembered()) {
      const ok = confirm(`„Neu starten“ legt einen leeren Spielstand an.\nWählst du im Dialog die bestehende ${SAVE_NAME}, wird dein bisheriger Fortschritt überschrieben.\n\nFortfahren?`);
      if (!ok) return;
    }
    await save.newGame();
    termLine('Neuer Spielstand angelegt.', 'ok');
    await enterGame();
    toast('Neuer Spielstand angelegt. Viel Erfolg!', { icon: '🎮' });
  },
  async load() {
    await save.loadGame();
    termLine('Spielstand geladen.', 'ok');
    await enterGame();
    toast('Willkommen zurück!', { icon: '👋' });
  },
  async resume() {
    await save.resume();
    termLine('Spielstand geöffnet.', 'ok');
    await enterGame();
    toast('Willkommen zurück!', { icon: '👋' });
  },
  async guest() {
    save.startGuest();
    await enterGame();
    toast('Demo-Modus: Fortschritt geht beim Schließen verloren.', { icon: 'ℹ️' });
  },
};

async function enterGame() {
  const m = Content.getManifest();
  if (m) await Promise.all(m.chapters.filter((c) => c.available).map((c) => Content.loadChapterContent(c.id, ['learn'])));
  renderHeader();
  setSaveChip(save.guest ? 'guest' : save.canWrite ? 'ready' : 'permission');
  renderDashboard();
  showScreen('dashboard');
}

/* =========================================================
   2 · Missionsauswahl
   ========================================================= */

function nextMission() {
  const m = Content.getManifest();
  if (!m) return null;
  for (const c of m.chapters.filter((x) => x.available)) {
    const st = chapterStatus(c.id);
    if (st.mastered) continue;
    const label = `Level ${c.level}`;
    if (!st.learnDone) {
      const learn = Content.getCachedChapter(c.id)?.learn;
      const p = prog(c.id);
      const sec = learn?.sections.find((s) => !p.learnCompleted.includes(s.id));
      return { chapter: c, label: `${label}: Lernskript ${st.done ? 'weiterlesen' : 'starten'}`, detail: sec ? `Nächster Abschnitt: ${sec.title}` : '', action: `data-action="open-learn" data-id="${esc(c.id)}"` };
    }
    if (!st.story) return { chapter: c, label: `${label}: Storymode starten`, detail: '10 Fragen in Lernreihenfolge – danach wird der Boss freigeschaltet.', action: `data-action="start-mode" data-mode="story" data-id="${esc(c.id)}"` };
    if (!st.versus) return { chapter: c, label: `${label}: Versus spielen`, detail: '5 Zufallsfragen, ein Fehler und es ist vorbei.', action: `data-action="start-mode" data-mode="versus" data-id="${esc(c.id)}"` };
    if (!st.boss) return { chapter: c, label: `${label}: Bossfight wagen`, detail: '5 harte Fragen, 10 Sekunden pro Frage.', action: `data-action="start-mode" data-mode="boss" data-id="${esc(c.id)}"` };
  }
  return null;
}

function potionButton(kind) {
  const pl = playerVitals();
  const item = POTIONS[kind];
  const count = pl.inventory[kind] || 0;
  if (kind === 'spark') {
    return `<div class="lootitem lootitem--spark" title="Wird bei 0 HP automatisch verbraucht und belebt dich mit voller HP wieder.">
      <span class="lootitem__icon">${item.icon}</span><span class="lootitem__body"><b>${esc(item.label)}</b><small>Auto-Wiederbelebung</small></span><strong>×${count}</strong>
    </div>`;
  }
  return `<button class="lootitem" data-action="use-potion" data-kind="${kind}" ${count <= 0 || pl.hp >= pl.maxHp ? 'disabled' : ''} title="${esc(item.label)} benutzen: +${item.heal}% HP">
    <span class="lootitem__icon">${item.icon}</span><span class="lootitem__body"><b>${esc(item.label)}</b><small>+${item.heal}% HP</small></span><strong>×${count}</strong>
  </button>`;
}

function renderDashboard() {
  const st = S();
  const m = Content.getManifest();
  const pl = playerVitals();
  const r = rankFor(pl.xp);
  const acc = pl.answered ? Math.round((pl.correct / pl.answered) * 100) : 0;
  const mission = nextMission();
  const hpPct = Math.round((pl.hp / pl.maxHp) * 100);

  const badges = ACHIEVEMENTS.map((a) => {
    const got = pl.achievements.includes(a.id);
    return `<li class="badge ${got ? 'badge--got' : ''}" title="${esc(a.title)}: ${esc(a.text)}"><span aria-hidden="true">${got ? a.icon : '?'}</span><span class="sr">${esc(a.title)} ${got ? 'freigeschaltet' : 'gesperrt'}</span></li>`;
  }).join('');

  let chaptersHtml = '<p class="empty">Die Levelliste konnte nicht geladen werden. Läuft die App über localhost?</p>';
  if (m) {
    const blocks = [...new Set(m.chapters.map((c) => c.block))];
    chaptersHtml = blocks.map((b) => `
      <section class="block">
        <h2 class="block__title">${esc(m.blocks?.[b] || 'Questline')}</h2>
        <div class="chapters">${m.chapters.filter((c) => c.block === b).map(chapterCard).join('')}</div>
      </section>`).join('');
  }

  $('dashboardView').innerHTML = `
    <div class="dash">
      <section class="player" aria-label="Dein Profil">
        <div class="player__emblem" aria-hidden="true"><span>${r.level}</span></div>
        <div class="player__main">
          <p class="player__kicker">Rangstufe ${r.level}</p>
          <h1 class="player__title">${esc(r.title)}</h1>
          <div class="bar bar--xp bar--lg" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.pct}"><span style="width:${r.pct}%"></span></div>
          <p class="player__next">${r.next ? `Noch ${r.toNext} XP bis „${esc(r.next.title)}“` : 'Höchster Rang erreicht.'}</p>
          <dl class="stats">
            <div><dt>Erfahrung</dt><dd>${pl.xp} XP</dd></div>
            <div><dt>Trefferquote</dt><dd>${pl.answered ? acc + ' %' : '–'}</dd></div>
            <div><dt>Beste Serie</dt><dd>${pl.bestCombo}</dd></div>
            <div><dt>Lerntage in Folge</dt><dd>${pl.dayStreak}</dd></div>
          </dl>
        </div>
        <div class="player__badges">
          <p class="player__kicker">Erfolge ${pl.achievements.length}/${ACHIEVEMENTS.length}</p>
          <ul class="badges">${badges}</ul>
        </div>
      </section>

      <section class="health" aria-label="HP und Inventar">
        <div class="health__main">
          <div class="health__head"><span>HP</span><strong>${pl.hp}/${pl.maxHp}</strong></div>
          <div class="bar bar--hp bar--lg" role="progressbar" aria-label="HP" aria-valuemin="0" aria-valuemax="${pl.maxHp}" aria-valuenow="${pl.hp}"><span style="width:${hpPct}%"></span></div>
          <p>Verlierst du einen Run, kostet das HP: Story −25 %, Versus −33 %, Boss −50 %. Ein abgeschlossenes Level füllt alles wieder auf.</p>
        </div>
        <div class="inventory" aria-label="Heilitems">
          ${potionButton('small')}${potionButton('medium')}${potionButton('large')}${potionButton('spark')}
        </div>
      </section>

      ${mission ? `
      <button class="mission" ${mission.action}>
        <span class="mission__label">Nächste Mission</span>
        <span class="mission__title">${esc(mission.label)}</span>
        <span class="mission__detail">${esc(mission.detail)}</span>
        <span class="mission__go">${I.next}</span>
      </button>` : ''}
      ${chaptersHtml}
    </div>`;
}

function chapterCard(c) {
  const level = c.level ?? '?';
  if (!c.available) {
    return `<div class="ccard ccard--locked" aria-disabled="true">
      <span class="ccard__num"><small>LEVEL</small>${esc(level)}</span>
      <h3 class="ccard__title">${esc(c.title)}</h3>
      <span class="lockbadge">${I.lock} LOCKED</span>
    </div>`;
  }
  const st = chapterStatus(c.id);
  const mark = (ok, label) => `<li class="${ok ? 'is-done' : ''}"><span aria-hidden="true">${ok ? '✓' : '○'}</span> ${label}</li>`;
  const tag = st.mastered ? '<span class="tag tag--gold">🏆 Level abgeschlossen</span>' : st.pct > 0 ? '<span class="tag">In Arbeit</span>' : '<span class="tag tag--new">Neu</span>';
  return `<button class="ccard" data-action="open-chapter" data-id="${esc(c.id)}">
    <span class="ccard__num"><small>LEVEL</small>${esc(level)}</span>
    <h3 class="ccard__title">${esc(c.title)}</h3>
    <span class="ccard__pct">Fortschritt ${st.pct} %</span>
    <span class="bar"><span style="width:${st.pct}%"></span></span>
    <ul class="ccard__checks">
      ${mark(st.learnDone, `Lernskript <small>${st.done}/${st.total}</small>`)}
      ${mark(st.story, 'Story')}
      ${mark(st.versus, 'Versus')}
      ${mark(st.boss, 'Bossfight')}
    </ul>
    ${tag}
  </button>`;
}

/* =========================================================
   3 · Kapitel
   ========================================================= */

async function openChapter(id) {
  const meta = Content.getChapterMeta(id);
  if (!meta || !meta.available) { toast('Dieses Level ist noch gesperrt.', { icon: '🔒' }); return; }
  ui.chapterId = id;
  $('chapterView').innerHTML = '<p class="loading">Level wird geladen …</p>';
  showScreen('chapter');
  await Content.loadChapterContent(id);
  renderChapter();
}

function ring(pct) {
  const r = 34, c = 2 * Math.PI * r;
  return `<svg class="ring" viewBox="0 0 80 80" aria-hidden="true">
    <circle cx="40" cy="40" r="${r}" class="ring__bg"/>
    <circle cx="40" cy="40" r="${r}" class="ring__fg" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}"/>
  </svg>`;
}
const stars = (n, cls = '') => `<span class="stars ${cls}" aria-label="${n} von 3 Sternen">${[1, 2, 3].map((i) => `<span class="${i <= n ? 'on' : ''}">${I.star}</span>`).join('')}</span>`;

function renderChapter() {
  const id = ui.chapterId;
  const meta = Content.getChapterMeta(id);
  const data = Content.getCachedChapter(id);
  const p = prog(id);
  const st = chapterStatus(id);
  const pl = playerVitals();
  const noHp = pl.hp <= 0;
  const bossLocked = BOSS_REQUIRES_STORY && !st.story;
  const bossName = data?.boss?.boss?.name || 'Level-Boss';

  const card = ({ key, icon, title, text, rules, stat, disabled, lockText, action }) => `
    <button class="mode mode--${key} ${disabled ? 'mode--locked' : ''}" ${disabled ? 'aria-disabled="true"' : action}>
      <span class="mode__icon">${disabled ? I.lock : icon}</span>
      <span class="mode__title">${title}</span>
      <span class="mode__text">${disabled ? esc(lockText) : text}</span>
      <span class="mode__rules">${rules}</span>
      ${stat ? `<span class="mode__stat">${stat}</span>` : ''}
    </button>`;

  const errs = Object.values(data?.errors || {});
  $('chapterView').innerHTML = `
    <button class="back" data-action="go-dashboard">${I.back} Missionsauswahl</button>
    <header class="chero">
      <div class="chero__ring">${ring(st.pct)}<span>${st.pct}%</span></div>
      <div class="chero__text">
        <p class="chero__level">LEVEL ${esc(meta.level)}</p>
        <h1>${esc(meta.title)}</h1>
        <p class="chero__hp">❤️ ${pl.hp}/${pl.maxHp} HP</p>
        <ol class="mastery" aria-label="Weg zum Levelabschluss">
          <li class="${st.learnDone ? 'is-done' : ''}">Lernskript</li>
          <li class="${st.story ? 'is-done' : ''}">Storymode</li>
          <li class="${st.versus ? 'is-done' : ''}">Versus</li>
          <li class="${st.boss ? 'is-done' : ''}">Bossfight</li>
          <li class="${st.mastered ? 'is-done is-gold' : ''}">Level abgeschlossen</li>
        </ol>
      </div>
    </header>
    ${noHp ? '<div class="notice notice--bad"><strong>0 HP.</strong> Nutze im Dashboard einen Heiltrank. Das Lernskript bleibt verfügbar, damit du weiterlernen kannst.</div>' : ''}
    ${errs.length ? `<div class="notice notice--bad"><strong>Teile dieses Levels fehlen:</strong> ${errs.map(esc).join(' ')}</div>` : ''}
    <div class="modes">
      ${card({ key: 'learn', icon: I.book, title: 'LERNSKRIPT', text: 'Der Stoff kompakt, in Lernreihenfolge, mit Merksätzen und Prüfungsfallen.',
        rules: `${st.done}/${st.total} Abschnitte verstanden · Checkpoint-Fehler −10 HP`, disabled: !data?.learn, lockText: 'UNAVAILABLE – Lernskript fehlt.',
        action: `data-action="open-learn" data-id="${esc(id)}"` })}
      ${card({ key: 'story', icon: I.path, title: 'STORYMODE', text: 'Zehn Fragen in der Reihenfolge des Lernskripts. Erst Grundlagen, dann Anwendung.',
        rules: '10 Fragen · 3 Leben · Verlust: −25 % HP', stat: `${stars(p.stars.story)} <span>Rekord ${p.bestStory} · ${p.storyWins}× gewonnen</span>`,
        disabled: !data?.questions || noHp, lockText: !data?.questions ? 'UNAVAILABLE – Fragen fehlen.' : 'KO – Fülle zuerst deine HP auf.', action: `data-action="start-mode" data-mode="story" data-id="${esc(id)}"` })}
      ${card({ key: 'versus', icon: I.swords, title: 'VERSUS', text: 'Fünf Zufallsfragen quer durchs Level. Ähnliche Begriffe gegeneinander.',
        rules: '5 Fragen · 1 Leben · Verlust: −33 % HP', stat: `${stars(p.stars.versus)} <span>Rekord ${p.bestVersus} · ${p.versusWins}× gewonnen</span>`,
        disabled: !data?.questions || noHp, lockText: !data?.questions ? 'UNAVAILABLE – Fragen fehlen.' : 'KO – Fülle zuerst deine HP auf.', action: `data-action="start-mode" data-mode="versus" data-id="${esc(id)}"` })}
      ${card({ key: 'boss', icon: I.seal, title: 'BOSSFIGHT', text: `${esc(bossName)} wartet – mit eigenen, harten Fallfragen.`,
        rules: '5 Fragen · 3 Leben · 10 Sekunden · Verlust: −50 % HP', stat: `${stars(p.stars.boss)} <span>Rekord ${p.bestBoss} · ${p.bossWins}× besiegt</span>`,
        disabled: !data?.boss || bossLocked || noHp,
        lockText: !data?.boss ? 'UNAVAILABLE – Bossfragen fehlen.' : bossLocked ? 'LOCKED – Gewinne zuerst den Storymode.' : 'KO – Fülle zuerst deine HP auf.',
        action: `data-action="start-mode" data-mode="boss" data-id="${esc(id)}"` })}
    </div>`;
}

/* =========================================================
   4 · Lernskript
   ========================================================= */

async function openLearn(id, sectionId) {
  ui.chapterId = id;
  await Content.loadChapterContent(id);
  const learn = Content.getCachedChapter(id)?.learn;
  if (!learn) { toast('Das Lernskript ist nicht verfügbar.', { icon: '⚠️', tone: 'bad' }); return; }
  const p = prog(id);
  let idx = sectionId ? learn.sections.findIndex((s) => s.id === sectionId) : learn.sections.findIndex((s) => !p.learnCompleted.includes(s.id));
  ui.learnIdx = idx < 0 ? 0 : idx;
  ui.check = null;
  renderLearn();
  showScreen('learn');
}

function renderBlock(b) {
  switch (b.type) {
    case 'text': return `<p>${rich(b.text)}</p>`;
    case 'list': return `${b.title ? `<h3 class="lesson__h">${esc(b.title)}</h3>` : ''}<ul class="lesson__list">${(b.items || []).map((x) => `<li>${rich(x)}</li>`).join('')}</ul>`;
    case 'table': return `<div class="tablewrap"><table><thead><tr>${(b.head || []).map((h) => `<th scope="col">${rich(h)}</th>`).join('')}</tr></thead><tbody>${(b.rows || []).map((r) => `<tr>${r.map((c) => `<td>${rich(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    case 'compare': return `<div class="compare">
        <div class="compare__side"><h3>${rich(b.left?.title)}</h3><p>${rich(b.left?.text)}</p></div>
        <span class="compare__vs" aria-hidden="true">vs</span>
        <div class="compare__side"><h3>${rich(b.right?.title)}</h3><p>${rich(b.right?.text)}</p></div>
      </div>`;
    case 'steps': return `${b.title ? `<h3 class="lesson__h">${esc(b.title)}</h3>` : ''}<ol class="steps">${(b.items || []).map((s) => `<li><strong>${rich(s.title)}</strong><span>${rich(s.text)}</span></li>`).join('')}</ol>`;
    case 'example': return `<aside class="box box--example"><h3>${esc(b.title || 'Beispiel')}</h3><p>${rich(b.text)}</p></aside>`;
    case 'note': return `<aside class="box box--note"><h3>${esc(b.title || 'Hinweis')}</h3><p>${rich(b.text)}</p></aside>`;
    default: return '';
  }
}

function renderLearn() {
  const id = ui.chapterId;
  const data = Content.getCachedChapter(id);
  const learn = data.learn;
  const meta = levelMeta(id);
  const p = prog(id);
  const sec = learn.sections[ui.learnIdx];
  const done = p.learnCompleted.includes(sec.id);
  const doneCount = learn.sections.filter((s) => p.learnCompleted.includes(s.id)).length;

  const nav = learn.sections.map((s, i) => {
    const ok = p.learnCompleted.includes(s.id);
    return `<li><button class="lnav__item ${i === ui.learnIdx ? 'is-active' : ''} ${ok ? 'is-done' : ''}" data-action="learn-goto" data-idx="${i}" ${i === ui.learnIdx ? 'aria-current="step"' : ''}>
      <span class="lnav__n">${ok ? I.check : i + 1}</span><span>${esc(s.title)}</span></button></li>`;
  }).join('');

  const laws = sec.laws?.length ? `<aside class="box box--law"><h3>Paragraphen-Anker</h3><dl>${sec.laws.map((l) => `<div><dt>${esc(l.ref)}</dt><dd>${rich(l.text)}</dd></div>`).join('')}</dl></aside>` : '';
  const memory = sec.memory ? `<aside class="box box--memory"><h3>Merksatz</h3><p>${rich(sec.memory)}</p></aside>` : '';
  const trap = sec.examTrap ? `<aside class="box box--trap"><h3>Prüfungsfalle</h3><p>${rich(sec.examTrap)}</p></aside>` : '';

  $('learnView').innerHTML = `
    <button class="back" data-action="back-chapter">${I.back} Level ${esc(meta.level)}</button>
    <div class="learn">
      <nav class="lnav" aria-label="Abschnitte">
        <p class="lnav__head">LEVEL ${esc(meta.level)} · LERNSKRIPT <span>${doneCount}/${learn.sections.length}</span></p>
        <span class="bar"><span style="width:${(doneCount / learn.sections.length) * 100}%"></span></span>
        <ol>${nav}</ol>
      </nav>
      <article class="lesson" aria-labelledby="lessonTitle">
        <header class="lesson__head">
          <p class="lesson__meta">Abschnitt ${ui.learnIdx + 1} von ${learn.sections.length} <span class="rel" title="Prüfungsrelevanz laut Einschätzung">Prüfung ${esc(sec.examRelevance || 'S')}</span></p>
          <h1 id="lessonTitle">${esc(sec.title)}</h1>
          ${sec.subtitle ? `<p class="lesson__sub">${esc(sec.subtitle)}</p>` : ''}
        </header>
        <div class="lesson__body">${sec.content.map(renderBlock).join('')}</div>
        <div class="lesson__boxes">${memory}${trap}${laws}</div>
        <div id="checkpoint">${renderCheckpoint(sec)}</div>
        <footer class="lesson__foot">
          <button class="btn btn--ghost" data-action="learn-prev" ${ui.learnIdx === 0 ? 'disabled' : ''}>${I.back} Zurück</button>
          <button class="btn ${done ? 'btn--done' : 'btn--primary'}" data-action="learn-toggle" aria-pressed="${done}" ${!done && !p.checksDone.includes(sec.checkId) ? 'disabled title="Erst den Checkpoint schaffen"' : ''}>${done ? 'VERSTANDEN ✓' : 'VERSTANDEN ✓ markieren'}</button>
          <button class="btn btn--ghost" data-action="learn-next" ${ui.learnIdx >= learn.sections.length - 1 ? 'disabled' : ''}>Weiter ${I.next}</button>
        </footer>
      </article>
    </div>`;
}

function pickRecoveryQuestion(sec, tried = []) {
  const pool = Content.getCachedChapter(ui.chapterId)?.questions?.questions || [];
  const triedSet = new Set(tried);
  const fresh = (list) => list.filter((q) => !triedSet.has(q.id));
  const choices = [
    fresh(pool.filter((q) => q.section === sec.id && (q.difficulty || 1) === 1)),
    fresh(pool.filter((q) => (q.difficulty || 1) === 1)),
    fresh(pool.filter((q) => q.section === sec.id && (q.difficulty || 1) <= 2)),
    pool.filter((q) => (q.difficulty || 1) === 1),
  ].find((x) => x.length) || [];
  return choices.length ? choices[Math.floor(Math.random() * choices.length)] : null;
}

function renderCheckpoint(sec) {
  const data = Content.getCachedChapter(ui.chapterId);
  const base = data?.questions?.questions.find((q) => q.id === sec.checkId);
  if (!base) return '';
  const p = prog(ui.chapterId);
  const alreadySolved = p.checksDone.includes(base.id);
  if (!ui.check || ui.check.checkpointId !== base.id) {
    const prepared = prepareQuestion(base, S().settings.shuffleAnswers);
    ui.check = {
      checkpointId: base.id, qid: base.id, q: prepared,
      selected: alreadySolved ? [...prepared.correct] : [], done: alreadySolved, ok: alreadySolved,
      recovery: false, tried: [base.id], message: '',
    };
  }
  const c = ui.check;
  const solved = p.checksDone.includes(c.checkpointId);
  const answers = c.q.answers.map((a, i) => {
    let cls = '';
    if (c.done) cls = c.q.correct.includes(i) ? (c.selected.includes(i) || c.ok ? 'is-correct' : 'is-missed') : c.selected.includes(i) ? 'is-wrong' : 'is-dim';
    else if (c.selected.includes(i)) cls = 'is-selected';
    return `<li><button class="answer answer--sm ${cls}" data-action="check-pick" data-i="${i}" ${c.done ? 'disabled' : ''}><span class="answer__key">${String.fromCharCode(65 + i)}</span><span>${esc(a)}</span></button></li>`;
  }).join('');
  const reward = c.recovery ? '+5 HP bei richtig' : solved ? 'geschafft ✓' : '+10 XP';
  const rescue = c.recovery ? `<p class="checkpoint__rescue">🩹 Rettungsfrage · ${esc(c.message || 'Schaffst du sie, bekommst du 5 HP zurück.')}</p>` : '';
  return `<section class="checkpoint ${c.recovery ? 'checkpoint--rescue' : ''}" aria-label="Checkpoint">
    <header><h2>${c.recovery ? 'Rettungsfrage' : 'Checkpoint'}</h2><span>${reward}</span></header>
    ${rescue}
    <p class="checkpoint__q">${esc(c.q.question)}</p>
    ${c.q.type === 'multi' ? '<p class="qhint">Mehrere Antworten richtig – wähle alle.</p>' : ''}
    <ol class="answers answers--sm">${answers}</ol>
    ${c.done
      ? `<p class="feedback ${c.ok ? 'feedback--ok' : 'feedback--bad'}"><strong>${c.ok ? 'Richtig.' : 'Nicht ganz.'}</strong> ${esc(c.q.explanation)}</p>`
      : c.q.type === 'multi' ? `<button class="btn btn--primary btn--sm" data-action="check-submit" ${c.selected.length ? '' : 'disabled'}>Prüfen</button>` : ''}
  </section>`;
}

function checkPick(i) {
  const c = ui.check;
  if (!c || c.done) return;
  if (c.q.type === 'single') { c.selected = [i]; checkSubmit(); return; }
  c.selected = c.selected.includes(i) ? c.selected.filter((x) => x !== i) : [...c.selected, i];
  $('checkpoint').innerHTML = renderCheckpoint(Content.getCachedChapter(ui.chapterId).learn.sections[ui.learnIdx]);
}

function checkSubmit() {
  const c = ui.check;
  if (!c || c.done || !c.selected.length) return;
  const sec = Content.getCachedChapter(ui.chapterId).learn.sections[ui.learnIdx];
  c.done = true;
  c.ok = c.q.correct.length === c.selected.length && c.q.correct.every((x) => c.selected.includes(x));
  const p = prog(ui.chapterId);
  sfx(c.ok ? 'ok' : 'bad');
  touchDay();

  if (c.ok) {
    if (!p.checksDone.includes(c.checkpointId)) p.checksDone.push(c.checkpointId);
    if (c.recovery) {
      healHp(5, 'Rettungsfrage');
    } else {
      addXp(10);
    }
    maybeDropReward(c.q);
    persist();
    $('checkpoint').innerHTML = renderCheckpoint(sec);
    renderLearn();
    return;
  }

  // Die erste falsche Checkpoint-Antwort kostet 10 HP. Danach kommt statt eines direkten Retries
  // eine neue, leichte Rettungsfrage. Weitere Fehlversuche kosten nicht nochmals HP.
  if (!c.recovery) damageHp(10, 'Checkpoint verfehlt');
  const tried = [...new Set([...(c.tried || []), c.qid])];
  const replacement = pickRecoveryQuestion(sec, tried);
  if (replacement) {
    ui.check = {
      checkpointId: c.checkpointId,
      qid: replacement.id,
      q: prepareQuestion(replacement, S().settings.shuffleAnswers),
      selected: [], done: false, ok: false, recovery: true,
      tried: [...tried, replacement.id],
      message: c.recovery ? 'Noch einmal – kein zusätzlicher HP-Abzug.' : '−10 HP. Diese einfache Ersatzfrage kann dir 5 HP zurückgeben.',
    };
  } else {
    c.done = false;
    c.selected = [];
    c.recovery = true;
    c.message = 'Keine weitere Ersatzfrage verfügbar – versuche diese Frage erneut. Kein zusätzlicher HP-Abzug.';
  }
  persist();
  renderLearn();
}

function learnToggle() {
  const id = ui.chapterId;
  const learn = Content.getCachedChapter(id).learn;
  const sec = learn.sections[ui.learnIdx];
  const p = prog(id);
  const i = p.learnCompleted.indexOf(sec.id);
  if (i >= 0) {
    p.learnCompleted.splice(i, 1);
    renderLearn();
    persist();
    return;
  }
  if (sec.checkId && !p.checksDone.includes(sec.checkId)) {
    toast('Schaffe zuerst den Checkpoint dieses Abschnitts.', { icon: '🧠' });
    return;
  }
  p.learnCompleted.push(sec.id);
  sfx('ok');
  touchDay();
  if (!p.learnXp.includes(sec.id)) { p.learnXp.push(sec.id); addXp(20); }
  const st = chapterStatus(id);
  if (st.learnDone) {
    unlock('scholar');
    checkMastery(id);
    toast('Lernskript komplett verstanden – jetzt ab in den Storymode!', { icon: '📘', tone: 'gold' });
    confetti(80);
  }
  persist();
  // Weiter zum nächsten offenen Abschnitt
  const nextOpen = learn.sections.findIndex((s, k) => k > ui.learnIdx && !p.learnCompleted.includes(s.id));
  if (nextOpen >= 0) { ui.learnIdx = nextOpen; ui.check = null; renderLearn(); window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); }
  else renderLearn();
}

function learnGo(idx) {
  const n = Content.getCachedChapter(ui.chapterId).learn.sections.length;
  ui.learnIdx = Math.max(0, Math.min(n - 1, idx));
  ui.check = null;
  renderLearn();
  window.scrollTo({ top: 0 });
}

/* =========================================================
   5 · Run: Story, Versus, Boss
   ========================================================= */

async function startMode(modeId, chapterId) {
  const mode = MODES[modeId];
  if (!mode) return;
  if (playerVitals().hp <= 0) { toast('Du hast 0 HP. Nutze im Dashboard einen Heiltrank oder arbeite im Lernskript weiter.', { icon: '💔', tone: 'bad', ms: 4500 }); return; }
  clearRunTimers();
  await Content.loadChapterContent(chapterId);
  const data = Content.getCachedChapter(chapterId);
  const poolData = mode.source === 'boss' ? data?.boss : data?.questions;
  if (!poolData?.questions?.length) { toast('Für diesen Modus fehlen die Fragen.', { icon: '⚠️', tone: 'bad' }); return; }
  if (modeId === 'boss' && BOSS_REQUIRES_STORY && !prog(chapterId).storyWins) { toast('Der Bossfight ist noch gesperrt. Gewinne zuerst den Storymode.', { icon: '🔒' }); return; }

  const p = prog(chapterId);
  const picked = selectQuestions(modeId, poolData.questions, { recent: lastQ(chapterId)[modeId], mistakes: p.mistakes });
  const prepared = picked.map((q) => prepareQuestion(q, S().settings.shuffleAnswers));
  ui.chapterId = chapterId;
  ui.run = new Run(modeId, chapterId, prepared);
  ui.run.bossInfo = data?.boss?.boss || { name: 'Level-Boss', title: '' };
  ui.newAchievements = [];
  touchDay();
  showScreen('run');
  renderRun();
}

function sealSvg(damage) {
  // Wachssiegel mit Zackenrand; Risse werden mit dem Schaden sichtbar
  const pts = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const r = i % 2 ? 44 : 49;
    pts.push(`${(50 + r * Math.cos(a)).toFixed(1)},${(50 + r * Math.sin(a)).toFixed(1)}`);
  }
  const cracks = [
    'M50 14 L46 30 L54 38 L48 48',
    'M84 58 L68 55 L62 64 L52 60',
    'M22 72 L36 64 L34 54 L44 52',
    'M70 20 L62 34 L66 42',
    'M30 22 L38 34 L32 42',
  ];
  return `<svg class="seal" viewBox="0 0 100 100" aria-hidden="true">
    <polygon points="${pts.join(' ')}" class="seal__edge"/>
    <circle cx="50" cy="50" r="36" class="seal__face"/>
    <circle cx="50" cy="50" r="30" class="seal__ring"/>
    <text x="50" y="63" text-anchor="middle" class="seal__glyph">§</text>
    ${cracks.map((d, i) => `<path d="${d}" class="seal__crack ${i < damage ? 'is-on' : ''}"/>`).join('')}
  </svg>`;
}

function renderRun() {
  const run = ui.run;
  if (!run) return;
  const q = run.current;
  const isBoss = run.mode.id === 'boss';
  ui.selected = [];
  ui.answered = false;

  const pips = run.questions.map((_, i) => {
    const r = run.results[i];
    const cls = r ? (r.correct ? 'is-ok' : 'is-bad') : i === run.idx ? 'is-now' : '';
    return `<li class="${cls}"></li>`;
  }).join('');
  const hearts = Array.from({ length: run.mode.lives }, (_, i) => `<span class="heart ${i < run.lives ? '' : 'is-lost'}">${I.heart}</span>`).join('');
  const hits = run.correctCount;
  const hp = Array.from({ length: run.total }, (_, i) => `<span class="${i < run.total - hits ? '' : 'is-gone'}"></span>`).join('');

  $('runView').innerHTML = `
    <div class="run run--${run.mode.id}">
      <div class="hud">
        <button class="back back--hud" data-action="abort-run">${I.back} Aufgeben</button>
        <span class="hud__mode">${esc(run.mode.label)} <small>${esc(levelLabel(run.chapterId))}</small></span>
        <ol class="pips" aria-label="Frage ${run.idx + 1} von ${run.total}">${pips}</ol>
        <span class="hud__lives" aria-label="${run.lives} Leben">${hearts}</span>
        <span class="hud__score"><small>Punkte</small> <b id="hudScore">${run.score}</b></span>
        <span class="hud__combo ${run.combo >= 2 ? 'is-hot' : ''}" id="hudCombo">${run.combo >= 2 ? `${I.flame} ${run.combo}er-Serie` : ''}</span>
      </div>
      ${isBoss ? `
      <div class="arena">
        <div class="arena__boss" id="bossSeal">${sealSvg(Math.round((hits / run.total) * 5))}</div>
        <div class="arena__info">
          <p class="arena__name">${esc(run.bossInfo.name)}</p>
          <p class="arena__title">${esc(run.bossInfo.title || '')}</p>
          <div class="hp" aria-label="Boss-Lebensleiste: ${run.total - hits} von ${run.total}">${hp}</div>
        </div>
        <div class="timer" aria-hidden="true"><span class="timer__num" id="timerNum">${run.mode.seconds}</span><span class="timer__bar"><span id="timerBar"></span></span></div>
      </div>` : ''}
      <section class="qcard" aria-live="polite">
        <p class="qcard__meta">
          <span>Frage ${run.idx + 1}/${run.total}</span>
          <span class="chip chip--soft">${esc(Array.isArray(q.topic) ? q.topic.join(' + ') : q.topic || '')}</span>
          ${q.type === 'multi' ? '<span class="chip chip--multi">Mehrere richtig</span>' : ''}
        </p>
        <h2 class="qcard__q">${esc(q.question)}</h2>
        ${q.type === 'multi' ? '<p class="qhint">Wähle alle richtigen Antworten und bestätige mit „Prüfen“.</p>' : ''}
        <ol class="answers" id="answers">
          ${q.answers.map((a, i) => `<li><button class="answer" data-action="answer" data-i="${i}"><span class="answer__key">${String.fromCharCode(65 + i)}</span><span>${esc(a)}</span></button></li>`).join('')}
        </ol>
        <div class="qcard__foot" id="qfoot">
          ${!isBoss || q.type === 'multi' ? `<button class="btn btn--primary" id="btnSubmit" data-action="submit" disabled>Prüfen</button>` : '<p class="qhint">Klick auf die Antwort zählt sofort.</p>'}
        </div>
      </section>
    </div>`;

  if (isBoss) {
    let lastSec = run.mode.seconds;
    countdown.start(run.mode.seconds, (sec, frac) => {
      const bar = $('timerBar');
      const num = $('timerNum');
      if (bar) { bar.style.transform = `scaleX(${frac})`; bar.parentElement.classList.toggle('is-low', sec <= 3); }
      const whole = Math.ceil(sec);
      if (num) num.textContent = whole;
      if (whole < lastSec) { lastSec = whole; if (whole <= 3 && whole > 0) sfx('tick'); }
    }, () => submitAnswer(true));
  }
}

function pickAnswer(i) {
  const run = ui.run;
  if (!run || ui.answered) return;
  const q = run.current;
  if (i < 0 || i >= q.answers.length) return;
  if (q.type === 'single') {
    ui.selected = [i];
    if (run.mode.id === 'boss') { submitAnswer(false); return; }
  } else {
    ui.selected = ui.selected.includes(i) ? ui.selected.filter((x) => x !== i) : [...ui.selected, i];
  }
  sfx('click');
  document.querySelectorAll('#answers .answer').forEach((b, k) => b.classList.toggle('is-selected', ui.selected.includes(k)));
  const btn = $('btnSubmit');
  if (btn) btn.disabled = ui.selected.length === 0;
}

function submitAnswer(timedOut = false) {
  const run = ui.run;
  if (!run || ui.answered) return;
  if (!timedOut && ui.selected.length === 0) return;
  ui.answered = true;
  const secondsLeft = countdown.secondsLeft();
  countdown.stop();
  const q = run.current;
  const res = run.answer(ui.selected, { timedOut, secondsLeft });
  const submitBtn = $('btnSubmit');
  if (submitBtn) submitBtn.hidden = true;
  const st = S();
  const p = prog(run.chapterId);

  // Statistik & Fehlerspeicher (fließt in die Versus-Gewichtung ein)
  st.player.answered += 1;
  if (res.correct) {
    st.player.correct += 1;
    if (p.mistakes[q.id]) { p.mistakes[q.id] -= 1; if (!p.mistakes[q.id]) delete p.mistakes[q.id]; }
    unlock('first_hit');
    if (run.combo >= 5) unlock('combo_5');
    if (run.combo >= 10) unlock('combo_10');
    if (run.mode.id === 'boss' && run.mode.seconds - secondsLeft < 3) unlock('quick_draw');
    maybeDropReward(q);
  } else {
    p.mistakes[q.id] = Math.min(9, (p.mistakes[q.id] || 0) + 1);
  }
  st.player.bestCombo = Math.max(st.player.bestCombo, run.bestCombo);

  // Antworten markieren
  document.querySelectorAll('#answers .answer').forEach((b, k) => {
    b.disabled = true;
    b.classList.remove('is-selected');
    if (q.correct.includes(k)) b.classList.add(ui.selected.includes(k) || res.correct ? 'is-correct' : 'is-missed');
    else if (ui.selected.includes(k)) b.classList.add('is-wrong');
    else b.classList.add('is-dim');
  });
  const score = $('hudScore'); if (score) score.textContent = run.score;
  const combo = $('hudCombo');
  if (combo) { combo.className = `hud__combo ${run.combo >= 2 ? 'is-hot' : ''}`; combo.innerHTML = run.combo >= 2 ? `${I.flame} ${run.combo}er-Serie` : ''; }
  document.querySelectorAll('.hud__lives .heart').forEach((h, k) => h.classList.toggle('is-lost', k >= run.lives));
  const pips = document.querySelectorAll('.pips li');
  if (pips[run.idx]) pips[run.idx].className = res.correct ? 'is-ok' : 'is-bad';

  const shell = document.querySelector('.run');
  if (res.correct) {
    sfx('ok');
    shell?.classList.add('fx-hit');
  } else {
    sfx('bad');
    shell?.classList.add('fx-shake');
  }

  if (run.mode.id === 'boss') {
    const hits = run.correctCount;
    const seal = $('bossSeal');
    if (seal && res.correct) { seal.innerHTML = sealSvg(Math.round((hits / run.total) * 5)); seal.classList.add('is-hit'); }
    document.querySelectorAll('.hp span').forEach((s, k) => s.classList.toggle('is-gone', k >= run.total - hits));
    flash(res.correct ? 'Treffer!' : timedOut ? 'Zeit um!' : 'Autsch!', res.correct ? 'ok' : 'bad');
    // Kein Weiter-Button: kurz Lösung zeigen, dann sofort weiter
    later(() => advance(), res.correct ? 520 : 680);
    return;
  }

  $('qfoot').innerHTML = `
    <div class="feedback ${res.correct ? 'feedback--ok' : 'feedback--bad'}" role="status">
      <strong>${res.correct ? `Richtig! +${res.gainedScore}` : 'Falsch.'}</strong> ${esc(q.explanation)}
    </div>
    <button class="btn btn--primary" id="btnNext" data-action="next-question">${res.finished ? 'Zur Auswertung' : 'Nächste Frage'} ${I.next}</button>`;
  $('btnNext')?.focus({ preventScroll: true });
}

function advance() {
  const run = ui.run;
  if (!run) return;
  if (run.finished) { finishRun(); return; }
  run.next();
  renderRun();
  window.scrollTo({ top: 0 });
}

function finishRun() {
  const run = ui.run;
  if (!run) return;
  clearRunTimers();
  const sum = run.summary();
  const id = run.chapterId;
  const p = prog(id);
  const m = run.mode.id;
  let hpEvent = null;
  let levelCompletedNow = false;
  let levelReset = false;

  if (m === 'story') { p.bestStory = Math.max(p.bestStory, sum.score); if (sum.won) p.storyWins += 1; }
  if (m === 'versus') { p.bestVersus = Math.max(p.bestVersus, sum.score); if (sum.won) p.versusWins += 1; }
  if (m === 'boss') { p.bestBoss = Math.max(p.bestBoss, sum.score); if (sum.won) p.bossWins += 1; }
  p.stars[m] = Math.max(p.stars[m], sum.stars);
  lastQ(id)[m] = run.questions.map((q) => q.id);

  if (sum.won) {
    if (m === 'story') { unlock('story_win'); if (sum.stars === 3) unlock('story_perfect'); }
    if (m === 'versus') unlock('versus_win');
    if (m === 'boss') { unlock('boss_slayer'); if (sum.stars === 3) unlock('boss_perfect'); }
    levelCompletedNow = checkMastery(id);
  } else {
    const loss = MODE_HP_LOSS[m] || 0;
    hpEvent = damageHp(Math.round(playerVitals().maxHp * (loss / 100)), `${run.mode.label} verloren`);
    levelReset = resetLevelModesAfterLoss(id);
    if (levelReset) toast('Level fehlgeschlagen – die Spielmodi starten wieder von vorn.', { icon: '↩️', tone: 'bad', ms: 4300 });
  }
  addXp(sum.xp);
  persist();

  ui.result = { sum, run, hpEvent, levelCompletedNow, levelReset };
  ui.run = null;
  renderResult();
  showScreen('result');
  if (sum.won) { sfx('win'); confetti(m === 'boss' ? 200 : 130); } else sfx('lose');
}

function abortRun(silent = false) {
  if (!ui.run) return true;
  if (!silent && !confirm('Run wirklich aufgeben? Fortschritt dieses Runs geht verloren.')) return false;
  clearRunTimers();
  lastQ(ui.run.chapterId)[ui.run.mode.id] = ui.run.questions.map((q) => q.id);
  ui.run = null;
  persist();
  return true;
}

/* =========================================================
   6 · Ergebnis
   ========================================================= */

function answerText(q, idxs) {
  if (!idxs.length) return '–';
  return idxs.map((i) => q.answers[i]).map(esc).join('<br>');
}

function renderResult() {
  const { sum, run, hpEvent, levelCompletedNow, levelReset } = ui.result;
  const boss = run.bossInfo?.name || 'Der Boss';
  const titles = {
    story: sum.won ? 'Story geschafft!' : 'Story verloren',
    versus: sum.won ? 'Duell gewonnen!' : 'Duell verloren',
    boss: sum.won ? `${boss} besiegt!` : `${boss} war stärker`,
  };
  const sub = levelCompletedNow
    ? `${levelLabel(run.chapterId)} komplett abgeschlossen. Deine HP wurden vollständig aufgefüllt.`
    : sum.won
      ? (sum.stars === 3 ? 'Ohne einen einzigen Fehler. Stark.' : 'Geschafft – mit etwas Luft nach oben.')
      : levelReset
        ? `Run verloren. Die Spielmodi dieses Levels wurden zurückgesetzt – du startest den Level-Run wieder von vorn.`
        : `Run verloren. Beim nächsten Versuch startet ${run.mode.label} wieder bei Frage 1.`;
  const hpNote = hpEvent
    ? (hpEvent.revived ? `✨ Lebensfunke verbraucht: Wiederbelebung mit voller HP.` : `💔 ${MODE_HP_LOSS[sum.mode]} % Max-HP verloren. Aktuell ${playerVitals().hp}/${playerVitals().maxHp} HP.`)
    : '';
  const achievements = ui.newAchievements.length
    ? `<ul class="newbadges">${ui.newAchievements.map((a) => `<li><span>${a.icon}</span><b>${esc(a.title)}</b><small>${esc(a.text)}</small></li>`).join('')}</ul>` : '';

  const review = run.results.map((r, k) => {
    const q = r.question;
    return `<li class="review__item ${r.correct ? 'is-ok' : 'is-bad'}">
      <details ${r.correct ? '' : 'open'}>
        <summary><span class="review__n">${k + 1}</span><span class="review__q">${esc(q.question)}</span><span class="review__tag">${r.correct ? 'richtig' : r.timedOut ? 'Zeit' : 'falsch'}</span></summary>
        <div class="review__body">
          ${r.correct ? '' : `<p><small>Deine Antwort</small>${answerText(q, r.selected)}</p>`}
          <p><small>Richtig</small>${answerText(q, q.correct)}</p>
          <p class="review__exp">${esc(q.explanation)}</p>
          ${q.section ? `<button class="linkbtn" data-action="open-learn" data-id="${esc(run.chapterId)}" data-section="${esc(q.section)}">Im Lernskript nachlesen</button>` : ''}
        </div>
      </details>
    </li>`;
  }).join('');

  $('resultView').innerHTML = `
    <div class="result ${sum.won ? 'result--win' : 'result--lose'} result--${sum.mode}">
      <header class="result__head">
        ${stars(sum.stars, 'stars--big')}
        <h1>${esc(titles[sum.mode])}</h1>
        <p>${sub}</p>${hpNote ? `<p class="result__hpnote">${esc(hpNote)}</p>` : ''}
      </header>
      <dl class="result__stats">
        <div><dt>Richtig</dt><dd>${sum.correct}/${sum.answered}</dd></div>
        <div><dt>Punkte</dt><dd>${sum.score}</dd></div>
        <div><dt>Beste Serie</dt><dd>${sum.bestCombo}</dd></div>
        <div class="is-xp"><dt>Erfahrung</dt><dd>+${sum.xp} XP</dd></div>
        <div class="is-hp"><dt>HP</dt><dd>${playerVitals().hp}/${playerVitals().maxHp}</dd></div>
      </dl>
      ${achievements}
      <div class="result__actions">
        <button class="btn btn--primary btn--xl" data-action="start-mode" data-mode="${sum.mode}" data-id="${esc(run.chapterId)}">Nochmal spielen</button>
        <button class="btn btn--ghost btn--xl" data-action="back-chapter">Zum Level</button>
      </div>
      <section class="review">
        <h2>Nachbesprechung</h2>
        <ol>${review}</ol>
      </section>
    </div>`;
}

/* =========================================================
   Ereignisse
   ========================================================= */

const ACTIONS = {
  'save-new': () => withBusy(() => saveActions.new().catch(saveErrorToTerminal)),
  'save-load': () => withBusy(() => saveActions.load().catch(saveErrorToTerminal)),
  'save-resume': () => withBusy(() => saveActions.resume().catch(saveErrorToTerminal)),
  'save-guest': () => withBusy(() => saveActions.guest()),
  'grant-write': async () => { if (await save.grantWrite()) toast('Speichern ist wieder aktiv.', { icon: '💾' }); },
  'toggle-sound': () => { S().settings.sound = !S().settings.sound; renderHeader(); persist(); },
  'use-potion': (d) => usePotion(d.kind),
  'go-dashboard': () => { if (ui.screen === 'terminal') return; if (!abortRun()) return; renderDashboard(); showScreen('dashboard'); },
  'open-chapter': (d) => openChapter(d.id),
  'back-chapter': () => { if (!abortRun()) return; openChapter(ui.chapterId); },
  'open-learn': (d) => { if (!abortRun()) return; openLearn(d.id, d.section); },
  'learn-goto': (d) => learnGo(Number(d.idx)),
  'learn-prev': () => learnGo(ui.learnIdx - 1),
  'learn-next': () => learnGo(ui.learnIdx + 1),
  'learn-toggle': () => learnToggle(),
  'check-pick': (d) => checkPick(Number(d.i)),
  'check-submit': () => checkSubmit(),
  'check-retry': () => { ui.check = null; $('checkpoint').innerHTML = renderCheckpoint(Content.getCachedChapter(ui.chapterId).learn.sections[ui.learnIdx]); },
  'start-mode': (d) => startMode(d.mode, d.id),
  'answer': (d) => pickAnswer(Number(d.i)),
  'submit': () => submitAnswer(false),
  'next-question': () => advance(),
  'abort-run': () => { const id = ui.run?.chapterId; if (abortRun()) openChapter(id); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  fn({ ...el.dataset }, el); // nur die Daten-Attribute, nie das Event-Objekt
});

document.addEventListener('keydown', (e) => {
  if (ui.screen !== 'run' || !ui.run || e.altKey || e.ctrlKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  const map = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, a: 0, b: 1, c: 2, d: 3, e: 4 };
  if (k in map && !ui.answered) { e.preventDefault(); pickAnswer(map[k]); return; }
  if (k === 'enter') {
    if (!ui.answered && ui.selected.length) { e.preventDefault(); submitAnswer(false); }
    else if (ui.answered && ui.run.mode.id !== 'boss' && document.activeElement?.id !== 'btnNext') { e.preventDefault(); advance(); }
  }
});

// Timer stoppen, wenn die Seite verlassen wird
window.addEventListener('pagehide', () => clearRunTimers());
window.addEventListener('beforeunload', (e) => {
  if (save.writing || (save.dirty && save.canWrite)) { e.preventDefault(); e.returnValue = ''; }
});

// Effekt-Klassen nach der Animation wieder entfernen
document.addEventListener('animationend', (e) => {
  const t = e.target;
  if (t.classList?.contains('fx-hit') || t.classList?.contains('fx-shake')) t.classList.remove('fx-hit', 'fx-shake');
  if (t.classList?.contains('is-hit')) t.classList.remove('is-hit');
});

/* =========================================================
   Service Worker & Start
   ========================================================= */

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (worker) => toast('Eine neue Version von 34i-Quest ist bereit.', {
      icon: '✨', ms: 0,
      action: { label: 'Jetzt laden', run: async () => { await save.flush(); worker.postMessage({ type: 'SKIP_WAITING' }); } },
    });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
  }).catch((err) => console.warn('[sw] Registrierung fehlgeschlagen', err));
}

// Testhaken nur im Demo-Link (#demo)
if (location.hash === '#demo') window.__quest = { ui, save };

registerSW();
bootTerminal();
