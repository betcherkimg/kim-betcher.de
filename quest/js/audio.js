/* 34i-Quest – Audio
 * Alle Geräusche und die Musik werden live mit der Web Audio API erzeugt (Synthese).
 * Es werden keine fremden Aufnahmen verwendet – daher keine Lizenzfragen.
 *
 * Soundeffekte: sfx('coin'), sfx('hurt'), sfx('gulp') …
 * Musik:        setTrack('calm' | 'quest' | 'boss' | null)
 */

let ctx = null;
let master = null;
let sfxBus = null;
let musicBus = null;
let reverbSend = null;
let sfxOn = true;
let musicOn = true;
let wantedTrack = null;
const MUSIC_VOLUME = 0.2;

/* ---------- Grundgerüst ---------- */

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 4;
  master.connect(comp).connect(ctx.destination);

  sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.85;
  sfxBus.connect(master);

  musicBus = ctx.createGain();
  musicBus.gain.value = 0;
  musicBus.connect(master);

  // Hall für die Musik: selbst erzeugte Impulsantwort (abklingendes Rauschen)
  const conv = ctx.createConvolver();
  const len = Math.floor(ctx.sampleRate * 2.6);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
  }
  conv.buffer = ir;
  reverbSend = ctx.createGain();
  reverbSend.gain.value = 0.35;
  reverbSend.connect(conv).connect(musicBus);

  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend(); else ctx.resume();
  });
  return ctx;
}

/** Nach einer Nutzeraktion aufrufen – Browser erlauben Ton erst dann. */
export function unlockAudio() {
  if (!ensure()) return;
  if (ctx.state === 'suspended') ctx.resume();
  if (musicOn && wantedTrack) startMusic(wantedTrack);
}

export function setSfxEnabled(on) { sfxOn = !!on; }
export function setMusicEnabled(on) {
  musicOn = !!on;
  if (!ctx) return;
  if (musicOn && wantedTrack) startMusic(wantedTrack);
  else stopMusic();
}

/* ---------- Bausteine ---------- */

function env(g, t, peak, attack, release, hold = 0) {
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  if (hold) g.gain.setValueAtTime(Math.max(0.0002, peak), t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
}

function tone(freq, t, { type = 'sine', gain = 0.15, attack = 0.005, release = 0.25, hold = 0, dest = sfxBus, glideTo = null, detune = 0 } = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + attack + hold + release);
  o.detune.value = detune;
  env(g, t, gain, attack, release, hold);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + attack + hold + release + 0.05);
  return o;
}

let noiseBuf = null;
function noise(t, dur, { type = 'bandpass', freq = 1000, freqEnd = null, q = 1, gain = 0.1, dest = sfxBus, attack = 0.005 } = {}) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t, gain, attack, Math.max(0.01, dur - attack));
  src.connect(f).connect(g).connect(dest);
  src.start(t);
  src.stop(t + dur + 0.05);
}

/** Metallisches „Klink“ einer Münze: unharmonische Teiltöne, kurzes Abklingen */
function clink(t, base, gain = 0.07) {
  [1, 2.76, 5.4, 8.9].forEach((r, i) => tone(base * r, t, { gain: gain / (i + 1), release: 0.18 + Math.random() * 0.12, attack: 0.001 }));
}

/** „Ouuw“: Sägezahn mit Tonhöhenabfall durch zwei wandernde Formantfilter (o → u) */
function ouch(t) {
  const src = ctx.createOscillator();
  src.type = 'sawtooth';
  src.frequency.setValueAtTime(290, t);
  src.frequency.exponentialRampToValueAtTime(185, t + 0.5);
  const vib = ctx.createOscillator();
  const vibGain = ctx.createGain();
  vib.frequency.value = 6;
  vibGain.gain.value = 5;
  vib.connect(vibGain).connect(src.frequency);
  const out = ctx.createGain();
  env(out, t, 0.5, 0.04, 0.45, 0.08);
  [[620, 360, 9, 1], [1000, 700, 10, 0.6], [2500, 2300, 12, 0.12]].forEach(([f0, f1, q, amp]) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f1, t + 0.45);
    bp.Q.value = q;
    const a = ctx.createGain();
    a.gain.value = amp;
    src.connect(bp).connect(a).connect(out);
  });
  out.connect(sfxBus);
  src.start(t); vib.start(t);
  src.stop(t + 0.7); vib.stop(t + 0.7);
  noise(t, 0.08, { freq: 1800, q: 0.8, gain: 0.03 });
}

