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
    if (active === figure) editor?.rebuild();
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
  // Kamera-Ausschnitte im Editor: Anteil der Figur, der im Bild liegt
  const FOCUS = {
    ganz: { feet: -0.84, head: 0.86 },
    kopf: { feet: -3.7, head: 0.76 },
    oberkoerper: { feet: -2.0, head: 0.86 },
    beine: { feet: -0.91, head: 2.17 },
    schuhe: { feet: -0.8, head: 4.3 }
  };
  let focusName = "ganz";
  const heroFrame = { ...FOCUS.ganz };
  function setFocus(name) {
    focusName = FOCUS[name] ? name : "ganz";
    stage?.classList.toggle("is-zoomed", focusName !== "ganz");
    if (reduceMotion) Object.assign(heroFrame, FOCUS[focusName]);
    wake();
  }
  const thumbCamera = new THREE.PerspectiveCamera(22, 1, 0.01, 50);

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
    const focus = FOCUS[editing ? focusName : "ganz"];
    heroFrame.feet = damp(heroFrame.feet, focus.feet, 5, dt);
    heroFrame.head = damp(heroFrame.head, focus.head, 5, dt);

    active?.mixer.update(dt);
    renderView();
    if (mode) frameRequest = requestAnimationFrame(tick);
  }
  // Beim Heranzoomen läuft die Figur am Bühnenrand weich aus statt hart abgeschnitten zu werden
  let maskValue = "";
  function setMask(value) {
    if (value === maskValue) return;
    maskValue = value;
    canvas.style.maskImage = value;
    canvas.style.webkitMaskImage = value;
  }
  function renderView() {
    renderer.setScissorTest(false);
    renderer.clear();
    const zoom = mode === "hero" && stage && !walk?.wide ? Math.min(1, Math.max(0, (heroFrame.head - heroFrame.feet) / (FOCUS.ganz.head - FOCUS.ganz.feet) - 1)) : 0;
    if (zoom > 0.02) {
      const rect = stage.getBoundingClientRect();
      const fade = Math.round(70 * Math.min(1, zoom * 2));
      const top = Math.round(rect.top), bottom = Math.round(rect.bottom);
      setMask(`linear-gradient(to bottom, transparent ${top}px, #000 ${top + fade}px, #000 ${bottom - fade}px, transparent ${bottom}px)`);
    } else setMask("");
    if (mode === "hero" && stage) {
      const frameRect = rectOf(stage);
      draw(frameRect, walk?.wide && heroSection ? rectOf(heroSection) : frameRect, walk?.wide ? frames.hero : heroFrame);
    } else if (mode === "companion") {
      const box = rectOf(companion);
      draw(box, box, frames.companion);
    }
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

  // Charakter-Editor: Reiter links, Auswahl rechts, Kamera zoomt auf den passenden Körperteil
  function setupEditor() {
    const createButton = document.querySelector("[data-create]");
    const worldsButton = document.querySelector("[data-worlds]");
    const editorActions = document.querySelector(".editor-actions");
    const tabsPanel = document.querySelector('[data-editor="tabs"]');
    const optionsPanel = document.querySelector('[data-editor="options"]');
    const modeLabel = document.querySelector("[data-mode-label]");
    if (!createButton || !tabsPanel || !optionsPanel || !editorActions) return null;
    const tabList = tabsPanel.querySelector(".ed-tabs");
    const optionsBox = optionsPanel.querySelector(".ed-options");
    const optionsTitle = optionsPanel.querySelector("#options-title");
    const optionsValue = optionsPanel.querySelector(".ed-options-value");
    createButton.hidden = false;
    if (state.fertig) createButton.textContent = "Charakter anpassen";
    worldsButton?.classList.remove("btn-primary");

    const ICONS = {
      frisur: '<path d="M6 15c0-6 3-10 9-10 4 0 6 2 7 4-3-1-5 0-6 2 3-1 5 0 6 2-4-1-8 0-10 3"/><path d="M8 26c-2-3-2-7-2-11"/><path d="M18 22l6 6m-3-9 6 6"/>',
      haarfarbe: '<path d="M9 5c-2 6 2 9 0 15"/><path d="M14 5c-2 6 2 9 0 15"/><path d="M23 14s-4 4.5-4 7.5a4 4 0 0 0 8 0c0-3-4-7.5-4-7.5Z"/>',
      haut: '<path d="M10 28v-9l-3-4c-1-1 0-3 2-2l3 3V6a1.5 1.5 0 0 1 3 0v8-10a1.5 1.5 0 0 1 3 0v10-8a1.5 1.5 0 0 1 3 0v9-6a1.5 1.5 0 0 1 3 0v9c0 6-3 10-7 10h-6"/>',
      Oberteil: '<path d="M11 4c1 2 3 3 5 3s4-1 5-3l7 4-3 6-3-2v16H10V12l-3 2-3-6Z"/>',
      Hose: '<path d="M9 4h14l2 24h-6l-3-15-3 15H7Z"/><path d="M9 8h14"/>',
      Schuhe: '<path d="M3 21v-9h6l3 3h4l3-1 9 5v4H3Z"/><path d="M3 25h25"/><path d="M13 15l2 3m1-4 2 3"/>'
    };
    const CATEGORIES = [
      { key: "frisur", label: "Frisur", focus: "kopf" },
      { key: "haarfarbe", label: "Haare", title: "Haarfarbe", focus: "kopf" },
      { key: "haut", label: "Haut", focus: "oberkoerper" },
      { key: "Oberteil", label: "Oberteil", focus: "oberkoerper" },
      { key: "Hose", label: "Hose", focus: "beine" },
      { key: "Schuhe", label: "Schuhe", focus: "schuhe" }
    ];
    let current = "frisur";
    const look = () => state.figuren[state.aktiv];
    const styleOf = () => HAIRSTYLES.find((item) => item.name === look().frisur) || HAIRSTYLES[0];
    const hairLocked = () => { const style = styleOf(); return Boolean(style.locked || !style.key); };
    const listFor = (key) => key === "haarfarbe" ? hairColors(state.aktiv) : key === "haut" ? skinColors(state.aktiv) : clothColors(state.aktiv, key);
    const valueOf = (key) => key === "frisur" ? look().frisur : key === "haarfarbe" && hairLocked() ? (styleOf().locked ? "Original" : "–") : look()[key];

    // Reiter
    const tabButtons = {};
    for (const category of CATEGORIES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ed-tab";
      button.setAttribute("role", "tab");
      button.dataset.tab = category.key;
      button.innerHTML = `<span class="ed-tab-icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[category.key]}</svg></span><span class="ed-tab-text"><strong>${category.label}</strong><span class="ed-tab-value"></span></span><span class="ed-tab-dot" aria-hidden="true"></span>`;
      button.addEventListener("click", () => select(category.key));
      tabList.append(button);
      tabButtons[category.key] = button;
    }
    tabList.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const index = CATEGORIES.findIndex((category) => category.key === current);
      const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
      const next = CATEGORIES[(index + step + CATEGORIES.length) % CATEGORIES.length].key;
      select(next);
      tabButtons[next].focus();
    });

    function select(key) {
      current = key;
      setFocus(CATEGORIES.find((category) => category.key === key).focus);
      renderOptions();
      refreshTabs();
    }

    function refreshTabs() {
      for (const category of CATEGORIES) {
        const button = tabButtons[category.key];
        const on = category.key === current;
        button.setAttribute("aria-selected", String(on));
        button.tabIndex = on ? 0 : -1;
        button.classList.toggle("is-active", on);
        button.querySelector(".ed-tab-value").textContent = valueOf(category.key);
        const dot = button.querySelector(".ed-tab-dot");
        if (category.key === "frisur") dot.style.removeProperty("--swatch");
        else dot.style.setProperty("--swatch", category.key === "haarfarbe" && hairLocked() ? CHARACTERS[state.aktiv].hair : findColor(listFor(category.key), look()[category.key]));
        button.classList.toggle("is-locked", category.key === "haarfarbe" && hairLocked());
      }
    }

    function renderOptions() {
      const category = CATEGORIES.find((item) => item.key === current);
      optionsTitle.textContent = category.title || category.label;
      optionsValue.textContent = valueOf(current);
      optionsBox.replaceChildren();
      optionsBox.dataset.kind = current === "frisur" ? "frisur" : "farbe";
      if (current === "frisur") {
        const grid = document.createElement("div");
        grid.className = "hair-grid";
        HAIRSTYLES.forEach((style, index) => {
          const card = document.createElement("button");
          card.type = "button";
          card.className = "hair-card";
          card.dataset.value = style.name;
          card.setAttribute("aria-pressed", String(style.name === look().frisur));
          card.setAttribute("aria-label", `Frisur: ${style.name}`);
          const thumb = thumbs[`${state.aktiv}:${index}`];
          card.innerHTML = `<span class="hair-thumb">${thumb ? `<img src="${thumb}" alt="" width="160" height="160">` : ""}</span><span class="hair-name">${style.name}</span>`;
          card.addEventListener("click", () => { look().frisur = style.name; changed(); });
          grid.append(card);
        });
        optionsBox.append(grid);
        return;
      }
      const grid = document.createElement("div");
      grid.className = "orb-grid";
      grid.setAttribute("role", "group");
      grid.setAttribute("aria-label", category.title || category.label);
      const locked = current === "haarfarbe" && hairLocked();
      for (const [name, hex] of listFor(current)) {
        const orb = document.createElement("button");
        orb.type = "button";
        orb.className = "orb";
        orb.dataset.value = name;
        orb.dataset.texture = current === "Oberteil" ? "strick" : current === "Hose" ? "jeans" : current === "Schuhe" ? "leder" : current === "haarfarbe" ? "haar" : "haut";
        orb.style.setProperty("--swatch", hex);
        orb.title = name;
        orb.setAttribute("aria-label", `${category.title || category.label}: ${name}`);
        orb.setAttribute("aria-pressed", String(!locked && name === look()[current]));
        orb.disabled = locked;
        orb.innerHTML = `<span class="orb-name">${name}</span>`;
        orb.addEventListener("click", () => { look()[current] = name; changed(); });
        grid.append(orb);
      }
      optionsBox.append(grid);
      if (locked) {
        const note = document.createElement("div");
        note.className = "ed-lock";
        note.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span>${styleOf().locked ? "Bei der Originalfrisur ist die Haarfarbe gesperrt." : "Ohne Haare gibt es keine Haarfarbe."}</span>`;
        const pick = document.createElement("button");
        pick.type = "button";
        pick.className = "btn btn-small";
        pick.textContent = "Andere Frisur wählen";
        pick.addEventListener("click", () => select("frisur"));
        note.append(pick);
        optionsBox.append(note);
      }
    }

    function refresh() {
      optionsValue.textContent = valueOf(current);
      optionsBox.querySelectorAll(".hair-card").forEach((card) => card.setAttribute("aria-pressed", String(card.dataset.value === look().frisur)));
      const locked = current === "haarfarbe" && hairLocked();
      optionsBox.querySelectorAll(".orb").forEach((orb) => orb.setAttribute("aria-pressed", String(!locked && orb.dataset.value === look()[current])));
      refreshTabs();
    }

    // Frisur-Vorschauen werden live aus der Figur gerendert, mit Haar- und Hautfarbe
    const thumbs = {};
    let thumbTimer = 0;
    function scheduleThumbs(delay = 120) {
      clearTimeout(thumbTimer);
      thumbTimer = setTimeout(() => {
        if (!editing || !active || active.id !== state.aktiv) return;
        const urls = renderHairThumbs(active);
        urls.forEach((url, index) => { thumbs[`${active.id}:${index}`] = url; });
        if (current === "frisur") {
          optionsBox.querySelectorAll(".hair-card").forEach((card, index) => {
            const box = card.querySelector(".hair-thumb");
            let img = box.querySelector("img");
            if (!img) { img = document.createElement("img"); img.alt = ""; img.width = 160; img.height = 160; box.append(img); }
            img.src = urls[index];
          });
        }
      }, delay);
    }

    const changed = () => {
      if (active?.id === state.aktiv) applyLook(active);
      refresh();
      if (current !== "frisur") scheduleThumbs(400);
      wake();
    };

    function rebuild() {
      for (const key of Object.keys(thumbs)) if (!key.startsWith(`${state.aktiv}:`)) delete thumbs[key];
      if (modeLabel && editing) modeLabel.textContent = `${CHARACTERS[state.aktiv].name} gestalten`;
      renderOptions();
      refreshTabs();
      if (editing) scheduleThumbs(200);
    }

    const setEditing = (on) => {
      editing = on;
      heroSection?.classList.toggle("is-editing", on);
      tabsPanel.hidden = !on;
      optionsPanel.hidden = !on;
      editorActions.hidden = !on;
      createButton.closest(".hero-actions").hidden = on;
      document.querySelector(".roster")?.toggleAttribute("inert", on);
      if (modeLabel) modeLabel.textContent = on ? `${CHARACTERS[state.aktiv].name} gestalten` : "Charakter wählen";
      if (on) { heroYaw = 0; state.begleiter = true; select("frisur"); scheduleThumbs(250); }
      else setFocus("ganz");
      updateMode();
    };
    createButton.addEventListener("click", () => {
      setEditing(true);
      stage.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    });
    editorActions.querySelector("[data-random]")?.addEventListener("click", () => {
      const pick = (list) => list[Math.floor(Math.random() * list.length)];
      const target = look();
      target.frisur = pick(HAIRSTYLES.slice(1)).name;
      target.haarfarbe = pick(HAIR_COLORS)[0];
      target.haut = Math.random() < 0.85 ? pick(SKIN_COLORS.filter(([name]) => name !== "Blau"))[0] : "Blau";
      for (const part of PARTS) target[part] = pick(CLOTH_COLORS)[0];
      if (!reduceMotion) heroYaw += Math.PI * 2;
      changed();
      scheduleThumbs(300);
    });
    editorActions.querySelector("[data-reset]").addEventListener("click", () => {
      state.figuren[state.aktiv] = { ...LOOK_DEFAULTS };
      changed();
      scheduleThumbs(300);
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
    renderOptions();
    refreshTabs();
    return { rebuild };
  }

  function renderHairThumbs(figure) {
    const size = 160;
    const ratio = renderer.getPixelRatio();
    const px = Math.round(size * ratio);
    const out = document.createElement("canvas");
    out.width = px;
    out.height = px;
    const context = out.getContext("2d");
    const saved = { yaw: pivot.rotation.y, x: pivot.position.x, visible: pivot.visible };
    pivot.rotation.y = 0.5;
    pivot.position.x = 0;
    pivot.visible = true;
    scene.updateMatrixWorld(true);
    const head = figure.model.getObjectByName("Head");
    const top = figure.model.getObjectByName("head_end");
    const a = head.getWorldPosition(new THREE.Vector3());
    const b = top ? top.getWorldPosition(new THREE.Vector3()) : a.clone().add(new THREE.Vector3(0, figure.height * 0.2, 0));
    const center = a.clone().lerp(b, 0.42);
    const radius = a.distanceTo(b) * 0.98;
    thumbCamera.position.set(center.x, center.y + radius * 0.12, center.z + radius / Math.tan(THREE.MathUtils.degToRad(thumbCamera.fov / 2)));
    thumbCamera.lookAt(center);
    thumbCamera.updateProjectionMatrix();
    const id = figure.id;
    const chosen = state.figuren[id].haarfarbe;
    const urls = [];
    renderer.setScissorTest(true);
    HAIRSTYLES.forEach((style) => {
      const meshName = style.key ? `Frisur_${CHARACTERS[id].prefix}_${style.key}` : null;
      for (const [name, mesh] of Object.entries(figure.hairMeshes)) mesh.visible = name === meshName;
      figure.materials.Haar?.color.set(style.locked ? CHARACTERS[id].hair : findColor(hairColors(id), chosen));
      renderer.setViewport(0, 0, size, size);
      renderer.setScissor(0, 0, size, size);
      renderer.clear();
      renderer.render(scene, thumbCamera);
      context.clearRect(0, 0, px, px);
      context.drawImage(renderer.domElement, 0, renderer.domElement.height - px, px, px, 0, 0, px, px);
      urls.push(out.toDataURL("image/png"));
    });
    renderer.setScissorTest(false);
    renderer.clear();
    pivot.rotation.y = saved.yaw;
    pivot.position.x = saved.x;
    pivot.visible = saved.visible;
    applyLook(figure);
    renderView();
    return urls;
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
          diffuseColor.rgb *= sampledDiffuseColor.rgb * mix( vec3( 1.0 ), uTint, smoothstep( 0.04, 0.32, sampledDiffuseColor.a ) );
        #endif`
      )}`;
    };
    material.customProgramCacheKey = () => "jl-tint-2";
    material.needsUpdate = true;
  }
}
