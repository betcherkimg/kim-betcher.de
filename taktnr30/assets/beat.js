/* TAKT Nr. 30 – Hintergrund-Track: deutscher Hardtekk mit Melodie, live im Browser erzeugt
   (keine Audiodatei, keine Lizenzfragen). 192 BPM, F-Moll, 96 Takte = genau 2:00, zwei Drops.
   Aufbau: Komposition (Noten) · Instrumente · Arrangement · Wiedergabe – jeweils getrennt.
   Eigene Samples (z. B. eine echte Hardtekk-Kick) lassen sich mit TAKT_BEAT.useSample("kick", url) einbinden.
   Startet nur nach einem Tipp (Browser-Regel). */
(function () {
  "use strict";

  /* ================= Komposition ================= */
  const BPM = 192, STEP = 60 / BPM / 4;           // 16tel = 0,078 s
  const TRACK_BARS = 96;                          // 96 × 1,25 s = 120 s
  const F4 = 349.2282;
  const hz = semi => F4 * Math.pow(2, semi / 12); // Halbtöne relativ zu F4

  // Fm – Db – Ab – Eb, je 2 Takte (= 32 16tel)
  const CHORDS = [
    { name: "Fm", root: 0, tones: [0, 3, 7] },
    { name: "Db", root: -4, tones: [-4, 0, 3] },
    { name: "Ab", root: 3, tones: [3, 7, 10] },
    { name: "Eb", root: -2, tones: [-2, 2, 5] }
  ];
  // Hauptmelodie: [16tel in 2 Takten, Halbton über F4, Länge] – lange Töne, kurze Läufe, Auflösung zurück nach F
  const THEME = [
    [[0, 12, 6], [6, 15, 2], [8, 14, 2], [10, 12, 2], [12, 10, 4], [16, 12, 8], [24, 10, 2], [26, 12, 2], [28, 15, 4]],
    [[0, 20, 6], [6, 19, 2], [8, 17, 2], [10, 15, 2], [12, 17, 4], [16, 15, 8], [24, 12, 2], [26, 15, 2], [28, 17, 4]],
    [[0, 19, 6], [6, 22, 2], [8, 20, 2], [10, 19, 2], [12, 17, 4], [16, 19, 8], [24, 17, 2], [26, 15, 2], [28, 14, 4]],
    [[0, 17, 6], [6, 19, 2], [8, 17, 2], [10, 15, 2], [12, 14, 4], [16, 10, 6], [22, 14, 2], [24, 15, 4], [28, 14, 4]]
  ];
  // Drop-2-Variante: schnellere Läufe in der zweiten Hälfte jedes Akkords
  const RUNS = [
    [[16, 12, 2], [18, 14, 1], [19, 15, 1], [20, 17, 2], [22, 15, 2], [24, 14, 2], [26, 12, 2], [28, 15, 4]],
    [[16, 15, 2], [18, 17, 1], [19, 19, 1], [20, 20, 2], [22, 19, 2], [24, 17, 2], [26, 15, 2], [28, 17, 4]],
    [[16, 19, 2], [18, 20, 1], [19, 22, 1], [20, 24, 2], [22, 22, 2], [24, 20, 2], [26, 19, 2], [28, 17, 4]],
    [[16, 14, 2], [18, 15, 1], [19, 17, 1], [20, 19, 2], [22, 17, 2], [24, 15, 2], [26, 14, 2], [28, 12, 4]]
  ];
  // Gegenmelodie (getragen) für Breakdown und Final Drop
  const COUNTER = [
    [[0, 7, 14], [16, 3, 16]],
    [[0, 8, 14], [16, 5, 16]],
    [[0, 10, 14], [16, 7, 16]],
    [[0, 10, 14], [16, 14, 16]]
  ];
  // Antwort-Riff des Rave-Leads (in den Pausen der Melodie)
  const SCREECH = [[16, 24, 1], [17, 22, 1], [18, 24, 2], [20, 27, 2], [22, 24, 2]];

  const SECTIONS = [
    [0, "intro", "Intro"], [8, "theme", "Melodie"], [24, "build", "Build-up"], [40, "drop1", "Drop 1"],
    [56, "breakdown", "Breakdown"], [72, "drop2", "Final Drop"], [88, "outro", "Outro"]
  ];
  const sectionOf = bar => { let s = SECTIONS[0]; for (const x of SECTIONS) if (bar >= x[0]) s = x; return s; };

  /* ================= Hilfen ================= */
  function noiseBuffer(ctx, sec = 2) {
    const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function curve(amount, hard) {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1, y = Math.tanh(x * amount) / Math.tanh(amount); c[i] = hard ? Math.max(-0.92, Math.min(0.92, y * 1.15)) : y; }
    return c;
  }
  function shaper(ctx, amount, hard = false) { const w = ctx.createWaveShaper(); w.curve = curve(amount, hard); w.oversample = "2x"; return w; }
  function impulse(ctx, sec = 3, decay = 2.8) {
    const len = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return b;
  }
  const SAMPLES = {};                                         // optionale WAV-Samples: { kick: ArrayBuffer }

  /* ================= Instrumente + Effekte ================= */
  function engine(ctx, volume = 0.2) {
    const out = ctx.createGain(); out.gain.value = volume;   // Gesamtlautstärke (für Fades)
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -6; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
    const glue = ctx.createDynamicsCompressor(); glue.threshold.value = -18; glue.ratio.value = 3; glue.attack.value = 0.01; glue.release.value = 0.12;
    const bus = ctx.createGain(); bus.connect(glue).connect(lim).connect(out).connect(ctx.destination);
    const noise = noiseBuffer(ctx);
    const buffers = {};
    for (const k in SAMPLES) ctx.decodeAudioData(SAMPLES[k].slice(0)).then(b => (buffers[k] = b)).catch(() => {});

    // Sends: großer Hall, punktiertes Achtel-Echo (stereo versetzt)
    const verb = ctx.createConvolver(); verb.buffer = impulse(ctx); const verbG = ctx.createGain(); verbG.gain.value = 0.45; verb.connect(verbG).connect(bus);
    const dL = ctx.createDelay(1), dR = ctx.createDelay(1); dL.delayTime.value = STEP * 3; dR.delayTime.value = STEP * 4.5;
    const dFb = ctx.createGain(); dFb.gain.value = 0.3; const dTone = ctx.createBiquadFilter(); dTone.type = "lowpass"; dTone.frequency.value = 3200;
    const merge = ctx.createChannelMerger(2); dL.connect(merge, 0, 0); dR.connect(merge, 0, 1);
    const dIn = ctx.createGain(); dIn.connect(dL); dIn.connect(dR); dL.connect(dTone).connect(dFb).connect(dIn);
    const dOut = ctx.createGain(); dOut.gain.value = 0.3; merge.connect(dOut).connect(bus);
    const fx = (node, room = 0.3, echo = 0) => {
      if (room) { const g = ctx.createGain(); g.gain.value = room; node.connect(g).connect(verb); }
      if (echo) { const g = ctx.createGain(); g.gain.value = echo; node.connect(g).connect(dIn); }
    };
    // Sidechain-Pumpen: Musik und Bass ducken bei jeder Kick
    const music = ctx.createGain(); music.connect(bus);
    const low = ctx.createGain(); low.connect(bus);
    function duck(t, depth = 0.35) {
      [[music, depth, 3], [low, 0.05, 1]].forEach(([g, d, len]) => { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(d, t); g.gain.linearRampToValueAtTime(1, t + STEP * len); });
    }
    const kickBus = shaper(ctx, 6, true); const kickTone = ctx.createBiquadFilter(); kickTone.type = "peaking"; kickTone.frequency.value = 2400; kickTone.gain.value = 4;
    kickBus.connect(kickTone).connect(bus);

    // --- Hardtekk-Kick: Klick + Punch + verzerrter Körper, auf F gestimmt ---
    function kick(t, power = 1, pitch = 1) {
      if (buffers.kick) { const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = buffers.kick; g.gain.value = power; s.connect(g).connect(bus); s.start(t); duck(t); return; }
      const body = ctx.createOscillator(), bg = ctx.createGain();
      body.frequency.setValueAtTime(420 * pitch, t); body.frequency.exponentialRampToValueAtTime(130 * pitch, t + 0.018);
      body.frequency.exponentialRampToValueAtTime(43.65 * pitch, t + 0.07);         // F1
      bg.gain.setValueAtTime(1.15 * power, t); bg.gain.setValueAtTime(1 * power, t + 0.09); bg.gain.exponentialRampToValueAtTime(0.001, t + 0.27);
      body.connect(bg).connect(kickBus); body.start(t); body.stop(t + 0.29);
      const c = ctx.createBufferSource(), cf = ctx.createBiquadFilter(), cg = ctx.createGain();
      c.buffer = noise; cf.type = "bandpass"; cf.frequency.value = 3500; cf.Q.value = 0.8;
      cg.gain.setValueAtTime(0.6 * power, t); cg.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
      c.connect(cf).connect(cg).connect(kickBus); c.start(t, Math.random()); c.stop(t + 0.02);
      duck(t);
    }
    // --- Rolling-Bass zwischen den Kicks (federnd, verzerrt, mono) ---
    const bassDrive = shaper(ctx, 3); bassDrive.connect(low);
    function bass(t, semi, open = 1400, level = 0.32) {
      const f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = "lowpass"; f.Q.value = 5; f.frequency.setValueAtTime(open * 1.6, t); f.frequency.exponentialRampToValueAtTime(open * 0.5, t + STEP * 0.85);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.003); g.gain.exponentialRampToValueAtTime(0.001, t + STEP * 0.9);
      f.connect(g).connect(bassDrive);
      [["sawtooth", 0], ["square", 7]].forEach(([type, cents]) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz(semi - 24); o.detune.value = cents; o.connect(f); o.start(t); o.stop(t + STEP); });
    }
    // --- Supersaw-Lead: 7 Stimmen, stereo verteilt ---
    function supersaw(t, semi, len, { level = 0.06, bright = 4000, room = 0.35, echo = 0.2, width = 1 } = {}) {
      const f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = "lowpass"; f.Q.value = 1;
      f.frequency.setValueAtTime(bright * 1.5, t); f.frequency.exponentialRampToValueAtTime(bright * 0.75, t + Math.max(0.05, len));
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.006); g.gain.setValueAtTime(level * 0.85, t + len * 0.85); g.gain.exponentialRampToValueAtTime(0.0008, t + len + 0.06);
      f.connect(g).connect(music); fx(g, room, echo);
      [-24, -15, -7, 0, 7, 15, 24].forEach((c, i) => {
        const o = ctx.createOscillator(), p = ctx.createStereoPanner(); o.type = "sawtooth"; o.frequency.value = hz(semi); o.detune.value = c;
        p.pan.value = ((i - 3) / 3) * 0.8 * width; o.connect(p).connect(f); o.start(t); o.stop(t + len + 0.08);
      });
    }
    // --- Heller Kristall-Layer (Pluck, eine Oktave über der Melodie) ---
    function crystal(t, semi, level = 0.03) {
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(); o.type = "triangle"; o2.type = "sine";
      o.frequency.value = hz(semi + 12); o2.frequency.value = hz(semi + 24);
      g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.connect(g); o2.connect(g); g.connect(music); fx(g, 0.4, 0.35); o.start(t); o2.start(t); o.stop(t + 0.36); o2.stop(t + 0.36);
    }
    // --- Glocke (FM) für das Intro und das Ende ---
    function bell(t, semi, level = 0.08, len = 1.6) {
      const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain();
      car.frequency.value = hz(semi); mod.frequency.value = hz(semi) * 3.5;
      mg.gain.setValueAtTime(hz(semi) * 2.2, t); mg.gain.exponentialRampToValueAtTime(1, t + len);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0005, t + len);
      mod.connect(mg).connect(car.frequency); car.connect(g).connect(music); fx(g, 0.6, 0.3);
      car.start(t); mod.start(t); car.stop(t + len + 0.02); mod.stop(t + len + 0.02);
    }
    // --- Piano (für den emotionalen Breakdown) ---
    function piano(t, semi, len, level = 0.1) {
      const f0 = hz(semi), o = ctx.createGain(); o.gain.value = level; o.connect(music); fx(o, 0.55, 0.12);
      [[1, 1, 1.6], [2, 0.5, 0.8], [3, 0.22, 0.45], [5, 0.08, 0.25]].forEach(([m, a, d]) => {
        const s = ctx.createOscillator(), g = ctx.createGain(); s.frequency.value = f0 * m * (1 + (m - 1) * 0.0007);
        const end = Math.min(len + 0.4, d * 2.4);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(a, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0008, t + end);
        s.connect(g).connect(o); s.start(t); s.stop(t + end + 0.02);
      });
    }
    // --- Flächen / Streicher / Chor ---
    function pad(t, tones, len, { level = 0.03, bright = 1600, octave = -12, room = 0.6 } = {}) {
      const f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = "lowpass"; f.frequency.setValueAtTime(bright * 0.6, t); f.frequency.linearRampToValueAtTime(bright, t + len * 0.5);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + Math.min(0.5, len * 0.3)); g.gain.setValueAtTime(level, t + len * 0.85); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.3);
      f.connect(g).connect(music); fx(g, room);
      tones.forEach(semi => [-10, 10].forEach(c => {
        const o = ctx.createOscillator(), p = ctx.createStereoPanner(); o.type = "sawtooth"; o.frequency.value = hz(semi + octave); o.detune.value = c;
        p.pan.value = c > 0 ? 0.5 : -0.5; o.connect(p).connect(f); o.start(t); o.stop(t + len + 0.35);
      }));
    }
    function strings(t, semi, len, level = 0.035) {
      const f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = "lowpass"; f.frequency.value = 2400;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.35); g.gain.setValueAtTime(level, t + len * 0.85); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.4);
      f.connect(g).connect(music); fx(g, 0.7);
      const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 5.3; lg.gain.value = 10; lfo.connect(lg); lfo.start(t); lfo.stop(t + len + 0.45);
      [-8, 0, 8].forEach(c => { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = hz(semi); o.detune.value = c; lg.connect(o.detune); o.connect(f); o.start(t); o.stop(t + len + 0.45); });
    }
    function choir(t, tones, len, level = 0.04) {
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.5); g.gain.setValueAtTime(level, t + len * 0.8); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.5);
      g.connect(music); fx(g, 0.9);
      const forms = [[730, 1], [1090, 0.55], [2440, 0.22]].map(([fr, a]) => { const b = ctx.createBiquadFilter(), bg = ctx.createGain(); b.type = "bandpass"; b.frequency.value = fr; b.Q.value = 7; bg.gain.value = a * 4; b.connect(bg).connect(g); return b; });
      tones.forEach(semi => [-12, 12].forEach(c => { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = hz(semi - 12); o.detune.value = c; forms.forEach(b => o.connect(b)); o.start(t); o.stop(t + len + 0.55); }));
    }
    // „Hey“-artiger Vokal-Stab kurz vor dem Drop
    function vox(t, semi = 12, level = 0.12) {
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.35);
      g.connect(bus); fx(g, 0.8, 0.4);
      const fs = [[600, 1100], [1000, 1700], [2500, 2600]].map(([a, b]) => { const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 8; f.frequency.setValueAtTime(a, t); f.frequency.linearRampToValueAtTime(b, t + 0.12); f.connect(g); return f; });
      [-6, 6].forEach(c => { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.setValueAtTime(hz(semi) * 0.94, t); o.frequency.exponentialRampToValueAtTime(hz(semi), t + 0.05); o.detune.value = c; fs.forEach(f => o.connect(f)); o.start(t); o.stop(t + 0.37); });
    }
    // Aggressiver Rave-/Screech-Lead (nur in den Drops)
    function screech(t, semi, len, level = 0.05) {
      const o = ctx.createOscillator(), d = shaper(ctx, 8), f = ctx.createBiquadFilter(), g = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
      o.type = "sawtooth"; o.frequency.setValueAtTime(hz(semi) * 1.06, t); o.frequency.exponentialRampToValueAtTime(hz(semi), t + 0.04);
      f.type = "bandpass"; f.Q.value = 3; f.frequency.value = 1800; lfo.frequency.value = 12; lg.gain.value = 900; lfo.connect(lg).connect(f.frequency);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0008, t + len);
      o.connect(d).connect(f).connect(g).connect(music); fx(g, 0.25, 0.2); o.start(t); lfo.start(t); o.stop(t + len + 0.02); lfo.stop(t + len + 0.02);
    }
    function arp(t, semi, level = 0.03, bright = 3000) {
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner();
      o.type = "square"; o.frequency.value = hz(semi); p.pan.value = Math.sin(t * 3) * 0.5;
      f.type = "lowpass"; f.frequency.setValueAtTime(bright, t); f.frequency.exponentialRampToValueAtTime(400, t + 0.09);
      g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
      o.connect(f).connect(g).connect(p).connect(music); fx(g, 0.2, 0.3); o.start(t); o.stop(t + 0.12);
    }
    // --- Percussion ---
    function nz(t, { type = "highpass", freq = 8000, q = 0.7, level = 0.1, len = 0.04, room = 0, dest = music, pan = 0 } = {}) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner();
      s.buffer = noise; f.type = type; f.frequency.value = freq; f.Q.value = q; p.pan.value = pan;
      g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      s.connect(f).connect(g).connect(p).connect(dest); if (room) fx(g, room);
      s.start(t, Math.random() * 1.5); s.stop(t + len + 0.02);
    }
    const hat = (t, l = 0.05) => nz(t, { freq: 9000, level: l, len: 0.025, pan: 0.15 });
    const ohat = (t, l = 0.12) => nz(t, { freq: 6500, level: l, len: 0.11, pan: -0.1 });
    function clap(t, level = 0.3) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; f.type = "bandpass"; f.frequency.value = 1500; f.Q.value = 0.9;
      g.gain.setValueAtTime(0, t); [0, 0.009, 0.019].forEach(d => { g.gain.setValueAtTime(level, t + d); g.gain.exponentialRampToValueAtTime(level * 0.15, t + d + 0.008); });
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2); s.connect(f).connect(g).connect(music); fx(g, 0.3); s.start(t, Math.random()); s.stop(t + 0.22);
    }
    function snare(t, level = 0.2, pitch = 1) {
      nz(t, { type: "bandpass", freq: 2300 * pitch, q: 0.6, level, len: 0.09, room: 0.25 });
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(240 * pitch, t); o.frequency.exponentialRampToValueAtTime(180 * pitch, t + 0.04);
      g.gain.setValueAtTime(level * 0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.06); o.connect(g).connect(music); o.start(t); o.stop(t + 0.08);
    }
    const crash = (t, l = 0.18) => nz(t, { freq: 4200, level: l, len: 2.2, room: 0.5, dest: bus });
    function impact(t) {
      crash(t, 0.24);
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(30, t + 1.2);
      g.gain.setValueAtTime(0.8, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.3); o.connect(g).connect(bus); fx(g, 0.4); o.start(t); o.stop(t + 1.35);
    }
    function riser(t, len, level = 0.18) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; s.loop = true; f.type = "bandpass"; f.Q.value = 2.5; f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(10000, t + len);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + len); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.03);
      s.connect(f).connect(g).connect(bus); fx(g, 0.5); s.start(t); s.stop(t + len + 0.05);
      const o = ctx.createOscillator(), og = ctx.createGain(); o.type = "sawtooth"; o.frequency.setValueAtTime(hz(-12), t); o.frequency.exponentialRampToValueAtTime(hz(36), t + len);
      og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(level * 0.2, t + len); og.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.03);
      o.connect(og).connect(music); fx(og, 0.4); o.start(t); o.stop(t + len + 0.05);
    }
    function swell(t, len, level = 0.12) {   // umgekehrtes Becken
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; f.type = "highpass"; f.frequency.value = 3000;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + len); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.02);
      s.connect(f).connect(g).connect(bus); fx(g, 0.6); s.start(t); s.stop(t + len + 0.03);
    }

    /* ================= Arrangement ================= */
    const melodyNote = (ci, pos, list = THEME) => list[ci].find(n => n[0] === pos);

    function schedule(step, t) {
      const s = step % 16, bar = Math.floor(step / 16) % TRACK_BARS, sec = sectionOf(bar)[1];
      const ci = Math.floor(bar / 2) % 4, chord = CHORDS[ci], pos = (bar % 2) * 16 + s, phrase = bar % 8, beat = s % 4;
      const drop = sec === "drop1" || sec === "drop2", D2 = sec === "drop2";
      const gapBuild = bar === 39 && s >= 8, gapBreak = bar === 71 && s >= 12, gapD2 = D2 && bar === 79 && s >= 12;
      const gap = gapBuild || gapBreak || gapD2;
      const prog = (from, len) => Math.min(1, Math.max(0, (bar - from + s / 16) / len));   // 0..1 innerhalb eines Teils

      /* ---- Harmonien ---- */
      if (pos === 0) {
        if (sec === "intro") pad(t, chord.tones, STEP * 32, { level: 0.06, bright: 600 + bar * 200 });
        if (sec === "theme") pad(t, chord.tones, STEP * 32, { level: 0.028, bright: 1800 });
        if (sec === "build") pad(t, chord.tones, STEP * 32, { level: 0.025, bright: 1500 + (bar - 24) * 160 });
        if (drop) pad(t, chord.tones, STEP * 32, { level: D2 ? 0.032 : 0.026, bright: 3200, octave: 0, room: 0.35 });
        if (sec === "breakdown") { pad(t, chord.tones, STEP * 32, { level: 0.05, bright: 1400 }); choir(t, chord.tones, STEP * 32, 0.065); }
        if (D2 || (sec === "theme" && bar >= 16)) choir(t, chord.tones, STEP * 32, D2 ? 0.035 : 0.025);
        if (sec === "outro" && bar < 94) pad(t, chord.tones, STEP * 32, { level: 0.03, bright: 1600 - (bar - 88) * 150 });
      }

      /* ---- Melodie ---- */
      const n = melodyNote(ci, pos), L = n ? STEP * n[2] * 0.95 : 0;
      const runsNow = D2 && pos >= 16 && phrase % 4 >= 2;                      // im Final Drop jede zweite Runde schnelle Läufe
      if (n && !gap) {
        const semi = n[1];
        if (sec === "intro" && pos < 16 && bar >= 2) bell(t, semi, 0.1 + bar * 0.008);                       // erste Andeutung
        if (sec === "theme") supersaw(t, semi + (bar >= 20 ? 12 : 0), L, { level: 0.045 + prog(8, 16) * 0.02, bright: 1600 + prog(8, 16) * 2200, room: 0.45 });
        if (sec === "theme" && bar >= 20) supersaw(t, semi, L, { level: 0.03, bright: 2200, room: 0.4, width: 0.6 });
        if (sec === "build") supersaw(t, semi + (bar >= 32 ? 12 : 0), L, { level: 0.04, bright: 1200 + prog(24, 16) * 3500, room: 0.35, echo: 0.25 });
        if (sec === "drop1") { supersaw(t, semi, L, { level: 0.07, bright: 4800 }); crystal(t, semi, 0.03); }
        if (sec === "breakdown") piano(t, semi, L + STEP * 2, 0.17);
        if (D2 && !runsNow) { supersaw(t, semi + 12, L, { level: 0.075, bright: 5200 }); supersaw(t, semi + 7, L, { level: 0.028, bright: 3600, width: 0.5 }); crystal(t, semi + 12, 0.025); }
        if (sec === "outro" && bar >= 92) bell(t, semi, 0.07, 2.2);
      }
      if (runsNow && !gap) {
        const r = melodyNote(ci, pos, RUNS);
        if (r) { supersaw(t, r[1] + 12, STEP * r[2] * 0.95, { level: 0.075, bright: 5600 }); crystal(t, r[1] + 12, 0.025); }
      }
      // Gegenmelodie: Streicher im Breakdown, im Final Drop eine Oktave höher
      const c = melodyNote(ci, pos, COUNTER);
      if (c && sec === "breakdown" && bar >= 60) strings(t, c[1], STEP * c[2], 0.06);
      if (c && D2) strings(t, c[1] + 12, STEP * c[2], 0.03);
      // Rave-Screech antwortet in den Melodie-Pausen (Drop 1 jede zweite Phrase, Final Drop immer)
      if (drop && bar % 2 === 1 && (D2 || phrase >= 4) && !gap) {
        const sc = SCREECH.find(x => x[0] === pos);
        if (sc) screech(t, sc[1] + chord.root - (chord.root > 0 ? 12 : 0), STEP * sc[2], D2 ? 0.05 : 0.04);
      }
      // Arpeggios
      if ((sec === "theme" && bar >= 12) || sec === "build" || drop || (sec === "breakdown" && bar >= 64)) {
        const seq = [0, 1, 2, 3, 2, 1, 0, 1], tone = [...chord.tones, chord.tones[0] + 12][seq[s % 8]] + 12 + (D2 && s >= 8 ? 12 : 0);
        if (!gap) arp(t, tone, drop ? 0.022 : 0.028, sec === "build" ? 1200 + prog(24, 16) * 3000 : sec === "breakdown" ? 800 + prog(64, 8) * 2500 : 3200);
      }

      /* ---- Drums ---- */
      const fourFloor = (sec === "theme" && bar >= 20) || sec === "build" || drop || (sec === "outro" && bar < 92);
      if (fourFloor && beat === 0 && !gap && bar !== 39) kick(t, sec === "theme" ? 0.55 : sec === "build" ? 0.8 : sec === "outro" ? 0.8 : 1);
      if (sec === "theme" && bar >= 16 && bar < 20 && s === 0) kick(t, 0.45);
      if (drop && phrase === 7 && s >= 13 && !gap) kick(t, 0.75, 1 + (s - 13) * 0.08);   // Kick-Fill
      if (sec === "breakdown" && bar >= 70 && !gapBreak && s % (bar === 70 ? 2 : 1) === 0) kick(t, 0.4 + prog(70, 2) * 0.5, 1 + prog(70, 2) * 0.4);
      // Bass: rollend „Kick – Bass – Bass – Bass“, im Build nur Offbeat
      const bassOn = (sec === "build" && bar >= 28) || drop || (sec === "outro" && bar < 90);
      if (bassOn && !gap && beat !== 0) {
        const play = drop ? true : beat === 2;
        if (play) bass(t, chord.root + (beat === 3 && D2 && phrase % 2 ? 12 : 0), drop ? 1500 + (beat === 2 ? 400 : 0) : 700 + prog(28, 12) * 600, drop ? 0.34 : 0.26);
      }
      if (drop && phrase === 7 && s >= 8 && s < 12) bass(t, chord.root + (s - 8) * 3, 2000, 0.3);          // Bass-Fill
      // Hats & Percussion
      const hats = (sec === "theme" && bar >= 16) || sec === "build" || drop || (sec === "breakdown" && bar >= 66) || (sec === "outro" && bar < 92);
      if (hats && !gap) {
        if (s % 2 === 1 || (drop && beat !== 0)) hat(t, drop ? 0.06 : 0.045);
        if (beat === 2 && sec !== "breakdown") ohat(t, drop ? 0.14 : 0.1);
      }
      if ((s === 4 || s === 12) && !gap && ((sec === "build" && bar >= 28) || drop || (sec === "outro" && bar < 91))) clap(t, drop ? 0.32 : 0.26);
      if (D2 && (s === 7 || s === 15) && bar % 2 && !gap) snare(t, 0.08, 1.2);
      // Fills am Phrasenende
      if ((sec === "theme" || sec === "build") && phrase === 7 && s >= 12 && bar >= 15 && !gap) snare(t, 0.08 + (s - 12) * 0.03);
      if (drop && phrase === 3 && s >= 12 && !gap) snare(t, 0.1 + (s - 12) * 0.04, 1.1);
      // Snare-Wirbel im Build-up (Takte 32–38) und am Ende des Breakdowns (66–71)
      const roll = (from, to) => {
        if (bar < from || bar > to || gap) return;
        const p = (bar - from) / (to - from + 1), div = p < 0.25 ? 4 : p < 0.5 ? 2 : p < 0.8 ? 1 : 0.5, lvl = 0.05 + p * 0.22, pitch = 1 + p * 0.6;
        if (div >= 1 ? s % div === 0 : true) snare(t, lvl, pitch);
        if (div < 1) snare(t + STEP / 2, lvl, pitch);
      };
      roll(32, 38); roll(66, 71);
      // Übergänge
      if (bar === 7 && s === 0) swell(t, STEP * 16, 0.1);
      if (bar === 8 && s === 0) crash(t, 0.12);
      if (bar === 24 && s === 0) crash(t, 0.16);
      if (bar === 32 && s === 0) riser(t, STEP * 16 * 7.5, 0.16);
      if (bar === 39 && s === 8) vox(t, 12, 0.13);
      if ((bar === 40 || bar === 72) && s === 0) impact(t);
      if (drop && phrase === 0 && s === 0 && bar !== 40 && bar !== 72) crash(t, 0.16);
      if (bar === 80 && s === 0) impact(t);
      if (bar === 56 && s === 0) crash(t, 0.14);
      if (bar === 64 && s === 0) riser(t, STEP * 16 * 7.75, 0.18);
      if (bar === 71 && s === 8) vox(t, 15, 0.12);
      if (bar === 88 && s === 0) crash(t, 0.14);
      // Schluss: letzter Akkord klingt aus
      if (bar === 94 && s === 0) { bell(t, 12, 0.09, 3); bell(t, 7, 0.06, 3); pad(t, [0, 3, 7], STEP * 32, { level: 0.03, bright: 900 }); }
    }
    return { schedule, out };
  }

  /* ================= Wiedergabe ================= */
  // Endlos-Schleife für die Website: läuft leise, blendet sanft ein und aus
  function player({ volume = 0.2 } = {}) {
    let ctx = null, eng = null, timer = null, step = 0, next = 0;
    const tick = () => { while (next < ctx.currentTime + 0.12) { eng.schedule(step++, next); next += STEP; } };
    return {
      get playing() { return !!timer; },
      get section() { return sectionOf(Math.floor(step / 16) % TRACK_BARS)[2]; },
      async start() {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        await ctx.resume();
        if (timer) return;
        if (eng) { const old = eng.out; old.gain.cancelScheduledValues(ctx.currentTime); old.gain.setTargetAtTime(0, ctx.currentTime, 0.05); setTimeout(() => old.disconnect(), 500); }
        eng = engine(ctx, 0.0001); step = 0; next = ctx.currentTime + 0.06;
        eng.out.gain.setValueAtTime(0.0001, ctx.currentTime); eng.out.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + 2);
        timer = setInterval(tick, 25); tick();
      },
      stop() {
        if (!timer) return;
        clearInterval(timer); timer = null;
        const g = eng.out.gain, now = ctx.currentTime;
        g.cancelScheduledValues(now); g.setValueAtTime(Math.max(0.0001, g.value), now); g.exponentialRampToValueAtTime(0.0001, now + 0.6);
        setTimeout(() => { if (!timer) ctx.suspend(); }, 700);
      }
    };
  }

  // Eigenes Sample (WAV/MP3) z. B. für die Kick einbinden – wird beim nächsten Start benutzt
  async function useSample(name, url) { SAMPLES[name] = await (await fetch(url)).arrayBuffer(); }

  // Hörprobe/Tests: offline in 8-Takt-Stücken rendern (Nachklang wird aufaddiert)
  async function render(seconds, fromBar = 0, sampleRate = 44100, volume = 0.2, maxSteps = Infinity) {
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const eng = engine(ctx, volume);
    for (let i = fromBar * 16, n = 0, t = 0.02; t < seconds && n < maxSteps; i++, n++, t += STEP) eng.schedule(i, t);
    return ctx.startRendering();
  }
  async function renderTrack(sampleRate = 44100, volume = 0.2) {
    const barLen = 16 * STEP, total = Math.round(TRACK_BARS * barLen * sampleRate);
    const L = new Float32Array(total), R = new Float32Array(total);
    for (let b = 0; b < TRACK_BARS; b += 8) {
      const bars = Math.min(8, TRACK_BARS - b), buf = await render(bars * barLen + 4, b, sampleRate, volume, bars * 16);
      const off = Math.round(b * barLen * sampleRate), l = buf.getChannelData(0), r = buf.getChannelData(1);
      for (let i = 0; i < l.length && off + i < total; i++) { L[off + i] += l[i]; R[off + i] += r[i]; }
    }
    const fade = Math.round(2.5 * sampleRate);                // sauberes Ausblenden bis 2:00
    for (let i = 0; i < fade; i++) { const k = 1 - i / fade, j = total - fade + i; L[j] *= k; R[j] *= k; }
    return { L, R, sampleRate };
  }

  window.TAKT_BEAT = { player, render, renderTrack, useSample, BPM, TRACK_BARS, STEP, SECTIONS };
})();
