// kim-betcher.de: Kims Wut. Dieses Modul kümmert sich um alles, was auf der Seite kaputtgeht.
// Pro Wutausbruch geht nur eine Kleinigkeit kaputt: ein Wort, ein Bild, eine Linie oder ein Fleck auf der Seite.
// Was Kim dabei tut (hinrennen, springen, kritzeln, wegrennen), steht in figur.js.
// Schäden bleiben im Browser gespeichert, bis man die Stelle anklickt oder die Seite zurücksetzt.

const STORE_KEY = "kb-wut-v2";
const TEXTS = "h2, h3, p, li, figcaption, dt, dd, blockquote, strong, span";
// Hier fasst Kim nichts an: Bühne und Editor, Fenster, Knöpfe, Navigation, Formulare und alles, was dieses Modul selbst anlegt
const OFF_LIMITS = ".hero, dialog, nav, button, .btn, summary, label, form, [hidden], [aria-hidden='true'], .wut-ebene, .wut-beute, .companion";
const NAMES = {
  malen: "übermaltes Bild", brechen: "kaputtes Bild", klauen: "geklaute Stelle", streichen: "durchgestrichener Text",
  wischen: "verwischte Schrift", wirbeln: "durcheinandergebrachte Buchstaben", schlagen: "kaputtes Wort",
  kritzeln: "Gekritzel auf der Seite", linie: "kaputte Linie"
};
const KINDS = { w: ["wirbeln", "schlagen", "wischen", "klauen", "streichen"], b: ["malen", "klauen", "brechen"], s: ["kritzeln"], l: ["linie"] };
const WITH_PEN = new Set(["malen", "streichen", "kritzeln"]);
const PENS = ["#c0392b", "#2f5fb3", "#3e8e4d", "#1f2d3a"];

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
const fixed = (value) => value.toFixed(1);
const choose = (list) => list[Math.floor(Math.random() * list.length)];

