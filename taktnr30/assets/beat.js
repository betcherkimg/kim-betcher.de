/* TAKT Nr. 30 – Hintergrund-Beat, live im Browser erzeugt (keine Audiodatei, keine Lizenzfragen).
   138 BPM, harter verzerrter Kick mit Rumble, Acid-Bassline, Stabs, Ride – als ein Track von
   ca. 3 Minuten mit Intro, Breakdown, Riser, Snare-Wirbel und Drop; danach wieder von vorn.
   Startet nur nach einem Tipp (Browser-Regel). */
(function () {
  "use strict";
  const BPM = 138, STEP = 60 / BPM / 4;   // 16tel
  // Acid-Muster: Halbtöne über A1 (55 Hz), null = Pause, Großbuchstabe-Effekt über accent-Liste
  const ACID = [
    { n: [0, null, 12, 0, null, 0, 15, null, 0, 12, null, 0, 10, null, 0, 12], acc: [2, 6, 12] },
    { n: [0, 0, null, 12, 0, null, 0, 13, null, 0, 0, 12, null, 15, 0, null], acc: [3, 7, 13] },
    { n: [0, null, 0, 0, 12, null, 0, null, 7, 0, null, 12, 0, 0, 10, 12], acc: [4, 8, 15] },
    { n: [0, 12, null, 0, null, 15, 0, 12, null, 0, 17, null, 0, 12, null, 0], acc: [1, 5, 10] }
  ];
  const hz = semi => 55 * Math.pow(2, semi / 12);

  function noiseBuffer(ctx) {
    const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function drive(ctx, amount) {
    const ws = ctx.createWaveShaper(), n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(x * amount) / Math.tanh(amount); }
    ws.curve = c; ws.oversample = "2x"; return ws;
  }

  function engine(ctx, volume = 0.2) {
    const master = ctx.createGain(); master.gain.value = volume;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.12;
    master.connect(comp).connect(ctx.destination);
    const noise = noiseBuffer(ctx);
    // Bus mit „Pumpen“: alles außer Kick wird bei jedem Kick kurz leiser (Sidechain-Gefühl)
    const pump = ctx.createGain(); pump.connect(master);
    const kickDrive = drive(ctx, 3.2); kickDrive.connect(master);
    const acidDrive = drive(ctx, 2.6); acidDrive.connect(pump);

    function duck(t) { pump.gain.setValueAtTime(0.35, t); pump.gain.linearRampToValueAtTime(1, t + STEP * 3.2); }
    function kick(t, hard = 1) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(190, t); o.frequency.exponentialRampToValueAtTime(47, t + 0.09);
      g.gain.setValueAtTime(1.1 * hard, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
      o.connect(g).connect(kickDrive); o.start(t); o.stop(t + 0.4);
      // Rumble: tiefer, verzerrter Nachhall zwischen den Kicks
      const r = ctx.createOscillator(), rf = ctx.createBiquadFilter(), rg = ctx.createGain();
      r.type = "triangle"; r.frequency.setValueAtTime(48, t + 0.08); rf.type = "lowpass"; rf.frequency.value = 120;
      rg.gain.setValueAtTime(0.0001, t + 0.08); rg.gain.exponentialRampToValueAtTime(0.35, t + 0.14); rg.gain.exponentialRampToValueAtTime(0.001, t + STEP * 3.6);
      r.connect(rf).connect(rg).connect(kickDrive); r.start(t + 0.08); r.stop(t + STEP * 3.8);
      duck(t);
    }
    function hit(t, { type = "highpass", freq = 8000, q = 0.7, level = 0.1, len = 0.04 } = {}) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
      g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      s.connect(f).connect(g).connect(pump); s.start(t, Math.random() * 1.5); s.stop(t + len + 0.02);
    }
    function clap(t, level = 0.4) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; f.type = "bandpass"; f.frequency.value = 1600; f.Q.value = 0.9;
      g.gain.setValueAtTime(0, t);
      [0, 0.011, 0.022].forEach(d => { g.gain.setValueAtTime(level, t + d); g.gain.exponentialRampToValueAtTime(level * 0.15, t + d + 0.009); });
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      s.connect(f).connect(g).connect(pump); s.start(t, Math.random()); s.stop(t + 0.26);
    }
    function acid(t, freq, cutoff, accent, slideFrom) {
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = "sawtooth";
      if (slideFrom) { o.frequency.setValueAtTime(slideFrom, t); o.frequency.exponentialRampToValueAtTime(freq, t + 0.05); } else o.frequency.setValueAtTime(freq, t);
      f.type = "lowpass"; f.Q.value = accent ? 16 : 11;
      const peak = cutoff * (accent ? 4.5 : 2.4);
      f.frequency.setValueAtTime(peak, t); f.frequency.exponentialRampToValueAtTime(Math.max(120, cutoff * 0.7), t + STEP * 0.9);
      const lvl = accent ? 0.34 : 0.22;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(lvl, t + 0.004); g.gain.setValueAtTime(lvl, t + STEP * 0.75); g.gain.exponentialRampToValueAtTime(0.001, t + STEP * 0.98);
      o.connect(f).connect(g).connect(acidDrive); o.start(t); o.stop(t + STEP);
    }
    function stab(t, root) {
      [0, 3, 7, 10].forEach(iv => {
        const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = "sawtooth"; o.frequency.value = hz(root + 24 + iv) * (1 + (Math.random() - 0.5) * 0.004);
        f.type = "lowpass"; f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(500, t + 0.16);
        g.gain.setValueAtTime(0.07, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        o.connect(f).connect(g).connect(pump); o.start(t); o.stop(t + 0.22);
      });
    }
    function riser(t, len) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; s.loop = true; f.type = "bandpass"; f.Q.value = 2.5;
      f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(9000, t + len);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + len); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.05);
      s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + len + 0.06);
    }

    function crash(t) {   // Einschlag beim Drop
      hit(t, { freq: 4000, level: 0.28, len: 2.2 });
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(30, t + 1.2);
      g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
      o.connect(g).connect(kickDrive); o.start(t); o.stop(t + 1.5);
    }
    function pad(t, len, open) {   // dunkler Moll-Akkord im Breakdown
      [0, 3, 7, 12].forEach(iv => [-1, 1].forEach(dt => {
        const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = "sawtooth"; o.frequency.value = hz(iv + 24) * (1 + dt * 0.006);
        f.type = "lowpass"; f.frequency.setValueAtTime(open ? 900 : 500, t); f.frequency.linearRampToValueAtTime(open ? 2600 : 900, t + len);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.055, t + len * 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(f).connect(g).connect(master); o.start(t); o.stop(t + len + 0.05);
      }));
    }

    /* Ein Track, ca. 3 Minuten (104 Takte), danach von vorn:
       0–15 Intro · 16–31 Groove · 32–47 Groove + Stabs/Ride · 48–63 Breakdown mit Riser und Snare-Wirbel
       64–87 DROP · 88–103 Outro (baut ab) */
    const TRACK_BARS = 104;
    let lastNote = null;
    function schedule(step, t) {
      const s = step % 16, bar = Math.floor(step / 16) % TRACK_BARS, round = Math.floor(Math.floor(step / 16) / TRACK_BARS);
      const intro = bar < 16, grooveA = bar >= 16 && bar < 32, grooveB = bar >= 32 && bar < 48;
      const brk = bar >= 48 && bar < 64, drop = bar >= 64 && bar < 88, outro = bar >= 88;
      const phrase = bar % 8, pattern = ACID[(Math.floor(bar / 16) + round) % ACID.length];
      const wave = 0.5 - 0.5 * Math.cos((phrase + s / 16) / 8 * Math.PI * 2);
      let cutoff = 280 + 700 * wave;
      if (intro) cutoff = 180 + 18 * bar + 120 * wave;                 // langsam aufgehend
      if (grooveB) cutoff += 300;
      if (brk) cutoff = 160 + 40 * (bar - 48) + 200 * wave;            // gefiltert, öffnet sich zum Drop hin
      if (drop) cutoff = 900 + 1100 * wave;                            // weit offen, kreischend
      if (outro) cutoff = Math.max(200, 900 - 45 * (bar - 88)) + 200 * wave;
      const gap = bar === 63 && s >= 8;                                 // Stille kurz vor dem Drop

      // Kick
      const kickOn = !brk && !(intro && bar < 4) && !(outro && bar >= 102);
      if (kickOn && s % 4 === 0) kick(t, drop ? 1.2 : 1);
      if (drop && phrase === 7 && (s === 14 || s === 15)) kick(t, 0.8);   // Doppel-Kick am Phrasenende
      if (bar === 64 && s === 0) crash(t);
      // Hats
      if (!gap) hit(t, { freq: 9500, level: (brk && bar < 56 ? 0.6 : 1) * (s % 4 === 2 ? 0.05 : (s % 2 ? (drop ? 0.09 : 0.07) : 0.04)), len: 0.025 });
      if (!brk && !(intro && bar < 8) && s % 4 === 2) hit(t, { freq: 6500, level: drop ? 0.2 : 0.16, len: 0.12 });
      // Ride
      if ((grooveB || drop || (outro && bar < 96)) && s % 2 === 0) hit(t, { type: "bandpass", freq: 5200, q: 3, level: drop ? 0.08 : 0.055, len: 0.3 });
      // Extra-Percussion im Drop
      if (drop && (s === 3 || s === 11 || (s === 15 && bar % 2))) hit(t, { type: "bandpass", freq: 900, q: 6, level: 0.18, len: 0.07 });
      // Clap
      if ((s === 4 || s === 12) && !(intro && bar < 8) && !(brk && bar < 56) && !gap) clap(t, brk ? 0.22 : drop ? 0.5 : 0.42);
      // Snare-Wirbel vor dem Drop: Viertel → Achtel → 16tel → 32tel
      if (bar >= 60 && bar < 64 && !gap) {
        const every = [4, 2, 1, 0.5][bar - 60], lvl = 0.08 + (bar - 60) * 0.06 + s * 0.006;
        if (every >= 1 ? s % every === 0 : true) clap(t, lvl);
        if (every < 1) clap(t + STEP / 2, lvl);
      }
      // Fill am Ende der Phrasen (außer im Breakdown)
      if (!brk && phrase === 7 && s >= 12 && !(intro && bar < 8)) clap(t + STEP * 0.5, 0.12 + (s - 12) * 0.05);
      // Riser über die letzten 8 Takte des Breakdowns
      if (bar === 56 && s === 0) riser(t, STEP * 16 * 7.5);
      // Pads im Breakdown
      if (brk && phrase % 4 === 0 && s === 0) pad(t, STEP * 16 * 4, bar >= 56);
      // Acid-Bass
      const note = pattern.n[s];
      const bassOn = !(intro && bar < 8) && !gap && !(outro && bar >= 100);
      if (bassOn && note !== null && !(phrase === 7 && s >= 12 && !drop)) {
        const f = hz(note);
        acid(t, f, cutoff, pattern.acc.includes(s) || (drop && s % 4 === 3), lastNote && Math.abs(lastNote - f) > 1 && s % 4 === 3 ? lastNote : null);
        lastNote = f;
      }
      // Stabs
      if ((grooveB || drop) && (s === 6 || (s === 14 && bar % 2) || (drop && s === 10 && phrase % 2))) stab(t, drop && phrase >= 4 ? 3 : 0);
    }
    return { schedule, master };
  }

  // Live-Wiedergabe mit Vorausplanung (stabil auch bei Ruckeln)
  function player({ volume = 0.2 } = {}) {
    let ctx = null, eng = null, timer = null, step = 0, next = 0;
    const tick = () => { while (next < ctx.currentTime + 0.12) { eng.schedule(step++, next); next += STEP; } };
    return {
      get playing() { return !!timer; },
      async start() {
        if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); eng = engine(ctx, 0.0001); }
        await ctx.resume();
        next = ctx.currentTime + 0.05;
        const g = eng.master.gain, now = ctx.currentTime;
        g.cancelScheduledValues(now); g.setValueAtTime(Math.max(0.0001, g.value), now); g.exponentialRampToValueAtTime(volume, now + 2.5);   // sanft einblenden
        timer = setInterval(tick, 25); tick();
      },
      stop() {
        if (!timer) return;
        clearInterval(timer); timer = null;
        const g = eng.master.gain, now = ctx.currentTime;
        g.cancelScheduledValues(now); g.setValueAtTime(Math.max(0.0001, g.value), now); g.exponentialRampToValueAtTime(0.0001, now + 0.6);
        setTimeout(() => { if (!timer) ctx.suspend(); }, 700);
      }
    };
  }

  // Hörprobe/Tests: Ausschnitt offline rendern (ab Takt fromBar)
  async function render(seconds = 30, fromBar = 0, sampleRate = 44100, volume = 0.2) {
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const eng = engine(ctx, volume);
    for (let i = fromBar * 16, t = 0.02; t < seconds; i++, t += STEP) eng.schedule(i, t);
    return ctx.startRendering();
  }

  window.TAKT_BEAT = { player, render, BPM };
})();