/** Ein Schluck: tiefes „Glug“ mit Tonhöhenabfall plus Bläschen */
function gulp(t) {
  tone(320, t, { type: 'sine', gain: 0.22, attack: 0.01, release: 0.12, glideTo: 110 });
  noise(t + 0.02, 0.09, { type: 'lowpass', freq: 700, freqEnd: 250, gain: 0.08 });
  tone(900, t + 0.06, { gain: 0.03, release: 0.05, glideTo: 1400 });
}

/* ---------- Soundeffekte ---------- */

export function sfx(kind) {
  if (!sfxOn || !ensure()) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + 0.01;
  switch (kind) {
    case 'ok': tone(660, t, { gain: 0.12, release: 0.12 }); tone(990, t + 0.08, { gain: 0.12, release: 0.22 }); break;
    case 'bad': tone(180, t, { type: 'square', gain: 0.05, release: 0.2, glideTo: 120 }); break;
    case 'tick': tone(1250, t, { gain: 0.05, release: 0.03 }); break;
    case 'click': tone(900, t, { gain: 0.04, release: 0.03 }); break;
    case 'hurt': ouch(t); break;
    case 'gulp': [0, 0.24, 0.48].forEach((d) => gulp(t + d)); tone(520, t + 0.8, { gain: 0.06, release: 0.3, glideTo: 780 }); break;
    case 'coin': for (let i = 0; i < 6; i++) clink(t + i * (0.045 + Math.random() * 0.04), 1900 + Math.random() * 1400); break;
    case 'spend':
      [0, 0.07, 0.14].forEach((d, i) => clink(t + d, 2600 - i * 450, 0.06));
      noise(t + 0.2, 0.12, { type: 'lowpass', freq: 400, gain: 0.08 });
      break;
    case 'win': [523, 659, 784, 1047].forEach((f, i) => { tone(f, t + i * 0.12, { type: 'triangle', gain: 0.12, release: 0.35 }); tone(f * 2, t + i * 0.12, { gain: 0.03, release: 0.3 }); }); break;
    case 'lose': [392, 330, 262].forEach((f, i) => tone(f, t + i * 0.18, { type: 'triangle', gain: 0.1, release: 0.4 })); break;
    case 'level': [784, 988, 1319, 1568].forEach((f, i) => tone(f, t + i * 0.08, { gain: 0.08, release: 0.3 })); break;
    case 'heart': tone(392, t, { type: 'triangle', gain: 0.12, release: 0.25 }); tone(587, t + 0.12, { type: 'triangle', gain: 0.12, release: 0.5 }); [1568, 2093].forEach((f, i) => tone(f, t + 0.25 + i * 0.07, { gain: 0.04, release: 0.4 })); break;
    case 'focus': [880, 1175, 1568].forEach((f, i) => tone(f, t + i * 0.05, { gain: 0.07, release: 0.2 })); break;
    case 'freeze': tone(2093, t, { gain: 0.07, release: 1.1 }); tone(2637, t + 0.05, { gain: 0.05, release: 1.0 }); noise(t, 0.6, { freq: 6000, freqEnd: 2500, q: 2, gain: 0.03 }); break;
    case 'skip': noise(t, 0.35, { freq: 400, freqEnd: 3500, q: 1.5, gain: 0.12 }); tone(700, t + 0.1, { gain: 0.05, release: 0.2, glideTo: 1400 }); break;
    case 'chest':
      noise(t, 0.35, { freq: 300, freqEnd: 900, q: 6, gain: 0.08 });
      for (let i = 0; i < 8; i++) clink(t + 0.35 + i * 0.05, 2000 + Math.random() * 1600, 0.06);
      break;
    case 'rumble': tone(55, t, { type: 'sawtooth', gain: 0.1, attack: 0.3, release: 0.7 }); tone(62, t + 0.2, { type: 'sawtooth', gain: 0.08, attack: 0.3, release: 0.6 }); break;
    case 'boss':
      tone(98, t, { type: 'sawtooth', gain: 0.14, release: 0.5 }); tone(73, t + 0.1, { type: 'sawtooth', gain: 0.12, release: 0.7 });
      noise(t, 0.4, { type: 'lowpass', freq: 200, gain: 0.2 });
      break;
    case 'denied': tone(220, t, { type: 'square', gain: 0.05, release: 0.08 }); tone(185, t + 0.09, { type: 'square', gain: 0.05, release: 0.12 }); break;
    default: break;
  }
}

