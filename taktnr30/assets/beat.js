/* TAKT Nr. 30 – Hintergrund-Track im Tekk-/Hardtekk-Stil, live im Browser erzeugt
   (keine Audiodatei, keine Lizenzfragen). 155 BPM, ca. 3 Minuten, zwei Drops, danach von vorn.
   Instrumente: harter verzerrter Kick, scheppernder Rolling-Bass, Supersaw-Lead mit Melodie,
   Arpeggio, Flächen, Hats, Ride, Clap, Snare, Toms, Crash, Riser – mit Hall und Echo.
   Startet nur nach einem Tipp (Browser-Regel). */
(function () {
  "use strict";
  const BPM = 155, STEP = 60 / BPM / 4;            // 16tel
  const TRACK_BARS = 116;                          // ≈ 3 Minuten
  const A4 = 440, A1 = 55;
  const f4 = semi => A4 * Math.pow(2, semi / 12);  // Melodie/Akkorde (relativ zu A4)
  const f1 = semi => A1 * Math.pow(2, semi / 12);  // Bass (relativ zu A1)

  // Akkordfolge a-Moll: Am – F – C – G (je 2 Takte), Akkordtöne relativ zu A4
  const CHORDS = [
    { root: 0, tones: [0, 3, 7, 12] },
    { root: -4, tones: [-4, 0, 3, 8] },
    { root: 3, tones: [3, 7, 10, 15] },
    { root: -2, tones: [-2, 2, 5, 10] }
  ];
  // Melodie A (Hook): synkopierter Rhythmus, je Akkord 12 Töne über 2 Takte
  const RHY_A = [0, 3, 6, 8, 11, 14, 16, 19, 22, 24, 26, 28];
  const MEL_A = [
    [12, 10, 7, 12, 15, 12, 10, 7, 10, 12, 14, 15],
    [12, 8, 5, 12, 15, 12, 8, 5, 8, 12, 15, 17],
    [15, 12, 10, 15, 19, 15, 12, 10, 12, 15, 17, 19],
    [14, 10, 7, 14, 17, 14, 10, 7, 10, 14, 12, 10]
  ];
  // Melodie B (Antwort/Variation): treibender, 8 Töne pro Akkord
  const RHY_B = [0, 4, 6, 10, 12, 16, 22, 26];
  const MEL_B = [
    [7, 12, 10, 7, 3, 7, 12, 15],
    [8, 12, 10, 8, 5, 8, 12, 17],
    [10, 15, 12, 10, 7, 10, 15, 19],
    [10, 14, 12, 10, 5, 10, 14, 17]
  ];
  // Bass-Muster pro Viertel (16tel 1–3 nach dem Kick); Zahl = Oktave (0 tief, 1 hoch), null = Pause
  const BASS_ROLL = [null, 0, 0, 1];               // klassisch Tekk: Kick – Bass – Bass – Bass
  const BASS_OFF = [null, null, 0, null];          // Offbeat (ruhigere Teile)
  const BASS_GALLOP = [null, 0, 1, 0];

  function noiseBuffer(ctx, sec = 2) {
    const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function shaper(ctx, amount, hard = false) {
    const ws = ctx.createWaveShaper(), n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1) * 2 - 1;
      c[i] = hard ? Math.max(-0.8, Math.min(0.8, Math.tanh(x * amount))) / 0.8 : Math.tanh(x * amount) / Math.tanh(amount);
    }
    ws.curve = c; ws.oversample = "4x"; return ws;
  }
  function impulse(ctx, sec = 2.4, decay = 3) {
    const len = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return b;
  }

  function engine(ctx, volume = 0.2) {
    const master = ctx.createGain(); master.gain.value = volume;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.09;
    master.connect(comp).connect(ctx.destination);
    const noise = noiseBuffer(ctx);

    // Hall und Echo als Sends
    const verb = ctx.createConvolver(); verb.buffer = impulse(ctx); const verbOut = ctx.createGain(); verbOut.gain.value = 0.35;
    verb.connect(verbOut).connect(master);
    const dly = ctx.createDelay(1); dly.delayTime.value = STEP * 3; const fb = ctx.createGain(); fb.gain.value = 0.38;
    const dlyTone = ctx.createBiquadFilter(); dlyTone.type = "lowpass"; dlyTone.frequency.value = 3500;
    dly.connect(dlyTone).connect(fb).connect(dly); const dlyOut = ctx.createGain(); dlyOut.gain.value = 0.3; dlyTone.connect(dlyOut).connect(master);

    // Pump-Bus (Sidechain-Gefühl) für alles außer Kick
    const pump = ctx.createGain(); pump.connect(master);
    const kickBus = shaper(ctx, 5, true); const kickGain = ctx.createGain(); kickGain.gain.value = 0.9; kickBus.connect(kickGain).connect(master);
    const bassBus = shaper(ctx, 4.5); const bassTone = ctx.createBiquadFilter(); bassTone.type = "peaking"; bassTone.frequency.value = 1800; bassTone.gain.value = 6; bassTone.Q.value = 1.2;
    bassBus.connect(bassTone).connect(pump);
    const leadBus = ctx.createGain(); leadBus.connect(pump); leadBus.connect(verb); leadBus.connect(dly);

    const send = (node, wet = 0.4) => { const g = ctx.createGain(); g.gain.value = wet; node.connect(g).connect(verb); };
    function duck(t, depth = 0.25) { pump.gain.cancelScheduledValues(t); pump.gain.setValueAtTime(depth, t); pump.gain.linearRampToValueAtTime(1, t + STEP * 3); }

    function kick(t, power = 1, pitch = 1) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(320 * pitch, t); o.frequency.exponentialRampToValueAtTime(52 * pitch, t + 0.07);
      g.gain.setValueAtTime(1.3 * power, t); g.gain.setValueAtTime(1.1 * power, t + 0.12); g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
      o.connect(g).connect(kickBus); o.start(t); o.stop(t + 0.36);
      const c = ctx.createBufferSource(), cf = ctx.createBiquadFilter(), cg = ctx.createGain();   // Klick
      c.buffer = noise; cf.type = "highpass"; cf.frequency.value = 2500; cg.gain.setValueAtTime(0.5 * power, t); cg.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
      c.connect(cf).connect(cg).connect(kickBus); c.start(t, Math.random()); c.stop(t + 0.02);
      duck(t);
    }
    function bass(t, semi, open, accent) {
      // zwei verstimmte Sägezähne + Rechteck, stark verzerrt, kurz → scheppert
      const g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = "lowpass"; f.Q.value = 6;
      f.frequency.setValueAtTime(open * (accent ? 2.2 : 1.6), t); f.frequency.exponentialRampToValueAtTime(Math.max(150, open * 0.5), t + STEP * 0.8);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(accent ? 0.55 : 0.42, t + 0.004); g.gain.exponentialRampToValueAtTime(0.001, t + STEP * 0.92);
      f.connect(g).connect(bassBus);
      [["sawtooth", 1, -7], ["sawtooth", 1, 7], ["square", 0.5, 0]].forEach(([type, mul, cents]) => {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = f1(semi) * mul; o.detune.value = cents;
        o.connect(f); o.start(t); o.stop(t + STEP);
      });
    }
    function sub(t, semi, len) {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = f1(semi) / 2;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      o.connect(g).connect(pump); o.start(t); o.stop(t + len + 0.02);
    }
    function lead(t, semi, len, level = 0.12, bright = 3200) {
      const g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = "lowpass"; f.Q.value = 2; f.frequency.setValueAtTime(bright * 1.6, t); f.frequency.exponentialRampToValueAtTime(bright * 0.6, t + len);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.006); g.gain.setValueAtTime(level * 0.8, t + len * 0.7); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      f.connect(g).connect(leadBus);
      [-14, -6, 0, 6, 14].forEach(cents => { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f4(semi); o.detune.value = cents; o.connect(f); o.start(t); o.stop(t + len + 0.02); });
    }
    function pluck(t, semi, level = 0.06, bright = 2400) {
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = "square"; o.frequency.value = f4(semi);
      f.type = "lowpass"; f.frequency.setValueAtTime(bright, t); f.frequency.exponentialRampToValueAtTime(300, t + 0.12);
      g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      o.connect(f).connect(g); g.connect(pump); g.connect(dly); o.start(t); o.stop(t + 0.16);
    }
    function pad(t, tones, len, level = 0.035, bright = 1400) {
      tones.forEach(semi => [-10, 10].forEach(c => {
        const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = "sawtooth"; o.frequency.value = f4(semi - 12); o.detune.value = c;
        f.type = "lowpass"; f.frequency.value = bright;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + len * 0.25); g.gain.setValueAtTime(level, t + len * 0.8); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(f).connect(g); g.connect(pump); send(g, 0.6); o.start(t); o.stop(t + len + 0.02);
      }));
    }
    function noiseHit(t, { type = "highpass", freq = 8000, q = 0.7, level = 0.1, len = 0.04, wet = 0, dest = pump } = {}) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
      g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      s.connect(f).connect(g).connect(dest); if (wet) send(g, wet);
      s.start(t, Math.random() * 1.5); s.stop(t + len + 0.02);
    }
    function clap(t, level = 0.4, wet = 0.25) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; f.type = "bandpass"; f.frequency.value = 1700; f.Q.value = 0.9;
      g.gain.setValueAtTime(0, t);
      [0, 0.01, 0.021].forEach(d => { g.gain.setValueAtTime(level, t + d); g.gain.exponentialRampToValueAtTime(level * 0.15, t + d + 0.009); });
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      s.connect(f).connect(g).connect(pump); send(g, wet); s.start(t, Math.random()); s.stop(t + 0.24);
    }
    function snare(t, level = 0.3, pitch = 1) {
      noiseHit(t, { type: "bandpass", freq: 2600 * pitch, q: 0.6, level, len: 0.12, wet: 0.2 });
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(220 * pitch, t); o.frequency.exponentialRampToValueAtTime(160 * pitch, t + 0.05);
      g.gain.setValueAtTime(level * 0.8, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08); o.connect(g).connect(pump); o.start(t); o.stop(t + 0.1);
    }
    function tom(t, freq, level = 0.4) {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(freq * 1.6, t); o.frequency.exponentialRampToValueAtTime(freq, t + 0.08);
      g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25); o.connect(g); g.connect(pump); send(g, 0.3); o.start(t); o.stop(t + 0.27);
    }
    function crash(t, big = false) {
      noiseHit(t, { freq: 3500, level: big ? 0.3 : 0.18, len: big ? 2.6 : 1.6, wet: 0.5, dest: master });
      if (big) { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(28, t + 1.5);
        g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.6); o.connect(g).connect(kickBus); o.start(t); o.stop(t + 1.7); }
    }
    function riser(t, len, level = 0.24) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; s.loop = true; f.type = "bandpass"; f.Q.value = 3;
      f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(11000, t + len);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + len); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.04);
      s.connect(f).connect(g).connect(master); send(g, 0.5); s.start(t); s.stop(t + len + 0.05);
      const o = ctx.createOscillator(), og = ctx.createGain(); o.type = "sawtooth";   // aufsteigender Ton
      o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(1760, t + len);
      og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.05, t + len); og.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.04);
      o.connect(og).connect(leadBus); o.start(t); o.stop(t + len + 0.05);
    }

    /* Ablauf (Takte):
       0–7 Intro · 8–23 Aufbau · 24–31 Break 1 (Melodie) · 32–55 DROP 1 · 56–63 Groove mit Toms
       64–79 Break 2 (ruhig, dann Kick-Wirbel) · 80–103 DROP 2 (größer, Melodie eine Oktave höher, am Ende einen Ton höher) · 104–115 Outro */
    function section(bar) {
      if (bar < 8) return "intro";
      if (bar < 24) return "build";
      if (bar < 32) return "break1";
      if (bar < 56) return "drop1";
      if (bar < 64) return "groove";
      if (bar < 80) return "break2";
      if (bar < 104) return "drop2";
      return "outro";
    }

    function schedule(step, t) {
      const s = step % 16, bar = Math.floor(step / 16) % TRACK_BARS;
      const sec = section(bar), phrase = bar % 8, sub16 = s % 4;
      const lift = sec === "drop2" && bar >= 96 ? 2 : 0;                 // letzter Teil: einen Ganzton höher
      const chord = CHORDS[Math.floor(bar / 2) % 4];
      const step32 = (bar % 2) * 16 + s;                                 // Position im 2-Takt-Motiv
      const drop = sec === "drop1" || sec === "drop2";
      const lastOfBreak = bar === 31 || bar === 79;
      const gap = lastOfBreak && s >= 12;                                 // Stille direkt vor dem Drop

      // ---------- Kick ----------
      let kickOn = sec !== "break1" && sec !== "break2" && !(sec === "outro" && bar >= 114);
      if (sec === "intro" && bar < 2) kickOn = s === 0;
      if (kickOn && sub16 === 0) kick(t, drop ? 1.15 : 1);
      if (drop && phrase === 7 && s >= 12) kick(t, 0.75);                // Kick-Rolle am Phrasenende
      if (sec === "break2" && bar >= 76 && !gap) {                       // Tekk-Kick-Wirbel vor Drop 2
        const every = bar < 78 ? 4 : bar === 78 ? 2 : 1;
        if (s % every === 0) kick(t, 0.5 + (bar - 76) * 0.18 + s * 0.01, 1 + (bar - 76) * 0.15 + s * 0.01);
      }
      if ((bar === 32 || bar === 80) && s === 0) crash(t, true);
      if (drop && phrase === 0 && s === 0 && bar !== 32 && bar !== 80) crash(t);
      if (sec === "groove" && bar === 56 && s === 0) crash(t);

      // ---------- Bass ----------
      const bassPat = sec === "build" && bar < 16 ? BASS_OFF : sec === "groove" ? BASS_GALLOP : sec === "drop2" && phrase >= 4 ? BASS_GALLOP : BASS_ROLL;
      const bassOn = (sec === "build" || drop || sec === "groove" || (sec === "outro" && bar < 110)) && !gap;
      const oct = bassPat[sub16];
      if (bassOn && oct !== null) {
        const open = drop ? 2600 : sec === "build" ? 600 + (bar - 8) * 90 : sec === "outro" ? 1500 - (bar - 104) * 120 : 1800;
        bass(t, chord.root + lift + oct * 12, open, sub16 === 3 || (drop && s % 8 === 3));
      }
      if (drop && s === 0 && phrase % 2 === 0) sub(t, chord.root + lift, STEP * 30);

      // ---------- Hats, Ride, Percussion ----------
      if (!gap && !(sec === "intro" && bar < 4) && !(sec === "break2" && bar < 72)) {
        noiseHit(t, { freq: 9500, level: sub16 === 2 ? 0.05 : (s % 2 ? (drop ? 0.09 : 0.07) : 0.035), len: drop && s % 2 ? 0.035 : 0.025 });
      }
      if (sub16 === 2 && (sec === "build" || drop || sec === "groove" || sec === "outro") && !gap) noiseHit(t, { freq: 6500, level: drop ? 0.2 : 0.15, len: 0.13 });
      if ((drop || sec === "groove") && s % 2 === 0) noiseHit(t, { type: "bandpass", freq: 5200, q: 3, level: drop ? 0.075 : 0.05, len: 0.3 });
      if (drop && (s === 3 || s === 11 || (s === 15 && bar % 2))) noiseHit(t, { type: "bandpass", freq: 900, q: 6, level: 0.17, len: 0.07 });   // Rimshot
      if (sec === "groove" && (s === 7 || s === 13)) tom(t, s === 7 ? 140 : 105, 0.32);

      // ---------- Clap / Snare ----------
      const clapOn = (sec === "build" && bar >= 12) || drop || sec === "groove" || (sec === "outro" && bar < 112) || (sec === "break1" && bar >= 28);
      if ((s === 4 || s === 12) && clapOn && !gap) clap(t, drop ? 0.5 : 0.4);
      if (drop && s === 12) snare(t, 0.22);
      // Snare-Wirbel vor Drop 1 (Takte 28–31): Viertel → Achtel → 16tel → 32tel
      if (bar >= 28 && bar <= 31 && !gap) {
        const every = [4, 2, 1, 0.5][bar - 28], lvl = 0.08 + (bar - 28) * 0.06 + s * 0.006, p = 1 + (bar - 28) * 0.12 + s * 0.01;
        if (every >= 1 ? s % every === 0 : true) snare(t, lvl, p);
        if (every < 1) snare(t + STEP / 2, lvl, p);
      }
      // Fills am Ende jeder 8er-Phrase in den Groove-Teilen
      if ((sec === "build" || drop || sec === "groove") && phrase === 7 && s >= 8) {
        if (sec === "groove" || sec === "drop2") tom(t, [180, 160, 140, 120, 105, 95, 85, 75][s - 8], 0.35);
        else snare(t, 0.12 + (s - 8) * 0.03, 1 + (s - 8) * 0.03);
      }
      if ((bar === 23 || bar === 63) && s === 0) riser(t, STEP * 16, 0.16);

      // ---------- Melodie ----------
      const ci = Math.floor(bar / 2) % 4;
      // Hook (Melodie A) im Break 1 (gedämpft), Drop 1, Drop 2 (Oktave + Terz drüber)
      if (sec === "break1" || drop || (sec === "outro" && bar < 108)) {
        const idx = RHY_A.indexOf(step32);
        if (idx >= 0 && !gap) {
          const semi = MEL_A[ci][idx] + lift, len = STEP * ((RHY_A[idx + 1] ?? 32) - step32) * 0.9;
          if (sec === "break1") lead(t, semi, len, 0.13, 1000 + (bar - 24) * 260);
          else if (sec === "drop2") { lead(t, semi + 12, len, 0.1, 4200); lead(t, semi + 3, len, 0.07, 3000); }
          else lead(t, semi, len, sec === "outro" ? 0.07 : 0.11, sec === "outro" ? 1800 : 3600);
        }
      }
      // Melodie B im Groove-Teil, im Break 2 und in der zweiten Hälfte von Drop 1 als Gegenstimme
      if (sec === "groove" || (sec === "drop1" && bar >= 48) || sec === "break2") {
        const idx = RHY_B.indexOf(step32);
        if (idx >= 0 && !gap) {
          const semi = MEL_B[ci][idx] + (sec === "drop1" ? 12 : 0);
          if (sec === "break2") lead(t, semi, STEP * 3.5, 0.11, 900 + Math.max(0, bar - 68) * 280);
          else lead(t, semi, STEP * 2, sec === "drop1" ? 0.05 : 0.08, 2600);
        }
      }
      // Arpeggio (16tel, Akkordtöne) in Intro, Aufbau, Groove, Drop 2 und Break 2
      if (sec === "build" || sec === "groove" || sec === "drop2" || (sec === "break2" && bar >= 68) || sec === "intro") {
        const tone = chord.tones[[0, 1, 2, 3, 2, 1, 3, 1][s % 8]] + 12 + lift;
        const bright = sec === "intro" ? 500 + bar * 150 : sec === "build" ? 1200 + (bar - 8) * 120 : 2600;
        if (!gap) pluck(t, tone, sec === "drop2" ? 0.035 : 0.05, bright);
      }
      // Flächen: in den Breaks, leise unter Aufbau, Drop 2 und Outro
      if (s === 0 && bar % 2 === 0) {
        const tones = chord.tones.map(x => x + lift);
        if (sec === "break1" || sec === "break2") pad(t, tones, STEP * 32, 0.07, sec === "break2" ? 900 + (bar - 64) * 120 : 1600);
        else if (sec === "drop2" || sec === "outro" || sec === "build") pad(t, tones, STEP * 32, 0.018, 1200);
      }
      // Riser vor beiden Drops
      if ((bar === 24 || bar === 72) && s === 0) riser(t, STEP * 16 * 7.75);
    }
    return { schedule, master };
  }

  // Live-Wiedergabe mit Vorausplanung (stabil auch bei Ruckeln)
  function player({ volume = 0.18 } = {}) {
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

  // Hörprobe/Tests: offline rendern
  async function render(seconds = TRACK_BARS * 16 * STEP, fromBar = 0, sampleRate = 44100, volume = 0.18, maxSteps = Infinity) {
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const eng = engine(ctx, volume);
    for (let i = fromBar * 16, n = 0, t = 0.02; t < seconds && n < maxSteps; i++, n++, t += STEP) eng.schedule(i, t);
    return ctx.startRendering();
  }
  // Ganzer Track in 8-Takt-Stücken (Nachklang wird aufaddiert) – schneller als alles auf einmal
  async function renderTrack(sampleRate = 44100, volume = 0.18) {
    const barLen = 16 * STEP, total = Math.ceil((TRACK_BARS * barLen + 3) * sampleRate);
    const L = new Float32Array(total), R = new Float32Array(total);
    for (let b = 0; b < TRACK_BARS; b += 8) {
      const bars = Math.min(8, TRACK_BARS - b), buf = await render(bars * barLen + 3, b, sampleRate, volume, bars * 16);
      const off = Math.round(b * barLen * sampleRate), l = buf.getChannelData(0), r = buf.getChannelData(1);
      for (let i = 0; i < l.length && off + i < total; i++) { L[off + i] += l[i]; R[off + i] += r[i]; }
    }
    return { L, R, sampleRate };
  }

  window.TAKT_BEAT = { player, render, renderTrack, BPM, TRACK_BARS, STEP };
})();
