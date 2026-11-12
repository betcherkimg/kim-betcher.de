// Juschkin Labs: Kim und Maksim als 3D-Spielfiguren.
// Charakterauswahl und Editor auf dem Podest, danach begleitet die gewählte Figur beim Scrollen.
// Eine einzige Zeichenfläche liegt fest über der Seite und zeichnet nur im Podest oder im Begleiter-Rahmen.
// Alle Dateien liegen lokal; es gibt keine Verbindung zu Dritten.
import * as THREE from "three";
import { GLTFLoader } from "./vendor/three/GLTFLoader.js";
import { MeshoptDecoder } from "./vendor/three/meshopt_decoder.module.js";

const ROOT = "/1293e128973/";
const STORE_KEY = "jl-figuren-v1";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const CHARACTERS = {
  kim: { name: "Kim", file: "kim.glb", prefix: "Kim", hair: "#6C4B35", skin: "#FFB490", parts: { Oberteil: "#E0D5D3", Hose: "#262528", Schuhe: "#262526" } },
  maksim: { name: "Maksim", file: "maksim.glb", prefix: "Maksim", hair: "#7C5D45", skin: "#FFAD7E", parts: { Oberteil: "#64C3F6", Hose: "#5E6693", Schuhe: "#32344B" } }
};
const HAIRSTYLES = [
  { name: "Original", key: "Original", locked: true },
  { name: "Kurz", key: "Kurz" }, { name: "Dutt", key: "Dutt" }, { name: "Irokese", key: "Irokese" },
  { name: "Kraus", key: "Kraus" }, { name: "Lang", key: "Lang" }, { name: "Lange Locken", key: "LangeLocken" },
  { name: "Locken", key: "Locken" }, { name: "Locs", key: "Locs" }, { name: "Zöpfe", key: "Zoepfe" },
  { name: "Zopf", key: "Zopf" }, { name: "Glatze", key: null }
];
const HAIR_COLORS = [
  ["Dunkelbraun", "#3B2A20"], ["Schwarz", "#1B1A1A"], ["Kastanie", "#7A3B22"], ["Rot", "#B4502C"],
  ["Blond", "#D9B56A"], ["Platin", "#E6DDCB"], ["Grau", "#9A9A9A"], ["Gold", "#D7C791"], ["Blau", "#8EBDFF"], ["Rosa", "#E79AB0"]
];
const SKIN_COLORS = [
  ["Sehr hell", "#FFD0B5"], ["Hell", "#F7B58F"], ["Mittel", "#D99A6C"], ["Hellbraun", "#B5754A"],
  ["Dunkelbraun", "#7A4A2E"], ["Sehr dunkel", "#47291C"], ["Blau", "#4F8FE6"]
];
const CLOTH_COLORS = [
  ["Weiß", "#F2F2F2"], ["Hellgrau", "#B8B8B8"], ["Schwarz", "#1E1E1E"], ["Rot", "#C0392B"], ["Blau", "#2F5FB3"],
  ["Jeansblau", "#4A6A8F"], ["Grün", "#3E8E4D"], ["Gold", "#D7C791"], ["Gelb", "#E3B93A"], ["Beige", "#CDB896"],
  ["Braun", "#6B4A32"], ["Rosa", "#E79AB0"], ["Lila", "#7A4FA3"]
];
const PARTS = ["Oberteil", "Hose", "Schuhe"];
const LOOK_DEFAULTS = { frisur: "Original", haarfarbe: "Original", haut: "Original", Oberteil: "Original", Hose: "Original", Schuhe: "Original" };

const hairColors = (id) => [["Original", CHARACTERS[id].hair], ...HAIR_COLORS];
const skinColors = (id) => [["Original", CHARACTERS[id].skin], ...SKIN_COLORS];
const clothColors = (id, part) => [["Original", CHARACTERS[id].parts[part]], ...CLOTH_COLORS];
const findColor = (list, name) => (list.find(([label]) => label === name) || list[0])[1];

function readState() {
  const base = { aktiv: "kim", fertig: false, begleiter: true, figuren: { kim: { ...LOOK_DEFAULTS }, maksim: { ...LOOK_DEFAULTS } } };
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}");
    return { ...base, ...saved, figuren: { kim: { ...LOOK_DEFAULTS, ...saved.figuren?.kim }, maksim: { ...LOOK_DEFAULTS, ...saved.figuren?.maksim } } };
  } catch {
    return base;
  }
}
function writeState() {
  try { window.localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* Speichern ist nur eine Bequemlichkeit. */ }
}
function webglAvailable() {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
  } catch {
    return false;
  }
}

