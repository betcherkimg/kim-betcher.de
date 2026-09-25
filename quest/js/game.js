/* 34i-Quest – Spiellogik (ohne DOM)
 * Fragenauswahl, Antwort-Mischen, Runs, Punkte, XP, Ränge, Erfolge, Countdown.
 */

export const MODES = {
  story:  { id: 'story',  label: 'Storymode', count: 10, lives: 3, seconds: 0,  source: 'questions', winXp: 60 },
  versus: { id: 'versus', label: 'Versus',    count: 5,  lives: 1, seconds: 0,  source: 'questions', winXp: 80 },
  boss:   { id: 'boss',   label: 'Bossfight', count: 5,  lives: 3, seconds: 10, source: 'boss',      winXp: 150 },
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
export function rollQuestionReward(question, rng = Math.random) {
  const d = Math.max(1, Math.min(3, Number(question?.difficulty) || 1));
  const r = rng();

  // Loot folgt klar der Schwierigkeit: leicht -> klein, mittel -> mittel,
  // schwer -> groß. Nur bei schweren Fragen kann sehr selten ein Lebensfunke fallen.
  if (d >= 3) {
    if (r < 0.01) return POTIONS.spark;  // 1 % Lebensfunke
    if (r < 0.10) return POTIONS.large; // weitere 9 % großer Heiltrank
    return null;
  }
  if (d === 2) return r < 0.11 ? POTIONS.medium : null;
  return r < 0.12 ? POTIONS.small : null;
}

/* ---------- Bossfight-Extras ---------- */

/** Rettungsmission bei 0 HP: 3 leichte Fragen in Folge richtig → so viele HP zurück */
export const RESCUE_HEAL = 30;
/** Mit so vielen Restsekunden gilt ein Boss-Treffer als kritisch */
export const BOSS_CRIT_SECONDS = 6;
/** Fokus: einmal pro Bossfight die Zeit der aktuellen Frage verlängern */
export const BOSS_FOCUS_SECONDS = 5;
/** Siegtruhe nach gewonnenem Bossfight: Sterne → garantierter Trank */
export const BOSS_CHEST = { 3: 'large', 2: 'medium', 1: 'small' };

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
    this.finished = this.lives <= 0 || last;
    return { correct: ok, gainedScore, gainedXp, lives: this.lives, combo: this.combo, finished: this.finished };
  }

  next() {
    if (this.finished) return false;
    this.idx += 1;
    return true;
  }

  get won() {
    return this.finished && this.lives > 0 && this.results.length === this.total;
  }

  get stars() {
    if (!this.won) return 0;
    const lost = this.mode.lives - this.lives;
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
  { id: 'story_win',     icon: '📖', title: 'Story erzählt',     text: 'Storymode gewonnen.' },
  { id: 'story_perfect', icon: '🌟', title: 'Makellos',          text: 'Storymode ohne Fehler.' },
  { id: 'versus_win',    icon: '⚔️', title: 'Duellant',          text: 'Versus gewonnen.' },
  { id: 'boss_slayer',   icon: '👑', title: 'Bossbezwinger',     text: 'Einen Boss besiegt.' },
  { id: 'boss_perfect',  icon: '🛡️', title: 'Unverwundbar',      text: 'Boss ohne Lebensverlust besiegt.' },
  { id: 'quick_draw',    icon: '⏱️', title: 'Schnellzieher',     text: 'Bossfrage in unter 3 Sekunden richtig.' },
  { id: 'streak_3',      icon: '📅', title: 'Dranbleiber',       text: 'An 3 Tagen in Folge gelernt.' },
  { id: 'master',        icon: '🏆', title: 'Level gemeistert',   text: 'Lernskript, Story, Versus und Bossfight eines Levels geschafft.' },
  { id: 'loot',          icon: '🧪', title: 'Sammler',            text: 'Den ersten Heiltrank gefunden.' },
  { id: 'spark',         icon: '✨', title: 'Funkenfund',         text: 'Einen Lebensfunken gefunden.' },
  { id: 'revived',       icon: '💫', title: 'Zweites Leben',      text: 'Vom Lebensfunken gerettet.' },
  { id: 'crit_king',     icon: '💥', title: 'Kritischer Schlag',  text: 'Drei kritische Treffer in einem Bossfight.' },
];

/* ---------- Countdown ---------- */

/** Countdown mit requestAnimationFrame. start() stoppt immer zuerst einen laufenden Timer. */
export class Countdown {
  constructor() { this.raf = 0; this.running = false; }

  start(seconds, onTick, onEnd) {
    this.stop();
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

  /** Zeit verlängern (Fokus). Wirkt nur, solange der Countdown läuft. */
  extend(seconds) {
    if (!this.running) return false;
    this.total += seconds * 1000;
    return true;
  }

  secondsLeft() {
    if (!this.running) return 0;
    return Math.max(0, (this.total - (performance.now() - this.startedAt)) / 1000);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
