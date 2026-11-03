/* TAKT Nr. 30 – epischer Hintergrund-Track mit Hardtekk-Drop, live im Browser erzeugt
   (keine Audiodatei, keine Lizenzfragen). 150 BPM, ca. 2 Minuten, ein Drop, danach von vorn.
   Instrumente: Piano, Streicher, Chor, Supersaw-Lead, Arpeggio, Orchester-Stabs, Pauken,
   Offbeat-Bass, Kick, Hats, Ride, Clap, Snare-Wirbel, Becken, Riser – mit Hall und Echo.
   Startet nur nach einem Tipp (Browser-Regel). */
(function () {
  "use strict";
  const BPM = 150, STEP = 60 / BPM / 4;            // 16tel
  const TRACK_BARS = 76;                           // ≈ 2 Minuten
  const fA4 = semi => 440 * Math.pow(2, semi / 12);

  // Akkordfolge a-Moll: Am – F – C – G (je 2 Takte); Töne relativ zu A4
  const CHORDS = [
    { root: 0, tones: [0, 3, 7] },
    { root: -4, tones: [-4, 0, 3] },
    { root: 3, tones: [3, 7, 10] },
    { root: -2, tones: [-2, 2, 5] }
  ];
  // Hauptmelodie: je Akkord [16tel-Position in 2 Takten, Halbton, Länge in 16teln]
  const THEME = [
    [[0, 7, 6], [6, 7, 2], [8, 5, 4], [12, 3, 4], [16, 2, 6], [22, 3, 2], [24, 0, 8]],
    [[0, 3, 6], [6, 3, 2], [8, 5, 4], [12, 7, 4], [16, 8, 6], [22, 7, 2], [24, 3, 8]],
    [[0, 10, 6], [6, 10, 2], [8, 8, 4], [12, 7, 4], [16, 5, 6], [22, 7, 2], [24, 3, 8]],
    [[0, 5, 6], [6, 7, 2], [8, 5, 4], [12, 2, 4], [16, -2, 6], [22, 2, 2], [24, 5, 8]]
  ];
  // Gegenstimme im Drop (höher, ruhiger)
  const COUNTER = [
    [[0, 12, 12], [16, 15, 8], [24, 14, 8]],
    [[0, 12, 12], [16, 10, 8], [24, 12, 8]],
    [[0, 15, 12], [16, 14, 8], [24, 12, 8]],
    [[0, 14, 12], [16, 10, 8], [24, 14, 8]]
  ];

  function noiseBuffer(ctx, sec = 2) {
    const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function shaper(ctx, amount) {
    const ws = ctx.createWaveShaper(), n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(x * amount) / Math.tanh(amount); }
    ws.curve = c; ws.oversample = "2x"; return ws;
  }
  function impulse(ctx, sec = 3.2, decay = 2.6) {
    const len = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return b;
  }

  function engine(ctx, volume = 0.2) {
    const master = ctx.createGain(); master.gain.value = volume;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.15;
    master.connect(comp).connect(ctx.destination);
    const noise = noiseBuffer(ctx);

    // Hall (groß, episch) und Echo (punktierte Achtel) als Sends
    const verb = ctx.createConvolver(); verb.buffer = impulse(ctx); const verbOut = ctx.createGain(); verbOut.gain.value = 0.5; verb.connect(verbOut).connect(master);
    const dly = ctx.createDelay(1); dly.delayTime.value = STEP * 3; const fb = ctx.createGain(); fb.gain.value = 0.35;
    const dTone = ctx.createBiquadFilter(); dTone.type = "lowpass"; dTone.frequency.value = 3000;
    dly.connect(dTone).connect(fb).connect(dly); const dOut = ctx.createGain(); dOut.gain.value = 0.28; dTone.connect(dOut).connect(master);
    const wet = (node, amount = 0.4, echo = 0) => {
      const g = ctx.createGain(); g.gain.value = amount; node.connect(g).connect(verb);
      if (echo) { const e = ctx.createGain(); e.gain.value = echo; node.connect(e).connect(dly); }
    };
    // Pump (sanftes Sidechain-Gefühl) für Musik, Kick direkt
    const pump = ctx.createGain(); pump.connect(master);
    const kickBus = shaper(ctx, 2.2); kickBus.connect(master);
    function duck(t) { pump.gain.cancelScheduledValues(t); pump.gain.setValueAtTime(0.55, t); pump.gain.linearRampToValueAtTime(1, t + STEP * 3); }

    /* ---------- Instrumente ---------- */
    function kick(t, power = 1) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(240, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.06);
      g.gain.setValueAtTime(power, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
      o.connect(g).connect(kickBus); o.start(t); o.stop(t + 0.28);
      const c = ctx.createBufferSource(), cf = ctx.createBiquadFilter(), cg = ctx.createGain();
      c.buffer = noise; cf.type = "highpass"; cf.frequency.value = 3000; cg.gain.setValueAtTime(0.35 * power, t); cg.gain.exponentialRampToValueAtTime(0.001, t + 0.01);
      c.connect(cf).connect(cg).connect(kickBus); c.start(t, Math.random()); c.stop(t + 0.02);
      duck(t);
    }
    // Offbeat-Bass (Hardtekk-Muster, aber sauber und ohne übertriebenen Druck)
    function bass(t, semi, open = 900) {
      const g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = "lowpass"; f.Q.value = 4; f.frequency.setValueAtTime(open * 1.8, t); f.frequency.exponentialRampToValueAtTime(open * 0.6, t + STEP * 1.6);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.005); g.gain.exponentialRampToValueAtTime(0.001, t + STEP * 1.8);
      f.connect(g).connect(pump);
      [-8, 8].forEach(c => { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = fA4(semi - 36); o.detune.value = c; o.connect(f); o.start(t); o.stop(t + STEP * 2); });
    }
    // Piano/E-Piano: Sinus-Teiltöne mit unterschiedlichem Ausklang
    function piano(t, semi, len, level = 0.12) {
      const f0 = fA4(semi), out = ctx.createGain(); out.gain.value = level; out.connect(pump); wet(out, 0.45, 0.15);
      [[1, 1, 1.8], [2, 0.45, 0.9], [3, 0.2, 0.5], [4, 0.12, 0.3]].forEach(([mul, amp, dec]) => {
        const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = f0 * mul * (1 + (mul - 1) * 0.0008);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(amp, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0008, t + Math.min(len + 0.3, dec * 2.2));
        o.connect(g).connect(out); o.start(t); o.stop(t + Math.min(len + 0.35, dec * 2.2 + 0.05));
      });
    }
    // Streicher: langsamer Einsatz, Vibrato, verstimmte Sägezähne
    function strings(t, tones, len, level = 0.03, bright = 2200) {
      const out = ctx.createGain(), f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = bright; f.Q.value = 0.5;
      out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(level, t + Math.min(0.6, len * 0.4));
      out.gain.setValueAtTime(level, t + len * 0.85); out.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.4);
      f.connect(out); out.connect(pump); wet(out, 0.6);
      const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 5.2; lg.gain.value = 9; lfo.connect(lg); lfo.start(t); lfo.stop(t + len + 0.45);
      tones.forEach(semi => [-9, 0, 9].forEach(c => {
        const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = fA4(semi); o.detune.value = c; lg.connect(o.detune);
        o.connect(f); o.start(t); o.stop(t + len + 0.45);
      }));
    }
    // Chor „Aah“: Formantfilter auf Sägezähnen
    function choir(t, tones, len, level = 0.05) {
      const out = ctx.createGain(); out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(level, t + 0.8);
      out.gain.setValueAtTime(level, t + len * 0.8); out.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.6);
      out.connect(pump); wet(out, 0.9);
      const forms = [[800, 1], [1150, 0.6], [2900, 0.25]].map(([fr, amp]) => { const b = ctx.createBiquadFilter(), g = ctx.createGain(); b.type = "bandpass"; b.frequency.value = fr; b.Q.value = 6; g.gain.value = amp * 4; b.connect(g).connect(out); return b; });
      tones.forEach(semi => [-12, 12].forEach(c => {
        const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = fA4(semi - 12); o.detune.value = c;
        forms.forEach(b => o.connect(b)); o.start(t); o.stop(t + len + 0.65);
      }));
    }
    // Supersaw-Lead (Drop)
    function lead(t, semi, len, level = 0.08, bright = 4200) {
      const f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = "lowpass"; f.Q.value = 1.5;
      f.frequency.setValueAtTime(bright * 1.4, t); f.frequency.exponentialRampToValueAtTime(bright * 0.7, t + len);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.008); g.gain.setValueAtTime(level * 0.85, t + len * 0.8); g.gain.exponentialRampToValueAtTime(0.0008, t + len + 0.08);
      f.connect(g).connect(pump); wet(g, 0.45, 0.3);
      [-18, -9, 0, 9, 18].forEach(c => { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = fA4(semi); o.detune.value = c; o.connect(f); o.start(t); o.stop(t + len + 0.1); });
    }
    function arp(t, semi, level = 0.04, bright = 2600) {
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = "square"; o.frequency.value = fA4(semi);
      f.type = "lowpass"; f.frequency.setValueAtTime(bright, t); f.frequency.exponentialRampToValueAtTime(350, t + 0.11);
      g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      o.connect(f).connect(g).connect(pump); wet(g, 0.25, 0.4); o.start(t); o.stop(t + 0.15);
    }
    // Orchester-Stab (Blech-artig) für Akzente im Drop
    function brass(t, tones, level = 0.06) {
      const f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = "lowpass"; f.frequency.setValueAtTime(600, t); f.frequency.exponentialRampToValueAtTime(3200, t + 0.05); f.frequency.exponentialRampToValueAtTime(900, t + 0.5);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      f.connect(g).connect(pump); wet(g, 0.6);
      tones.forEach(semi => [-6, 6].forEach(c => { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = fA4(semi - 12); o.detune.value = c; o.connect(f); o.start(t); o.stop(t + 0.75); }));
    }
    function timpani(t, semi, level = 0.5) {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(fA4(semi - 36) * 1.15, t); o.frequency.exponentialRampToValueAtTime(fA4(semi - 36), t + 0.15);
      g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
      o.connect(g).connect(master); wet(g, 0.5); o.start(t); o.stop(t + 1.15);
      noiseHit(t, { type: "lowpass", freq: 400, level: level * 0.4, len: 0.08, dest: master });
    }
    function noiseHit(t, { type = "highpass", freq = 8000, q = 0.7, level = 0.1, len = 0.04, room = 0, dest = pump } = {}) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
      g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      s.connect(f).connect(g).connect(dest); if (room) wet(g, room);
      s.start(t, Math.random() * 1.5); s.stop(t + len + 0.02);
    }
    function clap(t, level = 0.3) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; f.type = "bandpass"; f.frequency.value = 1500; f.Q.value = 0.9;
      g.gain.setValueAtTime(0, t);
      [0, 0.011, 0.022].forEach(d => { g.gain.setValueAtTime(level, t + d); g.gain.exponentialRampToValueAtTime(level * 0.15, t + d + 0.009); });
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      s.connect(f).connect(g).connect(pump); wet(g, 0.35); s.start(t, Math.random()); s.stop(t + 0.27);
    }
    function snare(t, level = 0.2, pitch = 1) {
      noiseHit(t, { type: "bandpass", freq: 2400 * pitch, q: 0.6, level, len: 0.1, room: 0.3 });
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(230 * pitch, t); o.frequency.exponentialRampToValueAtTime(170 * pitch, t + 0.05);
      g.gain.setValueAtTime(level * 0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07); o.connect(g).connect(pump); o.start(t); o.stop(t + 0.09);
    }
    function crash(t, level = 0.2) { noiseHit(t, { freq: 4000, level, len: 2.4, room: 0.6, dest: master }); }
    function impact(t) {
      crash(t, 0.26);
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(80, t); o.frequency.exponentialRampToValueAtTime(30, t + 1.4);
      g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.5); o.connect(g).connect(master); wet(g, 0.4); o.start(t); o.stop(t + 1.6);
    }
    function swell(t, len, level = 0.2) {   // Rauschen + aufsteigender Ton bis zum Drop
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; s.loop = true; f.type = "bandpass"; f.Q.value = 2.5;
      f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(10000, t + len);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + len); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.03);
      s.connect(f).connect(g).connect(master); wet(g, 0.5); s.start(t); s.stop(t + len + 0.05);
    }

    /* ---------- Ablauf (Takte) ----------
       0–7   Intro: Piano + Streicher, dazu Chor – ohne Drums
       8–15  Thema: Piano-Melodie, leichter Kick, Hats, Arpeggio
       16–31 Aufbau: Bass, Clap, Streicher-Ostinato, Pauken, Echo-Arpeggio
       32–39 Break: große Melodie mit Chor und Streichern, Riser, Snare-Wirbel, kurze Stille
       40–63 DROP: Supersaw-Hook, Offbeat-Bass, Orchester-Stabs, Chor, Gegenstimme, letzte 8 Takte einen Ton höher
       64–75 Outro: Drums gehen raus, Piano und Streicher klingen aus */
    function section(bar) {
      if (bar < 8) return "intro";
      if (bar < 16) return "theme";
      if (bar < 32) return "build";
      if (bar < 40) return "break";
      if (bar < 64) return "drop";
      return "outro";
    }

    function schedule(step, t) {
      const s = step % 16, bar = Math.floor(step / 16) % TRACK_BARS, sec = section(bar);
      const lift = sec === "drop" && bar >= 56 ? 2 : 0;
      const ci = Math.floor(bar / 2) % 4, chord = CHORDS[ci], tones = chord.tones.map(x => x + lift);
      const pos = (bar % 2) * 16 + s, phrase = bar % 8, drop = sec === "drop";
      const gap = bar === 39 && s >= 12;

      // ----- Harmonien -----
      if (pos === 0) {
        if (sec === "intro" || sec === "theme") strings(t, tones.map(x => x - 12), STEP * 32, sec === "intro" ? 0.022 : 0.014, 1000 + bar * 70);
        if (sec === "break") strings(t, tones, STEP * 32, 0.03, 2600);
        if (drop) strings(t, tones, STEP * 32, 0.02, 3200);
        if (sec === "outro" && bar < 74) strings(t, tones.map(x => x - 12), STEP * 32, 0.022, 1600);
        if ((sec === "intro" && bar >= 4) || sec === "break" || drop) choir(t, tones, STEP * 32, sec === "break" ? 0.06 : sec === "intro" ? 0.035 : 0.045);
      }
      // Streicher-Ostinato (Achtel) im Aufbau
      if (sec === "build" && s % 2 === 0) {
        const n = [chord.root + 12, chord.tones[2], chord.tones[1] + 12, chord.tones[2]][(s / 2) % 4];
        strings(t, [n], STEP * 1.6, 0.018 + (bar - 16) * 0.001, 1500 + (bar - 16) * 120);
      }

      // ----- Melodie -----
      const note = THEME[ci].find(n => n[0] === pos);
      if (note && !gap) {
        const [, semi, len] = note, L = STEP * len * 0.95;
        if (sec === "theme" || sec === "outro") piano(t, semi + 12 + lift, L, sec === "outro" ? 0.07 : 0.08);
        if (sec === "build" && bar >= 24) piano(t, semi + 12, L, 0.08);
        if (sec === "break") { piano(t, semi + 12, L, 0.12); lead(t, semi + 12, L, 0.03 + (bar - 32) * 0.006, 1200 + (bar - 32) * 400); }
        if (drop) { lead(t, semi + 12 + lift, L, 0.095, 4800); lead(t, semi + lift, L, 0.05, 2600); }
      }
      if (drop && bar >= 48) {   // Gegenstimme in der zweiten Hälfte
        const c = COUNTER[ci].find(n => n[0] === pos);
        if (c) choir(t, [c[1] + lift], STEP * c[2], 0.03);
      }
      // Intro: Piano spielt die Akkorde in Vierteln
      if (sec === "intro" && s % 4 === 0) piano(t, tones[(s / 4 + bar) % 3], STEP * 4, 0.07);

      // ----- Arpeggio -----
      if ((sec === "theme" && bar >= 12) || sec === "build" || drop) {
        const seq = [0, 1, 2, 1, 2, 0, 1, 2], semi = chord.tones[seq[s % 8]] + 12 + lift + (s % 16 >= 8 && drop ? 12 : 0);
        if (!gap) arp(t, semi, drop ? 0.028 : 0.035, sec === "build" ? 1200 + (bar - 16) * 150 : 3000);
      }

      // ----- Drums -----
      const kickOn = (sec === "theme" && bar >= 10) || sec === "build" || drop || (sec === "outro" && bar < 70);
      if (kickOn && s % 4 === 0) kick(t, sec === "theme" ? 0.7 : drop ? 1 : 0.85);
      if (drop && phrase === 7 && s === 14) kick(t, 0.6);
      if ((sec === "theme" && bar >= 12) || sec === "build" || drop || (sec === "outro" && bar < 72)) {
        if (s % 2 === 1) noiseHit(t, { freq: 9500, level: drop ? 0.05 : 0.04, len: 0.025 });
        if (s % 4 === 2) noiseHit(t, { freq: 7000, level: drop ? 0.11 : 0.08, len: 0.1 });
      }
      if (drop && s % 4 === 0) noiseHit(t, { type: "bandpass", freq: 5500, q: 3, level: 0.04, len: 0.35 });   // Ride
      if ((s === 4 || s === 12) && ((sec === "build" && bar >= 20) || drop || (sec === "outro" && bar < 68))) clap(t, drop ? 0.3 : 0.24);
      // Bass: Offbeat (Hardtekk), im Drop mit zusätzlichem 16tel
      if ((sec === "build" && bar >= 16) || drop || (sec === "outro" && bar < 68)) {
        if (s % 4 === 2) bass(t, chord.root + lift + 12, drop ? 1400 : 600 + (bar - 16) * 50);
        if (drop && s % 4 === 3 && phrase % 2 === 1) bass(t, chord.root + lift + 24, 1600);
      }
      // Pauken & Becken
      if (sec === "build" && pos === 0) timpani(t, chord.root, 0.35 + (bar - 16) * 0.015);
      if (sec === "break" && s === 0 && bar % 4 === 0) timpani(t, chord.root, 0.4);
      if (drop && phrase === 0 && s === 0) { if (bar === 40) impact(t); else crash(t); brass(t, tones, 0.06); }
      if (drop && (s === 6 || s === 14) && phrase % 2 === 1) brass(t, tones, 0.035);
      if (sec === "theme" && bar === 8 && s === 0) crash(t, 0.12);
      if (bar === 16 && s === 0) crash(t, 0.18);
      // Fills am Phrasenende
      if ((sec === "build" || drop) && phrase === 7 && s >= 12) snare(t, 0.1 + (s - 12) * 0.04, 1 + (s - 12) * 0.04);

      // ----- Break: Riser + Snare-Wirbel vor dem Drop -----
      if (bar === 32 && s === 0) swell(t, STEP * 16 * 7.75, 0.2);
      if (bar >= 36 && bar <= 39 && !gap) {
        const every = [4, 2, 1, 0.5][bar - 36], lvl = 0.06 + (bar - 36) * 0.05 + s * 0.005, p = 1 + (bar - 36) * 0.1 + s * 0.008;
        if (every >= 1 ? s % every === 0 : true) snare(t, lvl, p);
        if (every < 1) snare(t + STEP / 2, lvl, p);
      }
      // Outro: letzter Akkord klingt lang aus
      if (bar === 74 && s === 0) { piano(t, 12, STEP * 32, 0.1); piano(t, 7, STEP * 32, 0.08); piano(t, 0, STEP * 32, 0.08); }
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

  // Hörprobe/Tests: offline rendern
  async function render(seconds = TRACK_BARS * 16 * STEP, fromBar = 0, sampleRate = 44100, volume = 0.2, maxSteps = Infinity) {
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const eng = engine(ctx, volume);
    for (let i = fromBar * 16, n = 0, t = 0.02; t < seconds && n < maxSteps; i++, n++, t += STEP) eng.schedule(i, t);
    return ctx.startRendering();
  }
  // Ganzer Track in 8-Takt-Stücken (Nachklang wird aufaddiert) – schneller als alles auf einmal
  async function renderTrack(sampleRate = 44100, volume = 0.2) {
    const barLen = 16 * STEP, total = Math.ceil((TRACK_BARS * barLen + 4) * sampleRate);
    const L = new Float32Array(total), R = new Float32Array(total);
    for (let b = 0; b < TRACK_BARS; b += 8) {
      const bars = Math.min(8, TRACK_BARS - b), buf = await render(bars * barLen + 4, b, sampleRate, volume, bars * 16);
      const off = Math.round(b * barLen * sampleRate), l = buf.getChannelData(0), r = buf.getChannelData(1);
      for (let i = 0; i < l.length && off + i < total; i++) { L[off + i] += l[i]; R[off + i] += r[i]; }
    }
    return { L, R, sampleRate };
  }

  window.TAKT_BEAT = { player, render, renderTrack, BPM, TRACK_BARS, STEP };
})();
