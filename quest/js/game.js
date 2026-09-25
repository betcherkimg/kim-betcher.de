/* 34i-Quest – Spiellogik (ohne DOM)
 * Fragenauswahl, Antwort-Mischen, Runs, Punkte, XP, Ränge, Erfolge, Countdown.
 */

export const MODES = {
  story:    { id: 'story',    label: 'Story',     count: 10, lives: 3, seconds: 0,  source: 'questions', winXp: 60 },
  versus:   { id: 'versus',   label: 'Versus',    count: 5,  lives: 1, seconds: 0,  source: 'questions', winXp: 80 },
  // Boss: 6 Fragen, 15 s. 4 richtige besiegen den Boss, 3 Fehler verlieren den Kampf (4 + 2 = 6 geht immer auf).
  boss:     { id: 'boss',     label: 'Boss',      count: 6,  lives: 3, seconds: 15, source: 'boss',      winXp: 150, killHits: 4 },
  carousel: { id: 'carousel', label: 'Karussell', count: 999, lives: 3, seconds: 0, source: 'all',       winXp: 200 },
  rescue: { id: 'rescue', label: 'Rettungsmission', count: 3, lives: 1, seconds: 0, source: 'questions', winXp: 10 },
};


/* ---------- Globale HP & Loot ---------- */

export const MAX_HP = 100;

// Verlust bei einem komplett verlorenen Modus-Run (Prozentpunkte vom Maximal-HP-Wert).
export const MODE_HP_LOSS = { story: 25, versus: 33, boss: 50 };

export const POTIONS = {
  small:  { id: 'small',  label: 'Kleiner Heiltrank', heal: 25, icon: '🧪' },
  medium: { id: 'medium', label: 'Mittlerer Heiltrank', heal: 33, icon: '⚗️' },
  large:  { id: 'large',  label: 'Großer Heiltrank', heal: 50, icon: '🧴' },
  spark:  { id: 'spark',  label: 'Lebensfunke', heal: 100, icon: '✨' },
};

/**
 * Lootchance nach Schwierigkeit. Nur richtige Antworten würfeln Loot.
 * Schwierigkeit 1: gelegentlich kleiner Trank.
 * Schwierigkeit 2: kleine/mittlere Tränke.
 * Schwierigkeit 3: alle Tränke; Lebensfunke sehr selten (1 %).
 */
export function rollQuestionReward(question, rng = Math.random, luck = 1) {
  // Tränke sind bewusst selten – die normale Quelle ist der Shop (Quest-Coins).
  // luck: Multiplikator der Fundchance (Glückspilz = 2)
  const d = Math.max(1, Math.min(3, Number(question?.difficulty) || 1));
  const r = rng();
  if (d >= 3) {
    if (r < 0.003 * luck) return POTIONS.spark;   // 0,3 % Lebensfunke
    if (r < 0.018 * luck) return POTIONS.large;   // weitere 1,5 % großer Heiltrank
    return null;
  }
  if (d === 2) return r < 0.02 * luck ? POTIONS.medium : null;  // 2 %
  return r < 0.02 * luck ? POTIONS.small : null;                // 2 %
}

/* ---------- Charakterklassen (Wahl beim Anlegen des Spielstands) ---------- */