/* ---------- Musik: kleine prozedurale RPG-Playlist ----------
 * Jede „Playlist“ hat mehrere Stücke (Akkordfolgen). Nach jeweils 8 Takten wechselt das Stück.
 * Instrumente: gezupfte Laute/Harfe (Arpeggio), weiche Fläche, Bass, bei Kampf leise Trommeln.
 */

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI → Hz

const TRACKS = {
  calm: {
    tempo: 68, drums: false, bassEvery: 4,
    songs: [
      [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]],        // Am F C G
      [[50, 53, 57], [55, 58, 62], [52, 55, 59], [57, 60, 64]],        // Dm Gm Em Am
      [[57, 60, 64], [52, 55, 59], [53, 57, 60], [52, 56, 59]],        // Am Em F E
    ],
    scale: [57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74, 76],
    melodyChance: 0.28, pattern: [0, 1, 2, 1, 0, 2, 1, 2],
  },
  quest: {
    tempo: 92, drums: 'soft', bassEvery: 2,
    songs: [
      [[50, 53, 57], [55, 59, 62], [50, 53, 57], [48, 52, 55]],        // Dm G Dm C
      [[46, 50, 53], [53, 57, 60], [48, 52, 55], [50, 53, 57]],        // Bb F C Dm
      [[50, 53, 57], [48, 52, 55], [46, 50, 53], [45, 49, 52]],        // Dm C Bb A
    ],
    scale: [62, 64, 65, 67, 69, 71, 72, 74, 76, 77],
    melodyChance: 0.38, pattern: [0, 2, 1, 2, 0, 2, 1, 2],
  },
  boss: {
    tempo: 124, drums: 'war', bassEvery: 1,
    songs: [
      [[52, 55, 59], [53, 57, 60], [52, 55, 59], [50, 54, 57]],        // Em F Em D
      [[52, 55, 59], [48, 52, 55], [53, 57, 60], [47, 50, 54]],        // Em C F B°
    ],
    scale: [64, 65, 67, 69, 71, 72, 74, 76],
    melodyChance: 0.3, pattern: [0, 1, 2, 1, 0, 1, 2, 1],
  },
};

const music = { timer: 0, track: null, song: 0, step: 0, nextTime: 0, motif: [], pending: 0 };

function pluck(freq, t, gain, dur = 1.1) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(3200, t);
  lp.frequency.exponentialRampToValueAtTime(900, t + dur);
  const g = ctx.createGain();
  env(g, t, gain, 0.004, dur);
  [['triangle', 1, 1], ['sine', 2, 0.35]].forEach(([type, mult, amp]) => {
    const o = ctx.createOscillator();
    const a = ctx.createGain();
    o.type = type;
    o.frequency.value = freq * mult;
    a.gain.value = amp;
    o.connect(a).connect(lp);
    o.start(t);
    o.stop(t + dur + 0.05);
  });
  lp.connect(g);
  g.connect(musicBus);
  g.connect(reverbSend);
}

function pad(chord, t, dur, gain) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 850;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + dur * 0.35);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  chord.forEach((n) => [-6, 6].forEach((det) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = NOTE(n);
    o.detune.value = det;
    o.connect(lp);
    o.start(t);
    o.stop(t + dur + 0.05);
  }));
  lp.connect(g);
  g.connect(musicBus);
  g.connect(reverbSend);
}

function drum(t, kind) {
  if (kind === 'low') {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.25);
    env(g, t, 0.35, 0.003, 0.3);
    o.connect(g).connect(musicBus);
    o.start(t);
    o.stop(t + 0.35);
  } else {
    const src = ctx.createBufferSource();
    if (!noiseBuf) { noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = kind === 'tap' ? 2200 : 900;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    env(g, t, kind === 'tap' ? 0.05 : 0.09, 0.002, 0.08);
    src.connect(f).connect(g).connect(musicBus);
    src.start(t);
    src.stop(t + 0.12);
  }
}

function newMotif(cfg) {
  const len = 4;
  let idx = Math.floor(cfg.scale.length / 3);
  music.motif = Array.from({ length: len }, () => {
    idx = Math.max(0, Math.min(cfg.scale.length - 1, idx + [-2, -1, 1, 2, 0][Math.floor(Math.random() * 5)]));
    return cfg.scale[idx];
  });
}