// Filzstift-Gekritzel für eine Fläche von width × height Pixeln: Zickzack, Spirale, Kreuz, Schwung
function scribblePaths(seed, width, height, strokes) {
  const dice = random(seed);
  const paths = [];
  const unit = Math.min(width, height);
  for (let index = 0; index < strokes; index += 1) {
    const pen = PENS[Math.floor(dice() * PENS.length)];
    const thick = fixed(3 + dice() * 3);
    const style = Math.floor(dice() * 4);
    let d = "";
    if (style === 0) {
      let x = width * (0.06 + dice() * 0.2); let y = height * (0.2 + dice() * 0.6);
      d = `M${fixed(x)} ${fixed(y)}`;
      for (let step = 0; step < 8; step += 1) { x += width * (0.05 + dice() * 0.07); y += (step % 2 ? -1 : 1) * unit * (0.16 + dice() * 0.26); d += ` L${fixed(x)} ${fixed(Math.min(height * 0.96, Math.max(height * 0.04, y)))}`; }
    } else if (style === 1) {
      const cx = width * (0.25 + dice() * 0.5); const cy = height * (0.3 + dice() * 0.4);
      d = `M${fixed(cx)} ${fixed(cy)}`;
      for (let step = 1; step < 28; step += 1) { const angle = step * 0.55; const radius = step * unit * (0.012 + dice() * 0.003); d += ` L${fixed(cx + Math.cos(angle) * radius)} ${fixed(cy + Math.sin(angle) * radius)}`; }
    } else if (style === 2) {
      const cx = width * (0.2 + dice() * 0.6); const cy = height * (0.25 + dice() * 0.5); const size = unit * (0.12 + dice() * 0.14);
      d = `M${fixed(cx - size)} ${fixed(cy - size)} L${fixed(cx + size)} ${fixed(cy + size)} L${fixed(cx + size)} ${fixed(cy - size)} L${fixed(cx - size)} ${fixed(cy + size)}`;
    } else {
      const y = height * (0.25 + dice() * 0.5);
      d = `M${fixed(width * (0.04 + dice() * 0.1))} ${fixed(y)} C ${fixed(width * 0.3)} ${fixed(y - unit * (0.5 - dice() * 0.3))}, ${fixed(width * 0.6)} ${fixed(y + unit * (0.2 + dice() * 0.4))}, ${fixed(width * (0.88 + dice() * 0.08))} ${fixed(y - unit * (0.2 - dice() * 0.3))}`;
    }
    paths.push({ d, pen, thick });
  }
  return paths;
}
// Durchstreichen: ein oder zwei wacklige Striche quer durch die Zeile
function strikePaths(seed, width, height) {
  const dice = random(seed);
  const pen = PENS[Math.floor(dice() * PENS.length)];
  const paths = [];
  const count = 1 + Math.floor(dice() * 2);
  for (let index = 0; index < count; index += 1) {
    const y = height * (0.42 + dice() * 0.2 + index * 0.12);
    const wobble = height * 0.22;
    let d = `M${fixed(-4)} ${fixed(y + (dice() - 0.5) * wobble)}`;
    const steps = Math.max(3, Math.round(width / 38));
    for (let step = 1; step <= steps; step += 1) d += ` L${fixed((width + 8) * (step / steps) - 4)} ${fixed(y + (dice() - 0.5) * wobble)}`;
    paths.push({ d, pen, thick: fixed(2.6 + dice() * 1.6) });
  }
  return paths;
}
// Sprung im Bild: gezackte Risse von einem Punkt aus
function crackPaths(seed, width, height) {
  const dice = random(seed);
  const cx = width * (0.3 + dice() * 0.4); const cy = height * (0.3 + dice() * 0.4);
  const paths = [];
  const rays = 5 + Math.floor(dice() * 3);
  for (let ray = 0; ray < rays; ray += 1) {
    let angle = (ray / rays) * Math.PI * 2 + dice() * 0.6;
    let x = cx; let y = cy;
    let d = `M${fixed(x)} ${fixed(y)}`;
    const reach = Math.max(width, height) * (0.35 + dice() * 0.5);
    for (let done = 0; done < reach; ) { const step = 14 + dice() * 26; angle += (dice() - 0.5) * 0.9; x += Math.cos(angle) * step; y += Math.sin(angle) * step; done += step; d += ` L${fixed(x)} ${fixed(y)}`; }
    paths.push({ d });
  }
  return paths;
}
const svgOf = (width, height, inner) => `<svg viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" preserveAspectRatio="none" aria-hidden="true" fill="none" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export function setupWut() {
  const page = (window.location.pathname.split("/").pop() || "index.html").replace(/\.html$/, "") || "index";
  const root = document.querySelector("main");
  // Im Impressum und im Datenschutz bleibt alles heil
  const enabled = Boolean(root) && !/^(impressum|datenschutz)$/.test(page);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!enabled) return { enabled: false, count: 0, pick: () => null, visible: () => false, rect: () => null, cancel() {}, wreck() {}, steal: () => null, sketch: () => null, pen() {}, moveLoot() {}, dropLoot() {}, loseLoot() {}, meter() {}, reset() {} };

  const read = () => { try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}") || {}; } catch { return {}; } };
  const write = (all) => { try { window.localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* ohne Speicher gilt der Schaden nur bis zum Neuladen */ } };
  const save = () => { const all = read(); const list = [...damage.values()].map((entry) => entry.data); if (list.length) all[page] = list; else delete all[page]; write(all); };

  const damage = new Map();     // Schlüssel -> { data, spot, loot, anchor }
  const prepared = new Map();   // Textelement -> { html, text, label, words, uses }
  const keyOf = (data) => `${data.t}:${data.i}:${data.w ?? ""}:${data.fx ?? ""}`;

  // Feste Listen: Die Nummer einer Stelle darin wird gespeichert
  const free = (element) => !element.closest(OFF_LIMITS);
  const leaf = (element) => element.children.length === 0 || [...element.children].every((child) => child.tagName === "BR");
  const textOf = (element) => prepared.get(element)?.text ?? element.textContent;
  const texts = () => [...root.querySelectorAll(TEXTS)].filter((element) => free(element) && (prepared.has(element) || (leaf(element) && element.textContent.trim().length >= 3 && element.textContent.length <= 400)));
  const images = () => [...root.querySelectorAll("img")].filter(free);
  const hosts = () => [...root.querySelectorAll("section[id]")];
  const edgeOf = (element) => { const style = window.getComputedStyle(element); return parseFloat(style.borderTopWidth) >= 1 && style.borderTopStyle !== "none" ? "t" : parseFloat(style.borderBottomWidth) >= 1 && style.borderBottomStyle !== "none" ? "b" : ""; };
  const lines = () => [...root.querySelectorAll("li, dl > div, dt, dd, header, article, blockquote, hr, .section-head, .wrap > div, footer")].filter((element) => free(element) && edgeOf(element));
  const listOf = (type) => type === "w" ? texts() : type === "b" ? images() : type === "s" ? hosts() : lines();
  const signature = (type, element) => type === "w" ? textOf(element).trim().slice(0, 40) : type === "b" ? (element.getAttribute("src") || "").split("/").pop().split("?")[0] : type === "s" ? element.id : `${element.tagName}.${element.className}`.slice(0, 60);

  // Ebene über dem Inhalt: Auf jeder kaputten Stelle liegt ein Knopf, der sie heilt
  const layer = document.createElement("div");
  layer.className = "wut-ebene";
  document.body.append(layer);
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "wut-reset";
  resetButton.textContent = "Seite zurücksetzen";
  resetButton.hidden = true;
  resetButton.addEventListener("click", () => reset());
  document.body.append(resetButton);
  const meterBox = document.createElement("div");
  meterBox.className = "wut-anzeige";
  meterBox.setAttribute("role", "meter");
  meterBox.setAttribute("aria-label", "Kims Wut");
  meterBox.setAttribute("aria-valuemin", "0");
  meterBox.setAttribute("aria-valuemax", "100");
  meterBox.title = "Kims Wut";
  meterBox.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 2.5 5.5 13.4h5l-1.6 8.1 8.6-11.6h-5.3z" fill="currentColor"/></svg><span class="wut-balken"><span></span></span>';
  meterBox.hidden = true;
  document.body.append(meterBox);
  const meterFill = meterBox.querySelector(".wut-balken span");
  const penBox = document.createElement("div");
  penBox.className = "wut-stift";
  penBox.hidden = true;
  penBox.innerHTML = '<svg viewBox="0 0 16 56" aria-hidden="true"><path d="M8 56 3.5 45h9z" fill="currentColor"/><rect x="2.5" y="8" width="11" height="37" rx="2.5" fill="#f4f1ea" stroke="#1f2d3a" stroke-width="1.2"/><rect x="2.5" y="2" width="11" height="10" rx="2.5" fill="currentColor" stroke="#1f2d3a" stroke-width="1.2"/></svg>';
  document.body.append(penBox);

  // Texte: Wörter einzeln einpacken, sobald in einem Absatz etwas kaputtgeht. Vorleseprogramme bekommen weiter den ganzen Text.
  function prepare(element) {
    let info = prepared.get(element);
    if (info) return info;
    info = { html: element.innerHTML, text: element.textContent, label: element.getAttribute("aria-label"), words: [], uses: 0 };
    element.setAttribute("aria-label", info.text.trim());
    element.textContent = "";
    for (const part of info.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { element.append(document.createTextNode(" ")); continue; }
      const word = document.createElement("span");
      word.className = "wut-wort";
      word.setAttribute("aria-hidden", "true");
      word.textContent = part;
      word.dataset.wort = part;
      info.words.push(word);
      element.append(word);
    }
    prepared.set(element, info);
    return info;
  }
  function release(element) {
    const info = prepared.get(element);
    if (!info || info.uses > 0) return;
    element.innerHTML = info.html;
    if (info.label === null) element.removeAttribute("aria-label"); else element.setAttribute("aria-label", info.label);
    prepared.delete(element);
  }
  const plain = (word) => { word.textContent = word.dataset.wort; word.className = "wut-wort"; };
  function spell(word) {
    const signs = [...word.dataset.wort];
    word.textContent = "";
    return signs.map((sign) => { const letter = document.createElement("span"); letter.className = "wut-b"; letter.textContent = sign; word.append(letter); return letter; });
  }

  // Wo liegt die Stelle gerade? (Bildschirm-Koordinaten)
  function boxOf(entry) {
    const data = entry.data;
    if (data.t === "w") {
      const info = prepared.get(entry.anchor);
      const run = info ? info.words.slice(data.w, data.w + (data.n || 1)) : [];
      if (!run.length) return entry.anchor.getBoundingClientRect();
      const boxes = run.map((word) => word.getBoundingClientRect());
      const left = Math.min(...boxes.map((box) => box.left)); const top = Math.min(...boxes.map((box) => box.top));
      return new DOMRect(left, top, Math.max(...boxes.map((box) => box.right)) - left, Math.max(...boxes.map((box) => box.bottom)) - top);
    }
    const box = entry.anchor.getBoundingClientRect();
    if (data.t === "s") return new DOMRect(box.left + data.fx * box.width, box.top + data.fy * box.height, data.fw, data.fh);
    if (data.t === "l") return new DOMRect(box.left + data.fx * box.width - 30, (data.e === "t" ? box.top : box.bottom) - 12, 60, 24);
    return box;
  }
  function place() {
    for (const entry of damage.values()) {
      const box = boxOf(entry);
      const style = entry.spot.style;
      style.left = `${box.left + window.scrollX}px`;
      style.top = `${box.top + window.scrollY}px`;
      style.width = `${box.width}px`;
      style.height = `${box.height}px`;
    }
    resetButton.hidden = damage.size === 0;
  }
  let placing = 0;
  const placeSoon = () => { if (!placing) placing = requestAnimationFrame(() => { placing = 0; place(); }); };
  window.addEventListener("resize", placeSoon);
  window.addEventListener("scroll", placeSoon, { passive: true });
  window.addEventListener("load", placeSoon);
  if ("ResizeObserver" in window) new ResizeObserver(placeSoon).observe(root);

  const strokes = (paths) => paths.map((path) => `<path d="${path.d}" stroke="${path.pen}" stroke-width="${path.thick}"/>`).join("");
  // Schaden anlegen. fresh: gerade passiert (kurzer Ruck). Die Zeichnung selbst blendet sketch() ein.
  function apply(data, anchor, fresh) {
    const spot = document.createElement("button");
    spot.type = "button";
    spot.className = `wut-stelle wut-${data.kind}`;
    spot.setAttribute("aria-label", `Reparieren: ${NAMES[data.kind]}`);
    spot.title = "Klick: reparieren";
    const entry = { data, spot, loot: null, anchor };
    const key = keyOf(data);
    spot.addEventListener("click", () => heal(key));
    damage.set(key, entry);
    layer.append(spot);
    const dice = random(data.seed);
    if (data.t === "w") {
      const info = prepare(anchor);
      info.uses += 1;
      const word = info.words[data.w];
      if (data.kind === "wirbeln") {
        const letters = spell(word);
        const signs = letters.map((letter) => letter.textContent);
        // Reihenfolge würfeln; bleibt sie zufällig gleich, die ersten beiden tauschen
        const mixed = signs.map((sign) => [dice(), sign]).sort((a, b) => a[0] - b[0]).map((pair) => pair[1]);
        if (mixed.join("") === signs.join("") && mixed.length > 1) [mixed[0], mixed[1]] = [mixed[1], mixed[0]];
        letters.forEach((letter, index) => { letter.textContent = mixed[index]; letter.style.setProperty("--y", `${((dice() - 0.5) * 0.24).toFixed(2)}em`); letter.style.setProperty("--r", `${Math.round((dice() - 0.5) * 30)}deg`); });
        word.classList.add("wut-kaputt");
      } else if (data.kind === "schlagen") {
        for (const letter of spell(word)) {
          const falls = dice() < 0.4;
          letter.style.setProperty("--x", `${((dice() - 0.5) * 0.7).toFixed(2)}em`);
          letter.style.setProperty("--y", `${(falls ? 0.5 + dice() * 0.9 : (dice() - 0.5) * 0.7).toFixed(2)}em`);
          letter.style.setProperty("--r", `${Math.round((dice() - 0.5) * (falls ? 190 : 70))}deg`);
          if (falls) letter.classList.add("wut-liegt");
        }
        word.classList.add("wut-kaputt");
      } else if (data.kind === "wischen") word.classList.add("wut-verwischt");
      else if (data.kind === "klauen") {
        const letters = spell(word);
        const take = Math.min(letters.length, 1 + Math.floor(dice() * 3));
        const start = Math.floor(dice() * (letters.length - take + 1));
        letters.slice(start, start + take).forEach((letter) => letter.classList.add("wut-weg"));
        entry.taken = letters.slice(start, start + take).map((letter) => letter.textContent).join("");
      }
    } else if (data.t === "b") {
      if (data.kind === "klauen") anchor.classList.add("wut-geklaut");
      else if (data.kind === "brechen") { anchor.style.setProperty("--wut-dreh", `${((dice() - 0.5) * 7).toFixed(1)}deg`); anchor.classList.add("wut-schief"); }
    }
    place();
    const box = boxOf(entry);
    if (data.kind === "malen" || data.kind === "kritzeln") spot.innerHTML = svgOf(box.width, box.height, strokes(scribblePaths(data.seed, box.width, box.height, data.kind === "malen" ? 3 + Math.floor(dice() * 2) : 2 + Math.floor(dice() * 2))));
    else if (data.kind === "streichen") spot.innerHTML = svgOf(box.width, box.height, strokes(strikePaths(data.seed, box.width, box.height)));
    else if (data.kind === "brechen") { const cracks = crackPaths(data.seed, box.width, box.height); spot.innerHTML = svgOf(box.width, box.height, cracks.map((path) => `<path d="${path.d}" stroke="rgba(255,255,255,.9)" stroke-width="3.2"/>`).join("") + cracks.map((path) => `<path d="${path.d}" stroke="rgba(20,28,36,.85)" stroke-width="1.3"/>`).join("")); }
    else if (data.kind === "linie") {
      // Flicken in der Farbe des Untergrunds, darauf die zwei abgeknickten Enden
      let ground = anchor; let paper = "";
      while (ground && !paper) { const color = window.getComputedStyle(ground).backgroundColor; if (color && !/rgba?\([^)]*,\s*0\)$/.test(color) && color !== "transparent") paper = color; ground = ground.parentElement; }
      const style = window.getComputedStyle(anchor);
      const ink = data.e === "t" ? style.borderTopColor : style.borderBottomColor;
      spot.style.setProperty("--wut-papier", paper || "#fff");
      spot.innerHTML = `<svg viewBox="0 0 60 24" aria-hidden="true" fill="none" stroke-linecap="round"><path d="M0 12 L22 ${fixed(17 + dice() * 4)}" stroke="${ink}" stroke-width="1.6"/><path d="M60 12 L40 ${fixed(4 + dice() * 4)}" stroke="${ink}" stroke-width="1.6"/></svg>`;
    }
    if (fresh && !reduceMotion && !WITH_PEN.has(data.kind)) { spot.classList.add("wut-neu"); window.setTimeout(() => spot.classList.remove("wut-neu"), 500); }
    return entry;
  }

  function heal(key, quiet = false) {
    const entry = damage.get(key);
    if (!entry) return;
    damage.delete(key);
    entry.spot.remove();
    const { data, anchor, loot } = entry;
    const lootHome = (after) => {
      if (loot && loot.isConnected && !reduceMotion && !quiet) {
        // Das Stück fliegt an seinen Platz zurück
        const box = boxOf(entry);
        loot.classList.add("wut-heim");
        loot.style.left = `${box.left + box.width / 2 - loot.offsetWidth / 2}px`;
        loot.style.top = `${box.top + box.height / 2 - loot.offsetHeight / 2}px`;
        loot.style.bottom = "auto";
        window.setTimeout(() => { loot.remove(); after(); }, 420);
      } else { loot?.remove(); after(); }
    };
    if (data.t === "w") {
      const info = prepared.get(anchor);
      const mend = () => { if (!info) return; plain(info.words[data.w]); info.uses -= 1; release(anchor); placeSoon(); };
      if (data.kind === "klauen") lootHome(mend); else mend();
    } else if (data.t === "b") {
      if (data.kind === "klauen") lootHome(() => anchor.classList.remove("wut-geklaut"));
      else { anchor.classList.remove("wut-schief"); anchor.style.removeProperty("--wut-dreh"); }
    }
    if (!quiet) { save(); place(); }
  }

  function reset() {
    for (const key of [...damage.keys()]) heal(key, true);
    // Die ganze Website ist wieder heil, nicht nur diese Seite
    write({});
    place();
  }

  // Liegt die Fläche gut sichtbar im Bild (unter der Kopfleiste)?
  function seen(box, share = 0.6) {
    if (box.width < 8 || box.height < 8) return false;
    const seenX = Math.min(box.right, window.innerWidth) - Math.max(box.left, 0);
    const seenY = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 76);
    return seenX > 0 && seenY > 0 && (seenX * seenY) / (box.width * box.height) >= share;
  }
  const shown = (element) => { const style = window.getComputedStyle(element); return style.visibility !== "hidden" && Number(style.opacity) > 0.5; };
  const busy = (type, index) => [...damage.values()].some((entry) => entry.data.t === type && entry.data.i === index);

  let lastKind = "";
  function kindFor(type, allowed = KINDS[type]) {
    const options = allowed.filter((kind) => kind !== lastKind);
    return choose(options.length ? options : allowed);
  }
  function make(type, index, anchor, extra, kind) {
    const data = { t: type, i: index, kind, seed: Math.floor(Math.random() * 1e9), sig: signature(type, anchor), ...extra };
    return { data, anchor, kind, pen: WITH_PEN.has(kind) };
  }
  function pickWord() {
    const all = texts();
    const visible = all.filter((element) => shown(element) && seen(element.getBoundingClientRect(), 0.5));
    for (let attempt = 0; attempt < 6 && visible.length; attempt += 1) {
      const element = visible.splice(Math.floor(Math.random() * visible.length), 1)[0];
      const index = all.indexOf(element);
      const info = prepare(element);
      const taken = new Set();
      for (const entry of damage.values()) if (entry.data.t === "w" && entry.data.i === index) for (let step = 0; step < (entry.data.n || 1); step += 1) taken.add(entry.data.w + step);
      const options = info.words.map((word, number) => number).filter((number) => !taken.has(number) && [...info.words[number].dataset.wort].length >= 3 && seen(info.words[number].getBoundingClientRect(), 0.95));
      if (!options.length) { release(element); continue; }
      const number = choose(options);
      const kind = kindFor("w");
      let run = 1;
      if (kind === "streichen") {
        // Mehrere Wörter derselben Zeile durchstreichen
        const top = info.words[number].getBoundingClientRect().top;
        while (run < 5 && info.words[number + run] && !taken.has(number + run) && Math.abs(info.words[number + run].getBoundingClientRect().top - top) < 4) run += 1;
      }
      lastKind = kind;
      return make("w", index, element, { w: number, n: run }, kind);
    }
    return null;
  }
  function pickImage() {
    const all = images();
    const options = all.filter((element, index) => !busy("b", index) && shown(element) && element.getBoundingClientRect().width >= 80 && seen(element.getBoundingClientRect()));
    if (!options.length) return null;
    const element = choose(options);
    const kind = kindFor("b");
    lastKind = kind;
    return make("b", all.indexOf(element), element, {}, kind);
  }
  function pickPage() {
    const all = hosts();
    const options = all.filter((element) => seen(element.getBoundingClientRect(), 0.25));
    if (!options.length) return null;
    const element = choose(options);
    const box = element.getBoundingClientRect();
    const width = Math.min(240, window.innerWidth * 0.5); const height = Math.min(150, window.innerHeight * 0.24);
    const left = Math.max(box.left, 12); const right = Math.min(box.right, window.innerWidth - 12) - width;
    const top = Math.max(box.top, 96); const bottom = Math.min(box.bottom, window.innerHeight - 120) - height;
    if (right < left || bottom < top) return null;
    const x = left + Math.random() * (right - left); const y = top + Math.random() * (bottom - top);
    lastKind = "kritzeln";
    return make("s", all.indexOf(element), element, { fx: Math.round(((x - box.left) / box.width) * 1000) / 1000, fy: Math.round(((y - box.top) / box.height) * 1000) / 1000, fw: Math.round(width), fh: Math.round(height) }, "kritzeln");
  }
  function pickLine() {
    const all = lines();
    const options = all.filter((element, index) => !busy("l", index) && shown(element) && element.getBoundingClientRect().width >= 140);
    const fitting = options.map((element) => ({ element, edge: edgeOf(element) })).filter(({ element, edge }) => { const box = element.getBoundingClientRect(); const y = edge === "t" ? box.top : box.bottom; return y > 96 && y < window.innerHeight - 40 && box.left >= 0 && box.right <= window.innerWidth + 1; });
    if (!fitting.length) return null;
    const { element, edge } = choose(fitting);
    lastKind = "linie";
    return make("l", all.indexOf(element), element, { fx: Math.round((0.15 + Math.random() * 0.7) * 1000) / 1000, e: edge }, "linie");
  }
  // Ein Ziel aussuchen: meist ein Wort, oft ein Bild, manchmal ein Fleck auf der Seite oder eine Linie
  function pick() {
    const order = [choose(["w", "w", "w", "w", "b", "b", "b", "s", "s", "l"]), "w", "b", "s", "l"];
    const tried = new Set();
    for (const type of order) {
      if (tried.has(type)) continue;
      tried.add(type);
      const target = type === "w" ? pickWord() : type === "b" ? pickImage() : type === "s" ? pickPage() : pickLine();
      if (target) return target;
    }
    return null;
  }
  const rect = (target) => boxOf({ data: target.data, anchor: target.anchor });
  // Ziel doch nicht getroffen: einen nur vorbereiteten Absatz wieder zusammensetzen
  function cancel(target) { if (target?.data.t === "w") release(target.anchor); }

  function wreck(target) {
    if (damage.has(keyOf(target.data))) return;
    apply(target.data, target.anchor, true);
    save();
  }
  // Mit dem Stift: Die Striche erscheinen nach und nach. Rückgabe: Fortschritt setzen, Stiftspitze abfragen, abschließen.
  function sketch(target) {
    if (damage.has(keyOf(target.data))) return null;
    const entry = apply(target.data, target.anchor, true);
    save();
    const paths = [...entry.spot.querySelectorAll("path")];
    const lengths = paths.map((path) => path.getTotalLength());
    const total = lengths.reduce((sum, length) => sum + length, 0) || 1;
    const view = entry.spot.querySelector("svg").viewBox.baseVal;
    paths.forEach((path, index) => { path.style.strokeDasharray = `${lengths[index]}`; path.style.strokeDashoffset = `${lengths[index]}`; });
    const locate = (progress) => {
      let rest = Math.min(1, Math.max(0, progress)) * total;
      for (let index = 0; index < paths.length; index += 1) {
        if (rest <= lengths[index] || index === paths.length - 1) return { index, along: Math.min(rest, lengths[index]) };
        rest -= lengths[index];
      }
      return { index: 0, along: 0 };
    };
    return {
      set(progress) {
        const spot = locate(progress);
        paths.forEach((path, index) => { path.style.strokeDashoffset = `${index < spot.index ? 0 : index > spot.index ? lengths[index] : lengths[index] - spot.along}`; });
      },
      at(progress) {
        const spot = locate(progress);
        const point = paths[spot.index].getPointAtLength(spot.along);
        const box = entry.spot.getBoundingClientRect();
        return { x: box.left + (point.x / view.width) * box.width, y: box.top + (point.y / view.height) * box.height, color: paths[spot.index].getAttribute("stroke") };
      },
      done() { paths.forEach((path) => { path.style.strokeDasharray = ""; path.style.strokeDashoffset = ""; }); penBox.hidden = true; }
    };
  }
  // Stift zeigen: Die Spitze sitzt auf x, y
  function pen(x, y, color) {
    if (!Number.isFinite(x)) { penBox.hidden = true; return; }
    penBox.hidden = false;
    penBox.style.color = color || PENS[0];
    penBox.style.left = `${x}px`;
    penBox.style.top = `${y}px`;
  }

  // Beute: ein kleines Abbild der Stelle, das Kim über dem Kopf trägt
  function makeLoot(entry) {
    const loot = document.createElement("button");
    loot.type = "button";
    loot.className = "wut-beute";
    loot.setAttribute("aria-label", "Zurücklegen");
    if (entry.data.t === "b") {
      const copy = document.createElement("img");
      copy.src = entry.anchor.currentSrc || entry.anchor.src;
      copy.alt = "";
      loot.append(copy);
      loot.classList.add("wut-beute-bild");
    } else { loot.textContent = entry.taken || ""; loot.classList.add("wut-beute-buchstaben"); }
    const key = keyOf(entry.data);
    loot.addEventListener("click", () => heal(key));
    return loot;
  }
  function steal(target) {
    if (damage.has(keyOf(target.data))) return null;
    const entry = apply(target.data, target.anchor, true);
    const box = boxOf(entry);
    const loot = makeLoot(entry);
    entry.loot = loot;
    loot.style.left = `${box.left + box.width / 2}px`;
    loot.style.top = `${box.top + box.height / 2}px`;
    document.body.append(loot);
    save();
    return loot;
  }
  const ownerOf = (loot) => [...damage.values()].find((entry) => entry.loot === loot);
  // x, y: Mitte der Unterkante (über Kims Kopf)
  function moveLoot(loot, x, y) {
    loot.style.left = `${x - loot.offsetWidth / 2}px`;
    loot.style.top = `${y - loot.offsetHeight}px`;
  }
  function lay(loot, x, entry) {
    // Die Ecke unten rechts gehört Anzeige und Knöpfen: Die Beute bleibt links davon, auf schmalen Bildschirmen liegt sie darüber
    const corner = window.innerWidth - 300;
    const roomy = corner - loot.offsetWidth >= 8;
    const left = Math.min(Math.max(8, x - loot.offsetWidth / 2), Math.max(8, (roomy ? corner : window.innerWidth - 8) - loot.offsetWidth));
    loot.classList.add("wut-am-boden");
    loot.style.left = `${left}px`;
    loot.style.top = "auto";
    loot.style.bottom = roomy ? "10px" : "132px";
    loot.style.setProperty("--wut-dreh", `${(random(entry.data.seed)() - 0.5) * 24}deg`);
    entry.data.lx = Math.round((left / Math.max(1, window.innerWidth)) * 1000) / 1000;
  }
  function dropLoot(loot, x) {
    const owner = ownerOf(loot);
    if (!owner) { loot.remove(); return; }
    lay(loot, x, owner);
    save();
  }
  function loseLoot(loot) {
    const owner = ownerOf(loot);
    if (owner) owner.loot = null;
    loot.remove();
  }

  // Wut-Anzeige unten rechts
  function meter(value) {
    if (meterBox.hidden) meterBox.hidden = false;
    meterFill.style.width = `${Math.min(100, Math.max(0, value)).toFixed(1)}%`;
    meterBox.setAttribute("aria-valuenow", String(Math.round(value)));
    meterBox.classList.toggle("wut-voll", value >= 100);
  }

  // Schäden vom letzten Besuch wieder anlegen
  const saved = read()[page];
  if (Array.isArray(saved) && saved.length) {
    for (const data of saved) {
      const anchor = listOf(data.t)[data.i];
      if (!anchor || !NAMES[data.kind] || damage.has(keyOf(data)) || signature(data.t, anchor) !== data.sig) continue;
      if (data.t === "w" && !(prepare(anchor).words[data.w])) { release(anchor); continue; }
      if (data.t === "l" && !edgeOf(anchor)) continue;
      const entry = apply(data, anchor, false);
      if (data.kind === "klauen" && typeof data.lx === "number") {
        const loot = makeLoot(entry);
        entry.loot = loot;
        document.body.append(loot);
        lay(loot, data.lx * window.innerWidth + loot.offsetWidth / 2, entry);
      }
    }
    save();
  }
  place();

  return {
    enabled: true,
    get count() { return damage.size; },
    pick,
    visible: (target) => seen(rect(target), 0.45),
    rect,
    cancel,
    wreck,
    steal,
    sketch,
    pen,
    moveLoot,
    dropLoot,
    loseLoot,
    meter,
    reset
  };
}