export const HERO_CLASSES = {
  collector: {
    id: 'collector', name: 'Sammler', icon: '💰', color: '#E9A400',
    bonus: 'Doppelte Quest-Coins', short: 'Coins ×2',
    text: 'Jede Belohnung in Coins zählt doppelt – Siege, Truhen und Level-Abschlüsse.',
    fit: 'Für alle, die viel spielen und sich im Shop groß eindecken wollen.',
    coinMult: 2, priceMult: 1, luck: 1, dailyFocus: 1,
  },
  saver: {
    id: 'saver', name: 'Sparfuchs', icon: '🦊', color: '#E0682B',
    bonus: 'Alle Items zum halben Preis', short: 'Items ×0,5',
    text: 'Heiltränke, Lebensfunke und Kampf-Items kosten im Shop und in der Hotbar nur die Hälfte.',
    fit: 'Für alle, die gern Items einsetzen – Herz und Überspringer inklusive.',
    coinMult: 1, priceMult: 0.5, luck: 1, dailyFocus: 1,
  },
  normal: {
    id: 'normal', name: 'Normalo', icon: '🧭', color: '#0A6CF5',
    bonus: 'Täglich 2× Fokus gratis', short: '2 Fokus/Tag',
    text: 'Jeden Tag stehen dir zwei kostenlose Fokus-Einsätze (+10 s im Boss) bereit. Nicht Genutztes verfällt um Mitternacht.',
    fit: 'Für alle, die jeden Tag ein bisschen lernen und im Boss mehr Zeit brauchen.',
    coinMult: 1, priceMult: 1, luck: 1, dailyFocus: 2,
  },
  lucky: {
    id: 'lucky', name: 'Glückspilz', icon: '🍀', color: '#0E9F6E',
    bonus: 'Doppelte Fundchance für Items', short: 'Funde ×2',
    text: 'Tränke und Lebensfunken fallen doppelt so oft – bei Fragen und als Zugabe in Truhen.',
    fit: 'Für alle, die sich gern überraschen lassen.',
    coinMult: 1, priceMult: 1, luck: 2, dailyFocus: 1,
  },
};
export const HERO_CLASS_ORDER = ['collector', 'saver', 'normal', 'lucky'];
/** Ohne gewählte Klasse gelten neutrale Werte */
export const NO_CLASS = { id: null, coinMult: 1, priceMult: 1, luck: 1, dailyFocus: 1 };
export function heroClass(id) { return HERO_CLASSES[id] || NO_CLASS; }

/* ---------- Kampf-Items (Hotbar F1–F4) ---------- */

export const BATTLE_ITEMS = {
  focus: { id: 'focus', key: 'F1', label: 'Fokus',        icon: '⏳', price: 30,  modes: ['boss'],
           text: '+10 Sekunden für die aktuelle Frage' },
  pause: { id: 'pause', key: 'F2', label: 'Pauser',       icon: '⏸️', price: 60,  modes: ['boss'],
           text: 'Hält den Timer an – in Ruhe antworten' },
  heart: { id: 'heart', key: 'F3', label: 'Herz',         icon: '❤️', price: 120, modes: ['story', 'versus', 'boss', 'carousel'],
           text: 'Ein verlorenes Leben zurück' },
  skip:  { id: 'skip',  key: 'F4', label: 'Überspringer', icon: '⏭️', price: 250, modes: ['story', 'versus', 'boss', 'carousel'],
           text: 'Frage überspringen – ohne Leben zu verlieren' },
};
export const BATTLE_ITEM_ORDER = ['focus', 'pause', 'heart', 'skip'];

/* ---------- Karussell ---------- */

