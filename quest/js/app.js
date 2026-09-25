/* 34i-Quest – App: Screens, Rendering, Spielfluss, Effekte */

import * as Content from './content-loader.js';
import { SaveGame, SaveError, isSupported, createChapterProgress, SAVE_NAME } from './savegame.js';
import { MODES, BOSS_REQUIRES_STORY, MAX_HP, MODE_HP_LOSS, POTIONS, rollQuestionReward, selectQuestions, prepareQuestion, Run, rankFor, ACHIEVEMENTS, Countdown,
  RESCUE_HEAL, BOSS_CRIT_SECONDS, BOSS_FOCUS_SECONDS, DAILY_FOCUS_GIFT, BOSS_CHEST_POTION_CHANCE, BOSS_TAUNTS,
  COIN_REWARDS, COIN_LEVEL_COMPLETE, SHOP, coinsForWin, BATTLE_ITEMS, BATTLE_ITEM_ORDER, carouselOrder, carouselChest,
  HERO_CLASSES, HERO_CLASS_ORDER, heroClass } from './game.js';
import * as Audio from './audio.js';

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
  if (!Number.isFinite(pl.coins) || pl.coins < 0) pl.coins = 0;
  return pl;
}

const COIN_IMG = '<img class="coin" src="assets/coin.webp" alt="" width="20" height="20">';

/* ---------- Charakterklasse ---------- */
const cls = () => heroClass(playerVitals().heroClass);
/** Preis eines Shop-Artikels inkl. Klassenrabatt (Sparfuchs) */
const priceOf = (kind) => Math.max(1, Math.round((SHOP[kind]?.price || 0) * cls().priceMult));
/** Coins für den Level-Abschluss inkl. Klassenbonus (Sammler) */
const levelCoins = () => COIN_LEVEL_COMPLETE * cls().coinMult;

function addCoins(n, label = '') {
  if (!n) return 0;
  const pl = playerVitals();
  pl.coins += n;
  if (pl.coins >= 500) unlock('rich');
  sfx('coin');
  if (label) toast(`+${n} Quest-Coins · ${label}`, { icon: '🪙', tone: 'gold' });
  const chip = $('coinChip');
  if (chip) { chip.classList.remove('is-gain'); void chip.offsetWidth; chip.classList.add('is-gain'); }
  renderHeader();
  return n;
}

function buyItem(kind) {
  const item = POTIONS[kind] || BATTLE_ITEMS[kind];
  const offer = SHOP[kind];
  const pl = playerVitals();
  if (!item || !offer) return;
  if (offer.max && (pl.inventory[kind] || 0) >= offer.max) { toast(`Mehr als ${offer.max} ${item.label} kannst du nicht tragen.`, { icon: item.icon }); return; }
  const price = priceOf(kind);
  if (pl.coins < price) { toast(`Dir fehlen ${price - pl.coins} Quest-Coins.`, { icon: '🪙', tone: 'bad' }); return; }
  pl.coins -= price;
  pl.inventory[kind] = (pl.inventory[kind] || 0) + 1;
  unlock('shopper');
  sfx('spend');
  toast(`${item.label} gekauft (−${price} Coins)`, { icon: item.icon, tone: 'gold' });
  persist();
  rerenderCurrent();
}

function healHp(amount, label = 'Heilung', { quiet = false } = {}) {
  const pl = playerVitals();
  const before = pl.hp;
  pl.hp = Math.min(pl.maxHp, pl.hp + Math.max(0, amount));
  const gained = pl.hp - before;
  if (gained > 0 && !quiet) toast(`${label}: +${gained} HP`, { icon: '❤️', tone: 'gold' });
  if (gained > 0) pulseHp('heal');
  renderHeader();
  return gained;
}

function damageHp(amount, label = 'Schaden', { quiet = false } = {}) {
  const pl = playerVitals();
  const before = pl.hp;
  pl.hp = Math.max(0, pl.hp - Math.max(0, amount));
  const lost = before - pl.hp;
  let revived = false;
  // Der Lebensfunke greift nur, wenn die HP gerade eben auf 0 gefallen sind
  if (pl.hp <= 0 && before > 0 && pl.inventory.spark > 0) {
    pl.inventory.spark -= 1;
    pl.hp = pl.maxHp;
    revived = true;
    unlock('revived');
    toast('Lebensfunke aktiviert – volle HP!', { icon: POTIONS.spark.icon, tone: 'gold', ms: 5000 });
    sfx('level');
    confetti(70);
  } else if (lost > 0 && !quiet) {
    toast(`${label}: −${lost} HP`, { icon: '💔', tone: 'bad', ms: 3600 });
  }
  if (lost > 0) pulseHp(revived ? 'heal' : 'hurt');
  if (lost > 0 && !revived) sfx('hurt');
  renderHeader();
  return { lost, revived, hp: pl.hp, knockout: pl.hp <= 0 };
}

function usePotion(kind) {
  const item = POTIONS[kind];
  const pl = playerVitals();
  if (!item || kind === 'spark') return;
  if ((pl.inventory[kind] || 0) <= 0) { toast(`${item.label}: keiner im Inventar.`, { icon: item.icon }); return; }
  if (pl.hp >= pl.maxHp) { toast('Deine HP sind bereits voll.', { icon: '❤️' }); return; }
  pl.inventory[kind] -= 1;
  healHp(item.heal, item.label);
  sfx('gulp');
  persist();
  rerenderCurrent();
}

function maybeDropReward(question) {
  const item = rollQuestionReward(question, Math.random, cls().luck);
  if (!item) return null;
  const pl = playerVitals();
  pl.inventory[item.id] = (pl.inventory[item.id] || 0) + 1;
  unlock(item.id === 'spark' ? 'spark' : 'loot');
  if (ui.run) {
    // Im Run keine Toasts – sie würden Antworten verdecken. Die Beute erscheint im HUD und in der Auswertung.
    ui.run.loot = [...(ui.run.loot || []), item.id];
  } else {
    toast(`${item.icon} Gefunden: ${item.label}`, { icon: item.icon, tone: 'gold', ms: item.id === 'spark' ? 5200 : 3000 });
  }
  renderHeader();
  return item;
}

/** HP-Anzeige kurz aufleuchten lassen */
function pulseHp(kind) {
  const chip = $('hpChip');
  if (!chip) return;
  chip.classList.remove('is-hurt', 'is-heal');
  void chip.offsetWidth;
  chip.classList.add(kind === 'heal' ? 'is-heal' : 'is-hurt');
}

/** Den aktuell sichtbaren Screen neu zeichnen (z. B. nach dem Trinken eines Tranks) */
function rerenderCurrent() {
  renderHeader();
  if (ui.screen === 'dashboard') renderDashboard();
  else if (ui.screen === 'chapter') renderChapter();
  else if (ui.screen === 'result' && ui.result) renderResult();
}

/** Alte Abschnitts-IDs auf neue umschreiben, sobald ein überarbeitetes Lernskript geladen ist */
function migrateLegacySections(id) {
  const learn = Content.getCachedChapter(id)?.learn;
  const p = S()?.progress?.[id];
  if (!learn || !p) return false;
  let changed = false;
  for (const key of ['learnCompleted', 'learnXp']) {
    const have = new Set(p[key]);
    learn.sections.forEach((sec) => {
      if (!have.has(sec.id) && (sec.legacyIds || []).some((old) => have.has(old))) { have.add(sec.id); changed = true; }
    });
    const valid = new Set(learn.sections.map((s) => s.id));
    const next = [...have].filter((x) => valid.has(x));
    if (next.length !== p[key].length) changed = true;
    p[key] = next;
  }
  return changed;
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
  $('topbar').hidden = name === 'terminal' || name === 'onboard';
  document.body.dataset.view = name;
  ui.screen = name;
  syncMusic();
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
  crown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4.5L12 5l4.5 7.5L21 8l-2 11H5z"/><path d="M5 19h14"/></svg>',
  carousel: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v3"/><path d="M3.5 9L12 5l8.5 4z"/><path d="M6 9v8M12 9v8M18 9v8"/><path d="M4 17h16"/><path d="M12 17v4M8 21h8"/></svg>',
};

/* =========================================================
   Sound (WebAudio, kein Asset nötig)
   ========================================================= */

let audio = null;
function sfx(kind) {
  if (!S() || !S().settings.sound) return;
  Audio.sfx(kind);
}

