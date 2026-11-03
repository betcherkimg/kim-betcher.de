// TAKT Nr. 30 – Hintergrund-Track (eigene Produktion von Kim), leise, mit Lautsprecher-Knopf.
// Browser blockieren Ton ohne Interaktion: dann startet der Track beim ersten Tippen/Klick auf der Seite,
// außer man hat ihn per Knopf ausgeschaltet (wird gemerkt).
(function () {
  const SRC = "/taktnr30/assets/takt30-track.mp3?v=1", VOL = 0.22, KEY = "takt30.sound";
  const audio = new Audio(SRC); audio.loop = true; audio.preload = "none"; audio.volume = 0;
  let muted = false, fade = 0;
  try { muted = localStorage.getItem(KEY) === "off"; } catch (e) {}

  const css = document.createElement("style");
  css.textContent = `.snd{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:40;width:48px;height:48px;border-radius:50%;border:1px solid var(--line-2,#33333d);background:rgba(10,10,12,.82);backdrop-filter:blur(6px);color:var(--ink,#f2f2f4);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.snd:hover{border-color:var(--uv,#9d4dff)}.snd svg{width:22px;height:22px}.snd.on{border-color:var(--uv,#9d4dff);color:var(--uv-soft,#c09bff)}
.snd .w{transition:opacity .2s}.snd:not(.on) .w{opacity:0}.snd .x{opacity:0}.snd:not(.on) .x{opacity:1}`;
  document.head.appendChild(css);
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "snd";
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="w" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/><path class="x" d="M17 9.5l5 5M22 9.5l-5 5"/></svg>`;

  function ramp(to, ms, done) {
    cancelAnimationFrame(fade); const from = audio.volume, t0 = performance.now();
    const step = t => { const k = Math.min(1, (t - t0) / ms); audio.volume = from + (to - from) * k; k < 1 ? fade = requestAnimationFrame(step) : done && done(); };
    fade = requestAnimationFrame(step);
  }
  function show() { const on = !audio.paused && !muted; btn.classList.toggle("on", on); btn.setAttribute("aria-label", on ? "Musik ausschalten" : "Musik einschalten"); btn.title = btn.getAttribute("aria-label"); }
  function play() {
    if (muted || !audio.paused) return;
    audio.play().then(() => { ramp(VOL, 2500); show(); }).catch(() => show());
  }
  function stop() { ramp(0, 500, () => { audio.pause(); show(); }); }

  btn.addEventListener("click", e => {
    e.stopPropagation();
    muted = !(audio.paused || muted);
    try { localStorage.setItem(KEY, muted ? "off" : "on"); } catch (e2) {}
    if (muted) stop(); else { muted = false; play(); }
    show();
  });
  const first = e => { if (btn.contains(e.target)) return; ["pointerdown", "keydown"].forEach(t => removeEventListener(t, first, true)); play(); };
  ["pointerdown", "keydown"].forEach(t => addEventListener(t, first, true));
  document.addEventListener("visibilitychange", () => { if (document.hidden) { if (!audio.paused) { audio.pause(); audio._hid = true; } } else if (audio._hid) { audio._hid = false; play(); } });

  document.body.appendChild(btn); show();
  play();   // klappt nur, wenn der Browser Autoplay erlaubt
})();
