// Juschkin Labs: Kim und Maksim als 3D-Spielfiguren im Lab.
// Das Lab ist ein gerendertes Bild; die Figur steht mit derselben Kamera wie im Blender-Projekt
// auf dem Podest. Darüber liegt die Vordergrundmaske der vorderen Torsäule.
// Nach „Fertig“ läuft die Figur durchs Tor hinaus und begleitet danach beim Scrollen.
// Alle Dateien liegen auf dem eigenen Server; es gibt keine Verbindung zu Dritten.
import * as THREE from "three";
import { GLTFLoader } from "./vendor/three/GLTFLoader.js";
import { MeshoptDecoder } from "./vendor/three/meshopt_decoder.module.js";

const ROOT = new URL("./", import.meta.url).href;
const STORE_KEY = "jl-figuren-v1";
const SOUND_KEY = "jl-ton";
const FIGURE_VERSION = "20261112-3";
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

// Lab: Kamera und Wege aus dem Blender-Projekt (umgerechnet auf Y nach oben)
const LAB = {
  width: 3840,
  height: 1600,
  aspect: 2.4,
  vfov: THREE.MathUtils.radToDeg(2 * Math.atan(18 / 29 / 2.4)),
  camera: [0.7, 7.4, 16.5],
  pitch: -(90 - 73.465),
  feet: [-2.05, 0.195, 0.48],
  // Vom Podest herunter, in die Gasse zwischen den Lichtleisten, mittig durchs Tor hinaus
  exit: [[-2.05, 0.195, 0.48], [-0.6, 0.195, 0.48], [0.05, 0.03, 0.44], [1.4, 0.03, 0.15], [2.8, 0.03, -0.24], [4.6, 0.03, -0.3], [8.3, 0.03, -0.3], [12.5, 0.03, -0.3], [16.5, 0.03, -0.3]],
  // Vordergrundmaske (Torbogen und vordere Säule) als Ausschnitt des 3840er-Bilds
  front: [2976, 300, 3624, 1316],
  // Figuren sind im Lab größer als im Begleiter: rund 3,2 m, der goldene Rahmen im Tor liegt bei 4,0 bis 4,7 m
  scale: 1.75
};

// Stimmen: Dateinamen in assets/stimmen
const LINES = {
  kim: { leistungen: "leistungen", "web-apps": "webapps", agenturen: "agenturen", welten: "projekte", roadlands: "roadlands", team: "team", kontakt: "kontakt" },
  maksim: { leistungen: "vision", "web-apps": "anwendungen", einblick: "workshops", ablauf: "ablauf", team: "arbeitsprobe", kontakt: "kontakt", aufgaben: "daten", zusammenarbeit: "ablauf", arbeitsprobe: "arbeitsprobe" }
};

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
const lab = document.querySelector(".lab");
const labImage = lab?.querySelector(".lab-bg");
let state = readState();
if (!CHARACTERS[state.aktiv]) state.aktiv = "kim";

// Die Charakterleiste (portfolio.js) soll die zuletzt gewählte Figur zeigen, auch ohne WebGL.
document.dispatchEvent(new CustomEvent("figur:bereit", { detail: state.aktiv }));

