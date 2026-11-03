/* TAKT Nr. 30 – Hintergrund-Beat, live im Browser erzeugt (keine Audiodatei, keine Lizenzfragen).
   128 BPM: Kick auf jedem Viertel, Offbeat-Hi-Hat, leise 16tel-Hats, Clap auf 2 und 4,
   rollende Bassline mit langsam atmendem Filter. Startet nur nach einem Tipp (Browser-Regel). */
(function () {
  "use strict";
  const BPM = 128, STEP = 60 / BPM / 4;            // 16tel
  const BASS = [0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 0]; // wo die Bassline spielt (zwischen den Kicks)
  const NOTES = [55, 55, 55, 55, 55, 55, 65.41, 55, 55, 55, 55, 55, 49, 55, 55, 61.74];

  function noiseBuffer(ctx) {
    const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  // Baut die Klangkette an einem AudioContext (live oder offline) und liefert schedule(step, time)
  function engine(ctx, volume = 0.22) {
    const master = ctx.createGain(); master.gain.value = volume;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    const noise = noiseBuffer(ctx);

    function kick(t) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
      o.connect(g).connect(master); o.start(t); o.stop(t + 0.45);
    }
    function hat(t, open, level) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; f.type = "highpass"; f.frequency.value = open ? 7000 : 9000;
      const len = open ? 0.11 : 0.03;
      g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      s.connect(f).connect(g).connect(master); s.start(t, Math.random() * 0.5); s.stop(t + len + 0.01);
    }
    function clap(t) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; f.type = "bandpass"; f.frequency.value = 1400; f.Q.value = 0.8;
      g.gain.setValueAtTime(0, t);
      [0, 0.012, 0.024].forEach(d => { g.gain.setValueAtTime(0.32, t + d); g.gain.exponentialRampToValueAtTime(0.05, t + d + 0.01); });
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      s.connect(f).connect(g).connect(master); s.start(t, Math.random() * 0.5); s.stop(t + 0.22);
    }
    function bass(t, freq, cutoff) {
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = "sawtooth"; o.frequency.value = freq;
      f.type = "lowpass"; f.Q.value = 7;
      f.frequency.setValueAtTime(cutoff * 2.2, t); f.frequency.exponentialRampToValueAtTime(cutoff, t + 0.09);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.42, t + 0.006); g.gain.exponentialRampToValueAtTime(0.001, t + STEP * 0.95);
      o.connect(f).connect(g).connect(master); o.start(t); o.stop(t + STEP);
    }

    // step zählt endlos hoch; der Filter „atmet“ über 32 Takte
    function schedule(step, t) {
      const s = step % 16, bar = Math.floor(step / 16);
      const cutoff = 260 + 420 * (0.5 - 0.5 * Math.cos((bar % 32) / 32 * Math.PI * 2));
      if (s % 4 === 0) kick(t);
      if (s % 4 === 2) hat(t, true, 0.22);
      if (s % 2 === 1) hat(t, false, 0.06 + (s % 4 === 3 ? 0.03 : 0));
      if (s === 4 || s === 12) clap(t);
      if (BASS[s] && !(bar % 8 === 7 && s >= 8)) bass(t, NOTES[s], cutoff);   // kleine Pause am Ende jeder Phrase
    }
    return { schedule, master };
  }

  // Live-Wiedergabe mit Vorausplanung (stabil auch bei Ruckeln)
  function player({ volume = 0.22 } = {}) {
    let ctx = null, eng = null, timer = null, step = 0, next = 0;
    const tick = () => {
      while (next < ctx.currentTime + 0.12) { eng.schedule(step++, next); next += STEP; }
    };
    return {
      get playing() { return !!timer; },
      async start() {
        if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); eng = engine(ctx, 0); }
        await ctx.resume();
        next = ctx.currentTime + 0.05;
        eng.master.gain.cancelScheduledValues(ctx.currentTime);
        eng.master.gain.setValueAtTime(0.0001, ctx.currentTime);
        eng.master.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + 2.5);   // sanft einblenden
        timer = setInterval(tick, 25); tick();
      },
      stop() {
        if (!timer) return;
        clearInterval(timer); timer = null;
        const t = ctx.currentTime;
        eng.master.gain.cancelScheduledValues(t); eng.master.gain.setValueAtTime(eng.master.gain.value, t);
        eng.master.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        setTimeout(() => { if (!timer) ctx.suspend(); }, 700);
      }
    };
  }

  // Hörprobe/Tests: n Sekunden offline rendern
  async function render(seconds = 20, sampleRate = 44100, volume = 0.22) {
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const eng = engine(ctx, volume);
    for (let i = 0, t = 0.02; t < seconds; i++, t += STEP) eng.schedule(i, t);
    return ctx.startRendering();
  }

  window.TAKT_BEAT = { player, render, BPM };
})();