const stage = document.querySelector("[data-model-slot]");
const heroSection = document.querySelector(".hero");
let state = readState();
if (!CHARACTERS[state.aktiv]) state.aktiv = "kim";

// Die Charakterleiste (portfolio.js) soll die zuletzt gewählte Figur zeigen, auch ohne WebGL.
document.dispatchEvent(new CustomEvent("figur:bereit", { detail: state.aktiv }));

if (webglAvailable() && (stage || (state.fertig && state.begleiter))) {
  start().catch((error) => {
    console.warn("3D-Figur konnte nicht geladen werden:", error);
    stage?.classList.remove("is-loading", "is-loading-figure", "is-3d");
    const status = stage?.querySelector(".stage-status");
    if (status) status.textContent = "";
  });
}

async function start() {
  const status = stage?.querySelector(".stage-status");
  stage?.classList.add("is-loading");

  // Zeichenfläche und Licht
  const canvas = document.createElement("canvas");
  canvas.className = "figure-layer";
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(22, 1, 0.05, 60);
  scene.add(new THREE.HemisphereLight(0xf1eee4, 0x1d1c16, 1.5));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.3);
  keyLight.position.set(-1.6, 2.6, 3.2);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.7);
  fillLight.position.set(2.2, 1.2, 2.4);
  const rimGold = new THREE.DirectionalLight(0xe6d39a, 2.6);
  rimGold.position.set(-2.6, 1.8, -2.2);
  const rimBlue = new THREE.DirectionalLight(0x8ebdff, 2.2);
  rimBlue.position.set(2.6, 2, -2.2);
  scene.add(keyLight, fillLight, rimGold, rimBlue);

  const pivot = new THREE.Group();
  scene.add(pivot);

  // Figuren werden erst geladen, wenn sie gebraucht werden
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const loading = {};
  let active = null;
  let wanted = state.aktiv;
  let gesture = null;

  function loadFigure(id) {
    if (loading[id]) return loading[id];
    loading[id] = loader.loadAsync(`${ROOT}assets/figuren/${CHARACTERS[id].file}`, (event) => {
      if (status && event.total && id === wanted) status.textContent = `${CHARACTERS[id].name} wird geladen: ${Math.round((event.loaded / event.total) * 100)} %`;
    }).then((gltf) => {
      const model = gltf.scene;
      const materials = {};
      const hairMeshes = {};
      model.traverse((object) => {
        if (!object.isMesh) return;
        object.frustumCulled = false;
        materials[object.material.name] = object.material;
        if (object.name.startsWith("Frisur_")) hairMeshes[object.name] = object;
      });
      for (const name of ["Haut", ...PARTS]) makeTintable(materials[name]);
      if (materials.Haar) materials.Haar.vertexColors = true;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      const mixer = new THREE.AnimationMixer(model);
      const actions = {};
      for (const clip of gltf.animations) actions[clip.name.replace(/^[A-Za-z]+_/, "")] = mixer.clipAction(clip);
      const figure = { id, model, materials, hairMeshes, mixer, actions, height: box.max.y - box.min.y, current: null, currentName: "" };
      mixer.addEventListener("finished", (event) => {
        if (figure === active && event.action === figure.current && gesture) {
          gesture = null;
          play("Idle", { fade: 0.4 });
        }
      });
      applyLook(figure);
      return figure;
    });
    loading[id].catch(() => { delete loading[id]; });
    return loading[id];
  }

  function play(name, { once = false, fade = 0.35, timeScale = 1 } = {}) {
    const figure = active;
    const next = figure?.actions[name];
    if (!next) return;
    if (next === figure.current && !once) { next.timeScale = timeScale; return; }
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.timeScale = timeScale;
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    if (figure.current && fade > 0) next.crossFadeFrom(figure.current, fade, false);
    else if (figure.current) figure.current.stop();
    next.play();
    figure.current = next;
    figure.currentName = name;
  }
  function doGesture(name) {
    if (!active?.actions[name]) return;
    gesture = name;
    play(name, { once: true, fade: 0.25 });
    wake();
  }

  function applyLook(figure) {
    const id = figure.id;
    const look = state.figuren[id];
    const style = HAIRSTYLES.find((item) => item.name === look.frisur) || HAIRSTYLES[0];
    const meshName = style.key ? `Frisur_${CHARACTERS[id].prefix}_${style.key}` : null;
    for (const [name, mesh] of Object.entries(figure.hairMeshes)) mesh.visible = name === meshName;
    figure.materials.Haar?.color.set(style.locked ? CHARACTERS[id].hair : findColor(hairColors(id), look.haarfarbe));
    figure.materials.Haut?.userData.tint.set(findColor(skinColors(id), look.haut));
    for (const part of PARTS) figure.materials[part]?.userData.tint.set(findColor(clothColors(id, part), look[part]));
  }

  async function show(id, { greet = false } = {}) {
    wanted = id;
    if (active?.id !== id) {
      pivot.visible = false;
      stage?.classList.add("is-loading-figure");
    }
    editor?.rebuild();
    const figure = await loadFigure(id);
    if (wanted !== id) return;
    if (active !== figure) {
      if (active) {
        active.mixer.stopAllAction();
        active.current = null;
        pivot.remove(active.model);
      }
      active = figure;
      pivot.add(figure.model);
      gesture = null;
      play("Idle", { fade: 0 });
    }
    pivot.visible = true;
    stage?.classList.remove("is-loading", "is-loading-figure");
    stage?.classList.add("is-3d");
    if (status) status.textContent = "";
    if (greet && !reduceMotion) doGesture("Wave");
    wake();
  }

  // Begleiter-Rahmen unten links
  const companion = document.createElement("div");
  companion.className = "companion";
  companion.hidden = true;
  companion.innerHTML = '<button class="companion-figure" type="button" aria-label="Die Figur winkt dir zu"></button><button class="companion-close" type="button" aria-label="Begleiter ausblenden"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
  document.body.append(companion);
  const gestures = ["Wave", "Talk", "Jump"];
  let gestureIndex = 0;
  companion.querySelector(".companion-figure").addEventListener("click", () => {
    doGesture(gestures[gestureIndex % gestures.length]);
    gestureIndex += 1;
  });
  companion.querySelector(".companion-close").addEventListener("click", () => {
    state.begleiter = false;
    writeState();
    updateMode();
  });

  // Ansichten: Podest oder Begleiter
  let heroVisible = false;
  let mode = null;
  let editing = false;
  let heroYaw = 0;
  let walk = null;
  const clock = new THREE.Clock();
  let frameRequest = 0;
  const frames = { hero: { feet: -0.84, head: 0.86 }, companion: { feet: -0.9, head: 0.84 } };

  const rectOf = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right };
  };
  function draw(frameRect, renderRect, framing) {
    if (!active || !pivot.visible || frameRect.width < 2 || frameRect.height < 2) return;
    if (renderRect.bottom < 0 || renderRect.top > window.innerHeight || renderRect.right < 0 || renderRect.left > window.innerWidth) return;
    const scale = active.height / (framing.head - framing.feet);
    const target = -framing.feet * scale;
    const distance = scale / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.aspect = frameRect.width / frameRect.height;
    camera.position.set(0, target, distance);
    camera.lookAt(0, target, 0);
    camera.setViewOffset(frameRect.width, frameRect.height, renderRect.left - frameRect.left, renderRect.top - frameRect.top, renderRect.width, renderRect.height);
    camera.updateProjectionMatrix();
    const y = window.innerHeight - renderRect.bottom;
    renderer.setViewport(renderRect.left, y, renderRect.width, renderRect.height);
    renderer.setScissor(renderRect.left, y, renderRect.width, renderRect.height);
    renderer.setScissorTest(true);
    renderer.render(scene, camera);
  }

  let lastScroll = window.scrollY;
  let scrollSpeed = 0;
  let scrollDir = 1;
  let calmFor = 0;
  const greetQueue = [];
  const damp = (value, targetValue, lambda, dt) => THREE.MathUtils.lerp(value, targetValue, 1 - Math.exp(-lambda * dt));

  function tick() {
    frameRequest = 0;
    const dt = Math.min(clock.getDelta(), 0.05);
    const dy = window.scrollY - lastScroll;
    lastScroll = window.scrollY;
    scrollSpeed = damp(scrollSpeed, dt > 0 ? Math.abs(dy) / dt : 0, 10, dt);
    if (dy !== 0) scrollDir = Math.sign(dy);

    if (walk) {
      walk.elapsed += dt;
      const progress = Math.min(1, walk.elapsed / walk.duration);
      pivot.position.x = THREE.MathUtils.lerp(walk.from, walk.to, progress);
      pivot.rotation.y = damp(pivot.rotation.y, walk.yaw, 10, dt);
      if (progress >= 1) {
        const done = walk.done;
        walk = null;
        done?.();
      }
    } else if (mode === "companion") {
      if (scrollSpeed > 60 && !reduceMotion) {
        calmFor = 0;
        if (gesture) gesture = null;
        play(scrollSpeed > 1900 ? "Run" : "Walk", { timeScale: THREE.MathUtils.clamp(scrollSpeed / 750, 0.75, 1.5), fade: 0.25 });
        pivot.rotation.y = damp(pivot.rotation.y, scrollDir > 0 ? 1.15 : -1.15, 8, dt);
      } else {
        calmFor += dt;
        if (!gesture && active?.currentName !== "Idle") play("Idle", { fade: 0.45 });
        pivot.rotation.y = damp(pivot.rotation.y, 0.38, 5, dt);
        if (calmFor > 0.45 && greetQueue.length && !gesture) {
          greetQueue.length = 0;
          doGesture("Wave");
        }
      }
    } else if (mode === "hero") {
      pivot.rotation.y = damp(pivot.rotation.y, heroYaw, 9, dt);
    }

    active?.mixer.update(dt);
    renderer.setScissorTest(false);
    renderer.clear();
    if (mode === "hero" && stage) {
      const frameRect = rectOf(stage);
      draw(frameRect, walk?.wide && heroSection ? rectOf(heroSection) : frameRect, frames.hero);
    } else if (mode === "companion") {
      const box = rectOf(companion);
      draw(box, box, frames.companion);
    }
    if (mode) frameRequest = requestAnimationFrame(tick);
  }
  function wake() {
    if (!frameRequest && mode && !document.hidden) {
      clock.getDelta();
      frameRequest = requestAnimationFrame(tick);
    }
  }

  function updateMode() {
    const wantCompanion = !editing && state.fertig && state.begleiter && !heroVisible;
    const next = (stage && (heroVisible || editing)) || walk?.wide ? "hero" : wantCompanion ? "companion" : null;
    if (next === mode) { wake(); return; }
    const previous = mode;
    mode = next;
    companion.hidden = mode !== "companion";
    if (mode === "companion") {
      if (active?.id !== state.aktiv) show(state.aktiv);
      gesture = null;
      if (!reduceMotion && previous !== "companion") {
        pivot.position.x = -1.4;
        pivot.rotation.y = 1.3;
        play("Walk", { fade: 0.2 });
        walk = { from: -1.4, to: 0, elapsed: 0, duration: 1.5, yaw: 1.3, done: () => play("Idle", { fade: 0.5 }) };
      } else {
        pivot.position.x = 0;
        pivot.rotation.y = 0.38;
        play("Idle", { fade: 0.2 });
      }
    } else if (mode === "hero" && !walk) {
      pivot.position.x = 0;
      pivot.rotation.y = heroYaw;
      play("Idle", { fade: 0.2 });
    }
    if (!mode) {
      renderer.setScissorTest(false);
      renderer.clear();
    }
    wake();
  }

  window.addEventListener("resize", () => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    wake();
  });
  window.addEventListener("scroll", wake, { passive: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });

  if (stage) {
    new IntersectionObserver(([entry]) => {
      heroVisible = entry.isIntersecting;
      updateMode();
    }, { threshold: 0.12 }).observe(stage);
  }
  const greetSeen = new Set();
  const sections = document.querySelectorAll("main > section[id], main.legal");
  if (sections.length) {
    const greeter = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !greetSeen.has(entry.target) && mode === "companion") {
          greetSeen.add(entry.target);
          greetQueue.push(entry.target.id);
          wake();
        }
      }
    }, { threshold: 0.35 });
    sections.forEach((section) => greeter.observe(section));
  }

  // Podest: Figur statt Foto, drehen mit Ziehen oder Pfeiltasten
  let editor = null;
  if (stage) {
    stage.tabIndex = 0;
    stage.setAttribute("role", "img");
    stage.setAttribute("aria-label", "3D-Spielfigur. Zum Drehen ziehen oder Pfeiltasten nutzen.");
    let dragX = null;
    stage.addEventListener("dragstart", (event) => event.preventDefault());
    stage.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      dragX = event.clientX;
      stage.setPointerCapture(event.pointerId);
      stage.classList.add("is-dragging");
    });
    stage.addEventListener("pointermove", (event) => {
      if (dragX === null) return;
      heroYaw += (event.clientX - dragX) * 0.012;
      dragX = event.clientX;
      wake();
    });
    const stopDrag = () => { dragX = null; stage.classList.remove("is-dragging"); };
    stage.addEventListener("pointerup", stopDrag);
    stage.addEventListener("pointercancel", stopDrag);
    stage.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        heroYaw += event.key === "ArrowRight" ? 0.35 : -0.35;
        wake();
      }
    });
    stage.addEventListener("dblclick", () => doGesture("Wave"));
    editor = setupEditor();
    // Auswahl in der Charakterleiste (gesteuert von portfolio.js)
    document.addEventListener("figur:wahl", (event) => {
      const id = event.detail;
      if (!CHARACTERS[id] || (id === state.aktiv && active?.id === id)) return;
      state.aktiv = id;
      writeState();
      heroYaw = 0;
      show(id, { greet: true });
    });
  }
  await show(state.aktiv);
  updateMode();
  // Die andere Figur schon im Hintergrund holen, damit der Wechsel sofort klappt.
  if (stage) {
    const other = state.aktiv === "kim" ? "maksim" : "kim";
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 1500)))(() => loadFigure(other).catch(() => {}));
  }

  // Charakter-Editor
  function setupEditor() {
    const createButton = document.querySelector("[data-create]");
    const worldsButton = document.querySelector("[data-worlds]");
    const editorActions = document.querySelector(".editor-actions");
    const lookPanel = document.querySelector('[data-editor="look"]');
    const outfitPanel = document.querySelector('[data-editor="outfit"]');
    const modeLabel = document.querySelector("[data-mode-label]");
    if (!createButton || !lookPanel || !outfitPanel || !editorActions) return null;
    createButton.hidden = false;
    if (state.fertig) createButton.textContent = "Charakter anpassen";
    worldsButton?.classList.remove("btn-primary");

    const look = () => state.figuren[state.aktiv];
    const changed = () => { if (active?.id === state.aktiv) applyLook(active); refresh(); wake(); };

    function swatchRow(label, key, list, { lockable = false } = {}) {
      const row = document.createElement("div");
      row.className = "ed-row";
      row.dataset.key = key;
      row.innerHTML = `<p class="ed-label"><span>${label}</span><span class="ed-current"></span></p>`;
      const group = document.createElement("div");
      group.className = "swatches";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", label);
      for (const [name, hex] of list) {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = "swatch";
        swatch.style.setProperty("--swatch", hex);
        swatch.dataset.value = name;
        swatch.title = name;
        swatch.setAttribute("aria-label", `${label}: ${name}`);
        swatch.addEventListener("click", () => { look()[key] = name; changed(); });
        group.append(swatch);
      }
      row.append(group);
      if (lockable) {
        const lock = document.createElement("p");
        lock.className = "ed-lock";
        lock.hidden = true;
        lock.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span></span>';
        row.append(lock);
      }
      return row;
    }

    let builtFor = null;
    function rebuild() {
      const id = state.aktiv;
      if (builtFor === id) { refresh(); return; }
      builtFor = id;
      lookPanel.querySelectorAll(".ed-row").forEach((row) => row.remove());
      outfitPanel.querySelectorAll(".ed-row").forEach((row) => row.remove());
      const hairRow = document.createElement("div");
      hairRow.className = "ed-row";
      hairRow.innerHTML = '<p class="ed-label"><span>Frisur</span><span class="ed-current" data-hair-count></span></p><div class="ed-select"><button class="btn btn-icon" type="button" data-hair-step="-1" aria-label="Vorherige Frisur"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg></button><output class="ed-value" aria-live="polite" data-hair-name></output><button class="btn btn-icon" type="button" data-hair-step="1" aria-label="Nächste Frisur"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button></div>';
      hairRow.querySelectorAll("[data-hair-step]").forEach((button) => button.addEventListener("click", () => {
        const index = Math.max(0, HAIRSTYLES.findIndex((item) => item.name === look().frisur));
        look().frisur = HAIRSTYLES[(index + Number(button.dataset.hairStep) + HAIRSTYLES.length) % HAIRSTYLES.length].name;
        changed();
      }));
      lookPanel.append(hairRow, swatchRow("Haarfarbe", "haarfarbe", hairColors(id), { lockable: true }), swatchRow("Hautfarbe", "haut", skinColors(id)));
      for (const part of PARTS) outfitPanel.append(swatchRow(part, part, clothColors(id, part)));
      refresh();
    }

    function refresh() {
      const current = look();
      const index = Math.max(0, HAIRSTYLES.findIndex((item) => item.name === current.frisur));
      const style = HAIRSTYLES[index];
      const name = lookPanel.querySelector("[data-hair-name]");
      if (!name) return;
      name.textContent = style.name;
      lookPanel.querySelector("[data-hair-count]").textContent = `${index + 1} / ${HAIRSTYLES.length}`;
      document.querySelectorAll(".ed-row[data-key]").forEach((row) => {
        const key = row.dataset.key;
        row.querySelector(".ed-current").textContent = current[key];
        row.querySelectorAll(".swatch").forEach((swatch) => swatch.setAttribute("aria-pressed", String(swatch.dataset.value === current[key])));
        if (key === "haarfarbe") {
          const locked = style.locked || !style.key;
          row.classList.toggle("is-locked", locked);
          row.querySelectorAll(".swatch").forEach((swatch) => { swatch.disabled = locked; });
          const lock = row.querySelector(".ed-lock");
          lock.hidden = !locked;
          lock.querySelector("span").textContent = style.locked ? "Bei der Originalfrisur gesperrt" : "Ohne Haare keine Haarfarbe";
          if (locked) row.querySelector(".ed-current").textContent = style.locked ? "Original" : "–";
        }
      });
    }

    const setEditing = (on) => {
      editing = on;
      heroSection?.classList.toggle("is-editing", on);
      lookPanel.hidden = !on;
      outfitPanel.hidden = !on;
      editorActions.hidden = !on;
      createButton.closest(".hero-actions").hidden = on;
      document.querySelector(".roster")?.toggleAttribute("inert", on);
      if (modeLabel) modeLabel.textContent = on ? `${CHARACTERS[state.aktiv].name} gestalten` : "Charakter wählen";
      if (on) { heroYaw = 0; state.begleiter = true; }
      updateMode();
    };
    createButton.addEventListener("click", () => {
      rebuild();
      setEditing(true);
      stage.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    });
    editorActions.querySelector("[data-reset]").addEventListener("click", () => {
      state.figuren[state.aktiv] = { ...LOOK_DEFAULTS };
      changed();
    });
    editorActions.querySelector("[data-done]").addEventListener("click", () => {
      state.fertig = true;
      state.begleiter = true;
      writeState();
      createButton.textContent = "Charakter anpassen";
      setEditing(false);
      const target = document.querySelector("#leistungen");
      const goOn = () => target?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
      if (reduceMotion) { goOn(); return; }
      // Die Figur dreht sich zur Seite und läuft vom Podest; danach geht es weiter.
      gesture = null;
      play("Walk", { fade: 0.25 });
      heroYaw = 0;
      walk = {
        from: 0, to: 2.6, elapsed: 0, duration: 2.1, yaw: Math.PI / 2, wide: true,
        done: () => {
          pivot.position.x = 0;
          pivot.rotation.y = 0;
          play("Idle", { fade: 0 });
          updateMode();
        }
      };
      updateMode();
      setTimeout(goOn, 1100);
    });
    return { rebuild };
  }

  function makeTintable(material) {
    if (!material) return;
    const tint = new THREE.Color(1, 1, 1);
    material.userData.tint = tint;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTint = { value: tint };
      shader.fragmentShader = `uniform vec3 uTint;\n${shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          diffuseColor.rgb *= sampledDiffuseColor.rgb * mix( vec3( 1.0 ), uTint, sampledDiffuseColor.a );
        #endif`
      )}`;
    };
    material.customProgramCacheKey = () => "jl-tint";
    material.needsUpdate = true;
  }
}