if (webglAvailable() && (stage || (state.fertig && state.begleiter))) {
  start().catch((error) => {
    console.warn("3D-Figur konnte nicht geladen werden:", error);
    stage?.classList.remove("is-loading", "is-loading-figure", "is-3d");
    lab?.classList.remove("is-live");
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
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(22, 1, 0.05, 60);
  scene.add(new THREE.HemisphereLight(0xe8eef5, 0x1c1f24, 1.45));
  const keyLight = new THREE.DirectionalLight(0xffe7cc, 2.2);
  keyLight.position.set(-1.8, 3.2, 3.4);
  const fillLight = new THREE.DirectionalLight(0xbfd6ff, 0.85);
  fillLight.position.set(2.6, 1.6, 2.4);
  const rimGold = new THREE.DirectionalLight(0xe6d39a, 2.2);
  rimGold.position.set(-2.6, 1.8, -2.2);
  const rimBlue = new THREE.DirectionalLight(0x8ebdff, 1.9);
  rimBlue.position.set(2.6, 2, -2.2);
  scene.add(keyLight, fillLight, rimGold, rimBlue);

  const pivot = new THREE.Group();
  scene.add(pivot);

  // Weicher Schatten unter den Füßen (nur im Lab)
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = shadowCanvas.height = 128;
  const shadowContext = shadowCanvas.getContext("2d");
  const gradient = shadowContext.createRadialGradient(64, 64, 4, 64, 64, 62);
  gradient.addColorStop(0, "rgba(0,0,0,0.55)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  shadowContext.fillStyle = gradient;
  shadowContext.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.8), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false, toneMapped: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.006;
  shadow.renderOrder = -1;
  pivot.add(shadow);

  // Lab-Kamera wie in Blender, und eine Referenzkamera für Bildkoordinaten
  const labCamera = new THREE.PerspectiveCamera(LAB.vfov, LAB.aspect, 0.1, 200);
  labCamera.position.fromArray(LAB.camera);
  labCamera.rotation.set(THREE.MathUtils.degToRad(LAB.pitch), 0, 0);
  const labReference = labCamera.clone();
  labReference.updateMatrixWorld(true);
  labReference.updateProjectionMatrix();
  const feetHome = new THREE.Vector3().fromArray(LAB.feet);
  const faceCamera = Math.atan2(LAB.camera[0] - LAB.feet[0], LAB.camera[2] - LAB.feet[2]);
  const exitCurve = new THREE.CatmullRomCurve3(LAB.exit.map((point) => new THREE.Vector3().fromArray(point)), false, "centripetal");
  const exitLength = exitCurve.getLength();
  const labPos = feetHome.clone();
  let labYaw = faceCamera;
  const projected = new THREE.Vector3();
  const toImage = (point) => {
    projected.copy(point).project(labReference);
    return { x: (projected.x + 1) / 2, y: (1 - projected.y) / 2 };
  };

  // Vordergrund: vordere Torsäule, deckungsgleich mit dem Lab-Bild
  const frontScene = new THREE.Scene();
  const frontCamera = new THREE.OrthographicCamera(0, 1, 0, -1, -1, 1);
  const frontTexture = new THREE.TextureLoader().load(`${ROOT}assets/lab/labor-vorne.webp?v=2`);
  frontTexture.colorSpace = THREE.SRGBColorSpace;
  const front = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: frontTexture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  frontScene.add(front);

  // Figuren werden erst geladen, wenn sie gebraucht werden
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const loading = {};
  let active = null;
  let wanted = state.aktiv;
  let gesture = null;

  function loadFigure(id) {
    if (loading[id]) return loading[id];
    loading[id] = loader.loadAsync(`${ROOT}assets/figuren/${CHARACTERS[id].file}?v=${FIGURE_VERSION}`, (event) => {
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
    if (!active?.actions[name] || leave) return;
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
    pivot.visible = !leaveHidden;
    stage?.classList.remove("is-loading", "is-loading-figure");
    if (lab && !lab.classList.contains("is-live")) {
      initView(lab.getBoundingClientRect());
      lab.classList.add("is-live");
    }
    if (active === figure) editor?.rebuild();
    stage?.classList.add("is-3d");
    if (status) status.textContent = "";
    if (greet) {
      if (sound.on) sound.say("hallo", { force: true });
      else if (!reduceMotion) doGesture("Wave");
    }
    wake();
  }

  // Stimmen (standardmäßig aus, Schalter in der Kopfzeile)
  const sound = (() => {
    const toggle = document.querySelector(".sound-toggle");
    let on = false;
    try { on = window.localStorage.getItem(SOUND_KEY) === "an"; } catch { /* Standard: aus */ }
    let audio = null;
    let speaking = false;
    const said = new Set();
    const label = () => {
      if (!toggle) return;
      toggle.setAttribute("aria-pressed", String(on));
      toggle.setAttribute("aria-label", "Stimmen der Figuren");
      toggle.querySelector("span").textContent = on ? "Ton aus" : "Ton an";
      toggle.classList.toggle("is-on", on);
    };
    const api = {
      get on() { return on; },
      say(line, { force = false, once = false } = {}) {
        if (!on || !line) return false;
        const who = active?.id || state.aktiv;
        const file = line.startsWith("kim_") || line.startsWith("maksim_") ? line : `${who}_${line}`;
        if (once && said.has(file)) return false;
        if (speaking && !force) return false;
        audio?.pause();
        audio = new Audio(`${ROOT}assets/stimmen/${file}.mp3`);
        speaking = true;
        said.add(file);
        audio.addEventListener("ended", () => { speaking = false; });
        audio.addEventListener("error", () => { speaking = false; });
        audio.play().then(() => { if (!gesture && active?.actions.Talk && !leave) doGesture("Talk"); }).catch(() => { speaking = false; });
        return true;
      },
      stop() { audio?.pause(); speaking = false; }
    };
    if (toggle) {
      toggle.hidden = false;
      label();
      toggle.addEventListener("click", () => {
        on = !on;
        try { window.localStorage.setItem(SOUND_KEY, on ? "an" : "aus"); } catch { /* nur Bequemlichkeit */ }
        label();
        if (on) api.say("hallo", { force: true });
        else api.stop();
      });
    }
    return api;
  })();

  // Begleiter-Rahmen unten links
  const companion = document.createElement("div");
  companion.className = "companion";
  companion.hidden = true;
  companion.innerHTML = '<button class="companion-figure" type="button" aria-label="Die Figur winkt dir zu"></button><button class="companion-close" type="button" aria-label="Begleiter ausblenden"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
  document.body.append(companion);
  const gestures = ["Wave", "Talk", "Jump"];
  let gestureIndex = 0;
  companion.querySelector(".companion-figure").addEventListener("click", () => {
    if (sound.on && sound.say(`klick_${(gestureIndex % 3) + 1}`, { force: true })) { gestureIndex += 1; return; }
    doGesture(gestures[gestureIndex % gestures.length]);
    gestureIndex += 1;
  });
  companion.querySelector(".companion-close").addEventListener("click", () => {
    state.begleiter = false;
    writeState();
    updateMode();
  });

  // Ansichten: Lab (Startseite) oder Begleiter
  let heroVisible = false;
  let mode = null;
  let editing = false;
  let heroYaw = 0;
  let walkIn = null;
  let leave = null;
  let leaveHidden = false;
  const clock = new THREE.Clock();
  let frameRequest = 0;
  const companionFrame = { feet: -0.9, head: 0.84 };

  // Ausschnitte im Lab: k = Figurhöhe im Verhältnis zur Bühnenhöhe, a = Ankerpunkt an der Figur (0 Füße, 1 Kopf), ay = Höhe des Ankers auf der Bühne
  const FOCUS_WIDE = {
    ganz: { k: 0.44, a: 0, ay: 0.76 },
    kopf: { k: 1.2, a: 0.86, ay: 0.44 },
    oberkoerper: { k: 0.72, a: 0.6, ay: 0.48 },
    beine: { k: 0.64, a: 0.26, ay: 0.56 },
    schuhe: { k: 0.98, a: 0.03, ay: 0.66 },
    raus: { k: 0.36, a: 0, ay: 0.78 }
  };
  const FOCUS_NARROW = {
    ganz: { k: 0.5, a: 0, ay: 0.9 },
    kopf: { k: 1.3, a: 0.86, ay: 0.5 },
    oberkoerper: { k: 0.85, a: 0.6, ay: 0.52 },
    beine: { k: 0.75, a: 0.26, ay: 0.6 },
    schuhe: { k: 1.1, a: 0.03, ay: 0.7 },
    raus: { k: 0.34, a: 0, ay: 0.88 }
  };
  let focusName = "ganz";
  const view = { k: FOCUS_WIDE.ganz.k, a: 0, ay: FOCUS_WIDE.ganz.ay, x: null };
  const focusTable = (rect) => rect.width / rect.height < 1.1 ? FOCUS_NARROW : FOCUS_WIDE;
  function setFocus(name) {
    focusName = FOCUS_WIDE[name] ? name : "ganz";
    stage?.classList.toggle("is-zoomed", focusName !== "ganz");
    if (reduceMotion && lab) Object.assign(view, focusTable(lab.getBoundingClientRect())[focusName]);
    wake();
  }
  const thumbCamera = new THREE.PerspectiveCamera(22, 1, 0.01, 50);

  const rectOf = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right };
  };
  const visibleRect = (rect) => !(rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth || rect.width < 2 || rect.height < 2);
  function setViewport(rect) {
    const y = window.innerHeight - rect.bottom;
    renderer.setViewport(rect.left, y, rect.width, rect.height);
    renderer.setScissor(rect.left, y, rect.width, rect.height);
    renderer.setScissorTest(true);
  }

  // Begleiter: Kamera auf die Figur gerichtet
  function drawCompanion(rect) {
    if (!active || !pivot.visible || !visibleRect(rect)) return;
    const scale = active.height / (companionFrame.head - companionFrame.feet);
    const target = -companionFrame.feet * scale;
    const distance = scale / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.aspect = rect.width / rect.height;
    camera.position.set(0, target, distance);
    camera.lookAt(0, target, 0);
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    setViewport(rect);
    renderer.render(scene, camera);
  }

  // Lab: Bildausschnitt berechnen, Hintergrund verschieben, Figur und Torsäule zeichnen
  let lastTransform = "";
  let lastBlur = -1;
  function labLayout(rect) {
    const feet = toImage(labPos);
    const head = toImage(projected.set(labPos.x, labPos.y + (active?.height || 1.8) * LAB.scale, labPos.z));
    const charHeight = Math.max(0.02, feet.y - head.y);
    // Nie kleiner als bildschirmfüllend, damit auch sehr breite Fenster keinen Rand zeigen
    const dispH = Math.max((view.k * rect.height) / charHeight, rect.height, rect.width / LAB.aspect);
    const dispW = dispH * LAB.aspect;
    const anchorX = view.x ?? feet.x;
    const anchorY = feet.y - view.a * charHeight;
    let left = rect.width / 2 - anchorX * dispW;
    let top = view.ay * rect.height - anchorY * dispH;
    left = Math.min(0, Math.max(rect.width - dispW, left));
    top = Math.min(0, Math.max(rect.height - dispH, top));
    return { left, top, dispW, dispH, feet };
  }
  // Start genau dort, wo das Bild ohne 3D steht (object-fit: cover, 37 % 76 %), dann sanft heranfahren
  function initView(rect) {
    const feet = toImage(feetHome);
    const head = toImage(projected.set(feetHome.x, feetHome.y + (active?.height || 1.8) * LAB.scale, feetHome.z));
    const charHeight = feet.y - head.y;
    const scale = Math.max(rect.width / LAB.width, rect.height / LAB.height);
    const dispW = LAB.width * scale;
    const dispH = LAB.height * scale;
    const left = (rect.width - dispW) * 0.37;
    const top = (rect.height - dispH) * 0.76;
    view.k = (charHeight * dispH) / rect.height;
    view.a = 0;
    view.ay = (top + feet.y * dispH) / rect.height;
    view.x = reduceMotion ? null : (rect.width / 2 - left) / dispW;
    if (reduceMotion) Object.assign(view, focusTable(rect).ganz, { x: null });
  }
  function drawLab(rect) {
    const layout = labLayout(rect);
    if (labImage) {
      const transform = `translate3d(${layout.left.toFixed(1)}px, ${layout.top.toFixed(1)}px, 0) scale(${(layout.dispW / LAB.width).toFixed(5)})`;
      if (transform !== lastTransform) { labImage.style.transform = transform; lastTransform = transform; }
      const base = focusTable(rect).ganz.k;
      const blur = Math.round(Math.max(0, Math.min(3, (view.k / base - 1.8) * 1.6)) * 4) / 4;
      if (blur !== lastBlur) { labImage.style.filter = blur ? `blur(${blur}px)` : ""; lastBlur = blur; }
    }
    if (!visibleRect(rect)) return;
    setViewport(rect);
    if (active && pivot.visible) {
      labCamera.aspect = LAB.aspect;
      labCamera.setViewOffset(layout.dispW, layout.dispH, -layout.left, -layout.top, rect.width, rect.height);
      labCamera.updateProjectionMatrix();
      renderer.render(scene, labCamera);
    }
    const s = layout.dispW / LAB.width;
    const [x0, y0, x1, y1] = LAB.front;
    front.scale.set((x1 - x0) * s, (y1 - y0) * s, 1);
    front.position.set(layout.left + ((x0 + x1) / 2) * s, -(layout.top + ((y0 + y1) / 2) * s), 0);
    frontCamera.left = 0;
    frontCamera.right = rect.width;
    frontCamera.top = 0;
    frontCamera.bottom = -rect.height;
    frontCamera.updateProjectionMatrix();
    renderer.render(frontScene, frontCamera);
  }

  let lastScroll = window.scrollY;
  let scrollSpeed = 0;
  let scrollDir = 1;
  let calmFor = 0;
  let idleFor = 0;
  const greetQueue = [];
  const damp = (value, targetValue, lambda, dt) => THREE.MathUtils.lerp(value, targetValue, 1 - Math.exp(-lambda * dt));
  const tangent = new THREE.Vector3();

  function tick() {
    frameRequest = 0;
    const dt = Math.min(clock.getDelta(), 0.05);
    const dy = window.scrollY - lastScroll;
    lastScroll = window.scrollY;
    scrollSpeed = damp(scrollSpeed, dt > 0 ? Math.abs(dy) / dt : 0, 10, dt);
    if (dy !== 0) scrollDir = Math.sign(dy);

    if (mode === "hero") {
      const rect = lab ? lab.getBoundingClientRect() : null;
      const table = rect ? focusTable(rect) : FOCUS_WIDE;
      if (leave) {
        // Abgang: vom Podest, durch die Gasse, mittig durchs Tor
        // Tempo mit der Figurgröße skaliert, damit die Schritte nicht rutschen
        const walking = leave.s < 2.2 * LAB.scale;
        const target = (walking ? 1.4 : 4.2) * LAB.scale;
        leave.speed = damp(leave.speed, target, 2.6, dt);
        leave.s += leave.speed * dt;
        if (!walking && active?.currentName !== "Run") play("Run", { fade: 0.35, timeScale: 1.05 });
        const u = Math.min(1, leave.s / exitLength);
        labPos.copy(exitCurve.getPointAt(u));
        exitCurve.getTangentAt(u, tangent);
        labYaw = damp(labYaw, Math.atan2(tangent.x, tangent.z), 8, dt);
        const focus = table.raus;
        view.k = damp(view.k, focus.k, 1.6, dt);
        view.a = damp(view.a, focus.a, 1.6, dt);
        view.ay = damp(view.ay, focus.ay, 1.6, dt);
        const feetX = toImage(labPos).x;
        view.x = damp(view.x ?? feetX, feetX, 2.2, dt);
        if (u >= 1) finishLeave();
      } else {
        const focus = table[editing ? focusName : "ganz"];
        view.k = damp(view.k, focus.k, 5, dt);
        view.a = damp(view.a, focus.a, 5, dt);
        view.ay = damp(view.ay, focus.ay, 5, dt);
        if (view.x !== null) { view.x = damp(view.x, toImage(labPos).x, 4, dt); if (Math.abs(view.x - toImage(labPos).x) < 0.0005) view.x = null; }
        labYaw = damp(labYaw, faceCamera + heroYaw, 9, dt);
      }
      pivot.position.copy(labPos);
      pivot.rotation.y = labYaw;
    } else if (walkIn) {
      walkIn.elapsed += dt;
      const progress = Math.min(1, walkIn.elapsed / walkIn.duration);
      pivot.position.set(THREE.MathUtils.lerp(walkIn.from, walkIn.to, progress), 0, 0);
      pivot.rotation.y = damp(pivot.rotation.y, walkIn.yaw, 10, dt);
      if (progress >= 1) {
        const done = walkIn.done;
        walkIn = null;
        done?.();
      }
    } else if (mode === "companion") {
      if (scrollSpeed > 60 && !reduceMotion) {
        calmFor = 0;
        idleFor = 0;
        if (gesture) gesture = null;
        play(scrollSpeed > 1900 ? "Run" : "Walk", { timeScale: THREE.MathUtils.clamp(scrollSpeed / 750, 0.75, 1.5), fade: 0.25 });
        pivot.rotation.y = damp(pivot.rotation.y, scrollDir > 0 ? 1.15 : -1.15, 8, dt);
      } else {
        calmFor += dt;
        idleFor += dt;
        if (!gesture && active?.currentName !== "Idle") play("Idle", { fade: 0.45 });
        pivot.rotation.y = damp(pivot.rotation.y, 0.38, 5, dt);
        if (calmFor > 0.45 && greetQueue.length && !gesture) {
          const section = greetQueue.pop();
          greetQueue.length = 0;
          const line = LINES[active?.id]?.[section];
          if (!(line && sound.say(line, { once: true }))) doGesture("Wave");
        }
        if (idleFor > 40) { idleFor = -1e9; sound.say("warten", { once: true }); }
      }
    }

    shadow.visible = mode === "hero";
    active?.mixer.update(dt);
    renderView();
    if (mode) frameRequest = requestAnimationFrame(tick);
  }
  function renderView() {
    pivot.scale.setScalar(mode === "hero" ? LAB.scale : 1);
    renderer.setScissorTest(false);
    renderer.clear();
    if (mode === "hero" && lab) drawLab(rectOf(lab));
    else if (mode === "companion") drawCompanion(rectOf(companion));
  }
  function wake() {
    if (!frameRequest && mode && !document.hidden) {
      clock.getDelta();
      frameRequest = requestAnimationFrame(tick);
    }
  }

  function updateMode() {
    const wantCompanion = !editing && !leave && state.fertig && state.begleiter && !heroVisible;
    const next = lab && (heroVisible || editing || leave) ? "hero" : wantCompanion ? "companion" : null;
    if (next === mode) { wake(); return; }
    const previous = mode;
    mode = next;
    companion.hidden = mode !== "companion";
    if (mode === "companion") {
      if (active?.id !== state.aktiv) show(state.aktiv);
      gesture = null;
      pivot.visible = true;
      idleFor = 0;
      if (!reduceMotion && previous !== "companion") {
        pivot.position.set(-1.4, 0, 0);
        pivot.rotation.y = 1.3;
        play("Walk", { fade: 0.2 });
        walkIn = { from: -1.4, to: 0, elapsed: 0, duration: 1.5, yaw: 1.3, done: () => play("Idle", { fade: 0.5 }) };
      } else {
        pivot.position.set(0, 0, 0);
        pivot.rotation.y = 0.38;
        play("Idle", { fade: 0.2 });
      }
    } else if (mode === "hero" && !leave) {
      walkIn = null;
      labPos.copy(feetHome);
      pivot.position.copy(labPos);
      pivot.visible = !leaveHidden && Boolean(active);
      play("Idle", { fade: 0.2 });
    }
    if (!mode) {
      renderer.setScissorTest(false);
      renderer.clear();
    }
    wake();
  }

  // Abgang nach „Fertig“
  function startLeave() {
    const target = document.querySelector("#leistungen");
    const goOn = () => target?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    if (reduceMotion || !lab) { goOn(); return; }
    heroSection?.classList.add("is-leaving");
    gesture = null;
    heroYaw = 0;
    play("Walk", { fade: 0.3 });
    leave = { s: 0, speed: 0.6 };
    view.x = toImage(labPos).x;
    updateMode();
  }
  function finishLeave() {
    leave = null;
    leaveHidden = true;
    pivot.visible = false;
    const target = document.querySelector("#leistungen");
    target?.scrollIntoView({ behavior: "smooth" });
    setTimeout(() => {
      // Zurück auf das Podest, für den Fall, dass man wieder nach oben scrollt
      leaveHidden = false;
      labPos.copy(feetHome);
      labYaw = faceCamera;
      view.x = null;
      heroSection?.classList.remove("is-leaving");
      if (mode === "hero") { pivot.visible = true; play("Idle", { fade: 0 }); }
      updateMode();
    }, 1400);
    updateMode();
  }

  window.addEventListener("resize", () => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    wake();
  });
  window.addEventListener("scroll", wake, { passive: true });
  for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, () => { idleFor = 0; }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });

  const watch = lab || stage;
  if (watch) {
    new IntersectionObserver(([entry]) => {
      heroVisible = entry.isIntersecting;
      updateMode();
    }, { threshold: 0.12 }).observe(watch);
  }
  const greetSeen = new Set();
  const sections = document.querySelectorAll("main > section[id], #agenturen, main.legal");
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
  document.addEventListener("welt:aktiv", (event) => {
    if (event.detail === "roadlands" && mode === "companion" && active?.id === "kim") sound.say("roadlands", { once: true });
  });

  // Bühne: drehen mit Ziehen oder Pfeiltasten
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
    const defaultLabel = modeLabel?.textContent || "";
    createButton.hidden = false;
    if (state.fertig) createButton.textContent = "Charakter anpassen";
    worldsButton?.classList.remove("btn-primary");

    // Icons aus der Asset-Lieferung (32 × 32, currentColor)
    const ICONS = {
      frisur: '<path d="M7 28v-7a9.5 9.5 0 0 1-3-7c0-5.5 4.7-9 9.5-9 2.2 0 4.8-.8 6.5-2 .7 4.6-.8 7.8-3.7 9.7l2.2 4.3-3 1v4.5H12V28"/><path d="M4.5 12c3.8 1.2 7.2-.6 9.1-3.6"/><rect x="24" y="16" width="4" height="13" rx="1.4"/><path d="M21 18h3m-3 3h3m-3 3h3m-3 3h3"/>',
      haarfarbe: '<path d="M11 4C4 10 4 13.5 9 18c3.8 3.5 3.5 6.7-.5 10M17 4c-5.3 5.3-5.4 8.1-2.5 11.5"/><path d="M23 13c-1.8 3.2-5.5 6.6-5.5 10a5.5 5.5 0 0 0 11 0c0-3.4-3.7-6.8-5.5-10Z"/><path d="M21 22c-.7 1.5-.2 2.4.8 2.8"/>',
      haut: '<path d="M9 19V10a2 2 0 0 1 4 0V6a2 2 0 0 1 4 0v2a2 2 0 0 1 4 0v3a2 2 0 0 1 4 0v10a7 7 0 0 1-7 7h-3.3a7 7 0 0 1-5.5-2.7l-5-6.4a2.1 2.1 0 0 1 3.1-2.8Z"/><path d="M13 11v5m4-7v7m4-4v5"/><circle cx="27" cy="5" r="1.5"/>',
      Oberteil: '<path d="m12 5-5 3-4 10 5 2 2-5v13h12V15l2 5 5-2-4-10-5-3"/><path d="M12 5a4 4 0 0 0 8 0M10 24.5h12M4 15.5l5 2m14 0 5-2"/>',
      Hose: '<path d="M9 4h14l1.5 24h-7L16 14l-1.5 14h-7Z"/><path d="M9 8h14M16 8v6m-4-5-1.5 5m9-5 1 5M8 24h6.5m3 0H24"/>',
      Schuhe: '<path d="M5 12c2 2 3.5 3 7 3l4-5 5 7 5.6 2.8A4.3 4.3 0 0 1 29 24v2H4v-8.6c0-2.5.2-3.9 1-5.4Z"/><path d="M4 23h25M4 18h4l2 3m4-6 3 1m-.5-2.5 3 1M23 19l-1 3"/>'
    };
    const CATEGORIES = [
      { key: "frisur", label: "Frisur", focus: "kopf" },
      { key: "haarfarbe", label: "Haare", title: "Haarfarbe", focus: "kopf", texture: "haar" },
      { key: "haut", label: "Haut", title: "Hautfarbe", focus: "oberkoerper" },
      { key: "Oberteil", label: "Oberteil", focus: "oberkoerper", texture: "strick" },
      { key: "Hose", label: "Hose", focus: "beine", texture: "jeans" },
      { key: "Schuhe", label: "Schuhe", focus: "schuhe", texture: "leder" }
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
      if (key === "haarfarbe" && hairLocked() && state.aktiv === "kim") sound.say("gesperrt", { force: true });
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
        if (category.texture) orb.dataset.texture = category.texture;
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
      if (modeLabel) modeLabel.textContent = on ? `${CHARACTERS[state.aktiv].name} gestalten` : defaultLabel;
      if (on) {
        heroYaw = 0;
        state.begleiter = true;
        select("frisur");
        scheduleThumbs(250);
        if (state.aktiv === "kim") sound.say("editor", { force: true });
      } else setFocus("ganz");
      updateMode();
    };
    createButton.addEventListener("click", () => {
      setEditing(true);
      heroSection?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
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
      startLeave();
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
    const saved = { yaw: pivot.rotation.y, visible: pivot.visible, shadow: shadow.visible };
    pivot.rotation.y = 0.5;
    pivot.visible = true;
    shadow.visible = false;
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
    pivot.visible = saved.visible;
    shadow.visible = saved.shadow;
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
          diffuseColor.rgb *= sampledDiffuseColor.rgb * mix( vec3( 1.0 ), uTint, sampledDiffuseColor.a );
        #endif`
      )}`;
    };
    material.customProgramCacheKey = () => "jl-tint-3";
    material.needsUpdate = true;
  }
}