/** Reihenfolge: normale Fragen von leicht nach schwer, danach die Bossfragen */
export function carouselOrder(questions, bossQuestions) {
  const sortKey = (q) => [(q.difficulty || 1), (q.taxonomyLevel || 1), q.storyOrder || 0];
  const cmp = (a, b) => { const x = sortKey(a); const y = sortKey(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  return [...[...questions].sort(cmp), ...[...(bossQuestions || [])].sort(cmp)];
}

/** Truhen nach Anteil richtig beantworteter Fragen */
export const CAROUSEL_CHESTS = [
  { min: 1.0,  id: 'legend', label: 'Legendäre Truhe', coins: 150, potion: 'large',  potionChance: 1,    sparkChance: 0.05 },
  { min: 0.75, id: 'gold',   label: 'Goldtruhe',       coins: 75,  potion: 'medium', potionChance: 0.25, sparkChance: 0 },
  { min: 0.5,  id: 'silver', label: 'Silbertruhe',     coins: 35,  potion: 'small',  potionChance: 0.1,  sparkChance: 0 },
  { min: 0.25, id: 'wood',   label: 'Holztruhe',       coins: 15,  potion: null,     potionChance: 0,    sparkChance: 0 },
];
export function carouselChest(ratio) {
  return CAROUSEL_CHESTS.find((c) => ratio >= c.min) || null;
}

/* ---------- Quest-Coins & Shop ---------- */

/** Coins pro gewonnenem Modus: Grundwert, Bonus für 3 Sterne, erster Sieg im Level zählt doppelt */
export const COIN_REWARDS = {
  story:  { base: 10, perfect: 5 },
  versus: { base: 20, perfect: 10 },
  boss:   { base: 50, perfect: 25 },
};
export const COIN_FIRST_WIN_MULTIPLIER = 2;
export const COIN_LEVEL_COMPLETE = 100;

export const SHOP = {
  small:  { price: 50 },
  medium: { price: 100 },
  large:  { price: 200 },
  spark:  { price: 500, max: 1 },   // Lebensfunke: höchstens einer im Inventar
  focus:  { price: 30 },
  pause:  { price: 60 },
  heart:  { price: 120 },
  skip:   { price: 250 },
};

/** Coins für einen gewonnenen Run berechnen */
export function coinsForWin(modeId, stars, firstWin) {
  const r = COIN_REWARDS[modeId];
  if (!r) return { total: 0, base: 0, perfect: 0, first: 0 };
  const base = r.base;
  const perfect = stars === 3 ? r.perfect : 0;
  const first = firstWin ? base * (COIN_FIRST_WIN_MULTIPLIER - 1) : 0;
  return { total: base + perfect + first, base, perfect, first };
}

/* ---------- Bossfight-Extras ---------- */

/** Rettungsmission bei 0 HP: 3 leichte Fragen in Folge richtig → so viele HP zurück */
export const RESCUE_HEAL = 30;
/** Mit so vielen Restsekunden gilt ein Boss-Treffer als kritisch */
export const BOSS_CRIT_SECONDS = 11;   // bei 15 s: Antwort innerhalb von 4 s
/** Fokus-Item: Zeit der aktuellen Frage verlängern; jeden Tag gibt es einen Fokus geschenkt */
export const BOSS_FOCUS_SECONDS = 10;
/** Kostenlose Fokus-Einsätze pro Tag (Grundwert, Normalo: 2). Nicht stapelbar – Ungenutztes verfällt. */
export const DAILY_FOCUS_GIFT = 1;
/** Siegtruhe nach gewonnenem Bossfight: Sterne → garantierter Trank */
/** Siegtruhe: Coins kommen über COIN_REWARDS; mit etwas Glück liegt zusätzlich ein Trank darin */
export const BOSS_CHEST_POTION_CHANCE = { 3: 0.15, 2: 0.08, 1: 0.04 };

export const BOSS_TAUNTS = {
  intro: 'Du willst an mir vorbei? Dann zeig, was du gelernt hast.',
  hit: ['Treffer … das wird Folgen haben.', 'Glück gehabt.', 'Nicht schlecht, Anfänger.'],
  miss: ['Falsch! Das kostet dich.', 'Daneben!', 'So wird das nichts.'],
  timeout: ['Zu langsam!', 'Die Zeit arbeitet für mich.'],
  final: 'Letzte Frage. Jetzt oder nie!',
  low: 'Ich … bin noch nicht erledigt!',
  defeat: 'Du hast gewonnen. Diesmal.',
  victory: 'Zurück ins Lernskript mit dir!',
};

/** Bossfight erst nach gewonnenem Storymode freischalten (auf false setzen, um das abzuschalten). */
// TESTPHASE: Bossfights sind frei spielbar. Für den Echtbetrieb wieder auf true setzen.
export const BOSS_REQUIRES_STORY = false;

/* ---------- Zufall ---------- */

export function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Gewichtete Ziehung ohne Zurücklegen. */
function weightedPick(items, n, weightOf) {
  const pool = items.map((it) => ({ it, w: Math.max(0.01, weightOf(it)) }));
  const out = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((s, p) => s + p.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) { r -= pool[idx].w; if (r <= 0) break; }
    out.push(pool.splice(idx, 1)[0].it);
  }
  return out;
}

/**
 * Zuletzt gespielte Fragen möglichst meiden – erst wenn der Pool zu klein ist, dürfen sie zurück.
 */
function avoidRecent(pool, recent, needed) {
  const recentSet = new Set(recent);
  const fresh = pool.filter((q) => !recentSet.has(q.id));
  if (fresh.length >= needed) return fresh;
  return [...fresh, ...shuffle(pool.filter((q) => recentSet.has(q.id)))].slice(0, Math.max(needed, fresh.length));
}

/* ---------- Fragenauswahl pro Modus ---------- */

export function selectQuestions(modeId, pool, { recent = [], mistakes = {} } = {}) {
  const mode = MODES[modeId];
  if (!mode || !Array.isArray(pool) || pool.length === 0) return [];
  const n = Math.min(mode.count, pool.length);

  if (modeId === 'story') {
    // Chronologisch nach storyOrder, nur Stufe 1–2. Der Pool wird in n Abschnitte geteilt,
    // aus jedem kommt eine Frage – bevorzugt eine, die zuletzt nicht dran war.
    const ordered = pool.filter((q) => (q.taxonomyLevel || 1) <= 2).sort((a, b) => a.storyOrder - b.storyOrder);
    const recentSet = new Set(recent);
    const picks = [];
    for (let i = 0; i < n; i++) {
      const bucket = ordered.slice(Math.floor((i * ordered.length) / n), Math.floor(((i + 1) * ordered.length) / n));
      if (!bucket.length) continue;
      const fresh = bucket.filter((q) => !recentSet.has(q.id));
      const from = fresh.length ? fresh : bucket;
      picks.push(from[Math.floor(Math.random() * from.length)]);
    }
    return picks;
  }

  const candidates = avoidRecent(pool, recent, n);
  if (modeId === 'versus') {
    // Zufällig, Schwerpunkt Anwendung (Stufe 2) und eigene Fehler
    return weightedPick(candidates, n, (q) => ((q.taxonomyLevel || 1) >= 2 ? 1.6 : 1) * (1 + Math.min(2, mistakes[q.id] || 0) * 0.5));
  }
  return shuffle(candidates).slice(0, n);
}

/** Antworten mischen – die richtigen Indizes werden mitverschoben. */
export function prepareQuestion(q, doShuffle = true) {
  const order = q.answers.map((_, i) => i);
  const perm = doShuffle ? shuffle(order) : order;
  return {
    ...q,
    answers: perm.map((i) => q.answers[i]),
    correct: q.correct.map((c) => perm.indexOf(c)).sort((a, b) => a - b),
    originalOrder: perm,
  };
}

export function isCorrect(q, selected) {
  if (!Array.isArray(selected) || selected.length !== q.correct.length) return false;
  const s = new Set(selected);
  return q.correct.every((c) => s.has(c));
}

/* ---------- Ein Durchlauf ---------- */

export class Run {
  constructor(modeId, chapterId, questions) {
    this.mode = MODES[modeId];
    this.chapterId = chapterId;
    this.questions = questions;
    this.idx = 0;
    this.lives = this.mode.lives;
    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.xp = 0;
    this.results = [];   // { question, selected, correct, timedOut, secondsLeft }
    this.finished = false;
  }

  get current() { return this.questions[this.idx] || null; }
  get total() { return this.questions.length; }
  get correctCount() { return this.results.filter((r) => r.correct).length; }

  /** selected = Array von Indizes; timedOut = true bei abgelaufener Zeit. */
  answer(selected, { timedOut = false, secondsLeft = 0 } = {}) {
    if (this.finished || !this.current) return null;
    const q = this.current;
    const ok = !timedOut && isCorrect(q, selected);
    let gainedScore = 0;
    let gainedXp = 0;
    if (ok) {
      this.combo += 1;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      const comboBonus = Math.min(this.combo - 1, 5) * 20;
      const timeBonus = this.mode.seconds ? Math.round(secondsLeft * 10) : 0;
      gainedScore = 100 + comboBonus + timeBonus;
      gainedXp = 8 + 4 * (q.difficulty || 1) + (this.combo >= 3 ? 5 : 0) + (this.mode.seconds ? Math.round(secondsLeft) : 0);
    } else {
      this.combo = 0;
      this.lives -= 1;
    }
    this.score += gainedScore;
    this.xp += gainedXp;
    this.results.push({ question: q, selected: [...(selected || [])], correct: ok, timedOut, secondsLeft });
    const last = this.idx >= this.total - 1;
    this.finished = this.lives <= 0 || last || this.decided;
    return { correct: ok, gainedScore, gainedXp, lives: this.lives, combo: this.combo, finished: this.finished };
  }

  next() {
    if (this.finished) return false;
    this.idx += 1;
    return true;
  }

  get won() {
    // Boss: gewonnen, sobald genug Treffer gelandet sind. Andere Modi: alle Fragen mit Leben übrig.
    if (this.mode.killHits) return this.finished && this.lives > 0 && this.correctCount >= this.mode.killHits;
    return this.finished && this.lives > 0 && this.results.length === this.total;
  }

  /** Frage überspringen: zählt weder als richtig noch als Fehler, kostet kein Leben. */
  skip() {
    if (this.finished || !this.current) return null;
    this.results.push({ question: this.current, selected: [], correct: false, skipped: true, timedOut: false, secondsLeft: 0 });
    const last = this.idx >= this.total - 1;
    this.finished = last || this.decided;
    return { finished: this.finished };
  }

  /** Ein Leben zurück (Herz). Nicht über das Maximum des Modus. */
  restoreLife() {
    if (this.lives >= this.mode.lives) return false;
    const dead = this.lives <= 0;
    if (this.finished && !dead) return false;          // regulär zu Ende gespielt
    this.lives += 1;
    if (dead) this.finished = this.results.length >= this.total || this.decided;  // Wiederbelebt: weiter, falls noch offen
    return true;
  }

  /** Boss: Kampf entschieden – genug Treffer oder rechnerisch nicht mehr erreichbar */
  get decided() {
    const need = this.mode.killHits;
    if (!need) return false;
    const remaining = this.total - this.results.length;
    return this.correctCount >= need || this.correctCount + remaining < need;
  }

  get mistakes() { return this.results.filter((r) => !r.correct && !r.skipped).length; }
  get skipped() { return this.results.filter((r) => r.skipped).length; }

  get stars() {
    if (!this.won) return 0;
    // Sterne nach Fehlern, nicht nach Leben – sonst ließen sich Sterne mit Herzen zurückkaufen
    const lost = Math.min(this.mistakes, this.mode.lives);
    return Math.max(1, 3 - lost);
  }

  summary() {
    const bonus = this.won ? this.mode.winXp + (this.stars === 3 ? 40 : 0) : 0;
    return {
      mode: this.mode.id, won: this.won, stars: this.stars, score: this.score,
      correct: this.correctCount, total: this.total, answered: this.results.length,
      bestCombo: this.bestCombo, xp: this.xp + bonus, bonusXp: bonus, lives: this.lives,
    };
  }
}

/* ---------- Ränge & XP ---------- */

export const RANKS = [
  { xp: 0,    title: 'Azubi am Aktenschrank' },
  { xp: 250,  title: 'Flurstück-Scout' },
  { xp: 700,  title: 'Grundbuch-Leser' },
  { xp: 1500, title: 'Auflassungs-Profi' },
  { xp: 3000, title: 'Notar-Schreck' },
  { xp: 5000, title: '34i-Legende' },
];

export function rankFor(xp) {
  let i = 0;
  while (i < RANKS.length - 1 && xp >= RANKS[i + 1].xp) i++;
  const cur = RANKS[i];
  const next = RANKS[i + 1] || null;
  const pct = next ? Math.round(((xp - cur.xp) / (next.xp - cur.xp)) * 100) : 100;
  return { level: i + 1, title: cur.title, next, pct, toNext: next ? next.xp - xp : 0 };
}

/* ---------- Erfolge ---------- */

export const ACHIEVEMENTS = [
  { id: 'first_hit',     icon: '🎯', title: 'Erster Treffer',    text: 'Erste Frage richtig beantwortet.' },
  { id: 'combo_5',       icon: '🔥', title: 'Heiße Serie',       text: '5 richtige Antworten am Stück.' },
  { id: 'combo_10',      icon: '⚡', title: 'Unaufhaltsam',      text: '10 richtige Antworten am Stück.' },
  { id: 'scholar',       icon: '📘', title: 'Durchgelesen',      text: 'Ein Lernskript komplett verstanden.' },
  { id: 'story_win',     icon: '📖', title: 'Story erzählt',     text: 'Story gewonnen.' },
  { id: 'story_perfect', icon: '🌟', title: 'Makellos',          text: 'Story ohne Fehler.' },
  { id: 'versus_win',    icon: '⚔️', title: 'Duellant',          text: 'Versus gewonnen.' },
  { id: 'boss_slayer',   icon: '👑', title: 'Bossbezwinger',     text: 'Einen Boss besiegt.' },
  { id: 'boss_perfect',  icon: '🛡️', title: 'Unverwundbar',      text: 'Boss ohne Lebensverlust besiegt.' },
  { id: 'quick_draw',    icon: '⏱️', title: 'Schnellzieher',     text: 'Bossfrage in unter 3 Sekunden richtig.' },
  { id: 'streak_3',      icon: '📅', title: 'Dranbleiber',       text: 'An 3 Tagen in Folge gelernt.' },
  { id: 'master',        icon: '🏆', title: 'Level gemeistert',   text: 'Lernskript, Story, Versus und Boss eines Levels geschafft.' },
  { id: 'loot',          icon: '🧪', title: 'Sammler',            text: 'Den ersten Heiltrank gefunden.' },
  { id: 'spark',         icon: '✨', title: 'Funkenfund',         text: 'Einen Lebensfunken gefunden.' },
  { id: 'revived',       icon: '💫', title: 'Zweites Leben',      text: 'Vom Lebensfunken gerettet.' },
  { id: 'shopper',       icon: '🪙', title: 'Kundschaft',         text: 'Den ersten Gegenstand im Shop gekauft.' },
  { id: 'rich',          icon: '💰', title: 'Schatzmeister',      text: '500 Quest-Coins auf einmal besessen.' },
  { id: 'carousel_50',   icon: '🎠', title: 'Karussellfahrer',    text: 'Im Karussell die Hälfte der Fragen geschafft.' },
  { id: 'carousel_100',  icon: '🏵️', title: 'Endlosrunde',        text: 'Im Karussell alle Fragen eines Levels geschafft.' },
  { id: 'crit_king',     icon: '💥', title: 'Kritischer Schlag',  text: 'Drei kritische Treffer in einem Bosskampf.' },
];

/* ---------- Countdown ---------- */

/** Countdown mit requestAnimationFrame. start() stoppt immer zuerst einen laufenden Timer. */
export class Countdown {
  constructor() { this.raf = 0; this.running = false; }

  start(seconds, onTick, onEnd) {
    this.stop();
    this.frozen = false;
    this.frozenLeft = 0;
    this.running = true;
    const t0 = performance.now();
    this.startedAt = t0;
    this.total = seconds * 1000;
    const loop = (now) => {
      if (!this.running) return;
      const left = Math.max(0, this.total - (now - t0));
      onTick(left / 1000, Math.min(1, left / (seconds * 1000)));
      if (left <= 0) { this.stop(); onEnd(); return; }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Countdown anhalten (Pauser): Restzeit bleibt stehen, der Timer läuft für diese Frage nicht weiter. */
  freeze() {
    if (!this.running) return false;
    this.frozenLeft = this.secondsLeft();
    this.stop();
    this.frozen = true;
    return true;
  }

  /** Zeit verlängern (Fokus). Wirkt nur, solange der Countdown läuft. */
  extend(seconds) {
    if (!this.running) return false;
    this.total += seconds * 1000;
    return true;
  }

  secondsLeft() {
    if (this.frozen) return this.frozenLeft || 0;
    if (!this.running) return 0;
    return Math.max(0, (this.total - (performance.now() - this.startedAt)) / 1000);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