function scheduleStep(cfg, t) {
  const eighth = 60 / cfg.tempo / 2;
  const song = cfg.songs[music.song % cfg.songs.length];
  const stepInBar = music.step % 8;
  const bar = Math.floor(music.step / 8);
  const chord = song[bar % song.length];

  // Arpeggio
  const note = chord[cfg.pattern[stepInBar]] + 12;
  pluck(NOTE(note), t, 0.075, cfg.tempo > 110 ? 0.5 : 1.2);

  // Fläche am Taktanfang
  if (stepInBar === 0) pad(chord, t, eighth * 8, cfg.drums === 'war' ? 0.012 : 0.018);

  // Bass
  const bassSteps = 8 / (cfg.bassEvery * 2);
  if (stepInBar % Math.max(1, Math.round(bassSteps)) === 0) pluck(NOTE(chord[0] - 12), t, 0.11, cfg.tempo > 110 ? 0.35 : 0.9);

  // Melodie: wiederkehrendes Motiv mit Varianten
  if (stepInBar % 2 === 0 && Math.random() < cfg.melodyChance) {
    const m = music.motif[(stepInBar / 2) % music.motif.length];
    const n = Math.random() < 0.2 ? m + 12 : m;
    pluck(NOTE(n + 12), t + (Math.random() < 0.2 ? eighth / 2 : 0), 0.05, 1.4);
  }

  // Trommeln
  if (cfg.drums === 'soft') {
    if (stepInBar === 0 || stepInBar === 4) drum(t, 'hand');
    if (stepInBar % 2 === 1 && Math.random() < 0.5) drum(t, 'tap');
  } else if (cfg.drums === 'war') {
    if (stepInBar % 2 === 0) drum(t, 'low');
    if (stepInBar === 3 || stepInBar === 7) drum(t, 'hand');
    drum(t, 'tap');
  }

  music.step += 1;
  // Nach 8 Takten nächstes Stück der Playlist, neues Motiv alle 4 Takte
  if (music.step % 32 === 0) newMotif(cfg);
  if (music.step % 64 === 0) music.song += 1;
}

function scheduler() {
  const cfg = TRACKS[music.track];
  if (!cfg || !ctx) return;
  const eighth = 60 / cfg.tempo / 2;
  while (music.nextTime < ctx.currentTime + 0.15) {
    scheduleStep(cfg, music.nextTime);
    music.nextTime += eighth;
  }
}

function startMusic(track) {
  if (!ensure() || !TRACKS[track]) return;
  if (music.track === track && music.timer) return;
  clearTimeout(music.pending);
  const fadeIn = () => {
    music.pending = 0;
    music.track = track;
    music.song = Math.floor(Math.random() * TRACKS[track].songs.length);
    music.step = 0;
    music.nextTime = ctx.currentTime + 0.1;
    newMotif(TRACKS[track]);
    clearInterval(music.timer);
    music.timer = setInterval(scheduler, 30);
    musicBus.gain.cancelScheduledValues(ctx.currentTime);
    musicBus.gain.setValueAtTime(Math.max(0.0001, musicBus.gain.value), ctx.currentTime);
    musicBus.gain.linearRampToValueAtTime(MUSIC_VOLUME, ctx.currentTime + 1.5);
  };
  if (music.timer) {
    // Überblenden: kurz ausblenden, dann neues Stück
    musicBus.gain.cancelScheduledValues(ctx.currentTime);
    musicBus.gain.setValueAtTime(musicBus.gain.value, ctx.currentTime);
    musicBus.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    clearInterval(music.timer);
    music.timer = 0;
    music.pending = setTimeout(fadeIn, 650);
  } else {
    fadeIn();
  }
}

function stopMusic() {
  if (!ctx) return;
  clearTimeout(music.pending);
  music.pending = 0;
  clearInterval(music.timer);
  music.timer = 0;
  music.track = null;
  musicBus.gain.cancelScheduledValues(ctx.currentTime);
  musicBus.gain.setValueAtTime(musicBus.gain.value, ctx.currentTime);
  musicBus.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.8);
}

/** Gewünschte Musik für den aktuellen Bildschirm setzen (null = still) */
export function setTrack(track) {
  wantedTrack = track;
  if (!ctx || !musicOn) return;
  if (!track) stopMusic();
  else startMusic(track);
}

/** Nur für Tests/Diagnose */
export function audioStatus() {
  return { state: ctx ? ctx.state : 'none', track: music.track, musicOn, sfxOn, gain: musicBus ? musicBus.gain.value : 0 };
}