/** Musik passend zum Bildschirm: ruhig im Menü, Abenteuer in den Runs, Kampf im Boss */
function musicFor(screen) {
  if (screen === 'terminal') return null;
  if (screen === 'run' && ui.run) return ui.run.mode.id === 'boss' ? 'boss' : 'quest';
  return 'calm';
}
function syncMusic() {
  if (!S()) return;
  Audio.setSfxEnabled(S().settings.sound);
  Audio.setMusicEnabled(S().settings.music !== false);
  Audio.setTrack(musicFor(ui.screen));
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

function clearToasts() {
  const box = $('toasts');
  if (box) box.innerHTML = '';
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

/** Einmal pro Kalendertag: Fokus geschenkt, sobald der Spielstand geöffnet wird */
/** Tages-Fokus: 1 (Normalo 2) kostenlose Einsätze pro Kalendertag. Nicht stapelbar – Ungenutztes verfällt. */
function grantDailyGift() {
  const pl = playerVitals();
  if (!pl.heroClass) return false;
  const today = todayKey();
  if (pl.dailyFocus?.day === today) return false;
  pl.dailyFocus = { day: today, left: cls().dailyFocus };
  toast(`Tagesgeschenk: ${pl.dailyFocus.left}× Fokus gratis (+${BOSS_FOCUS_SECONDS} s im Boss) – gilt nur heute`, { icon: '🎁', tone: 'gold', ms: 5000 });
  persist();
  return true;
}
function dailyFocusLeft() {
  const pl = playerVitals();
  return pl.dailyFocus?.day === todayKey() ? (pl.dailyFocus.left || 0) : 0;
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
  addCoins(levelCoins());
  unlock('master');
  toast(`${levelLabel(id)} abgeschlossen – HP voll und +${levelCoins()} Quest-Coins!`, { icon: '🏆', tone: 'gold', ms: 5200 });
  confetti(120);
  return true;
}

/**
 * Ein verlorener Run setzt bei einem noch nicht abgeschlossenen Level die
 * Spielmodus-Fortschritte zurück. Lernskript, Bestwerte, XP und Inventar bleiben erhalten.
 */
/** Wird nur noch bei K.o. aufgerufen (siehe applyDefeat). */
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
  const pl = playerVitals();
  const hpPct = Math.round((pl.hp / pl.maxHp) * 100);
  const tone = pl.hp <= 0 ? 'is-ko' : hpPct <= 25 ? 'is-crit' : hpPct <= 50 ? 'is-low' : '';
  const potions = (pl.inventory.small || 0) + (pl.inventory.medium || 0) + (pl.inventory.large || 0);
  const chip = $('hpChip');
  chip.classList.remove('is-ko', 'is-crit', 'is-low');
  if (tone) chip.classList.add(tone);
  chip.innerHTML = `
    <span class="hpchip__heart">${I.heart}</span>
    <span class="hpchip__body">
      <span class="hpchip__num"><b>${pl.hp}</b>/${pl.maxHp} HP</span>
      <span class="hpchip__bar"><span style="width:${hpPct}%"></span></span>
    </span>
    <span class="hpchip__bag" title="Heiltränke im Inventar">🧪${potions}${pl.inventory.spark ? ` ✨${pl.inventory.spark}` : ''}</span>`;
  chip.setAttribute('aria-label', `${pl.hp} von ${pl.maxHp} Lebenspunkten, ${potions} Heiltränke`);
  $('coinChip').innerHTML = `${COIN_IMG}<b>${pl.coins}</b>`;
  $('coinChip').setAttribute('aria-label', `${pl.coins} Quest-Coins – Shop öffnen`);
  if (!$('invPop').hidden) renderInvPop();
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
  const musicOn = S().settings.music !== false;
  const mb = $('musicBtn');
  if (mb) {
    mb.innerHTML = `<span aria-hidden="true">♪</span>`;
    mb.classList.toggle('is-off', !musicOn);
    mb.setAttribute('aria-pressed', String(musicOn));
    mb.setAttribute('aria-label', musicOn ? 'Musik ausschalten' : 'Musik einschalten');
    mb.title = musicOn ? 'Musik aus' : 'Musik an';
  }
  const on = S().settings.sound;
  $('soundBtn').innerHTML = on ? I.soundOn : I.soundOff;
  $('soundBtn').setAttribute('aria-pressed', String(on));
  $('soundBtn').setAttribute('aria-label', on ? 'Ton ausschalten' : 'Ton einschalten');
}

function renderInvPop() {
  const pl = playerVitals();
  const rows = ['small', 'medium', 'large', 'spark'].map((k) => {
    const it = POTIONS[k];
    const offer = SHOP[k];
    const have = pl.inventory[k] || 0;
    const full = offer.max && have >= offer.max;
    const canBuy = pl.coins >= priceOf(k) && !full;
    const canUse = k !== 'spark' && have > 0 && pl.hp < pl.maxHp;
    return `<li class="shoprow ${have ? '' : 'is-empty'}">
      <span class="shoprow__icon">${it.icon}</span>
      <span class="shoprow__body"><b>${esc(it.label)}</b><small>${k === 'spark' ? 'Belebt bei 0 HP automatisch · max. 1' : `+${it.heal} HP`}</small></span>
      <span class="shoprow__have" title="Im Inventar">×${have}</span>
      ${k === 'spark'
        ? '<span class="shoprow__auto">automatisch</span>'
        : `<button class="btn btn--sm ${canUse ? 'btn--primary' : 'btn--ghost'}" data-action="use-potion" data-kind="${k}" ${canUse ? '' : 'disabled'}>Trinken</button>`}
      <button class="btn btn--sm btn--buy" data-action="buy-item" data-kind="${k}" ${canBuy ? '' : 'disabled'} title="${full ? 'Maximum erreicht' : `Kaufen für ${priceOf(k)} Coins`}">${COIN_IMG}${priceOf(k)}</button>
    </li>`;
  }).join('');
  $('invPop').innerHTML = `
    <div class="invpop__head">
      <span>Inventar &amp; Shop</span>
      <span class="invpop__stats"><b class="invpop__hp">${pl.hp}/${pl.maxHp} HP</b><b class="invpop__coins">${COIN_IMG}${pl.coins}</b></span>
    </div>
    <ul class="shop">${rows}</ul>
    <p class="shop__sub">Kampf-Items · im Run mit F1–F4</p>
    <ul class="shop">${BATTLE_ITEM_ORDER.map((k) => {
      const it = BATTLE_ITEMS[k];
      const have = pl.inventory[k] || 0;
      const canBuy = pl.coins >= priceOf(k);
      return `<li class="shoprow shoprow--item ${have ? '' : 'is-empty'}">
        <span class="shoprow__icon">${it.icon}</span>
        <span class="shoprow__body"><b>${esc(it.label)} <kbd>${it.key}</kbd></b><small>${esc(it.text)}${it.modes.length === 1 ? ' · nur Boss' : ''}</small></span>
        <span class="shoprow__have" title="Im Inventar">×${have}</span>
        <button class="btn btn--sm btn--buy" data-action="buy-item" data-kind="${k}" ${canBuy ? '' : 'disabled'} title="Kaufen für ${priceOf(k)} Coins">${COIN_IMG}${priceOf(k)}</button>
      </li>`;
    }).join('')}</ul>
    ${pl.heroClass ? `<p class="invpop__class">${HERO_CLASSES[pl.heroClass].icon} ${esc(HERO_CLASSES[pl.heroClass].name)}: ${esc(HERO_CLASSES[pl.heroClass].bonus)}${dailyFocusLeft() ? ` · heute noch ${dailyFocusLeft()}× Fokus gratis` : ''}</p>` : ''}
    <p class="invpop__rules">Coins gibt es für jeden gewonnenen Modus (Story ${COIN_REWARDS.story.base}, Versus ${COIN_REWARDS.versus.base}, Boss ${COIN_REWARDS.boss.base}). Erster Sieg doppelt, 3 Sterne mit Bonus, Level-Abschluss +${COIN_LEVEL_COMPLETE}.<br>Niederlage kostet HP: Story −25, Versus −33, Boss −50. Level-Reset nur bei K.o. (0 HP).</p>`;
}

function toggleInv(force) {
  const pop = $('invPop');
  const open = typeof force === 'boolean' ? force : pop.hidden;
  pop.hidden = !open;
  $('hpChip').setAttribute('aria-expanded', String(open));
  if (open) renderInvPop();
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
  // Überarbeitete Lernskripte: bereits verstandene Abschnitte übernehmen
  const migrated = m ? m.chapters.filter((c) => c.available).map((c) => migrateLegacySections(c.id)).some(Boolean) : false;
  if (migrated) { persist(); toast('Lernskript aktualisiert – dein Fortschritt wurde übernommen.', { icon: '📘' }); }
  renderHeader();
  setSaveChip(save.guest ? 'guest' : save.canWrite ? 'ready' : 'permission');
  if (!playerVitals().heroClass) {
    // Neuer Spielstand (oder alter ohne Klasse): erst Anleitung und Charakterwahl
    openOnboard('new');
  } else {
    grantDailyGift();
    renderDashboard();
    showScreen('dashboard');
  }
  // Der Klick auf „Laden/Neu starten“ ist die nötige Nutzeraktion – Musik darf direkt starten
  Audio.unlockAudio();
  syncMusic();
}

/* =========================================================
   1b · Einstieg: Anleitung + Charakterwahl
   ========================================================= */

const GUIDE = [
  { icon: '📘', title: 'Lernen', text: 'Jedes Level ist ein Prüfungsthema. Das <b>Lernskript</b> erklärt den Stoff kompakt – mit Merksätzen, Prüfungsfallen und einer Checkpoint-Frage pro Abschnitt. Markiere Abschnitte als <b>Verstanden</b>.' },
  { icon: '⚔️', title: 'Spielen', text: '<b>Story</b>: 10 Fragen in Lernreihenfolge, 3 Leben. <b>Versus</b>: 5 Zufallsfragen, 1 Leben. <b>Boss</b>: 6 harte Fragen, 15 Sekunden pro Frage – 4 richtig besiegen ihn, 3 Fehler verlieren.' },
  { icon: '🏆', title: 'Level abschließen', text: 'Lernskript, Story, Versus und Boss geschafft? Dann ist das Level abgeschlossen: <b>HP voll</b> und <b>Bonus-Coins</b>. Das <b>Karussell</b> fragt alle Fragen am Stück ab – Training ohne Risiko mit Truhe am Ende.' },
  { icon: '❤️', title: 'Lebenspunkte', text: 'Eine Niederlage kostet HP: Story <b>−25</b>, Versus <b>−33</b>, Boss <b>−50 HP</b>. Dein Fortschritt im Level bleibt erhalten. Erst bei <b>0 HP</b> (K.o.) werden die Modi des Levels zurückgesetzt – dann Heiltrank trinken oder die kostenlose <b>Rettungsmission</b> spielen.' },
  { icon: '🪙', title: 'Coins & Items', text: 'Siege bringen <b>Quest-Coins</b>. Im Shop (oben rechts) gibt es Heiltränke und Kampf-Items für die Hotbar: <b>F1</b> Fokus, <b>F2</b> Pauser, <b>F3</b> Herz, <b>F4</b> Überspringer. Grau = nicht im Inventar, roter Preis = zu wenig Coins.' },
  { icon: '💾', title: 'Fortschritt', text: 'Alles wird automatisch in <b>smartadm_34i.json</b> gespeichert. Rang, Erfolge und Lerntage wachsen mit – jeden Tag gibt es Fokus geschenkt.' },
];

function openOnboard(mode = 'new') {
  ui.onboard = { mode, step: 'guide', pick: playerVitals().heroClass || null, returnTo: ui.screen };
  drawOnboard();
  showScreen('onboard');
}

function drawOnboard() {
  const ob = ui.onboard;
  const help = ob.mode === 'help';
  const guide = `
    <div class="onboard__guide">
      ${GUIDE.map((g, i) => `<article class="gcard" style="--d:${i * 70}ms"><span class="gcard__icon" aria-hidden="true">${g.icon}</span><h3>${g.title}</h3><p>${g.text}</p></article>`).join('')}
    </div>
    <p class="onboard__note">Die Fragen sind eigene, prüfungsnahe Fragen auf Basis der Lernskripte und des DIHK-Rahmenplans – keine Original-IHK-Prüfungsfragen.</p>`;

  if (ob.step === 'guide') {
    $('onboardView').innerHTML = `
      <div class="onboard">
        <header class="onboard__head">
          <img class="onboard__logo" src="assets/logo.png" alt="34i-Quest" width="720" height="235">
          <p class="onboard__kicker">${help ? 'Spielanleitung' : 'Neues Abenteuer · Schritt 1 von 2'}</p>
          <h1>So funktioniert 34i-Quest</h1>
          <p class="onboard__lead">Du bereitest dich auf die Sachkundeprüfung nach § 34i GewO vor – als Spiel. Lernen, kämpfen, Level abschließen.</p>
        </header>
        ${guide}
        <div class="onboard__actions">
          ${help
            ? `<button class="btn btn--primary btn--xl" data-action="onboard-close">Zurück zum Spiel</button>`
            : `<button class="btn btn--primary btn--xl" data-action="onboard-step" data-step="class">Weiter zur Charakterwahl ${I.next}</button>`}
        </div>
      </div>`;
    return;
  }

  const pick = ob.pick;
  const cards = HERO_CLASS_ORDER.map((id) => {
    const c = HERO_CLASSES[id];
    const on = pick === id;
    return `<button class="hero ${on ? 'is-picked' : ''}" data-action="pick-class" data-id="${id}" aria-pressed="${on}" style="--hc:${c.color}">
      <span class="hero__emblem" aria-hidden="true">${c.icon}</span>
      <span class="hero__name">${esc(c.name)}</span>
      <span class="hero__bonus">${esc(c.bonus)}</span>
      <span class="hero__text">${esc(c.text)}</span>
      <span class="hero__fit">${esc(c.fit)}</span>
      <span class="hero__check" aria-hidden="true">${I.check}</span>
    </button>`;
  }).join('');
  const chosen = pick ? HERO_CLASSES[pick] : null;
  $('onboardView').innerHTML = `
    <div class="onboard">
      <header class="onboard__head">
        <p class="onboard__kicker">Neues Abenteuer · Schritt 2 von 2</p>
        <h1>Wähle deine Klasse</h1>
        <p class="onboard__lead">Deine Klasse gibt dir einen dauerhaften Vorteil für diesen Spielstand. Alle vier sind gleich stark – nur anders.</p>
      </header>
      <div class="heroes" role="radiogroup" aria-label="Klasse wählen">${cards}</div>
      <div class="onboard__actions">
        <button class="btn btn--ghost" data-action="onboard-step" data-step="guide">${I.back} Anleitung</button>
        <button class="btn btn--primary btn--xl" data-action="confirm-class" ${chosen ? '' : 'disabled'}>${chosen ? `Als ${esc(chosen.name)} beginnen` : 'Klasse wählen'}</button>
      </div>
      <p class="onboard__note">Die Wahl gilt dauerhaft für diesen Spielstand.</p>
    </div>`;
}

function confirmClass() {
  const pick = ui.onboard?.pick;
  if (!pick || !HERO_CLASSES[pick]) return;
  const pl = playerVitals();
  pl.heroClass = pick;
  sfx('level');
  confetti(90);
  toast(`Willkommen, ${HERO_CLASSES[pick].name}! ${HERO_CLASSES[pick].bonus}.`, { icon: HERO_CLASSES[pick].icon, tone: 'gold', ms: 4500 });
  grantDailyGift();
  persist();
  renderHeader();
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
    if (!st.story) return { chapter: c, label: `${label}: Story starten`, detail: '10 Fragen in Lernreihenfolge – danach wird der Boss freigeschaltet.', action: `data-action="start-mode" data-mode="story" data-id="${esc(c.id)}"` };
    if (!st.versus) return { chapter: c, label: `${label}: Versus spielen`, detail: '5 Zufallsfragen, ein Fehler und es ist vorbei.', action: `data-action="start-mode" data-mode="versus" data-id="${esc(c.id)}"` };
    if (!st.boss) return { chapter: c, label: `${label}: Boss wagen`, detail: '6 Fragen, 15 Sekunden pro Frage. 4 richtige besiegen den Boss, 3 Fehler beenden den Kampf.', action: `data-action="start-mode" data-mode="boss" data-id="${esc(c.id)}"` };
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
    <span class="lootitem__icon">${item.icon}</span><span class="lootitem__body"><b>${esc(item.label)}</b><small>+${item.heal} HP</small></span><strong>×${count}</strong>
  </button>`;
}

function renderDashboard() {
  const m = Content.getManifest();
  const pl = playerVitals();
  const r = rankFor(pl.xp);
  const acc = pl.answered ? Math.round((pl.correct / pl.answered) * 100) : 0;
  const mission = nextMission();
  const earned = ACHIEVEMENTS.filter((a) => pl.achievements.includes(a.id));

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
      <div class="dash__top">
        ${mission ? `
        <button class="mission" ${mission.action}>
          <span class="mission__label">Nächste Mission</span>
          <span class="mission__title">${esc(mission.label)}</span>
          <span class="mission__detail">${esc(mission.detail)}</span>
          <span class="mission__go">${I.next}</span>
        </button>` : `
        <div class="mission mission--done">
          <span class="mission__label">Alle verfügbaren Level abgeschlossen</span>
          <span class="mission__title">Stark! Neue Level folgen.</span>
          <span class="mission__detail">Spiel Bosse und Karussell erneut für Coins und Bestwerte.</span>
        </div>`}
        <section class="profile" aria-label="Dein Profil">
          <div class="profile__head">
            <span class="profile__emblem" aria-hidden="true">${r.level}</span>
            <div>
              <p class="profile__kicker">Rang ${r.level}</p>
              <p class="profile__title">${esc(r.title)}</p>
            </div>
          </div>
          ${pl.heroClass ? `<p class="profile__class" style="--hc:${HERO_CLASSES[pl.heroClass].color}"><span aria-hidden="true">${HERO_CLASSES[pl.heroClass].icon}</span> ${esc(HERO_CLASSES[pl.heroClass].name)} <small>${esc(HERO_CLASSES[pl.heroClass].short)}</small></p>` : ''}
          <div class="bar bar--xp" role="progressbar" aria-label="Erfahrung bis zum nächsten Rang" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.pct}"><span style="width:${r.pct}%"></span></div>
          <p class="profile__next">${pl.xp} XP${r.next ? ` · noch ${r.toNext} bis „${esc(r.next.title)}“` : ' · höchster Rang'}</p>
          <dl class="profile__stats">
            <div><dt>Treffer</dt><dd>${pl.answered ? acc + ' %' : '–'}</dd></div>
            <div><dt>Beste Serie</dt><dd>${pl.bestCombo}</dd></div>
            <div><dt>Lerntage</dt><dd>${pl.dayStreak}</dd></div>
          </dl>
          <details class="ach">
            <summary>
              <span>Erfolge <b>${earned.length}/${ACHIEVEMENTS.length}</b></span>
              <span class="ach__preview" aria-hidden="true">${earned.slice(-5).map((a) => a.icon).join('') || '–'}</span>
            </summary>
            <ul class="badges">${badges}</ul>
          </details>
        </section>
      </div>
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
      ${mark(st.boss, 'Boss')}
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
  const carouselTotal = (data?.questions?.questions?.length || 0) + (data?.boss?.questions?.length || 0);

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
        
        <ol class="mastery" aria-label="Weg zum Levelabschluss">
          <li class="${st.learnDone ? 'is-done' : ''}">Lernskript</li>
          <li class="${st.story ? 'is-done' : ''}">Story</li>
          <li class="${st.versus ? 'is-done' : ''}">Versus</li>
          <li class="${st.boss ? 'is-done' : ''}">Boss</li>
          <li class="${st.mastered ? 'is-done is-gold' : ''}">Level abgeschlossen</li>
        </ol>
      </div>
    </header>
    ${noHp ? `<div class="rescue">
      <div class="rescue__text"><strong>K.o. – 0 HP.</strong> Trink einen Heiltrank (Herz oben rechts) oder kämpf dich zurück:
      Beantworte in der <b>Rettungsmission</b> 3 leichte Fragen in Folge richtig und du bekommst <b>${RESCUE_HEAL} HP</b>. Kein Risiko, beliebig oft versuchbar.</div>
      <button class="btn btn--primary" data-action="start-mode" data-mode="rescue" data-id="${esc(id)}">Rettungsmission starten</button>
    </div>` : ''}
    ${errs.length ? `<div class="notice notice--bad"><strong>Teile dieses Levels fehlen:</strong> ${errs.map(esc).join(' ')}</div>` : ''}
    <div class="modes">
      ${card({ key: 'learn', icon: I.book, title: 'LERNSKRIPT', text: 'Der Stoff kompakt, in Lernreihenfolge, mit Merksätzen und Prüfungsfallen.',
        rules: `${st.done}/${st.total} Abschnitte verstanden · Checkpoint-Fehler −10 HP`, disabled: !data?.learn, lockText: 'UNAVAILABLE – Lernskript fehlt.',
        action: `data-action="open-learn" data-id="${esc(id)}"` })}
      ${card({ key: 'story', icon: I.path, title: 'STORY', text: 'Zehn Fragen in der Reihenfolge des Lernskripts. Erst Grundlagen, dann Anwendung.',
        rules: '10 Fragen · 3 Leben · Verlust: −25 HP', stat: `${stars(p.stars.story)} <span>Rekord ${p.bestStory} · ${p.storyWins}× gewonnen</span>`,
        disabled: !data?.questions || noHp, lockText: !data?.questions ? 'UNAVAILABLE – Fragen fehlen.' : 'KO – Fülle zuerst deine HP auf.', action: `data-action="start-mode" data-mode="story" data-id="${esc(id)}"` })}
      ${card({ key: 'versus', icon: I.swords, title: 'VERSUS', text: 'Fünf Zufallsfragen quer durchs Level. Ähnliche Begriffe gegeneinander.',
        rules: '5 Fragen · 1 Leben · Verlust: −33 HP', stat: `${stars(p.stars.versus)} <span>Rekord ${p.bestVersus} · ${p.versusWins}× gewonnen</span>`,
        disabled: !data?.questions || noHp, lockText: !data?.questions ? 'UNAVAILABLE – Fragen fehlen.' : 'KO – Fülle zuerst deine HP auf.', action: `data-action="start-mode" data-mode="versus" data-id="${esc(id)}"` })}
      ${card({ key: 'boss', icon: I.crown, title: 'BOSS', text: `${esc(bossName)} wartet – mit eigenen, harten Fallfragen.`,
        rules: '6 Fragen · 4 richtig = Sieg · 3 Fehler = Niederlage · 15 s · Verlust: −50 HP', stat: `${stars(p.stars.boss)} <span>Rekord ${p.bestBoss} · ${p.bossWins}× besiegt</span>`,
        disabled: !data?.boss || bossLocked || noHp,
        lockText: !data?.boss ? 'UNAVAILABLE – Bossfragen fehlen.' : bossLocked ? 'LOCKED – Gewinne zuerst die Story.' : 'KO – Fülle zuerst deine HP auf.',
        action: `data-action="start-mode" data-mode="boss" data-id="${esc(id)}"` })}
      ${card({ key: 'carousel', icon: I.carousel, title: 'KARUSSELL', text: 'Alle Fragen des Levels am Stück – erst die leichten, am Ende die Bossfragen.',
        rules: `${carouselTotal} Fragen · 3 Leben · ohne Timer · kein HP-Verlust`,
        stat: `<span>Rekord ${p.bestCarousel || 0}/${carouselTotal} (${p.bestCarouselPct || 0} %)</span>`,
        disabled: !data?.questions, lockText: 'UNAVAILABLE – Fragen fehlen.',
        action: `data-action="start-mode" data-mode="carousel" data-id="${esc(id)}"` })}
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
    toast('Lernskript komplett verstanden – jetzt ab in die Story!', { icon: '📘', tone: 'gold' });
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
  const rescue = modeId === 'rescue';
  if (!rescue && modeId !== 'carousel' && playerVitals().hp <= 0) { toast('Du hast 0 HP. Trink einen Heiltrank oder starte die Rettungsmission.', { icon: '💔', tone: 'bad', ms: 4500 }); openChapter(chapterId); return; }
  if (rescue && playerVitals().hp > 0) { toast('Die Rettungsmission gibt es nur bei 0 HP.', { icon: '❤️' }); return; }
  clearRunTimers();
  toggleInv(false);
  clearToasts();
  grantDailyGift();   // falls die Sitzung über Mitternacht läuft
  await Content.loadChapterContent(chapterId);
  const data = Content.getCachedChapter(chapterId);
  const poolData = mode.source === 'boss' ? data?.boss : data?.questions;  // Karussell: questions + boss
  if (!poolData?.questions?.length) { toast('Für diesen Modus fehlen die Fragen.', { icon: '⚠️', tone: 'bad' }); return; }
  if (modeId === 'boss' && BOSS_REQUIRES_STORY && !prog(chapterId).storyWins) { toast('Der Bossfight ist noch gesperrt. Gewinne zuerst die Story.', { icon: '🔒' }); return; }

  const p = prog(chapterId);
  let pool = poolData.questions;
  if (rescue) {
    const easy = pool.filter((q) => (q.difficulty || 1) === 1);
    pool = easy.length >= mode.count ? easy : pool.filter((q) => (q.difficulty || 1) <= 2);
  }
  const picked = modeId === 'carousel'
    ? carouselOrder(data.questions.questions, data?.boss?.questions || [])
    : selectQuestions(rescue ? 'versus' : modeId, pool, { recent: rescue ? [] : lastQ(chapterId)[modeId], mistakes: rescue ? {} : p.mistakes })
      .slice(0, mode.count);
  const prepared = picked.map((q) => prepareQuestion(q, S().settings.shuffleAnswers));
  ui.chapterId = chapterId;
  const run = new Run(modeId, chapterId, prepared);
  const bossInfo = data?.boss?.boss || {};
  const safeImg = (v) => (typeof v === 'string' && /^[\w./-]+\.(webp|png|jpe?g|avif)$/i.test(v) && !v.includes('..') ? v : '');
  run.bossInfo = {
    name: bossInfo.name || 'Level-Boss', title: bossInfo.title || '',
    taunts: { ...BOSS_TAUNTS, ...(bossInfo.taunts || {}) },
    image: safeImg(bossInfo.image), bust: safeImg(bossInfo.bust) || safeImg(bossInfo.image),
    accent: /^#[0-9a-f]{6}$/i.test(bossInfo.accent || '') ? bossInfo.accent : '#FF738B',
  };
  run.loot = [];
  run.crits = 0;
  run.itemUse = {};                // pro Frage: welche Items schon eingesetzt wurden
  run.started = modeId !== 'boss';   // Boss startet erst nach dem Intro
  run.say = run.bossInfo.taunts.intro;
  ui.run = run;
  ui.newAchievements = [];
  touchDay();
  showScreen('run');
  if (modeId === 'boss') renderBossIntro(); else renderRun();
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

const pickLine = (v) => (Array.isArray(v) ? v[Math.floor(Math.random() * v.length)] : v) || '';

/** Boss-Darstellung in der Arena: Porträt mit Schadensstufe oder – ohne Bild – das Siegel */
function bossVisual(info, dmg) {
  if (info.bust) {
    return `<div class="bossart" style="--dmg:${(dmg / 5).toFixed(2)}"><img src="${esc(info.bust)}" alt="" width="300" height="300" decoding="async"><span class="bossart__cracks">${sealCracks(dmg)}</span></div>`;
  }
  return sealSvg(dmg);
}
function sealCracks(dmg) {
  const paths = ['M20 8 L34 30 L28 44 L40 60', 'M82 14 L66 34 L72 48', 'M10 70 L28 62 L34 74 L48 70', 'M90 66 L74 60 L70 78', 'M52 4 L50 22 L60 30'];
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${paths.map((d, i) => `<path d="${d}" class="${i < dmg ? 'is-on' : ''}"/>`).join('')}</svg>`;
}

/**
 * Boss-Intro als kurze Kinosequenz (~3 s): Warnbalken → Silhouette steigt auf → Blitz, Farbe →
 * Name knallt rein → Spruch wird getippt → Regeln und „Kampf beginnen“.
 * Jederzeit überspringbar (Klick, Enter, Leertaste). Der Timer startet erst mit „Kampf beginnen“.
 */
function renderBossIntro() {
  const run = ui.run;
  const b = run.bossInfo;
  run.introReady = false;
  // Buchstaben einzeln animieren, Wörter aber nie umbrechen
  let li = 0;
  const letters = b.name.split(' ').map((word) => `<span class="bosscine__word">${[...word].map((ch) => `<span style="--i:${li++}">${esc(ch)}</span>`).join('')}</span>`).join(' ');
  const ticker = Array(20).fill('BOSS NÄHERT SICH').join(' ✦ ');
  const art = b.image
    ? `<img class="bosscine__art" src="${esc(b.image)}" alt="${esc(b.name)}" decoding="async">`
    : `<div class="bosscine__seal">${sealSvg(0)}</div>`;
  $('runView').innerHTML = `
    <div class="bosscine" id="bossCine" data-action="boss-skip" style="--accent:${esc(b.accent)}" role="dialog" aria-modal="true" aria-labelledby="bossName">
      <div class="bosscine__rays" aria-hidden="true"></div>
      <div class="bosscine__bar bosscine__bar--top" aria-hidden="true"><span>${ticker}</span></div>
      <div class="bosscine__bar bosscine__bar--bottom" aria-hidden="true"><span>${ticker}</span></div>
      <div class="bosscine__flash" aria-hidden="true"></div>
      <div class="bosscine__stage">
        <div class="bosscine__figure">${art}</div>
        <div class="bosscine__text">
          <p class="bosscine__kicker">${esc(levelLabel(run.chapterId))} · Boss</p>
          <h1 class="bosscine__name" id="bossName" aria-label="${esc(b.name)}">${letters}</h1>
          <p class="bosscine__title">${esc(b.title)}</p>
          <blockquote class="bosscine__say" id="bossCineSay" aria-live="polite"></blockquote>
          <div class="bosscine__panel">
            <ul class="bosscine__rules">
              <li><b>${run.total}</b> Fragen</li>
              <li><b>${run.mode.killHits}</b> richtig = Sieg</li>
              <li><b>${run.mode.lives}</b> Fehler = Niederlage</li>
              <li><b>${run.mode.seconds} s</b> pro Frage</li>
              <li>Items <b>F1–F4</b></li>
            </ul>
            <p class="bosscine__stakes">
              <span class="win">Sieg: Siegtruhe mit ${COIN_REWARDS.boss.base * cls().coinMult}–${((COIN_REWARDS.boss.base * 2) + COIN_REWARDS.boss.perfect) * cls().coinMult} Quest-Coins</span>
              <span class="lose">Niederlage: −${MODE_HP_LOSS.boss} HP · bei 0 HP (K.o.) Level-Reset</span>
            </p>
            <div class="bosscine__actions">
              <button class="btn btn--boss btn--xl" id="btnFight" data-action="boss-fight">Kampf beginnen</button>
              <button class="btn btn--ghost" data-action="abort-run">Noch nicht – zurück</button>
            </div>
            <p class="bosscine__hint">Enter startet · Antworten mit A–D · F1 Fokus · F2 Pauser · F3 Herz · F4 Überspringer</p>
          </div>
        </div>
      </div>
      <button class="bosscine__skip" data-action="boss-skip">Überspringen ⏭</button>
    </div>`;

  if (reducedMotion()) { finishBossIntro(); return; }
  sfx('rumble');
  later(() => sfx('boss'), 1150);
  // Spruch tippen
  const text = b.taunts.intro || '';
  const say = $('bossCineSay');
  let n = 0;
  const type = () => {
    if (!ui.run || ui.run.introReady || !say) return;
    n += 2;
    say.textContent = `„${text.slice(0, n)}${n < text.length ? '' : '“'}`;
    if (n < text.length) later(type, 28);
  };
  later(type, 2050);
  later(finishBossIntro, 2900);
}

function finishBossIntro() {
  const run = ui.run;
  if (!run || run.mode.id !== 'boss' || run.started || run.introReady) return;
  run.introReady = true;
  const cine = $('bossCine');
  if (cine) cine.classList.add('is-ready');
  const say = $('bossCineSay');
  if (say) say.textContent = `„${run.bossInfo.taunts.intro || ''}“`;
  $('btnFight')?.focus({ preventScroll: true });
}

function startBossFight() {
  const run = ui.run;
  if (!run || run.mode.id !== 'boss' || run.started) return;
  if (!run.introReady) { finishBossIntro(); return; }
  run.started = true;
  clearToasts();
  sfx('level');
  renderRun();
}

function floatText(text, tone = 'ok', where = 'boss') {
  const layer = $('fxLayer');
  if (!layer || reducedMotion()) return;
  const el = document.createElement('span');
  el.className = `float float--${tone} float--${where}`;
  el.textContent = text;
  layer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function renderRun() {
  const run = ui.run;
  if (!run) return;
  const q = run.current;
  const isBoss = run.mode.id === 'boss';
  ui.selected = [];
  ui.answered = false;

  const isCarousel = run.mode.id === 'carousel';
  const pips = isCarousel ? '' : run.questions.map((_, i) => {
    const r = run.results[i];
    const cls = r ? (r.skipped ? 'is-skip' : r.correct ? 'is-ok' : 'is-bad') : i === run.idx ? 'is-now' : '';
    return `<li class="${cls}"></li>`;
  }).join('');
  const progressHtml = isCarousel
    ? `<div class="cprog" aria-label="Frage ${run.idx + 1} von ${run.total}"><span class="cprog__bar"><span style="width:${(run.idx / run.total) * 100}%"></span></span><span class="cprog__txt">${run.correctCount} richtig · Frage ${run.idx + 1}/${run.total}</span></div>`
    : `<ol class="pips" aria-label="Frage ${run.idx + 1} von ${run.total}">${pips}</ol>`;
  const hearts = Array.from({ length: run.mode.lives }, (_, i) => `<span class="heart ${i < run.lives ? '' : 'is-lost'}">${I.heart}</span>`).join('');
  const hits = run.correctCount;
  const bossHp = run.mode.killHits || run.total;
  const bossLeft = Math.max(0, bossHp - hits);
  const hp = Array.from({ length: bossHp }, (_, i) => `<span class="${i < bossLeft ? '' : 'is-gone'}"></span>`).join('');
  const isLastQuestion = run.idx === run.total - 1;
  const decider = !!run.mode.killHits && run.correctCount === run.mode.killHits - 1 && run.lives === 1;
  const isFinal = isLastQuestion || decider;
  const enraged = isBoss && (isFinal || bossLeft <= 1);
  if (isBoss) {
    if (isFinal) run.say = run.bossInfo.taunts.final;
    else if (bossLeft === 1) run.say = run.bossInfo.taunts.low;
  }
  const loot = (run.loot || []).map((k) => POTIONS[k]?.icon || '').join('');

  $('runView').innerHTML = `
    <div class="run run--${run.mode.id} ${enraged ? 'is-enraged' : ''}">
      <div class="hud">
        <button class="back back--hud" data-action="abort-run">${I.back} ${isCarousel ? 'Beenden' : 'Aufgeben'}</button>
        <span class="hud__mode">${esc(run.mode.label)} <small>${esc(levelLabel(run.chapterId))}</small></span>
        ${progressHtml}
        <span class="hud__lives" aria-label="${run.lives} Leben">${hearts}</span>
        <span class="hud__score"><small>Punkte</small> <b id="hudScore">${run.score}</b></span>
        <span class="hud__combo ${run.combo >= 2 ? 'is-hot' : ''}" id="hudCombo">${run.combo >= 2 ? `${I.flame} ${run.combo}er-Serie` : ''}</span>
        <span class="hud__loot" id="hudLoot" title="Beute in diesem Run">${loot}</span>
      </div>
      ${isBoss ? `
      <div class="arena ${enraged ? 'is-enraged' : ''}" id="arena">
        <div class="arena__boss ${run.bossInfo.bust ? 'arena__boss--art' : ''}" id="bossSeal">${bossVisual(run.bossInfo, Math.round((Math.min(hits, bossHp) / bossHp) * 5))}</div>
        <div class="arena__info">
          <p class="arena__name">${esc(run.bossInfo.name)} ${enraged ? '<span class="rage">WUT</span>' : ''}</p>
          <p class="arena__title">${esc(run.bossInfo.title || '')}</p>
          <div class="hp" aria-label="Boss-Lebensleiste: ${bossLeft} von ${bossHp}">${hp}</div>
          <p class="say" id="bossSay">„${esc(run.say || '')}“</p>
        </div>
        <div class="timer" aria-hidden="true">
          <span class="timer__num" id="timerNum">${run.mode.seconds}</span>
          <span class="timer__bar"><span id="timerBar"></span></span>
        </div>
        <div class="fxlayer" id="fxLayer" aria-hidden="true"></div>
      </div>
      ${isFinal ? `<p class="finalbanner" role="status">${decider ? 'Entscheidung' : 'Letzte Frage'}</p>` : ''}` : ''}
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
      ${run.mode.id === 'rescue' ? '' : '<nav class="hotbar" id="hotbar" aria-label="Kampf-Items"></nav>'}
    </div>`;
  renderHotbar();

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

/** Ist ein Kampf-Item gerade einsetzbar? { ok, reason } */
function itemState(id) {
  const run = ui.run;
  const it = BATTLE_ITEMS[id];
  if (!run || !it || run.mode.id === 'rescue') return { ok: false, reason: 'Nur in einem Run' };
  if (!it.modes.includes(run.mode.id)) return { ok: false, reason: it.modes.length === 1 ? 'Nur im Boss' : 'In diesem Modus nicht verfügbar' };
  if (run.mode.id === 'boss' && !run.started) return { ok: false, reason: 'Erst nach Kampfbeginn' };
  const used = run.itemUse[run.idx] || {};
  switch (id) {
    case 'focus':
      if (ui.answered || !countdown.running) return { ok: false, reason: 'Nur während die Zeit läuft' };
      if (used.focus) return { ok: false, reason: 'Pro Frage einmal' };
      return { ok: true };
    case 'pause':
      if (ui.answered || !countdown.running) return { ok: false, reason: countdown.frozen ? 'Schon pausiert' : 'Nur während die Zeit läuft' };
      return { ok: true };
    case 'heart': {
      const dead = run.lives <= 0;
      if (run.lives >= run.mode.lives) return { ok: false, reason: 'Alle Leben voll' };
      if (run.finished && !dead) return { ok: false, reason: 'Run ist beendet' };
      return { ok: true };
    }
    case 'skip':
      if (ui.answered || run.finished) return { ok: false, reason: 'Nur vor dem Antworten' };
      return { ok: true };
    default: return { ok: false, reason: '' };
  }
}

function renderHotbar() {
  const bar = $('hotbar');
  if (!bar || !ui.run) return;
  const pl = playerVitals();
  bar.innerHTML = BATTLE_ITEM_ORDER.map((id) => {
    const it = BATTLE_ITEMS[id];
    const gratis = id === 'focus' ? dailyFocusLeft() : 0;
    const have = (pl.inventory[id] || 0) + gratis;
    const st = itemState(id);
    const price = priceOf(id);
    const poor = !have && pl.coins < price;
    const cls = [have ? 'is-owned' : 'is-buy', st.ok ? '' : 'is-off', poor ? 'is-poor' : ''].join(' ');
    const tip = `${it.label}: ${it.text}${have ? ` · ${have} verfügbar${gratis ? ` (davon ${gratis} gratis heute)` : ''}` : ` · kaufen und einsetzen für ${price} Coins`}${st.ok ? '' : ` · ${st.reason}`}`;
    return `<button class="hot ${cls}" data-action="use-item" data-item="${id}" title="${esc(tip)}" aria-label="${esc(tip)}" ${st.ok ? '' : 'aria-disabled="true"'}>
      <span class="hot__key">${it.key}</span>
      <span class="hot__icon" aria-hidden="true">${it.icon}</span>
      <span class="hot__name">${esc(it.label)}</span>
      ${have ? `<span class="hot__count ${gratis ? 'is-gift' : ''}">×${have}</span>` : `<span class="hot__price">${COIN_IMG}${price}</span>`}
    </button>`;
  }).join('');
}

/** Item einsetzen – ist keins im Inventar, wird es direkt gekauft (falls Coins reichen) */
function useItem(id) {
  const run = ui.run;
  const it = BATTLE_ITEMS[id];
  if (!run || !it) return;
  const st = itemState(id);
  const slot = document.querySelector(`.hot[data-item="${id}"]`);
  const deny = (msg) => {
    sfx('denied');
    if (slot) { slot.classList.remove('is-denied'); void slot.offsetWidth; slot.classList.add('is-denied'); }
    hotbarHint(msg);
  };
  if (!st.ok) { deny(st.reason); return; }
  const pl = playerVitals();
  if (id === 'focus' && dailyFocusLeft() > 0) {
    pl.dailyFocus.left -= 1;          // Tages-Fokus zuerst verbrauchen
  } else if ((pl.inventory[id] || 0) > 0) {
    pl.inventory[id] -= 1;
  } else if (pl.coins >= priceOf(id)) {
    pl.coins -= priceOf(id);
    sfx('spend');
    unlock('shopper');
  } else {
    deny(`Dir fehlen ${priceOf(id) - pl.coins} Coins`);
    return;
  }
  run.itemUse[run.idx] = { ...(run.itemUse[run.idx] || {}), [id]: true };
  run.itemsUsed = (run.itemsUsed || 0) + 1;

  if (id === 'focus') {
    countdown.extend(BOSS_FOCUS_SECONDS);
    floatText(`+${BOSS_FOCUS_SECONDS} s`, 'focus', 'timer');
    sfx('focus');
  } else if (id === 'pause') {
    countdown.freeze();
    const timer = document.querySelector('.timer');
    timer?.classList.add('is-paused');
    const num = $('timerNum');
    if (num) num.textContent = '⏸';
    floatText('Pausiert', 'focus', 'timer');
    sfx('freeze');
  } else if (id === 'heart') {
    run.restoreLife();
    document.querySelectorAll('.hud__lives .heart').forEach((h, k) => h.classList.toggle('is-lost', k >= run.lives));
    floatText('+1 ♥', 'ok', 'player');
    sfx('heart');
    const next = $('btnNext');
    if (next && !run.finished) next.innerHTML = `Nächste Frage ${I.next}`;
  } else if (id === 'skip') {
    countdown.stop();
    ui.answered = true;
    run.skip();
    const pips = document.querySelectorAll('.pips li');
    if (pips[run.idx]) pips[run.idx].className = 'is-skip';
    document.querySelectorAll('#answers .answer').forEach((b) => { b.disabled = true; b.classList.add('is-dim'); });
    floatText('Übersprungen', 'focus', 'combo');
    sfx('skip');
    later(() => advance(), 350);
  }
  persist();
  renderHeader();
  renderHotbar();
}

function hotbarHint(msg) {
  const bar = $('hotbar');
  if (!bar || !msg) return;
  let hint = bar.querySelector('.hotbar__hint');
  if (!hint) { hint = document.createElement('p'); hint.className = 'hotbar__hint'; bar.appendChild(hint); }
  hint.textContent = msg;
  hint.classList.remove('is-on'); void hint.offsetWidth; hint.classList.add('is-on');
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
  let droppedNow = null;

  // Statistik & Fehlerspeicher (fließt in die Versus-Gewichtung ein)
  st.player.answered += 1;
  if (res.correct) {
    st.player.correct += 1;
    if (p.mistakes[q.id]) { p.mistakes[q.id] -= 1; if (!p.mistakes[q.id]) delete p.mistakes[q.id]; }
    unlock('first_hit');
    if (run.combo >= 5) unlock('combo_5');
    if (run.combo >= 10) unlock('combo_10');
    if (run.mode.id === 'boss' && run.mode.seconds - secondsLeft < 3) unlock('quick_draw');
    // Karussell und Rettung: keine Zufallsbeute – dort gibt es die Truhe bzw. HP
    if (!['carousel', 'rescue'].includes(run.mode.id)) droppedNow = maybeDropReward(q);
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
    sfx('hurt');
    shell?.classList.add('fx-shake');
  }

  const lootIcons = (run.loot || []).map((k) => POTIONS[k]?.icon || '').join('');
  const hudLoot = $('hudLoot');
  if (hudLoot && hudLoot.textContent !== lootIcons) { hudLoot.textContent = lootIcons; hudLoot.classList.add('is-new'); }
  const newLoot = droppedNow ? POTIONS[droppedNow.id] : null;

  if (run.mode.id === 'boss') {
    const hits = run.correctCount;
    const seal = $('bossSeal');
    const t = run.bossInfo.taunts;
    const crit = res.correct && secondsLeft >= BOSS_CRIT_SECONDS && !(run.itemUse[run.idx] || {}).pause;
    if (crit) run.crits += 1;
    const bossHp = run.mode.killHits || run.total;
    if (seal && res.correct) { seal.innerHTML = bossVisual(run.bossInfo, Math.round((Math.min(hits, bossHp) / bossHp) * 5)); seal.classList.add(crit ? 'is-crit' : 'is-hit'); }
    if (seal && !res.correct) seal.classList.add('is-gloat');
    document.querySelectorAll('.hp span').forEach((s, k) => s.classList.toggle('is-gone', k >= bossHp - hits));
    run.say = pickLine(res.correct ? t.hit : timedOut ? t.timeout : t.miss);
    const say = $('bossSay');
    if (say) { say.textContent = `„${run.say}“`; say.classList.remove('is-new'); void say.offsetWidth; say.classList.add('is-new'); }
    if (res.correct) {
      floatText(crit ? 'KRITISCH! −1' : '−1', crit ? 'crit' : 'ok', 'boss');
      if (run.combo >= 2) floatText(`Kombo ×${run.combo}`, 'combo', 'combo');
    } else {
      floatText('−1 ♥', 'bad', 'player');
      shell?.classList.add('fx-hurt');
    }
    if (newLoot) floatText(`${newLoot.icon} ${newLoot.label}!`, 'loot', 'loot');
    flash(res.correct ? (crit ? 'Kritisch!' : 'Treffer!') : timedOut ? 'Zeit um!' : 'Autsch!', res.correct ? 'ok' : 'bad');
    renderHotbar();
    // Kein Weiter-Button: kurz Lösung zeigen, dann sofort weiter.
    // Letztes Leben verloren: etwas länger warten, damit ein Herz (F3) noch retten kann.
    const lastBreath = run.lives <= 0 && !res.correct;
    if (lastBreath) hotbarHint('Letztes Leben verloren – F3 Herz rettet dich!');
    later(() => advance(), res.correct ? 620 : lastBreath ? 1800 : 750);
    return;
  }

  $('qfoot').innerHTML = `
    <div class="feedback ${res.correct ? 'feedback--ok' : 'feedback--bad'}" role="status">
      <strong>${res.correct ? `Richtig! +${res.gainedScore}` : 'Falsch.'}</strong> ${esc(q.explanation)}
      ${newLoot ? `<span class="feedback__loot">${newLoot.icon} Gefunden: ${esc(newLoot.label)}</span>` : ''}
    </div>
    <button class="btn btn--primary" id="btnNext" data-action="next-question">${res.finished ? 'Zur Auswertung' : 'Nächste Frage'} ${I.next}</button>`;
  $('btnNext')?.focus({ preventScroll: true });
  renderHotbar();
  if (run.lives <= 0) hotbarHint('Letztes Leben verloren – mit F3 Herz geht es weiter');
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
  let chest = null;
  let healed = 0;
  let coins = null;

  let carousel = null;
  if (m === 'carousel') {
    // Karussell: keine Strafe, Truhe nach Anteil richtiger Antworten
    const ratio = run.total ? run.correctCount / run.total : 0;
    const pct = Math.round(ratio * 100);
    const chestTier = carouselChest(ratio);
    const newRecord = run.correctCount > (p.bestCarousel || 0);
    p.bestCarousel = Math.max(p.bestCarousel || 0, run.correctCount);
    p.bestCarouselPct = Math.max(p.bestCarouselPct || 0, pct);
    carousel = { ratio, pct, chestTier, newRecord, potion: null, spark: false };
    if (chestTier) {
      const pl = playerVitals();
      if (chestTier.potion && Math.random() < Math.min(1, chestTier.potionChance * cls().luck)) { carousel.potion = chestTier.potion; pl.inventory[chestTier.potion] += 1; }
      if (chestTier.sparkChance && Math.random() < chestTier.sparkChance * cls().luck && pl.inventory.spark < (SHOP.spark.max || 1)) { carousel.spark = true; pl.inventory.spark += 1; }
      coins = { total: chestTier.coins, base: chestTier.coins, perfect: 0, first: 0 };
    }
    if (ratio >= 0.5) unlock('carousel_50');
    if (ratio >= 1) unlock('carousel_100');
  } else if (m === 'rescue') {
    // Rettungsmission: kein Fortschritt, keine Strafe – nur HP zurück bei Erfolg
    if (sum.won) healed = healHp(RESCUE_HEAL, 'Rettungsmission', { quiet: true });
  } else {
    if (!Array.isArray(p.coinFirst)) p.coinFirst = [];
    const firstWin = sum.won && !p.coinFirst.includes(m);
    if (sum.won) { coins = coinsForWin(m, sum.stars, firstWin); if (firstWin) p.coinFirst.push(m); }
    if (m === 'story') { p.bestStory = Math.max(p.bestStory, sum.score); if (sum.won) p.storyWins += 1; }
    if (m === 'versus') { p.bestVersus = Math.max(p.bestVersus, sum.score); if (sum.won) p.versusWins += 1; }
    if (m === 'boss') { p.bestBoss = Math.max(p.bestBoss, sum.score); if (sum.won) p.bossWins += 1; }
    p.stars[m] = Math.max(p.stars[m], sum.stars);
    lastQ(id)[m] = run.questions.map((q) => q.id);

    if (sum.won) {
      if (m === 'story') { unlock('story_win'); if (sum.stars === 3) unlock('story_perfect'); }
      if (m === 'versus') unlock('versus_win');
      if (m === 'boss') {
        unlock('boss_slayer');
        if (sum.stars === 3) unlock('boss_perfect');
        if ((run.crits || 0) >= 3) unlock('crit_king');
        // Siegtruhe: seltene Trankbeigabe, die Coins kommen unten für alle Modi
        if (Math.random() < Math.min(1, (BOSS_CHEST_POTION_CHANCE[sum.stars] || 0) * cls().luck)) {
          chest = sum.stars === 3 ? 'large' : sum.stars === 2 ? 'medium' : 'small';
          const pl = playerVitals();
          pl.inventory[chest] = (pl.inventory[chest] || 0) + 1;
        }
      }
      levelCompletedNow = checkMastery(id);
    } else {
      ({ hpEvent, levelReset } = applyDefeat(run));
    }
  }
  if (coins?.total && cls().coinMult > 1) {
    coins.classBonus = coins.total * (cls().coinMult - 1);
    coins.total += coins.classBonus;
  }
  if (coins?.total) addCoins(coins.total);
  addXp(sum.xp);
  persist();

  ui.result = { sum, run, hpEvent, levelCompletedNow, levelReset, chest, healed, coins, carousel };
  ui.run = null;
  renderHeader();
  renderResult();
  showScreen('result');
  if (m === 'carousel') {
    if (carousel?.chestTier) { sfx('chest'); confetti(carousel.ratio >= 0.75 ? 180 : 80); } else sfx('lose');
  } else if (sum.won) { sfx('win'); confetti(m === 'boss' ? 220 : 130); } else sfx('lose');
}

/** Niederlage verrechnen – gilt auch für „Aufgeben“, sonst ließe sich die Strafe umgehen. */
function applyDefeat(run) {
  const loss = MODE_HP_LOSS[run.mode.id] || 0;
  const hpEvent = damageHp(loss, `${run.mode.label} verloren`, { quiet: true });
  // Level-Reset nur bei K.o. (0 HP, kein Lebensfunke)
  const levelReset = hpEvent.knockout ? resetLevelModesAfterLoss(run.chapterId) : false;
  return { hpEvent, levelReset };
}

function abortRun(silent = false) {
  const run = ui.run;
  if (!run) return true;
  if (run.mode.id === 'carousel' && run.results.length > 0) {
    if (!silent && !confirm('Karussell beenden? Deine bisherigen Antworten werden ausgewertet und du bekommst die passende Truhe.')) return false;
    run.finished = true;
    finishRun();
    return false;   // Auswertung wird angezeigt – nicht zusätzlich wegnavigieren
  }
  // Strafe nur, wenn der Run wirklich lief: Boss nach „Kampf beginnen“, sonst ab der ersten Antwort
  const penalty = !['rescue', 'carousel'].includes(run.mode.id) && run.started && (run.results.length > 0 || run.mode.id === 'boss');
  const loss = MODE_HP_LOSS[run.mode.id] || 0;
  if (!silent) {
    const msg = penalty
      ? `Run aufgeben?\n\nAufgeben zählt als Niederlage: −${loss} HP. Fallen deine HP dabei auf 0 (K.o.), werden die Spielmodi dieses Levels zurückgesetzt.`
      : 'Run verlassen? Es gab noch keine Antwort – das kostet nichts.';
    if (!confirm(msg)) return false;
  }
  clearRunTimers();
  if (run.mode.id !== 'rescue') lastQ(run.chapterId)[run.mode.id] = run.questions.map((q) => q.id);
  ui.run = null;
  if (penalty) {
    const { hpEvent, levelReset } = applyDefeat(run);
    const parts = [`${run.mode.label} aufgegeben: −${hpEvent.lost} HP`];
    if (hpEvent.revived) parts.push('Lebensfunke hat dich gerettet');
    if (levelReset) parts.push('K.o. – Level-Modi zurückgesetzt');
    toast(parts.join(' · '), { icon: '🏳️', tone: 'bad', ms: 5000 });
  }
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
  const { sum, run, hpEvent, levelCompletedNow, levelReset, chest, healed, coins, carousel } = ui.result;
  const pl = playerVitals();
  const boss = run.bossInfo?.name || 'Der Boss';
  const titles = {
    story: sum.won ? 'Story geschafft!' : 'Story verloren',
    versus: sum.won ? 'Duell gewonnen!' : 'Duell verloren',
    boss: sum.won ? `${boss} besiegt!` : `${boss} war stärker`,
    rescue: sum.won ? 'Gerettet!' : 'Noch nicht geschafft',
    carousel: carousel?.chestTier ? `${carousel.chestTier.label}!` : 'Karussell beendet',
  };
  let sub;
  if (sum.mode === 'carousel') {
    sub = `${sum.correct} von ${run.total} Fragen richtig (${carousel.pct} %)${carousel.newRecord ? ' – neuer Rekord!' : '.'}`
      + (carousel.chestTier ? '' : ' Ab 25 % gibt es eine Truhe.');
  } else if (sum.mode === 'rescue') {
    sub = sum.won ? `Du bist wieder auf den Beinen: +${healed} HP.` : 'Kein Problem – die Rettungsmission kostet nichts. Versuch es gleich noch einmal.';
  } else if (levelCompletedNow) {
    sub = `${levelLabel(run.chapterId)} komplett abgeschlossen. Deine HP wurden vollständig aufgefüllt.`;
  } else if (sum.won) {
    sub = sum.stars === 3 ? 'Ohne einen einzigen Fehler. Stark.' : 'Geschafft – mit etwas Luft nach oben.';
  } else if (levelReset) {
    sub = 'K.o.! Deine HP sind aufgebraucht – die Spielmodi dieses Levels wurden zurückgesetzt, du startest das Level wieder von vorn.';
  } else {
    sub = `Run verloren. Beim nächsten Versuch startet ${run.mode.label} wieder bei Frage 1.`;
  }
  const hpNote = hpEvent
    ? (hpEvent.revived ? '✨ Lebensfunke verbraucht: Wiederbelebung mit voller HP.'
      : hpEvent.knockout ? `💔 K.o.! Du hast 0 HP. Trink einen Heiltrank oder starte im Level die Rettungsmission.`
        : `💔 −${hpEvent.lost} HP. Aktuell ${pl.hp}/${pl.maxHp} HP.`)
    : '';
  const quote = sum.mode === 'boss' ? (sum.won ? run.bossInfo.taunts.defeat : run.bossInfo.taunts.victory) : '';
  const achievements = ui.newAchievements.length
    ? `<ul class="newbadges">${ui.newAchievements.map((a) => `<li><span>${a.icon}</span><b>${esc(a.title)}</b><small>${esc(a.text)}</small></li>`).join('')}</ul>` : '';
  const lootList = [...(run.loot || [])];
  const chestItem = chest ? POTIONS[chest] : null;
  const coinParts = coins?.total ? [
    `${coins.base} Sieg`,
    coins.first ? `+${coins.first} erster Sieg` : '',
    coins.perfect ? `+${coins.perfect} makellos` : '',
    coins?.classBonus ? `+${coins.classBonus} ${cls().name}` : '',
    levelCompletedNow ? `+${levelCoins()} Level-Abschluss` : '',
  ].filter(Boolean).join(' · ') : '';
  const coinTotal = (coins?.total || 0) + (levelCompletedNow ? levelCoins() : 0);
  const isBossWin = (sum.mode === 'boss' && sum.won) || (sum.mode === 'carousel' && !!carousel?.chestTier);
  const lootHtml = (lootList.length || chestItem || coinTotal || sum.mode === 'carousel') ? `
    <section class="loot" aria-label="Belohnung">
      ${coinTotal ? `<div class="reward ${isBossWin ? 'reward--chest' : ''}">
        ${isBossWin
          ? `<div class="chest__box" aria-hidden="true"><span class="chest__lid"></span><span class="chest__body"></span><img class="chest__item" src="assets/coin-lg.webp" alt=""></div>`
          : `<img class="reward__coin" src="assets/coin-lg.webp" alt="" width="64" height="64">`}
        <div>
          <p class="chest__kicker">${sum.mode === 'carousel' ? `${esc(carousel.chestTier.label)} geöffnet` : isBossWin ? 'Siegtruhe geöffnet' : 'Belohnung'}</p>
          <p class="reward__amount">+${coinTotal} Quest-Coins</p>
          <small>${esc(coinParts)}</small>
        </div>
      </div>` : ''}
      ${carousel?.potion || carousel?.spark ? `<p class="loot__line"><b>In der Truhe lag außerdem:</b> ${carousel.potion ? `<span class="loot__item">${POTIONS[carousel.potion].icon} ${esc(POTIONS[carousel.potion].label)}</span>` : ''} ${carousel.spark ? `<span class="loot__item">${POTIONS.spark.icon} ${esc(POTIONS.spark.label)}</span>` : ''}</p>` : ''}
      ${sum.mode === 'carousel' ? `<div class="ctiers">${[['wood', 'Holz', 25], ['silver', 'Silber', 50], ['gold', 'Gold', 75], ['legend', 'Legendär', 100]].map(([idT, name, min]) => `<span class="ctier ctier--${idT} ${carousel.pct >= min ? 'is-got' : ''}">${name}<small>ab ${min} %</small></span>`).join('')}</div>` : ''}
      ${chestItem ? `<p class="loot__line"><b>In der Truhe lag außerdem:</b> <span class="loot__item">${chestItem.icon} ${esc(chestItem.label)}</span></p>` : ''}
      ${lootList.length ? `<p class="loot__line"><b>Seltener Fund:</b> ${lootList.map((k) => `<span class="loot__item">${POTIONS[k].icon} ${esc(POTIONS[k].label)}</span>`).join(' ')}</p>` : ''}
    </section>` : '';

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

  const again = sum.mode === 'rescue'
    ? (sum.won ? '' : `<button class="btn btn--primary btn--xl" data-action="start-mode" data-mode="rescue" data-id="${esc(run.chapterId)}">Nochmal versuchen</button>`)
    : pl.hp > 0
      ? `<button class="btn btn--primary btn--xl" data-action="start-mode" data-mode="${sum.mode}" data-id="${esc(run.chapterId)}">Nochmal spielen</button>`
      : `<button class="btn btn--primary btn--xl" data-action="start-mode" data-mode="rescue" data-id="${esc(run.chapterId)}">Rettungsmission</button>`;

  $('resultView').innerHTML = `
    <div class="result ${sum.won ? 'result--win' : 'result--lose'} result--${sum.mode}">
      <header class="result__head">
        ${sum.mode === 'boss' && run.bossInfo.image
          ? `<div class="bossfinal ${sum.won ? 'is-defeated' : 'is-victor'}" aria-hidden="true"><img src="${esc(run.bossInfo.image)}" alt="" decoding="async">${sum.won ? '<span></span><span></span><span></span><span></span><span></span><span></span>' : ''}</div>`
          : sum.mode === 'boss' && sum.won ? `<div class="shatter" aria-hidden="true">${sealSvg(5)}<span></span><span></span><span></span><span></span><span></span><span></span></div>` : ''}
        ${['rescue', 'carousel'].includes(sum.mode) ? '' : stars(sum.stars, 'stars--big')}
        <h1>${esc(titles[sum.mode])}</h1>
        ${quote ? `<blockquote class="result__quote">„${esc(quote)}“</blockquote>` : ''}
        <p>${sub}</p>${hpNote ? `<p class="result__hpnote">${esc(hpNote)}</p>` : ''}
      </header>
      <dl class="result__stats">
        <div><dt>Richtig</dt><dd>${sum.correct}/${sum.mode === 'carousel' ? run.total : sum.answered}</dd></div>
        <div><dt>Punkte</dt><dd>${sum.score}</dd></div>
        <div><dt>${sum.mode === 'boss' ? 'Kritische Treffer' : 'Beste Serie'}</dt><dd>${sum.mode === 'boss' ? run.crits || 0 : sum.bestCombo}</dd></div>
        <div class="is-xp"><dt>Erfahrung</dt><dd>+${sum.xp} XP</dd></div>
        <div class="is-hp"><dt>HP</dt><dd>${pl.hp}/${pl.maxHp}</dd></div>
        <div class="is-coins"><dt>Quest-Coins</dt><dd>${pl.coins}</dd></div>
      </dl>
      ${lootHtml}
      ${achievements}
      <div class="result__actions">
        ${again}
        <button class="btn btn--ghost btn--xl" data-action="back-chapter">Zum Level</button>
      </div>
      ${review ? `<section class="review"><h2>Nachbesprechung</h2><ol>${review}</ol></section>` : ''}
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
  'toggle-sound': () => { S().settings.sound = !S().settings.sound; syncMusic(); renderHeader(); persist(); },
  'use-potion': (d) => usePotion(d.kind),
  'buy-item': (d) => buyItem(d.kind),
  'toggle-inv': () => toggleInv(),
  'boss-fight': () => startBossFight(),
  'boss-skip': () => finishBossIntro(),
  'use-item': (d) => useItem(d.item),
  'onboard-step': (d) => { ui.onboard.step = d.step; drawOnboard(); window.scrollTo({ top: 0 }); },
  'pick-class': (d) => { ui.onboard.pick = d.id; sfx('click'); drawOnboard(); },
  'confirm-class': () => confirmClass(),
  'open-help': () => { if (ui.run) { toast('Die Anleitung gibt es außerhalb eines Runs.', { icon: 'ℹ️' }); return; } toggleInv(false); openOnboard('help'); },
  'onboard-close': () => { const back = ui.onboard?.returnTo; if (back === 'chapter') renderChapter(); else if (back !== 'learn' && back !== 'result') renderDashboard(); showScreen(['chapter', 'learn', 'result'].includes(back) ? back : 'dashboard'); },
  'toggle-music': () => { S().settings.music = S().settings.music === false; syncMusic(); renderHeader(); persist(); },
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

// Inventar-Popover schließen: Klick daneben oder Escape
document.addEventListener('click', (e) => {
  if ($('invPop').hidden) return;
  if (!e.target.closest('.hpwrap')) toggleInv(false);
});

// Browser erlauben Ton erst nach einer Nutzeraktion
document.addEventListener('pointerdown', () => { if (S()) { Audio.unlockAudio(); syncMusic(); } }, { passive: true });

const HOTKEYS = { F1: 'focus', F2: 'pause', F3: 'heart', F4: 'skip' };
document.addEventListener('keydown', (e) => {
  if (HOTKEYS[e.key] && ui.screen === 'run' && ui.run) {
    e.preventDefault();   // F1 = Hilfe, F3 = Suchen im Browser – im Run übernehmen die Items
    useItem(HOTKEYS[e.key]);
    return;
  }
  if (S()) Audio.unlockAudio();
  if (e.key === 'Escape' && !$('invPop').hidden) { toggleInv(false); $('hpChip').focus(); return; }
  if (ui.screen !== 'run' || !ui.run || e.altKey || e.ctrlKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (ui.run.mode.id === 'boss' && !ui.run.started) {
    if (k === 'enter' || k === ' ') {
      e.preventDefault();
      if (!ui.run.introReady) finishBossIntro();
      else if (k === 'enter' || document.activeElement?.id === 'btnFight') startBossFight();
    }
    return;
  }

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
  if (t.classList?.contains('is-hit') || t.classList?.contains('is-crit') || t.classList?.contains('is-gloat')) t.classList.remove('is-hit', 'is-crit', 'is-gloat');
  if (t.classList?.contains('fx-hurt')) t.classList.remove('fx-hurt');
  if (t.id === 'hudLoot') t.classList.remove('is-new');
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
if (location.hash === '#demo') window.__quest = { ui, save, audio: Audio };

registerSW();
bootTerminal();
