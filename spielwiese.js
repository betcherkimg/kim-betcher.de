// Spielwiese: kleine 3D-Wiese. Kim laufen lassen, Dinge aus der Leiste auf die Wiese ziehen, einsteigen und losfahren.
// Die Map wird nur im Browser gemerkt (localStorage "kb-spielwiese-v1"), Kims Aussehen kommt aus dem Charakter-Editor.
import * as THREE from "three";
import { GLTFLoader } from "./vendor/three/GLTFLoader.js";
import { MeshoptDecoder } from "./vendor/three/meshopt_decoder.module.js";

const ASSET_VERSION = "3";
const MAP_KEY = "kb-spielwiese-v1";
const LOOK_KEY = "kb-figur-v1";
const SIZE = 110; // Kantenlänge der Wiese in Metern
const EDGE = SIZE / 2 - 4;
const KIM_SCALE = 1.22;
const FLIGHT = 9; // Reiseflughöhe des E-Quester Flight; auf dieser Höhe fliegt auch die Drohne

// Dinge für die Leiste. h: Zielhöhe in Metern, yaw: Drehung, damit "vorn" nach +Z zeigt,
// drive: fahrbar, fly: hebt mit der Leertaste auf Reiseflughöhe ab und landet beim nächsten Druck, hover: schwebt so hoch,
// wander: läuft von selbst herum, ride: reitbar, patrol: Streifenwagen (fährt von selbst, verfolgt Kim),
// follow: fliegt Kim von selbst hinterher, npc: Mensch mit Bewegungen (chase: verfolgt Kim), radio: hat ein Autoradio
const CATALOG = [
  { id: "streife", name: "Polizeiauto", group: "Polizei", h: 1.26, hull: true, flip: true, patrol: { speed: 5, chase: 14, turn: 1.9 } },
  { id: "polizist", name: "Polizist", group: "Polizei", h: 2.08, armsDown: 72, npc: { chase: true } },
  { id: "hubschrauber", name: "Polizei-Hubschrauber", group: "Polizei", h: 2.9, drive: { speed: 17, turn: 1.7 }, fly: { cruise: 16 }, follow: true, engine: "rotor" },
  { id: "arian", name: "Arians Auto", group: "Fahrzeuge", h: 1.02, drive: { speed: 16, turn: 2.3 }, radio: true, engine: "boxer" },
  { id: "schweber", name: "E-Quester Flight", group: "Fahrzeuge", h: 0.85, hover: 0.45, drive: { speed: 19, turn: 2.4 }, fly: { cruise: FLIGHT }, radio: true, engine: "summen" },
  { id: "monstertruck", name: "Monstertruck", group: "Fahrzeuge", h: 1.8, drive: { speed: 13, turn: 1.8 }, radio: true, engine: "v8" },
  { id: "gokart", name: "Gokart", group: "Fahrzeuge", h: 0.68, drive: { speed: 17, turn: 2.8 }, radio: true, engine: "boxer" },
  { id: "pferd", name: "Pferd", group: "Tiere", h: 1.95, wander: { walk: "Schritt", speed: 1.3 }, ride: { seat: [0, 0.69, -0.08], turn: 2.1 } },
  { id: "fuchs", name: "Fuchs", group: "Tiere", h: 0.62, wander: { walk: "Walk", idle: "Idle", speed: 1.1 } },
  { id: "kind", name: "Kind mit Fernsteuerung", group: "Leute", h: 1.5, armsDown: 58, npc: { keepArms: true } },
  { id: "drohne", name: "Drohne", group: "Leute", h: 0.3, hover: FLIGHT + 0.5, orbit: true, hull: true },
  { id: "eiche", name: "Eiche", group: "Grün", h: 7.2, hull: true },
  { id: "birke", name: "Birke", group: "Grün", h: 6.3, hull: true },
  { id: "fichte", name: "Fichte", group: "Grün", h: 8, hull: true },
  { id: "busch", name: "Busch", group: "Grün", h: 0.9, hull: true },
  { id: "sonnenblume", name: "Sonnenblume", group: "Grün", h: 1.5, hull: true },
  { id: "mohn", name: "Klatschmohn", group: "Grün", h: 0.7, hull: true }
];
const byId = Object.fromEntries(CATALOG.map((item) => [item.id, item]));
// Trennstellen für die schmale Leiste
const SOFT = { "Polizei-Hubschrauber": "Polizei-Hub\u00adschrauber", Monstertruck: "Monster\u00adtruck", Sonnenblume: "Sonnen\u00adblume", Klatschmohn: "Klatsch\u00admohn", "Kind mit Fernsteuerung": "Kind mit Fern\u00adsteuerung" };

const stageEl = document.querySelector("[data-play]");
const canvas = stageEl?.querySelector("canvas");
const palette = document.querySelector("[data-palette]");
const hint = document.querySelector("[data-play-hint]");
const tools = document.querySelector("[data-play-tools]");
const statusEl = document.querySelector("[data-play-status]");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function webgl() {
  try { const c = document.createElement("canvas"); return Boolean(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
}

if (stageEl && canvas && webgl()) start(); else stageEl?.classList.add("is-unsupported");

function start() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Filmische Farbwiedergabe: kräftige Farben ohne ausgefressene Lichter
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const HORIZON = new THREE.Color("#e6e6dc");
  scene.background = HORIZON;
  scene.fog = new THREE.Fog(HORIZON, 55, 150);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 600);
  // Licht: frühe Abendsonne, etwas tiefer und wärmer, kühles Himmelslicht in den Schatten
  scene.add(new THREE.HemisphereLight("#d6e4f5", "#8aa055", 1.5));
  const sun = new THREE.DirectionalLight("#ffd39a", 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -30;
  sun.shadow.camera.right = sun.shadow.camera.top = 30;
  sun.shadow.camera.far = 140;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  sun.shadow.radius = 5;
  scene.add(sun, sun.target);
  // Himmel: Verlauf vom hellen Horizont ins Blau, mit einem warmen Schein um die Sonne
  const SUN_DIR = new THREE.Vector3(0.56, 0.44, 0.46).normalize();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(420, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: new THREE.Color("#3f88d2") }, mid: { value: new THREE.Color("#93c3e8") }, low: { value: HORIZON }, sunDir: { value: SUN_DIR }, glow: { value: new THREE.Color("#ffd9a0") } },
    vertexShader: "varying vec3 dir; void main() { dir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 low; uniform vec3 sunDir; uniform vec3 glow; varying vec3 dir;
      void main() {
        float h = clamp(dir.y, 0.0, 1.0);
        vec3 color = mix(low, mid, smoothstep(0.0, 0.22, h));
        color = mix(color, top, smoothstep(0.18, 0.85, h));
        float s = max(dot(normalize(dir), sunDir), 0.0);
        // Sonnenscheibe, weicher Schein und ein Hauch von Strahlen
        vec3 side = normalize(cross(sunDir, vec3(0.0, 1.0, 0.0)));
        vec3 upv = cross(side, sunDir);
        float around = atan(dot(dir, upv), dot(dir, side));
        float rays = (0.5 + 0.5 * sin(around * 14.0)) * (0.5 + 0.5 * sin(around * 9.0 + 1.7));
        color += glow * (pow(s, 260.0) * 1.5 + pow(s, 7.0) * 0.3 + pow(s, 26.0) * rays * 0.22);
        // Warmer Saum am Horizont zur Sonne hin
        color += vec3(0.16, 0.07, 0.0) * pow(s, 3.0) * (1.0 - smoothstep(0.0, 0.3, h));
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  }));
  dome.renderOrder = -10;
  scene.add(dome);
  // Wolken: ein paar flache, helle Haufen, die langsam ziehen
  const clouds = new THREE.Group();
  const cloudMaterial = new THREE.MeshLambertMaterial({ color: "#ffffff", emissive: "#aebfd0", emissiveIntensity: 0.35, fog: false });
  const puff = new THREE.SphereGeometry(1, 10, 8);
  for (let i = 0; i < 9; i += 1) {
    const cloud = new THREE.Group();
    for (let j = 0; j < 5; j += 1) {
      const part = new THREE.Mesh(puff, cloudMaterial);
      part.position.set((j - 2) * 5.5 + Math.sin(i * 7 + j) * 2, Math.sin(j * 2.1 + i) * 1.2, Math.cos(i * 3 + j * 1.7) * 3);
      part.scale.set(6 + Math.sin(i + j) * 2, 2.6 + Math.cos(j + i * 2) * 0.7, 4.5);
      cloud.add(part);
    }
    const angle = (i / 9) * Math.PI * 2 + Math.sin(i * 5) * 0.4;
    cloud.position.set(Math.cos(angle) * (110 + (i % 3) * 45), 62 + (i % 4) * 9, Math.sin(angle) * (110 + (i % 3) * 45));
    clouds.add(cloud);
  }
  scene.add(clouds);

  // Wiese: leicht wellig, an den Rändern etwas höher
  function height(x, z) {
    const waves = Math.sin(x * 0.085) * Math.cos(z * 0.07) * 1.1 + Math.sin(x * 0.19 + 1.7) * Math.sin(z * 0.16 + 0.6) * 0.5 + Math.sin((x + z) * 0.045 + 2.1) * 0.8;
    const rim = Math.max(0, Math.max(Math.abs(x), Math.abs(z)) - (SIZE / 2 - 9));
    // Um den Start herum eben, damit Kim nicht schief ankommt
    const flat = THREE.MathUtils.smoothstep(Math.hypot(x, z), 2, 9);
    return waves * flat + rim * rim * 0.09;
  }
  const normalAt = (x, z, target) => target.set(height(x - 0.4, z) - height(x + 0.4, z), 0.8, height(x, z - 0.4) - height(x, z + 0.4)).normalize();
  const groundGeometry = new THREE.PlaneGeometry(SIZE + 60, SIZE + 60, 150, 150);
  groundGeometry.rotateX(-Math.PI / 2);
  const groundPos = groundGeometry.attributes.position;
  const colors = new Float32Array(groundPos.count * 3);
  const low = new THREE.Color("#5fa544");
  const high = new THREE.Color("#8cc75a");
  const shade = new THREE.Color();
  for (let i = 0; i < groundPos.count; i += 1) {
    const x = groundPos.getX(i);
    const z = groundPos.getZ(i);
    const y = height(x, z);
    groundPos.setY(i, y);
    const patch = 0.5 + 0.5 * Math.sin(x * 0.6 + Math.sin(z * 0.45) * 2) * Math.sin(z * 0.52);
    shade.copy(low).lerp(high, THREE.MathUtils.clamp(0.45 + y * 0.22 + patch * 0.25, 0, 1));
    colors.set([shade.r, shade.g, shade.b], i * 3);
  }
  groundGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  groundGeometry.computeVertexNormals();
  // Grasstruktur: feine helle und dunkle Halme als Kachel, mit den Farbflächen der Wiese multipliziert
  const grassCanvas = document.createElement("canvas");
  grassCanvas.width = grassCanvas.height = 256;
  const pen = grassCanvas.getContext("2d");
  pen.fillStyle = "#e9efe2";
  pen.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i += 1) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const bright = Math.random() > 0.5;
    pen.strokeStyle = bright ? `rgba(255,255,240,${0.25 + Math.random() * 0.4})` : `rgba(70,110,50,${0.18 + Math.random() * 0.3})`;
    pen.lineWidth = 1 + Math.random();
    pen.beginPath();
    pen.moveTo(x, y);
    pen.lineTo(x + (Math.random() - 0.5) * 5, y - 4 - Math.random() * 7);
    pen.stroke();
  }
  const grassMap = new THREE.CanvasTexture(grassCanvas);
  grassMap.wrapS = grassMap.wrapT = THREE.RepeatWrapping;
  grassMap.repeat.set(70, 70);
  grassMap.colorSpace = THREE.SRGBColorSpace;
  grassMap.anisotropy = 4;
  const ground = new THREE.Mesh(groundGeometry, new THREE.MeshLambertMaterial({ vertexColors: true, map: grassMap }));
  ground.receiveShadow = true;
  scene.add(ground);
  // Grasbüschel: viele kleine Halme, dichter in den hellen Flecken
  const blade = new THREE.ConeGeometry(0.028, 0.2, 3);
  blade.translate(0, 0.1, 0);
  const tufts = new THREE.InstancedMesh(blade, new THREE.MeshLambertMaterial({ color: "#ffffff" }), 14000);
  const place = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let i = 0; i < tufts.count; i += 1) {
    const x = (Math.random() * 2 - 1) * (SIZE / 2 + 12);
    const z = (Math.random() * 2 - 1) * (SIZE / 2 + 12);
    place.position.set(x, height(x, z) - 0.03, z);
    place.rotation.set((Math.random() - 0.5) * 0.5, Math.random() * 6.28, (Math.random() - 0.5) * 0.5);
    place.scale.set(0.8 + Math.random() * 0.9, 0.6 + Math.random() * 1.1, 0.8 + Math.random() * 0.9);
    place.updateMatrix();
    tufts.setMatrixAt(i, place.matrix);
    tufts.setColorAt(i, tint.setHSL(0.27 + Math.random() * 0.05, 0.5 + Math.random() * 0.15, 0.36 + Math.random() * 0.12));
  }
  scene.add(tufts);
  // Waldrand: einfache Bäume rund um die Wiese geben dem Bild Tiefe
  const trunk = new THREE.CylinderGeometry(0.35, 0.5, 3, 6);
  trunk.translate(0, 1.5, 0);
  const crown = new THREE.ConeGeometry(2.6, 8, 7);
  crown.translate(0, 6.2, 0);
  const round = new THREE.IcosahedronGeometry(3.4, 1);
  round.translate(0, 5.6, 0);
  const ringCount = 130;
  const trunks = new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ color: "#6b4a32" }), ringCount);
  const firs = new THREE.InstancedMesh(crown, new THREE.MeshLambertMaterial({ color: "#ffffff" }), ringCount);
  const leafy = new THREE.InstancedMesh(round, new THREE.MeshLambertMaterial({ color: "#ffffff", flatShading: true }), ringCount);
  for (let i = 0; i < ringCount; i += 1) {
    const angle = (i / ringCount) * Math.PI * 2 + Math.sin(i * 12.9) * 0.03;
    const reach = SIZE / 2 + 14 + (Math.sin(i * 7.3) * 0.5 + 0.5) * 22;
    const x = Math.cos(angle) * reach * 1.25;
    const z = Math.sin(angle) * reach * 1.25;
    const size = 0.9 + (Math.sin(i * 3.7) * 0.5 + 0.5) * 0.9;
    place.position.set(x, height(THREE.MathUtils.clamp(x, -80, 80), THREE.MathUtils.clamp(z, -80, 80)) - 0.4, z);
    place.rotation.set(0, i * 2.4, 0);
    place.scale.setScalar(size);
    place.updateMatrix();
    trunks.setMatrixAt(i, place.matrix);
    const fir = i % 3 !== 0;
    tint.setHSL(fir ? 0.36 : 0.29, 0.42, fir ? 0.2 + (i % 5) * 0.012 : 0.3 + (i % 4) * 0.02);
    if (fir) { firs.setMatrixAt(i, place.matrix); firs.setColorAt(i, tint); place.scale.setScalar(0); place.updateMatrix(); leafy.setMatrixAt(i, place.matrix); leafy.setColorAt(i, tint); }
    else { leafy.setMatrixAt(i, place.matrix); leafy.setColorAt(i, tint); place.scale.setScalar(0); place.updateMatrix(); firs.setMatrixAt(i, place.matrix); firs.setColorAt(i, tint); }
  }
  scene.add(trunks, firs, leafy);

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const clock = new THREE.Clock();
  const damp = (value, target, lambda, dt) => THREE.MathUtils.lerp(value, target, 1 - Math.exp(-lambda * dt));
  const dampAngle = (value, target, lambda, dt) => value + Math.atan2(Math.sin(target - value), Math.cos(target - value)) * (1 - Math.exp(-lambda * dt));
  let sayTimer = 0;
  // hold: Sekunden, nach denen die Meldung wieder verschwindet (0 = bleibt stehen)
  const say = (text, hold = 0) => {
    if (statusEl) statusEl.textContent = text;
    window.clearTimeout(sayTimer);
    if (hold > 0) sayTimer = window.setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, hold * 1000);
  };

  // Ton: Vogelstimmen, Schritte, Motoren, Hufe, Martinshorn, Rotor, Autoradio. Startet mit der ersten Taste oder dem ersten Klick.
  const sound = (() => {
    const toggle = document.querySelector(".sound-toggle");
    let on = true;
    try { on = window.localStorage.getItem("kb-ton") !== "aus"; } catch { /* Standard: an */ }
    let context = null;
    let master = null;
    let world = null;
    const buffers = {};
    const loops = {};
    const FILES = ["voegel", "v8_leerlauf", "v8_fahrt", "boxer_leerlauf", "boxer_fahrt", "wind", "start", "tuer", "hupe", "hufe_schritt", "hufe_trab", "hufe_galopp", "klaps", "schnauben", "schritt_1", "schritt_2", "schritt_3", "schritt_4", "landen", "polizei_anhalten", "polizei_festnahme"];
    const label = () => {
      if (!toggle) return;
      toggle.hidden = false;
      toggle.setAttribute("aria-pressed", String(on));
      toggle.setAttribute("aria-label", "Ton auf der Spielwiese");
      toggle.querySelector("span").textContent = on ? "Ton aus" : "Ton an";
      toggle.classList.toggle("is-on", on);
    };
    // Erzeugte Töne (wie im Spiel): Martinshorn 440/585 Hz, Rotor mit Blattschlag, Schweber-Summen, Knall, Radiorauschen
    function make(name, seconds, shape) {
      const rate = context.sampleRate;
      const buffer = context.createBuffer(1, Math.round(rate * seconds), rate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.max(-1, Math.min(1, shape(i / rate)));
      buffer.made = true;
      buffers[name] = buffer;
    }
    function makeAll() {
      const tau = Math.PI * 2;
      make("martinshorn", 2.4, (t) => {
        const phase = t % 1.2;
        const f = phase < 0.6 ? 440 : 585;
        const edge = Math.min(1, Math.min(phase % 0.6, 0.6 - (phase % 0.6)) / 0.012);
        const w = tau * f * t;
        return (Math.sin(w) * 0.55 + Math.sin(2 * w) * 0.22 + Math.sin(3 * w) * 0.12 + Math.sign(Math.sin(w)) * 0.08) * 0.55 * edge;
      });
      let low = 0;
      let high = 0;
      make("rotor", 2, (t) => {
        const noise = Math.random() * 2 - 1;
        low += (noise - low) * 0.05;
        high += (noise - high) * 0.4;
        const slap = Math.exp(-((t * 20) % 1) * 9);
        return low * 1.5 * (0.35 + slap) + Math.sin(tau * 40 * t) * slap * 0.5 + high * 0.03;
      });
      make("summen", 2, (t) => (Math.sin(tau * 92 * t) * 0.34 + Math.sin(tau * 138 * t) * 0.2 + Math.sin(tau * 184 * t) * 0.1 + Math.sin(tau * 368 * t) * 0.04) * (0.85 + 0.15 * Math.sin(tau * 6 * t)));
      let boom = 0;
      make("knall", 1.1, (t) => {
        const noise = Math.random() * 2 - 1;
        boom += (noise - boom) * (0.5 * Math.exp(-t * 5) + 0.03);
        return boom * 1.8 * Math.exp(-t * 4.5) + Math.sin(tau * 62 * t) * Math.exp(-t * 9) * 0.9;
      });
      let rustle = 0;
      make("rascheln", 0.45, (t) => {
        const noise = Math.random() * 2 - 1;
        rustle += (noise - rustle) * 0.35;
        return (noise - rustle) * 0.8 * Math.exp(-t * 9) * (0.6 + 0.4 * Math.sin(Math.PI * 2 * 31 * t));
      });
      let hiss = 0;
      // Sendersuche: Rauschen mit Pfeifen, das am Ende abreißt
      make("rauschen", 1, (t) => {
        const noise = Math.random() * 2 - 1;
        hiss += (noise - hiss) * 0.55;
        const swell = Math.min(1, t / 0.04) * (t > 0.86 ? Math.max(0, (1 - t) / 0.14) : 1);
        return ((noise - hiss) * 0.5 + hiss * 0.3 + Math.sin(tau * (900 + 2600 * t * t) * t) * 0.07) * swell * (0.75 + 0.25 * Math.sin(tau * 9 * t));
      });
      let grain = 0;
      make("knistern", 2, () => {
        const noise = Math.random() * 2 - 1;
        grain += (noise - grain) * 0.6;
        return (noise - grain) * 0.35 + (Math.random() > 0.9994 ? 0.8 : 0);
      });
    }
    function unlock() {
      if (context) { if (context.state === "suspended") context.resume(); return; }
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      context = new Audio();
      master = context.createGain();
      master.gain.value = on ? 1 : 0;
      master.connect(context.destination);
      world = context.createGain();
      world.connect(master);
      makeAll();
      for (const name of FILES) {
        fetch(`assets/spielwiese/ton/${name}.mp3?v=${ASSET_VERSION}`).then((response) => response.arrayBuffer()).then((data) => context.decodeAudioData(data)).then((buffer) => { buffers[name] = buffer; }).catch(() => { /* ohne diesen Ton */ });
      }
    }
    for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, unlock, { capture: true, passive: true });
    label();
    toggle?.addEventListener("click", () => {
      on = !on;
      try { window.localStorage.setItem("kb-ton", on ? "an" : "aus"); } catch { /* nur Bequemlichkeit */ }
      label();
      if (master) master.gain.setTargetAtTime(on ? 1 : 0, context.currentTime, 0.05);
      api.changed?.(on);
    });
    const api = {
      get on() { return on; },
      get context() { return context; },
      get master() { return world; },
      // Baumodus: Motoren, Martinshorn und Radio schweigen, die Vögel singen weiter
      hush(flag) { if (world) world.gain.setTargetAtTime(flag ? 0 : 1, context.currentTime, 0.12); },
      // Einmal abspielen
      play(name, volume = 1, rate = 1) {
        if (!context || !buffers[name] || !on || volume <= 0.001) return;
        const source = context.createBufferSource();
        source.buffer = buffers[name];
        source.playbackRate.value = rate;
        const gain = context.createGain();
        gain.gain.value = volume;
        source.connect(gain).connect(world);
        source.start();
      },
      // Dauerton: jedes Bild mit der gewünschten Lautstärke aufrufen; 0 blendet aus und beendet ihn
      loop(key, name, volume, rate = 1) {
        if (!context || !buffers[name]) return;
        let entry = loops[key];
        if (!entry) {
          if (volume <= 0.001) return;
          const source = context.createBufferSource();
          const buffer = buffers[name];
          source.buffer = buffer;
          source.loop = true;
          // MP3 hat am Anfang und Ende etwas Stille: Schleife knapp innerhalb setzen
          if (!buffer.made && buffer.duration > 0.6) { source.loopStart = 0.03; source.loopEnd = buffer.duration - 0.06; }
          const gain = context.createGain();
          gain.gain.value = 0;
          source.connect(gain).connect(key === "atmo" ? master : world);
          source.start();
          entry = loops[key] = { source, gain, quiet: 0 };
        }
        entry.gain.gain.setTargetAtTime(volume, context.currentTime, 0.09);
        entry.source.playbackRate.setTargetAtTime(rate, context.currentTime, 0.09);
        entry.quiet = volume <= 0.001 ? entry.quiet + 1 : 0;
        if (entry.quiet > 90) api.stop(key);
      },
      stop(key) {
        const entry = loops[key];
        if (!entry) return;
        entry.source.stop();
        entry.gain.disconnect();
        delete loops[key];
      }
    };
    return api;
  })();
  sound.changed = (on) => { if (!on) radio.stop(false); else if (driving?.item.radio && driving.motor) radio.start(); };
  // Lautstärke nach Entfernung zur Kamera: bis near volle Lautstärke, bei far still
  const heard = new THREE.Vector3();
  const loudness = (position, near, far) => {
    const distance = heard.copy(position).distanceTo(camera.position);
    const k = THREE.MathUtils.clamp(1 - (distance - near) / (far - near), 0, 1);
    return k * k;
  };

  // Autoradio: "ODYN - Wald (2026 Remake)". Erst Rauschen, dann der Song mit dem Klang eines alten Radios. R schaltet es ein und aus.
  const radio = (() => {
    const element = new Audio();
    element.preload = "none";
    element.loop = true;
    element.src = "assets/musik/odyn-wald-2026-remake.mp3?v=1";
    let wanted = true;
    let active = false;
    let gain = null;
    let timer = 0;
    function wire() {
      if (gain || !sound.context) return Boolean(gain);
      const context = sound.context;
      const source = context.createMediaElementSource(element);
      const high = context.createBiquadFilter();
      high.type = "highpass";
      high.frequency.value = 340;
      const lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 3100;
      const nose = context.createBiquadFilter();
      nose.type = "peaking";
      nose.frequency.value = 1350;
      nose.Q.value = 0.9;
      nose.gain.value = 7;
      // Leichte Verzerrung wie bei einem kleinen, übersteuerten Lautsprecher
      const drive = context.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i += 1) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(x * 2.6) / Math.tanh(2.6); }
      drive.curve = curve;
      gain = context.createGain();
      gain.gain.value = 0;
      source.connect(high).connect(lowpass).connect(nose).connect(drive).connect(gain).connect(sound.master);
      return true;
    }
    function start() {
      if (active || !wanted || !sound.on || !wire()) return;
      active = true;
      sound.play("rauschen", 0.5);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!active) return;
        element.play().catch(() => { /* ohne Radio */ });
        gain.gain.setTargetAtTime(0.75, sound.context.currentTime, 0.25);
      }, 780);
    }
    function stop(click = true) {
      if (!active) return;
      active = false;
      window.clearTimeout(timer);
      if (gain) gain.gain.setTargetAtTime(0, sound.context.currentTime, 0.04);
      window.setTimeout(() => { if (!active) element.pause(); }, 220);
      if (click) sound.play("rauschen", 0.22, 2.4);
    }
    return {
      get active() { return active; },
      get wanted() { return wanted; },
      start,
      stop,
      toggle() { wanted = !wanted; return wanted; }
    };
  })();

  // Kim: dieselbe Figur wie auf der Startseite, mit dem Aussehen aus dem Charakter-Editor
  const kim = { group: new THREE.Group(), mixer: null, actions: {}, clips: {}, rest: {}, materials: [], legs: [], current: "", yaw: 0, speed: 0, jump: 0, stepIn: 0, target: null, ready: false, height: 1.75, hip: 0.95, shin: 0.5, busy: null, pose: null };
  scene.add(kim.group);
  const HAIR = { Original: "Original", Kurz: "Kurz", Dutt: "Dutt", Irokese: "Irokese", Kraus: "Kraus", Lang: "Lang", "Lange Locken": "LangeLocken", Locken: "Locken", Locs: "Locs", "Zöpfe": "Zoepfe", Zopf: "Zopf", Glatze: null };
  const COLORS = {
    haar: { Dunkelbraun: "#3B2A20", Schwarz: "#1B1A1A", Kastanie: "#7A3B22", Rot: "#B4502C", Blond: "#D9B56A", Platin: "#E6DDCB", Grau: "#9A9A9A", Gold: "#D7C791", Blau: "#8EBDFF", Rosa: "#E79AB0" },
    haut: { "Sehr hell": "#FFD0B5", Hell: "#F7B58F", Mittel: "#D99A6C", Hellbraun: "#B5754A", Dunkelbraun: "#7A4A2E", "Sehr dunkel": "#47291C", Blau: "#4F8FE6" },
    stoff: { "Weiß": "#F2F2F2", Hellgrau: "#B8B8B8", Schwarz: "#1E1E1E", Rot: "#C0392B", Blau: "#2F5FB3", Jeansblau: "#4A6A8F", "Grün": "#3E8E4D", Gold: "#D7C791", Gelb: "#E3B93A", Beige: "#CDB896", Braun: "#6B4A32", Rosa: "#E79AB0", Lila: "#7A4FA3" }
  };
  const ORIGINAL = { haar: "#6C4B35", haut: "#FFB490", Oberteil: "#E0D5D3", Hose: "#262528", Schuhe: "#262526" };
  function tintable(material) {
    if (!material) return null;
    const tint = new THREE.Color(1, 1, 1);
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTint = { value: tint };
      shader.fragmentShader = `uniform vec3 uTint;\n${shader.fragmentShader.replace("#include <map_fragment>", `#ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          diffuseColor.rgb *= sampledDiffuseColor.rgb * mix( vec3( 1.0 ), uTint, sampledDiffuseColor.a );
        #endif`)}`;
    };
    material.customProgramCacheKey = () => "jl-tint-3";
    material.needsUpdate = true;
    return tint;
  }
  function readLook() {
    try { return JSON.parse(window.localStorage.getItem(LOOK_KEY) || "{}").figuren?.kim || {}; } catch { return {}; }
  }
  loader.loadAsync("assets/figuren/kim.glb?v=20261112-3").then((gltf) => {
    const look = readLook();
    const materials = {};
    const hairKey = HAIR[look.frisur] === undefined ? "Original" : HAIR[look.frisur];
    gltf.scene.traverse((object) => {
      if (!object.isMesh) return;
      object.frustumCulled = false;
      object.castShadow = true;
      materials[object.material.name] = object.material;
      if (object.name.startsWith("Frisur_")) object.visible = hairKey !== null && object.name === `Frisur_Kim_${hairKey}`;
    });
    if (materials.Haar) {
      materials.Haar.vertexColors = true;
      materials.Haar.color.set(hairKey === "Original" ? ORIGINAL.haar : COLORS.haar[look.haarfarbe] || ORIGINAL.haar);
    }
    tintable(materials.Haut)?.set(COLORS.haut[look.haut] || ORIGINAL.haut);
    for (const part of ["Oberteil", "Hose", "Schuhe"]) tintable(materials[part])?.set(COLORS.stoff[look[part]] || ORIGINAL[part]);
    // Kim ist hier etwas größer als im Lab, damit die Fahrzeuge für ihn eher zu klein wirken
    gltf.scene.scale.setScalar(KIM_SCALE);
    gltf.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    gltf.scene.position.y = -box.min.y;
    kim.height = box.max.y - box.min.y;
    kim.group.add(gltf.scene);
    // Ruhepose der Knochen: Grundlage, um Kims Bewegungen auf andere Figuren zu übertragen
    gltf.scene.traverse((bone) => { if (bone.isBone) kim.rest[bone.name] = bone.quaternion.clone(); });
    gltf.scene.updateMatrixWorld(true);
    kim.hip = (gltf.scene.getObjectByName("Hips")?.getWorldPosition(new THREE.Vector3()).y ?? kim.height * 0.55);
    kim.materials = Object.values(materials);
    // Beine: für Sitzen mit ausgestreckten Beinen und für den Reitsitz
    for (const side of ["Left", "Right"]) {
      const thigh = gltf.scene.getObjectByName(`${side}UpLeg`);
      const shin = gltf.scene.getObjectByName(`${side}Leg`);
      const foot = gltf.scene.getObjectByName(`${side}Foot`);
      if (!thigh || !shin || !foot) continue;
      const at = thigh.getWorldPosition(new THREE.Vector3());
      kim.shin = shin.getWorldPosition(new THREE.Vector3()).distanceTo(foot.getWorldPosition(new THREE.Vector3()));
      kim.legs.push({ thigh, shin, out: at.x >= 0 ? 1 : -1 });
    }
    kim.mixer = new THREE.AnimationMixer(gltf.scene);
    for (const clip of gltf.animations) { kim.clips[clip.name.replace(/^[A-Za-z]+_/, "")] = clip; kim.actions[clip.name.replace(/^[A-Za-z]+_/, "")] = kim.mixer.clipAction(clip); }
    // Umfallen (kim-moves) sowie Ein-/Aussteigen und Sitzen (kim-fahren)
    for (const file of ["kim-moves.glb?v=1", "kim-fahren.glb?v=1"]) {
      loader.loadAsync(`assets/figuren/${file}`).then((extra) => {
        for (const clip of extra.animations) kim.actions[clip.name.replace(/^[A-Za-z]+_/, "")] = kim.mixer.clipAction(clip);
      }).catch(() => { /* ohne Zusatzbewegungen: Kim steht im Auto und fällt nicht um */ });
    }
    kim.ready = true;
    kimPlay("Idle", 0);
    // Ankunft: Kim kommt angerannt
    kim.group.position.set(0, 0, 9);
    kim.yaw = Math.PI;
    kim.target = new THREE.Vector3(0, 0, 0);
    kim.run = true;
  }).catch(() => say("Kim konnte nicht geladen werden. Lade die Seite bitte neu."));
  function kimPlay(name, fade = 0.25, timeScale = 1) {
    const next = kim.actions[name];
    if (!next) return;
    next.timeScale = timeScale;
    if (kim.current === name) return;
    const previous = kim.actions[kim.current];
    next.reset().setEffectiveWeight(1).setLoop(THREE.LoopRepeat, Infinity).play();
    if (previous && fade > 0) next.crossFadeFrom(previous, fade, false); else previous?.stop();
    kim.current = name;
  }
  // Einmal abspielen und am Ende stehen bleiben; speed < 0 spielt rückwärts. Liefert die Dauer in Sekunden.
  function kimOnce(name, speed = 1, fade = 0.2) {
    const next = kim.actions[name];
    if (!next) return 0;
    const previous = kim.actions[kim.current];
    const length = next.getClip().duration;
    next.reset().setEffectiveWeight(1).setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
    next.timeScale = speed;
    if (speed < 0) next.time = length;
    next.play();
    if (previous && previous !== next) { if (fade > 0) next.crossFadeFrom(previous, fade, false); else previous.stop(); }
    kim.current = name;
    return length / Math.abs(speed);
  }

  // Beinhaltung nach der Bewegung überschreiben. down: Oberschenkel nach unten, spread: nach außen, shin: Unterschenkel nach vorn (negativ)
  const legWorld = new THREE.Quaternion();
  const legParent = new THREE.Quaternion();
  const legTurn = new THREE.Quaternion();
  const legPitch = new THREE.Quaternion();
  const legYaw = new THREE.Quaternion();
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisY = new THREE.Vector3(0, 1, 0);
  function turnBone(bone, local) {
    // Drehung "local" in Kims Körperachsen auf den Knochen anwenden
    kim.group.getWorldQuaternion(legWorld);
    legTurn.copy(legWorld).multiply(local).multiply(legWorld.invert());
    bone.parent.getWorldQuaternion(legParent);
    bone.quaternion.premultiply(legWorld.copy(legParent).invert().multiply(legTurn).multiply(legParent));
    bone.updateMatrixWorld(true);
  }
  function poseLegs({ down = 0, spread = 0, shin = 0 }) {
    for (const leg of kim.legs) {
      legYaw.setFromAxisAngle(axisY, leg.out * spread);
      turnBone(leg.thigh, legTurn.copy(legYaw).multiply(legPitch.setFromAxisAngle(axisX, down)));
      const undo = legYaw.clone().multiply(legPitch.setFromAxisAngle(axisX, shin - down)).multiply(legYaw.invert());
      turnBone(leg.shin, undo);
    }
  }
  // Im Fahrzeug nichts zeichnen, was unter dem Fahrzeugboden herausschauen würde
  renderer.localClippingEnabled = true;
  const floorClip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const CLIP_ON = [floorClip];
  const CLIP_OFF = [];
  function clipKim(on) {
    for (const material of kim.materials) { material.clippingPlanes = on ? CLIP_ON : CLIP_OFF; material.needsUpdate = true; }
  }

  // Bewegungen für Polizist und Kind: gleiche Knochen wie Kim, deshalb lassen sich Clips übertragen
  let people = null;
  loader.loadAsync(`assets/spielwiese/leute-anim.glb?v=${ASSET_VERSION}`).then((gltf) => {
    const rest = {};
    gltf.scene.traverse((node) => { rest[node.name] = node.quaternion.clone(); });
    people = { rest, clips: Object.fromEntries(gltf.animations.map((clip) => [clip.name, clip])) };
  }).catch(() => { people = null; });
  const fix = new THREE.Quaternion();
  const turned = new THREE.Quaternion();
  function retarget(clip, sourceRest, targetRest, skip) {
    const tracks = [];
    for (const track of clip.tracks) {
      const [bone, property] = track.name.split(".");
      if (property !== "quaternion" || !sourceRest[bone] || !targetRest[bone] || (skip && skip.test(bone))) continue;
      fix.copy(targetRest[bone]).multiply(turned.copy(sourceRest[bone]).invert());
      const values = new Float32Array(track.values.length);
      for (let i = 0; i < values.length; i += 4) {
        turned.fromArray(track.values, i).premultiply(fix);
        turned.toArray(values, i);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(track.name, track.times, values));
    }
    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
  }
  function setupNpc(thing) {
    if (thing.mixer || !people || !kim.ready) return;
    const skip = thing.item.npc.keepArms ? /Arm|Hand|Shoulder/ : null;
    thing.mixer = new THREE.AnimationMixer(thing.inner);
    const add = (name, clip, rest) => { if (clip) thing.actions[name] = thing.mixer.clipAction(retarget(clip, rest, thing.rest, skip)); };
    add("Idle", people.clips.Idle, people.rest);
    add("Look", people.clips.Activity_Umsehen, people.rest);
    add("Walk", people.clips.Walk_InPlace, people.rest);
    add("Run", kim.clips.Run, kim.rest);
    thing.pose = "";
    npcPlay(thing, "Idle");
  }
  function npcPlay(thing, name, timeScale = 1) {
    const next = thing.actions[name];
    if (!next) return;
    next.timeScale = timeScale;
    if (thing.pose === name) return;
    const previous = thing.actions[thing.pose];
    next.reset().setEffectiveWeight(1).play();
    if (previous) next.crossFadeFrom(previous, 0.25, false);
    thing.pose = name;
  }

  // Modelle: einmal laden, für jedes platzierte Ding klonen
  const models = {};
  function loadModel(id) {
    if (!models[id]) {
      models[id] = loader.loadAsync(`assets/spielwiese/${id}.glb?v=${ASSET_VERSION}`).then((gltf) => {
        const item = byId[id];
        // Manche Modelle zeigen mit der Front nach hinten: umdrehen, damit "vorn" bei allen +Z ist
        if (item.flip) gltf.scene.rotation.y = Math.PI;
        gltf.scene.updateMatrixWorld(true);
        const rest = {};
        gltf.scene.traverse((bone) => { if (bone.isBone) rest[bone.name] = bone.quaternion.clone(); });
        const seatNode = gltf.scene.getObjectByName("DriverSeat") || gltf.scene.getObjectByName("PilotSeat");
        const seatAt = seatNode ? seatNode.getWorldPosition(new THREE.Vector3()) : null;
        const exitNode = gltf.scene.getObjectByName("Exit_L");
        const exitAt = exitNode ? exitNode.getWorldPosition(new THREE.Vector3()) : null;
        // Manche Modelle kommen mit Deckkraft 0 aus der Quelle
        gltf.scene.traverse((object) => { if (object.isMesh && object.material.opacity === 0) { object.material.opacity = 1; object.material.transparent = false; } });
        // Umrisshülle (nach innen gedrehte Flächen): einseitig zeichnen, sonst verdeckt sie das Modell
        if (item.hull) gltf.scene.traverse((object) => { if (object.isMesh && object.material.name.startsWith("Outline")) object.material.side = THREE.FrontSide; });
        // Figuren ohne eigene Bewegung stehen sonst mit ausgebreiteten Armen da: Oberarme herunternehmen
        if (item.armsDown) {
          const world = new THREE.Quaternion();
          const parent = new THREE.Quaternion();
          const turn = new THREE.Quaternion();
          gltf.scene.traverse((bone) => {
            if (!bone.isBone || !/arm/i.test(bone.name) || /fore|lower|unter/i.test(bone.name)) return;
            const side = bone.getWorldPosition(new THREE.Vector3()).x >= 0 ? -1 : 1;
            turn.setFromAxisAngle(new THREE.Vector3(0, 0, 1), side * THREE.MathUtils.degToRad(item.armsDown));
            bone.getWorldQuaternion(world);
            bone.parent.getWorldQuaternion(parent);
            bone.quaternion.copy(parent.invert().multiply(turn).multiply(world));
            bone.updateMatrixWorld(true);
          });
        }
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const size = box.getSize(new THREE.Vector3());
        const scale = item.h / Math.max(0.001, size.y);
        const center = box.getCenter(new THREE.Vector3());
        const offset = new THREE.Vector3(-center.x, -box.min.y, -center.z);
        const length = size.z * scale;
        const seat = item.ride ? new THREE.Vector3(item.ride.seat[0], item.ride.seat[1] * item.h, item.ride.seat[2] * length) : seatAt ? seatAt.add(offset).multiplyScalar(scale) : null;
        return { gltf, scale, offset, rest, seat, exit: exitAt ? exitAt.add(offset).multiplyScalar(scale) : null, radius: Math.max(size.x, size.z) * scale / 2 };
      });
      models[id].catch(() => { delete models[id]; });
    }
    return models[id];
  }
  function cloneSkinned(source) {
    // Klon mit eigenem Skelett (wie SkeletonUtils.clone), damit jedes Tier für sich läuft
    const clone = source.clone(true);
    const sourceNodes = [];
    const cloneNodes = [];
    source.traverse((node) => sourceNodes.push(node));
    clone.traverse((node) => cloneNodes.push(node));
    const map = new Map(sourceNodes.map((node, index) => [node, cloneNodes[index]]));
    cloneNodes.forEach((node, index) => {
      const original = sourceNodes[index];
      if (!node.isSkinnedMesh) return;
      node.skeleton = original.skeleton.clone();
      node.skeleton.bones = original.skeleton.bones.map((bone) => map.get(bone));
      node.bind(node.skeleton, original.bindMatrix);
    });
    return clone;
  }

  const things = [];
  let nextKey = 1;
  async function addThing(id, x, z, yaw = 0, { save = true } = {}) {
    const item = byId[id];
    if (!item) return null;
    const model = await loadModel(id);
    const inner = cloneSkinned(model.gltf.scene);
    inner.scale.setScalar(model.scale);
    inner.position.copy(model.offset).multiplyScalar(model.scale);
    inner.traverse((object) => { if (object.isMesh) { object.castShadow = true; object.frustumCulled = !object.isSkinnedMesh; } });
    const tilt = new THREE.Group();
    tilt.add(inner);
    const group = new THREE.Group();
    group.add(tilt);
    const rotors = [];
    inner.traverse((node) => {
      if (node.name === "Rotor_Haupt" || /^Rotor_[LR]_(Front|Rear)$/.test(node.name)) rotors.push([node, "y"]);
      else if (node.name === "Rotor_Heck") rotors.push([node, "x"]);
    });
    // Blaulicht: eigene Materialien je Streifenwagen, damit nicht alle zugleich blinken
    const lights = [];
    if (item.patrol) {
      inner.traverse((object) => {
        if (!object.isMesh || !object.material.name.startsWith("BlueLight")) return;
        object.material = object.material.clone();
        lights.push(object.material);
      });
    }
    // Türen: Scharniere (Door_L_Hinge / Door_R_Hinge), Drehachse ist die Hochachse des Autos
    const doors = [];
    group.updateMatrixWorld(true);
    inner.traverse((node) => {
      if (!/^Door_.*_Hinge$/.test(node.name)) return;
      // side: Seite am Fahrzeug (für die Fahrertür), swing: Drehsinn, damit die Tür nach außen aufgeht
      const side = Math.sign(group.worldToLocal(node.getWorldPosition(new THREE.Vector3())).x) || 1;
      doors.push({ node, closed: node.quaternion.clone(), side, swing: -(Math.sign(node.position.x) || 1) * (item.flip ? -1 : 1), open: 0, want: 0 });
    });
    const thing = { key: nextKey, id, item, group, tilt, inner, rest: model.rest, seat: model.seat, exit: model.exit, rotors, lights, doors, hp: 100, wreck: false, alt: 0, float: 1, down: 0, cool: 0, state: "patrol", lost: 0, airborne: false, x, z, yaw, radius: model.radius, speed: 0, home: new THREE.Vector2(x, z), phase: Math.random() * 6.28, mixer: null, actions: {}, wait: 1 + Math.random() * 3, goal: null };
    nextKey += 1;
    group.userData.thing = thing;
    if (item.orbit) thing.float = 0.05;
    if (model.gltf.animations.length && item.wander) {
      thing.mixer = new THREE.AnimationMixer(inner);
      for (const clip of model.gltf.animations) thing.actions[clip.name.split("|").pop().replace(/^\d+_/, "")] = thing.mixer.clipAction(clip);
      const idle = thing.actions[item.wander.idle];
      if (idle) idle.play();
    }
    scene.add(group);
    things.push(thing);
    settle(thing, 1);
    if (save) saveMap();
    return thing;
  }
  function removeThing(thing) {
    if (driving === thing) { thing.alt = 0; kim.busy = null; kim.climb = null; kim.pose = null; clipKim(false); radio.stop(false); if (kim.group.parent !== scene) { scene.add(kim.group); kim.group.scale.x = 1; kim.group.position.set(thing.x, 0, thing.z); kim.group.rotation.set(0, thing.yaw, 0); } kim.group.visible = true; kim.current = ""; driving = null; if (driveButton) driveButton.hidden = true; say(""); }
    sound.stop(`horn${thing.key}`);
    sound.stop(`motor${thing.key}`);
    sound.stop(`rotor${thing.key}`);
    if (thing.officer) { const officer = thing.officer; thing.officer = null; officer.owner = null; removeThing(officer); }
    if (thing.owner) { thing.owner.officer = null; thing.owner = null; }
    scene.remove(thing.group);
    if (things.indexOf(thing) < 0) return;
    things.splice(things.indexOf(thing), 1);
    if (selected === thing) select(null);
    saveMap();
  }
  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();
  const tiltTarget = new THREE.Quaternion();
  // Auf den Boden setzen: Höhe der Wiese, Fahrzeuge neigen sich mit dem Hang
  function settle(thing, blend) {
    // Beim Aufstellen bleibt auch die Drohne in Bodennähe, damit man sieht, wo sie landet
    const float = thing.held ? Math.min(thing.float, 1.2 / thing.item.hover) : thing.float;
    const lift = (thing.item.hover ? (thing.item.hover + Math.sin(clock.elapsedTime * 2 + thing.phase) * 0.06) * float : 0) + thing.alt;
    thing.lift = lift;
    thing.group.position.set(thing.x, height(thing.x, thing.z) + lift, thing.z);
    thing.group.rotation.y = thing.yaw;
    if (lift > 1) thing.tilt.quaternion.slerp(tiltTarget.identity(), blend);
    else if (thing.item.drive || thing.item.wander || thing.item.patrol) {
      normalAt(thing.x, thing.z, normal).applyAxisAngle(up, -thing.yaw);
      tiltTarget.setFromUnitVectors(up, normal);
      thing.tilt.quaternion.slerp(tiltTarget, blend);
    }
  }
  function saveMap() {
    try { window.localStorage.setItem(MAP_KEY, JSON.stringify(things.filter((thing) => !thing.temp).map((thing) => [thing.id, Math.round(thing.x * 100) / 100, Math.round(thing.z * 100) / 100, Math.round(thing.yaw * 100) / 100]))); } catch { /* nur Bequemlichkeit */ }
  }
  function loadMap() {
    let saved = null;
    try { saved = JSON.parse(window.localStorage.getItem(MAP_KEY) || window.localStorage.getItem("kb-spielplatz-v1") || "null"); } catch { saved = null; }
    // Erster Besuch: ein paar Dinge stehen schon da
    const list = Array.isArray(saved) ? saved : [["eiche", -9, 7, 0.4], ["birke", 11, 9, 1.2], ["fichte", -13, -6, 0], ["busch", 6, -7, 0.7], ["sonnenblume", -4, 9, 0], ["gokart", 6, 3, -0.9], ["fuchs", -6, -3, 1.5]];
    // Frühere Maps kannten das offene Polizeiauto: daraus wird der Streifenwagen
    for (const row of list) if (Array.isArray(row) && row[0] === "polizeiauto") row[0] = "streife";
    return Promise.all(list.filter((row) => Array.isArray(row) && byId[row[0]]).slice(0, 80).map((row) => addThing(row[0], Number(row[1]) || 0, Number(row[2]) || 0, Number(row[3]) || 0, { save: false }).catch(() => null)));
  }
  loadMap();

  // Leiste: Dinge mit Maus oder Finger auf die Wiese ziehen
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hit = new THREE.Vector3();
  function groundAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const found = raycaster.intersectObject(ground, false)[0];
    if (!found) return null;
    hit.copy(found.point);
    hit.x = THREE.MathUtils.clamp(hit.x, -EDGE, EDGE);
    hit.z = THREE.MathUtils.clamp(hit.z, -EDGE, EDGE);
    return hit;
  }
  function thingAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const found = raycaster.intersectObjects(things.map((thing) => thing.group), true)[0];
    let node = found?.object;
    while (node && !node.userData.thing) node = node.parent;
    return node?.userData.thing || null;
  }
  if (palette) {
    let group = "";
    for (const item of CATALOG) {
      if (item.group !== group) {
        group = item.group;
        const title = document.createElement("p");
        title.className = "palette-group";
        title.textContent = group;
        palette.append(title);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "palette-item";
      button.dataset.item = item.id;
      button.innerHTML = `<img src="assets/spielwiese/bilder/${item.id}.webp?v=${ASSET_VERSION}" alt="" width="96" height="72" loading="lazy"><span>${SOFT[item.name] || item.name}</span>`;
      palette.append(button);
      let pull = null;
      button.addEventListener("pointerdown", (event) => {
        if (event.button) return;
        pull = { id: event.pointerId, x: event.clientX, y: event.clientY, thing: null, pending: false, moved: false };
        button.setPointerCapture(event.pointerId);
        loadModel(item.id);
      });
      button.addEventListener("pointermove", (event) => {
        if (!pull || event.pointerId !== pull.id) return;
        if (!pull.moved && Math.hypot(event.clientX - pull.x, event.clientY - pull.y) < 8) return;
        pull.moved = true;
        const spot = groundAt(event.clientX, event.clientY);
        if (!spot) return;
        if (pull.thing) { pull.thing.x = spot.x; pull.thing.z = spot.z; pull.thing.home.set(spot.x, spot.z); settle(pull.thing, 1); }
        else if (!pull.pending) {
          pull.pending = true;
          const mine = pull;
          addThing(item.id, spot.x, spot.z, kim.yaw + Math.PI, { save: false }).then((thing) => {
            if (!thing) return;
            if (pull === mine) { mine.thing = thing; thing.held = true; }
            else if (mine.cancelled) removeThing(thing);
            else saveMap();
          });
        }
      });
      const done = (event) => {
        if (!pull || event.pointerId !== pull.id) return;
        const mine = pull;
        pull = null;
        if (!mine.moved) {
          // Nur angetippt: direkt vor Kim abstellen
          const ahead = 3.5 + (byId[item.id].h > 3 ? 4 : 0);
          addThing(item.id, THREE.MathUtils.clamp(kim.group.position.x + Math.sin(kim.yaw) * ahead, -EDGE, EDGE), THREE.MathUtils.clamp(kim.group.position.z + Math.cos(kim.yaw) * ahead, -EDGE, EDGE), kim.yaw + Math.PI).then((thing) => thing && select(thing));
          return;
        }
        if (mine.thing) {
          mine.thing.held = false;
          if (groundAt(event.clientX, event.clientY)) { saveMap(); select(mine.thing); } else removeThing(mine.thing);
        } else if (mine.pending && !groundAt(event.clientX, event.clientY)) mine.cancelled = true;
      };
      button.addEventListener("pointerup", done);
      button.addEventListener("pointercancel", done);
    }
  }

  // Auswahl: drehen, entfernen, einsteigen
  let selected = null;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: "#f4e3a1", transparent: true, opacity: 0.9, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  scene.add(ring);
  function select(thing) {
    selected = thing;
    ring.visible = Boolean(thing);
    if (tools) {
      tools.hidden = !thing;
      if (thing) {
        tools.querySelector("[data-tool-name]").textContent = thing.item.name;
        const enter = tools.querySelector('[data-tool="drive"]');
        enter.hidden = !(thing.item.drive || thing.item.ride);
        enter.textContent = thing.item.ride ? "Aufsteigen" : "Einsteigen";
      }
    }
  }
  tools?.addEventListener("click", (event) => {
    const tool = event.target.closest("[data-tool]")?.dataset.tool;
    if (!tool || !selected) return;
    if (tool === "left" || tool === "right") { selected.yaw += tool === "left" ? Math.PI / 8 : -Math.PI / 8; settle(selected, 1); saveMap(); }
    else if (tool === "remove") removeThing(selected);
    else if (tool === "drive") { const thing = selected; setMode("play"); enterVehicle(thing); }
    else if (tool === "close") select(null);
  });
  document.querySelector("[data-play-clear]")?.addEventListener("click", () => {
    for (const thing of [...things]) removeThing(thing);
    select(null);
    saveMap();
  });

  // Fahren: einsteigen mit E oder dem Knopf, aussteigen genauso
  let driving = null;
  const driveButton = document.querySelector("[data-play-exit]");
  function nearestVehicle() {
    let best = null;
    let bestDistance = 4.2;
    for (const thing of things) {
      if (!thing.item.drive && !thing.item.ride) continue;
      const distance = Math.hypot(thing.x - kim.group.position.x, thing.z - kim.group.position.z) - thing.radius;
      if (distance < bestDistance) { best = thing; bestDistance = distance; }
    }
    return best;
  }
  function helpFor(thing) {
    if (thing.item.ride) return "Pferd: W reiten, Leertaste Klaps (Trab, dann Galopp), S langsamer, A/D lenken, E absteigen";
    const fly = thing.item.fly ? ", Leertaste abheben und landen" : ", H Hupe";
    return `${thing.item.name}: W/S Gas und Bremse, A/D lenken${fly}${thing.item.radio ? ", R Radio" : ""}, E aussteigen`;
  }
  // Sitzhöhe: Becken auf den Sitz. Ist der Sitz zu niedrig für Kims Beine, streckt er sie nach vorn.
  function seatKim(thing) {
    const sitHip = kim.hip - 0.21 * KIM_SCALE;
    thing.tilt.add(kim.group);
    kim.group.position.set(thing.seat.x, thing.seat.y - sitHip, thing.seat.z);
    kim.group.rotation.set(0, 0, 0);
    // Die Ein- und Aussteigebewegung führt nach +x. Sitzt der Fahrer auf der anderen Seite, wird Kim gespiegelt,
    // damit er durch die Fahrertür steigt und nicht quer über den Beifahrersitz.
    kim.group.scale.x = thing.seat.x < -0.02 ? -1 : 1;
    const room = thing.seat.y - 0.1;
    kim.pose = room < sitHip ? { shin: -Math.acos(THREE.MathUtils.clamp(room / Math.max(0.1, kim.shin + 0.12 * KIM_SCALE), 0.15, 1)) } : null;
  }
  function enterVehicle(thing) {
    if (!thing || !(thing.item.drive || thing.item.ride) || !kim.ready || driving || kim.busy) return;
    if (thing.wreck) { say("Das ist nur noch ein Wrack. Im Baumodus (B) stellst du ein neues Fahrzeug auf.", 5); return; }
    driving = thing;
    thing.speed = 0;
    thing.goal = null;
    thing.motor = false;
    kim.target = null;
    kim.jump = 0;
    kim.speed = 0;
    select(null);
    if (driveButton) { driveButton.hidden = false; driveButton.textContent = thing.item.ride ? "Absteigen" : "Aussteigen"; }
    say(helpFor(thing), 9);
    if (thing.item.ride) {
      // Pferd geht zum Aufsteigen herunter; Kim sitzt auf, sobald es unten ist
      thing.riding = { gait: 0, held: 0, clip: "" };
      horsePlay(thing, "Aufsteigen", 1, true);
      kimOnce("Jump", 1.5);
      kim.busy = { left: 1.5, then: () => {
        seatKim(thing);
        kim.pose = { down: 0.72, spread: 0.52, shin: 0.2 };
        kimPlay("SitInCar", 0.1);
        sound.play("schnauben", 0.7);
        kim.busy = { left: 2.3, then: () => {} };
      } };
      return;
    }
    const begin = () => {
      thing.motor = true;
      sound.play("tuer", 0.8);
      if (thing.item.engine === "v8" || thing.item.engine === "boxer") sound.play("start", 0.7);
      if (thing.item.radio) radio.start();
    };
    if (!thing.seat || !kim.actions.SitInCar) { kim.group.visible = false; begin(); return; }
    // Kim sitzt auf dem Sitzanker des Fahrzeugs: Aussteigen rückwärts abgespielt ist das Einsteigen
    seatKim(thing);
    const pose = kim.pose;
    kim.pose = null;
    clipKim(true);
    swingDoor(thing, true);
    const wait = kimOnce("ExitCar", -2.2, 0.15);
    // Beim Einsteigen steht Kim zuerst auf dem Boden und steigt in Stufen auf Sitzhöhe (Monstertruck) bzw. hinunter (flache Autos)
    kim.climb = { seat: kim.group.position.y, ground: -(thing.lift || 0), t: 0, time: (wait || 0.01) * 0.62, up: true };
    kim.group.position.y = kim.climb.ground;
    kim.busy = { left: wait || 0.01, then: () => { kim.climb = null; kim.group.position.y = thing.seat.y - (kim.hip - 0.21 * KIM_SCALE); kim.pose = pose; kimPlay("SitInCar", 0.2); swingDoor(thing, false); begin(); } };
  }
  const stand = new THREE.Vector3();
  function leaveVehicle() {
    if (!driving || kim.busy) return;
    const thing = driving;
    if (thing.alt > 0.5 || thing.airborne) { say("Erst landen (Leertaste), dann aussteigen.", 4); return; }
    if (Math.abs(thing.speed) > 2.5) { say("Erst anhalten, dann aussteigen.", 3); return; }
    thing.speed = 0;
    thing.motor = false;
    radio.stop();
    const finish = () => {
      // Dort absetzen, wo die Bewegung endet, sonst neben dem Fahrzeug
      const hips = kim.group.getObjectByName("Hips");
      if (kim.group.parent !== scene && hips && !thing.item.ride) hips.getWorldPosition(stand);
      else { const side = thing.seat && thing.seat.x < -0.02 ? -1 : 1; stand.set(thing.x + side * Math.cos(thing.yaw) * (thing.radius + 0.9), 0, thing.z - side * Math.sin(thing.yaw) * (thing.radius + 0.9)); }
      scene.add(kim.group);
      kim.group.scale.x = 1;
      kim.group.position.set(THREE.MathUtils.clamp(stand.x, -EDGE, EDGE), 0, THREE.MathUtils.clamp(stand.z, -EDGE, EDGE));
      kim.group.rotation.set(0, thing.yaw, 0);
      kim.yaw = thing.yaw;
      kim.group.visible = true;
      kim.speed = 0;
      kim.pose = null;
      clipKim(false);
      kim.actions[kim.current]?.stop();
      kim.current = "";
      kimPlay("Idle", 0);
      if (thing.item.ride) { thing.riding = null; thing.home.set(thing.x, thing.z); thing.wait = 4; thing.moving = undefined; horsePlay(thing, "Schritt", 0); }
      else sound.play("tuer", 0.8);
      driving = null;
      if (driveButton) driveButton.hidden = true;
      say("");
      saveMap();
    };
    if (kim.group.parent === scene || !kim.actions.ExitCar || thing.item.ride) { finish(); return; }
    kim.pose = null;
    swingDoor(thing, true);
    const wait = kimOnce("ExitCar", 2.2, 0.15);
    kim.climb = { seat: kim.group.position.y, ground: -(thing.lift || 0), t: 0, time: wait * 0.62, delay: wait * 0.38, up: false };
    kim.busy = { left: wait, then: () => { kim.climb = null; finish(); swingDoor(thing, false); } };
  }
  // Tür auf der Fahrerseite öffnen oder schließen (bewegt sich dann von selbst dorthin)
  function swingDoor(thing, open) {
    if (!thing.doors.length) return;
    const side = Math.sign(thing.seat ? thing.seat.x : thing.exit ? thing.exit.x : -1) || -1;
    const driver = thing.doors.find((entry) => entry.side === side) || thing.doors[0];
    driver.want = open ? 1 : 0;
  }
  const doorTurn = new THREE.Quaternion();
  function moveDoors(thing, dt) {
    for (const entry of thing.doors) {
      if (Math.abs(entry.want - entry.open) < 0.001) continue;
      entry.open = THREE.MathUtils.clamp(entry.open + Math.sign(entry.want - entry.open) * dt * 3.2, 0, 1);
      const angle = THREE.MathUtils.smoothstep(entry.open, 0, 1) * THREE.MathUtils.degToRad(68) * entry.swing;
      entry.node.quaternion.copy(entry.closed).multiply(doorTurn.setFromAxisAngle(axisY, angle));
    }
  }
  // Pferd: eine Gangart abspielen (Schritt, Trab, Galopp, Aufsteigen)
  function horsePlay(thing, name, timeScale = 1, once = false) {
    const next = thing.actions[name];
    if (!next) return;
    const previous = thing.actions[thing.gait];
    if (thing.gait !== name || once) {
      next.reset().setEffectiveWeight(1).setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
      next.clampWhenFinished = once;
      next.play();
      if (previous && previous !== next) next.crossFadeFrom(previous, 0.3, false);
      thing.gait = name;
    }
    next.paused = timeScale === 0;
    next.timeScale = timeScale || 1;
  }
  driveButton?.addEventListener("click", leaveVehicle);

  // Eingaben: Tasten, Klick auf die Wiese (hinlaufen), Ziehen dreht die Kamera, Mausrad zoomt
  const keys = new Set();
  const typing = (event) => event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]");
  window.addEventListener("keydown", (event) => {
    if (typing(event) || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " ", "shift", "e", "delete", "backspace", "q", "r", "h", "b"].includes(key)) {
      if (key === " " || key.startsWith("arrow")) event.preventDefault();
      if (key === "b") { if (!event.repeat) setMode(mode === "build" ? "play" : "build"); return; }
      if (mode === "build") {
        // Bauen: nur drehen und löschen
        if ((key === "delete" || key === "backspace") && selected) removeThing(selected);
        if (key === "q" && selected) { selected.yaw += Math.PI / 8; settle(selected, 1); saveMap(); }
        if (key === "e" && selected) { selected.yaw -= Math.PI / 8; settle(selected, 1); saveMap(); }
        return;
      }
      if (!event.repeat) {
        if (key === "e") { if (driving) leaveVehicle(); else enterVehicle(nearestVehicle()); }
        if (key === "r") {
          // Autoradio ein und aus
          const wanted = radio.toggle();
          if (driving?.item.radio && driving.motor) { if (wanted) radio.start(); else radio.stop(); }
          say(wanted ? "Radio an" : "Radio aus", 2);
        }
        if (key === "h" && driving?.item.drive && !driving.item.fly) sound.play("hupe", 0.8);
        if (key === " " && !kim.busy) {
          if (!driving) { if (kim.ready && kim.jump <= 0) { kim.jump = 0.0001; kim.vy = 6.2; } }
          else if (driving.item.fly) {
            // Einmal drücken: auf Reiseflughöhe steigen. Noch einmal: wieder hinuntergleiten.
            driving.airborne = !driving.airborne;
            say(driving.airborne ? "Abheben" : "Landen", 2);
          } else if (driving.riding) {
            // Klaps: nächste Gangart
            driving.riding.gait = Math.min(3, Math.max(1, driving.riding.gait) + 1);
            driving.riding.held = driving.riding.gait === 2 ? 3.5 : 7.5;
            sound.play("klaps", 0.8);
          }
        }
        if ((key === "s" || key === "arrowdown") && driving?.riding) { driving.riding.gait = Math.max(0, driving.riding.gait - 1); driving.riding.held = 0; }
      }
      keys.add(key);
      hint?.classList.add("is-used");
    }
  });
  window.addEventListener("keyup", (event) => keys.delete(event.key.toLowerCase()));
  window.addEventListener("blur", () => keys.clear());
  // Maus fangen (Klick auf die Wiese): Mausbewegung dreht die Kamera, zu Fuß dreht sich Kim mit. Esc gibt die Maus frei.
  const look = { locked: false, last: -99 };
  document.addEventListener("pointerlockchange", () => {
    look.locked = document.pointerLockElement === canvas;
    stageEl.classList.toggle("is-locked", look.locked);
    if (look.locked) say("Maus gefangen: Esc gibt sie wieder frei.", 4);
  });
  document.addEventListener("mousemove", (event) => {
    if (!look.locked) return;
    orbit.yaw -= event.movementX * 0.0028;
    orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + event.movementY * 0.0022, 0.04, 1.25);
    look.last = clock.elapsedTime;
  });
  // Zwei Modi. Spielen: Maus gefangen, Kim steuern. Bauen (Taste B): Blick von oben, Dinge aus der Leiste aufstellen.
  let mode = "play";
  const build = { x: 0, z: 0, yaw: Math.PI, distance: 42 };
  const modeButtons = document.querySelectorAll("[data-mode]");
  function setMode(next) {
    if (next === mode) return;
    mode = next;
    stageEl.classList.toggle("is-build", mode === "build");
    for (const button of modeButtons) button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    keys.clear();
    if (mode === "build") {
      document.exitPointerLock?.();
      const lead = driving ? driving.group.position : kim.group.position;
      build.x = lead.x;
      build.z = lead.z;
      scene.fog.near = 500;
      scene.fog.far = 1200;
      say("Bauen: Dinge aus der Leiste auf die Wiese ziehen. Mit B geht es zurück ins Spiel.", 7);
    } else {
      select(null);
      scene.fog.near = 55;
      scene.fog.far = 150;
      say("Spielen: Klick auf die Wiese fängt die Maus, Esc gibt sie frei.", 6);
    }
    sound.hush(mode === "build");
  }
  for (const button of modeButtons) button.addEventListener("click", () => setMode(button.dataset.mode));

  // Start: schräg, halb von vorn
  const orbit = { yaw: Math.PI - 0.65, pitch: 0.24, distance: 8.5 };
  let drag = null;
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button > 2 || look.locked) return;
    // Dinge anfassen geht nur beim Bauen
    const thing = mode === "build" && event.button === 0 ? thingAt(event.clientX, event.clientY) : null;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: 0, thing, moving: false, turn: event.button !== 0 };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.moved < 8) return;
    if (drag.thing && drag.thing !== driving) {
      // Platziertes Ding verschieben
      const spot = groundAt(event.clientX, event.clientY);
      if (spot) { drag.moving = true; drag.thing.held = true; drag.thing.x = spot.x; drag.thing.z = spot.z; drag.thing.home.set(spot.x, spot.z); drag.thing.goal = null; settle(drag.thing, 1); select(drag.thing); }
      return;
    }
    if (mode === "build") {
      if (drag.turn) { build.yaw -= dx * 0.006; return; }
      // Karte verschieben: der Punkt unter dem Zeiger wandert mit
      const perPixel = (2 * build.distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, canvas.clientHeight);
      const rightX = -Math.cos(build.yaw);
      const rightZ = Math.sin(build.yaw);
      const aheadX = -Math.sin(build.yaw);
      const aheadZ = -Math.cos(build.yaw);
      build.x = THREE.MathUtils.clamp(build.x - (rightX * dx - aheadX * dy) * perPixel, -EDGE, EDGE);
      build.z = THREE.MathUtils.clamp(build.z - (rightZ * dx - aheadZ * dy) * perPixel, -EDGE, EDGE);
      return;
    }
    orbit.yaw -= dx * 0.006;
    orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + dy * 0.004, 0.04, 1.25);
    look.last = clock.elapsedTime;
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const mine = drag;
    drag = null;
    if (mine.thing) mine.thing.held = false;
    if (mine.moving) { saveMap(); return; }
    if (mine.moved >= 8 || event.type === "pointercancel") return;
    if (mode === "build") { select(mine.thing && mine.thing !== selected ? mine.thing : null); return; }
    // Spielen. Maus: Klick auf die Wiese fängt die Maus. Finger: dorthin laufen.
    if (event.pointerType === "mouse") { if (!mine.turn) canvas.requestPointerLock?.(); return; }
    const spot = groundAt(event.clientX, event.clientY);
    if (spot && !driving && kim.ready) { kim.target = spot.clone(); kim.run = false; hint?.classList.add("is-used"); }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const step = event.deltaY > 0 ? 1.1 : 0.9;
    if (mode === "build") build.distance = THREE.MathUtils.clamp(build.distance * step, 14, 110);
    else orbit.distance = THREE.MathUtils.clamp(orbit.distance * step, 4, 30);
  }, { passive: false });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  // Leiste auf- und zuklappen
  const paletteToggle = document.querySelector("[data-palette-toggle]");
  paletteToggle?.addEventListener("click", () => {
    const closed = paletteToggle.closest(".palette").classList.toggle("is-closed");
    paletteToggle.setAttribute("aria-expanded", String(!closed));
  });
  function resize() {
    const rect = stageEl.getBoundingClientRect();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  const forward = new THREE.Vector3();
  const focus = new THREE.Vector3(0, 1, 0);
  const cameraGoal = new THREE.Vector3();
  function moveKim(dt) {
    const position = kim.group.position;
    if (kim.busy) { position.y = height(position.x, position.z); return; }
    let moveX = 0;
    let moveZ = 0;
    const ahead = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
    const side = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
    let running = keys.has("shift");
    if (ahead || side) {
      // Richtung aus Sicht der Kamera
      const fx = -Math.sin(orbit.yaw);
      const fz = -Math.cos(orbit.yaw);
      moveX = fx * ahead - fz * side;
      moveZ = fz * ahead + fx * side;
      kim.target = null;
    } else if (kim.target) {
      moveX = kim.target.x - position.x;
      moveZ = kim.target.z - position.z;
      const left = Math.hypot(moveX, moveZ);
      running = kim.run || left > 9;
      if (left < 0.25) { kim.target = null; moveX = 0; moveZ = 0; }
    }
    const length = Math.hypot(moveX, moveZ);
    // Gefangene Maus: Kim schaut dorthin, wohin die Kamera schaut, und geht mit S rückwärts
    const backwards = look.locked && ahead < 0;
    const wanted = length > 0.001 ? (backwards ? 2 : running ? 6.4 : 2.5) : 0;
    kim.speed = damp(kim.speed, wanted, 9, dt);
    if (look.locked) kim.yaw = dampAngle(kim.yaw, orbit.yaw + Math.PI, 16, dt);
    if (length > 0.001) {
      if (!look.locked) kim.yaw = dampAngle(kim.yaw, Math.atan2(moveX, moveZ), 12, dt);
      position.x = THREE.MathUtils.clamp(position.x + (moveX / length) * kim.speed * dt, -EDGE, EDGE);
      position.z = THREE.MathUtils.clamp(position.z + (moveZ / length) * kim.speed * dt, -EDGE, EDGE);
    }
    // Um Bäume, Autos und Leute herum statt hindurch
    for (const thing of things) {
      if (thing.held || thing.lift > 1.2) continue;
      const reach = Math.min(thing.radius, thing.item.group === "Grün" && thing.item.h > 3 ? 0.45 : thing.radius) * 0.8 + 0.3;
      const dx = position.x - thing.x;
      const dz = position.z - thing.z;
      const distance = Math.hypot(dx, dz);
      if (distance < reach && distance > 0.0001) { position.x = thing.x + (dx / distance) * reach; position.z = thing.z + (dz / distance) * reach; }
    }
    const floor = height(position.x, position.z);
    if (kim.jump > 0) {
      kim.vy -= 16 * dt;
      kim.jump += kim.vy * dt;
      if (kim.jump <= 0) { kim.jump = 0; sound.play("landen", 0.5); }
    } else if (kim.speed > 0.6) {
      // Schritte im Gras
      kim.stepIn -= dt;
      if (kim.stepIn <= 0) {
        kim.stepIn = kim.speed > 4 ? 0.3 : 0.5;
        sound.play(`schritt_${1 + Math.floor(Math.random() * 4)}`, kim.speed > 4 ? 0.42 : 0.3, 0.92 + Math.random() * 0.16);
      }
    }
    position.y = floor + Math.max(0, kim.jump);
    kim.group.rotation.y = kim.yaw;
    if (kim.jump > 0) kimPlay("Jump", 0.15, 1.6);
    else if (kim.speed > 4) kimPlay("Run", 0.2, kim.speed / 5.2 / KIM_SCALE);
    else if (kim.speed > 0.4) kimPlay("Walk", 0.2, (backwards ? -1 : 1) * kim.speed / 1.9 / KIM_SCALE);
    else kimPlay("Idle", 0.3);
  }
  // Kleine Teilchen: Funken (Drohne), Blätter und Blüten (zerfetzte Pflanzen), Rauch (beschädigte Fahrzeuge)
  const bits = [];
  const flake = new THREE.PlaneGeometry(0.13, 0.08);
  const spark = new THREE.SphereGeometry(0.035, 5, 4);
  const cloudlet = new THREE.SphereGeometry(0.2, 8, 6);
  function bit(kind, at, color, vx, vy, vz, life) {
    const fog = kind !== "spark";
    const mesh = new THREE.Mesh(kind === "leaf" ? flake : kind === "spark" ? spark : cloudlet, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: kind === "smoke" ? 0.5 : 1, side: THREE.DoubleSide, depthWrite: false, fog }));
    mesh.position.copy(at);
    mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    mesh.userData = { kind, vx, vy, vz, life, age: 0, spin: (Math.random() - 0.5) * 12 };
    scene.add(mesh);
    bits.push(mesh);
  }
  function moveBits(dt) {
    for (let i = bits.length - 1; i >= 0; i -= 1) {
      const mesh = bits[i];
      const data = mesh.userData;
      data.age += dt;
      const k = data.age / data.life;
      if (k >= 1) { scene.remove(mesh); mesh.material.dispose(); bits.splice(i, 1); continue; }
      if (data.kind === "smoke") {
        mesh.scale.setScalar(1 + data.age * 2.2);
        mesh.material.opacity = 0.5 * (1 - k);
        data.vx *= 1 - dt;
        data.vz *= 1 - dt;
      } else {
        data.vy -= (data.kind === "spark" ? 7 : 5) * dt;
        mesh.rotation.x += data.spin * dt;
        mesh.rotation.z += data.spin * 0.7 * dt;
        mesh.material.opacity = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
      }
      mesh.position.x += data.vx * dt;
      mesh.position.y += data.vy * dt;
      mesh.position.z += data.vz * dt;
      const floor = height(mesh.position.x, mesh.position.z) + 0.03;
      if (data.kind === "leaf" && mesh.position.y < floor) { mesh.position.y = floor; data.vx = data.vz = data.vy = 0; data.spin = 0; }
    }
  }
  const burstAt = new THREE.Vector3();
  // Drohne geht kaputt: ein paar rötliche und orange Funken, kein Feuerball. Nach einer Weile startet der Pilot eine neue.
  function explode(drone) {
    drone.down = 14;
    drone.group.visible = false;
    for (let i = 0; i < 16; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 2.6;
      bit("spark", drone.group.position, ["#ff5a2a", "#ff8a1f", "#ffb347", "#e0331c"][i % 4], Math.cos(angle) * speed, 0.6 + Math.random() * 2.4, Math.sin(angle) * speed, 0.5 + Math.random() * 0.5);
    }
    bit("smoke", drone.group.position, "#5a5a5a", 0, 0.5, 0, 0.9);
    sound.play("knall", 0.4 * Math.max(0.4, loudness(drone.group.position, 6, 80)), 1.7);
    say("Drohne erwischt!", 3);
  }
  // Blume oder Busch zerfetzen: Blätter und Blüten fliegen, die Pflanze ist weg (im Baumodus neu setzen)
  const PETALS = { sonnenblume: ["#f2c230", "#e8a51d", "#4f8f3a"], mohn: ["#d6382c", "#e9574a", "#4f8f3a"], busch: ["#4f8f3a", "#6aa84a", "#3d7430"] };
  function shred(plant, pushX, pushZ) {
    const colors = PETALS[plant.id] || PETALS.busch;
    const count = plant.id === "busch" ? 26 : 14;
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.8 + Math.random() * 2.2;
      burstAt.set(plant.x + (Math.random() - 0.5) * plant.radius, height(plant.x, plant.z) + 0.2 + Math.random() * plant.item.h * 0.8, plant.z + (Math.random() - 0.5) * plant.radius);
      bit("leaf", burstAt, colors[i % colors.length], Math.cos(angle) * speed + pushX * 0.25, 1.6 + Math.random() * 2.6, Math.sin(angle) * speed + pushZ * 0.25, 1.6 + Math.random() * 1.2);
    }
    sound.play("rascheln", 0.7 * Math.max(0.3, loudness(plant.group.position, 5, 50)));
    removeThing(plant);
  }
  // Anstoßen: feste Dinge bremsen und beschädigen das Fahrzeug, Blumen und Büsche werden zerfetzt, Tiere springen weg
  function bump(thing) {
    if (thing.alt > 2.5) return;
    const fast = Math.abs(thing.speed);
    for (const other of [...things]) {
      if (other === thing || other.held || other.lift > 1.2 || other.owner === thing) continue;
      const soft = other.item.group === "Grün" && other.item.h < 2;
      const reach = (soft ? other.radius * 0.6 : other.item.group === "Grün" ? 0.5 : other.radius * 0.8) + thing.radius * 0.7;
      const dx = thing.x - other.x;
      const dz = thing.z - other.z;
      const distance = Math.hypot(dx, dz);
      if (distance >= reach || distance < 0.0001) continue;
      if (soft) {
        // Durchfahren oder tief durchfliegen
        if (fast > 1.5 && thing.alt < other.item.h + 0.2) shred(other, Math.sin(thing.yaw) * thing.speed, Math.cos(thing.yaw) * thing.speed);
        continue;
      }
      if (thing.alt > 1.2) continue;
      thing.x = other.x + (dx / distance) * reach;
      thing.z = other.z + (dz / distance) * reach;
      thing.speed *= 0.5;
      if (fast > 5) harm(thing, fast * 2.4);
      if (other.item.wander && other !== driving) { other.goal = new THREE.Vector2(other.x - dx * 3, other.z - dz * 3); other.wait = 0; other.scared = 2.5; }
    }
  }
  // Schaden: unter 45 % raucht das Fahrzeug, bei 0 ist es ein Wrack und fährt nicht mehr
  const hpBar = document.querySelector("[data-play-hp]");
  function harm(thing, amount) {
    if (!thing.item.drive || thing.wreck) return;
    thing.hp = Math.max(0, thing.hp - amount);
    sound.play("knall", Math.min(0.6, amount / 40) * Math.max(0.3, loudness(thing.group.position, 5, 60)), 1.5);
    if (thing.hp > 0) return;
    thing.wreck = true;
    thing.motor = false;
    thing.speed = 0;
    thing.airborne = false;
    if (thing === driving) { radio.stop(); say("Totalschaden! Steig aus (E). Im Baumodus (B) stellst du ein neues Fahrzeug auf.", 8); }
  }
  function smoke(thing, dt) {
    if (thing.hp >= 45) return;
    thing.puff = (thing.puff || 0) - dt;
    if (thing.puff > 0) return;
    thing.puff = thing.wreck ? 0.16 : 0.1 + thing.hp / 120;
    burstAt.set(0, thing.item.h * 0.75, thing.radius * 0.55).applyAxisAngle(up, thing.yaw).add(thing.group.position);
    bit("smoke", burstAt, thing.wreck ? "#1e1e1e" : "#8a8a8a", (Math.random() - 0.5) * 0.4, 1 + Math.random() * 0.6, (Math.random() - 0.5) * 0.4, thing.wreck ? 2.2 : 1.4);
  }
  function drive(thing, dt) {
    if (thing.riding) { ride(thing, dt); return; }
    const locked = Boolean(kim.busy) || thing.wreck;
    const gas = locked ? 0 : (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
    const steer = locked ? 0 : (keys.has("a") || keys.has("arrowleft") ? 1 : 0) - (keys.has("d") || keys.has("arrowright") ? 1 : 0);
    if (thing.item.fly) {
      // Leertaste schaltet um: auf Reiseflughöhe steigen oder wieder hinuntergleiten
      const goal = thing.airborne ? thing.item.fly.cruise : 0;
      thing.alt += THREE.MathUtils.clamp(goal - thing.alt, -3.4 * dt, 3.4 * dt);
      // In der Luft: Drohnen fliegen auf derselben Höhe und lassen sich rammen
      if (thing.alt > 1) {
        for (const other of things) {
          if (!other.item.orbit || other.down > 0) continue;
          if (Math.hypot(other.group.position.x - thing.group.position.x, other.group.position.y - (thing.group.position.y + 0.5), other.group.position.z - thing.group.position.z) < thing.radius * 0.8 + 0.9) {
            explode(other);
            thing.speed *= 0.6;
            harm(thing, 8);
          }
        }
      }
    }
    const top = thing.item.drive.speed * (keys.has("shift") ? 1.35 : 1);
    thing.speed = damp(thing.speed, gas > 0 ? top : gas < 0 ? -top * 0.45 : 0, gas ? 1.6 : 1.1, dt);
    const grip = THREE.MathUtils.clamp(Math.abs(thing.speed) / 4, 0, 1) * Math.sign(thing.speed || 1);
    thing.yaw += steer * thing.item.drive.turn * grip * dt;
    const nx = thing.x + Math.sin(thing.yaw) * thing.speed * dt;
    const nz = thing.z + Math.cos(thing.yaw) * thing.speed * dt;
    if (Math.abs(nx) > EDGE || Math.abs(nz) > EDGE) thing.speed *= -0.3;
    thing.x = THREE.MathUtils.clamp(nx, -EDGE, EDGE);
    thing.z = THREE.MathUtils.clamp(nz, -EDGE, EDGE);
    bump(thing);
    settle(thing, 1 - Math.exp(-8 * dt));
    kim.yaw = thing.yaw;
  }
  // Reiten: W im Schritt, wer W hält, wird schneller (Trab, Galopp); Leertaste = Klaps, S nimmt eine Gangart zurück
  const GAIT_SPEED = [0, 1.9, 4.8, 10.5];
  function ride(thing, dt) {
    const state = thing.riding;
    const locked = Boolean(kim.busy);
    const go = !locked && (keys.has("w") || keys.has("arrowup"));
    const steer = locked ? 0 : (keys.has("a") || keys.has("arrowleft") ? 1 : 0) - (keys.has("d") || keys.has("arrowright") ? 1 : 0);
    if (go) {
      state.held += dt;
      if (state.gait === 0) state.gait = 1;
      if (state.gait === 1 && state.held > 3.5) state.gait = 2;
      if (state.gait === 2 && state.held > 7.5) state.gait = 3;
    }
    thing.speed = damp(thing.speed, go ? GAIT_SPEED[state.gait] : 0, go ? 1.3 : 1.7, dt);
    if (!go && thing.speed < 0.3) { state.gait = 0; state.held = 0; }
    thing.yaw += steer * thing.item.ride.turn * THREE.MathUtils.clamp(thing.speed / 2, 0.25, 1) * dt;
    thing.x = THREE.MathUtils.clamp(thing.x + Math.sin(thing.yaw) * thing.speed * dt, -EDGE, EDGE);
    thing.z = THREE.MathUtils.clamp(thing.z + Math.cos(thing.yaw) * thing.speed * dt, -EDGE, EDGE);
    bump(thing);
    // Gangart nach tatsächlichem Tempo: beim Abbremsen fällt das Pferd sichtbar in die langsamere
    if (!locked) {
      if (thing.speed < 0.15) { horsePlay(thing, "Schritt", 0); state.clip = ""; }
      else if (thing.speed < 3.2) { horsePlay(thing, "Schritt", thing.speed / 1.7); state.clip = "schritt"; }
      else if (thing.speed < 7.6) { horsePlay(thing, "Trab", thing.speed / 4.6); state.clip = "trab"; }
      else { horsePlay(thing, "Galopp", thing.speed / 10); state.clip = "galopp"; }
    }
    settle(thing, 1 - Math.exp(-6 * dt));
    kim.yaw = thing.yaw;
  }
  // Kim erwischt: er fällt um, bleibt kurz liegen und steht wieder auf
  function catchKim() {
    kim.target = null;
    kim.speed = 0;
    sound.play("polizei_festnahme", 1);
    say("Erwischt! Der Polizist hat dich.", 6);
    const fall = kimOnce("FallBackward", 1.7);
    if (fall) kim.busy = { left: fall + 0.8, then: () => { kim.busy = { left: kimOnce("FallBackward", -2), then: () => { kim.current = ""; kimPlay("Idle", 0.3); } }; } };
  }
  // Polizist: läuft Kim hinterher und wirft ihn um, wenn er ihn erwischt.
  // Mit Streifenwagen (owner): gibt auf, wenn Kim zu weit weg ist, läuft zum Wagen zurück und steigt ein.
  function chase(thing, dt) {
    thing.cool = Math.max(0, thing.cool - dt);
    const car = thing.owner;
    const lead = driving ? driving.group.position : kim.group.position;
    let dx = lead.x - thing.x;
    let dz = lead.z - thing.z;
    let distance = Math.hypot(dx, dz);
    if (car) {
      thing.out = (thing.out || 0) + dt;
      if (!thing.back && (thing.cool > 0 || distance > 34 || thing.out > 40 || (driving && Math.abs(driving.speed) > 4))) thing.back = true;
      if (thing.back) {
        // Zurück zur Fahrertür
        const door = doorOf(car);
        dx = door.x - thing.x;
        dz = door.z - thing.z;
        distance = Math.hypot(dx, dz);
        if (distance < 0.7) {
          sound.play("tuer", 0.7 * loudness(car.group.position, 5, 60));
          swingDoor(car, true);
          car.doorIn = 0.5;
          car.state = "patrol";
          car.cool = thing.caught ? 25 : 3;
          removeThing(thing);
          return;
        }
        thing.yaw = dampAngle(thing.yaw, Math.atan2(dx, dz), 7, dt);
        thing.x += Math.sin(thing.yaw) * 4.6 * dt;
        thing.z += Math.cos(thing.yaw) * 4.6 * dt;
        npcPlay(thing, thing.actions.Run ? "Run" : "Walk", 0.9);
        settle(thing, 1);
        return;
      }
    }
    const reach = driving ? driving.radius + 0.9 : 0.9;
    const hunting = thing.cool <= 0 && !kim.busy && distance < 45 && distance > reach && !(driving && driving.alt > 3);
    if (hunting) {
      if (!thing.called) { thing.called = true; sound.play("polizei_anhalten", loudness(thing.group.position, 6, 50)); }
      const speed = distance > 5 ? 5.3 : 3.6;
      thing.yaw = dampAngle(thing.yaw, Math.atan2(dx, dz), 7, dt);
      thing.x = THREE.MathUtils.clamp(thing.x + Math.sin(thing.yaw) * speed * dt, -EDGE, EDGE);
      thing.z = THREE.MathUtils.clamp(thing.z + Math.cos(thing.yaw) * speed * dt, -EDGE, EDGE);
      thing.home.set(thing.x, thing.z);
      npcPlay(thing, thing.actions.Run ? "Run" : "Walk", speed / 5.2);
    } else {
      npcPlay(thing, thing.cool > 0 && thing.cool < 5 ? "Look" : "Idle");
      if (thing.cool <= 0 && !kim.busy && !driving && distance <= reach && kim.jump <= 0) {
        thing.cool = 12;
        thing.called = false;
        thing.caught = true;
        catchKim();
      }
    }
    settle(thing, 1);
  }
  // Fahrertür des Streifenwagens in der Welt (Ausstiegspunkt aus dem Modell, sonst links neben dem Wagen)
  const doorSpot = new THREE.Vector3();
  function doorOf(car) {
    if (car.exit) doorSpot.copy(car.exit); else doorSpot.set(car.radius + 0.6, 0, 0);
    doorSpot.y = 0;
    return doorSpot.applyAxisAngle(up, car.yaw).add(car.group.position);
  }
  // Streifenwagen: fährt Streife, verfolgt Kim mit Martinshorn und Blaulicht; steht er bei ihm, steigt ein Polizist aus.
  // Im geschlossenen Wagen ist die Besatzung unsichtbar, sie erscheint erst an der Tür.
  function patrol(thing, dt) {
    const rule = thing.item.patrol;
    thing.cool = Math.max(0, thing.cool - dt);
    const lead = driving ? driving.group.position : kim.group.position;
    const leadSpeed = driving ? Math.abs(driving.speed) : kim.speed;
    const leadAlt = driving ? driving.alt : 0;
    const toLead = Math.hypot(lead.x - thing.x, lead.z - thing.z);
    if (thing.state === "patrol" && thing.cool <= 0 && kim.ready && !kim.busy && toLead < 42 && leadAlt < 5) { thing.state = "chase"; thing.lost = 0; }
    if (thing.state === "chase") {
      thing.lost = toLead > 75 || leadAlt > 6 ? thing.lost + dt : 0;
      if (thing.lost > 5) { thing.state = "patrol"; thing.cool = 6; }
      else if (toLead < thing.radius + (driving ? driving.radius : 0) + 3.4 && leadSpeed < 2.6 && Math.abs(thing.speed) < 2.5) {
        // Angekommen: Motor aus, Martinshorn aus, Blaulicht bleibt; ein Polizist steigt aus
        thing.state = "halt";
        thing.speed = 0;
        const door = doorOf(thing);
        const pending = thing;
        addThing("polizist", door.x, door.z, thing.yaw, { save: false }).then((officer) => {
          if (!officer) { pending.state = "patrol"; return; }
          if (things.indexOf(pending) < 0 || pending.state !== "halt") { removeThing(officer); return; }
          officer.temp = true;
          officer.owner = pending;
          officer.wait = 0;
          pending.officer = officer;
          swingDoor(pending, true);
          pending.doorIn = 1.6;
          sound.play("tuer", 0.8 * loudness(pending.group.position, 5, 60));
        });
      }
    }
    if (thing.doorIn > 0) { thing.doorIn -= dt; if (thing.doorIn <= 0) swingDoor(thing, false); }
    if (thing.state === "halt") {
      thing.speed = damp(thing.speed, 0, 6, dt);
    } else {
      let goalX;
      let goalZ;
      let wanted;
      if (thing.state === "chase") {
        goalX = lead.x;
        goalZ = lead.z;
        // Höchstens etwas schneller als Kim, und mit Bremsweg heran
        wanted = Math.min(THREE.MathUtils.clamp(leadSpeed + 2.6, 7, rule.chase), Math.max(0, (toLead - thing.radius - (driving ? driving.radius : 0) - 2.4) * 1.3));
      } else {
        if (!thing.goal || Math.hypot(thing.goal.x - thing.x, thing.goal.y - thing.z) < 3) {
          const angle = Math.random() * Math.PI * 2;
          const reach = 12 + Math.random() * 26;
          thing.goal = new THREE.Vector2(THREE.MathUtils.clamp(thing.home.x + Math.cos(angle) * reach, -EDGE + 4, EDGE - 4), THREE.MathUtils.clamp(thing.home.y + Math.sin(angle) * reach, -EDGE + 4, EDGE - 4));
        }
        goalX = thing.goal.x;
        goalZ = thing.goal.y;
        wanted = rule.speed;
      }
      const heading = Math.atan2(goalX - thing.x, goalZ - thing.z);
      const off = Math.atan2(Math.sin(heading - thing.yaw), Math.cos(heading - thing.yaw));
      // Vor engen Kurven vom Gas
      if (Math.abs(off) > 1.1) wanted = Math.min(wanted, 4);
      thing.speed = damp(thing.speed, wanted, 1.4, dt);
      thing.yaw += THREE.MathUtils.clamp(off, -1, 1) * rule.turn * THREE.MathUtils.clamp(thing.speed / 3, 0.2, 1) * dt;
      thing.x = THREE.MathUtils.clamp(thing.x + Math.sin(thing.yaw) * thing.speed * dt, -EDGE, EDGE);
      thing.z = THREE.MathUtils.clamp(thing.z + Math.cos(thing.yaw) * thing.speed * dt, -EDGE, EDGE);
      bump(thing);
      // Rammt die Streife Kims Fahrzeug, bremst es beide
      if (driving && driving.alt < 1.5) {
        const dx = driving.x - thing.x;
        const dz = driving.z - thing.z;
        const distance = Math.hypot(dx, dz);
        const reach = (driving.radius + thing.radius) * 0.75;
        if (distance < reach && distance > 0.001) { driving.x += (dx / distance) * (reach - distance); driving.z += (dz / distance) * (reach - distance); if (Math.abs(thing.speed) > 4) harm(driving, 6); driving.speed *= 0.6; thing.speed *= 0.5; }
      }
    }
    settle(thing, 1 - Math.exp(-8 * dt));
    // Blaulicht: links und rechts im Wechsel, sobald die Streife im Einsatz ist
    const alarm = thing.state !== "patrol";
    const flash = Math.sin(clock.elapsedTime * 16) > 0;
    thing.lights.forEach((material, index) => {
      const lit = alarm && (index % 2 === 0 ? flash : !flash);
      material.emissive.set(lit ? "#2f6bff" : "#000000");
      material.emissiveIntensity = lit ? 3 : 0;
    });
    const near = loudness(thing.group.position, 9, 110);
    sound.loop(`horn${thing.key}`, "martinshorn", thing.state === "chase" ? 0.34 * near : 0);
    sound.loop(`motor${thing.key}`, "v8_fahrt", thing.state === "halt" ? 0 : 0.2 * near * (0.4 + Math.abs(thing.speed) / rule.chase), 0.7 + Math.abs(thing.speed) / rule.chase * 0.6);
  }
  // Hubschrauber ohne Pilot: hebt ab und kreist über Kim
  function follow(thing, dt) {
    thing.wait -= dt;
    if (thing.wait > 0) return;
    thing.alt = damp(thing.alt, thing.item.fly.cruise, 0.6, dt);
    if (thing.alt < 4) { settle(thing, 1); return; }
    const lead = driving ? driving.group.position : kim.group.position;
    thing.phase += dt * 0.3;
    const gx = lead.x + Math.cos(thing.phase) * 12;
    const gz = lead.z + Math.sin(thing.phase) * 12;
    const dx = gx - thing.x;
    const dz = gz - thing.z;
    const distance = Math.hypot(dx, dz);
    const speed = Math.min(11, distance * 1.2);
    if (distance > 0.05) {
      thing.yaw = dampAngle(thing.yaw, Math.atan2(dx, dz), 2.5, dt);
      thing.x = THREE.MathUtils.clamp(thing.x + (dx / distance) * speed * dt, -EDGE, EDGE);
      thing.z = THREE.MathUtils.clamp(thing.z + (dz / distance) * speed * dt, -EDGE, EDGE);
    }
    settle(thing, 1);
  }
  function wander(thing, dt) {
    const rule = thing.item.wander;
    thing.scared = Math.max(0, (thing.scared || 0) - dt);
    if (!thing.goal) {
      thing.wait -= dt;
      if (thing.wait <= 0) {
        const angle = Math.random() * Math.PI * 2;
        const reach = 3 + Math.random() * 7;
        thing.goal = new THREE.Vector2(THREE.MathUtils.clamp(thing.home.x + Math.cos(angle) * reach, -EDGE, EDGE), THREE.MathUtils.clamp(thing.home.y + Math.sin(angle) * reach, -EDGE, EDGE));
      }
    }
    const walk = thing.actions[rule.walk];
    const idle = thing.actions[rule.idle];
    let moving = false;
    if (thing.goal) {
      const dx = thing.goal.x - thing.x;
      const dz = thing.goal.y - thing.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.3) { thing.goal = null; thing.wait = 2 + Math.random() * 6; }
      else {
        moving = true;
        const speed = rule.speed * (thing.scared ? 2.6 : 1);
        thing.yaw = dampAngle(thing.yaw, Math.atan2(dx, dz), 4, dt);
        thing.x = THREE.MathUtils.clamp(thing.x + Math.sin(thing.yaw) * speed * dt, -EDGE, EDGE);
        thing.z = THREE.MathUtils.clamp(thing.z + Math.cos(thing.yaw) * speed * dt, -EDGE, EDGE);
        if (walk) walk.timeScale = thing.scared ? 2.2 : 1;
      }
    }
    if (walk && thing.moving !== moving) {
      thing.moving = moving;
      if (moving) { walk.reset().setEffectiveWeight(1).play(); if (idle) walk.crossFadeFrom(idle, 0.3, false); }
      else if (idle) { idle.reset().setEffectiveWeight(1).play(); idle.crossFadeFrom(walk, 0.3, false); }
      else walk.paused = true;
    }
    if (walk && moving) walk.paused = false;
    settle(thing, 1 - Math.exp(-6 * dt));
  }

  const seatUp = new THREE.Vector3();
  const seatFloor = new THREE.Vector3();
  function simulate(dt) {
    if (kim.ready) {
      if (kim.busy) {
        kim.busy.left -= dt;
        if (kim.busy.left <= 0) { const then = kim.busy.then; kim.busy = null; then(); }
      }
      if (driving) drive(driving, dt); else moveKim(dt);
      kim.mixer.update(dt);
      if (kim.climb) {
        // Stufen: drei Tritte zwischen Boden und Sitzhöhe
        const climb = kim.climb;
        climb.t += dt;
        const k = THREE.MathUtils.clamp((climb.t - (climb.delay || 0)) / climb.time, 0, 1);
        const steps = Math.abs(climb.seat - climb.ground) > 0.3 ? 3 : 1;
        const stepped = (Math.floor(k * steps) + THREE.MathUtils.smoothstep((k * steps) % 1, 0.15, 0.7)) / steps;
        const done = k >= 1 ? 1 : stepped;
        kim.group.position.y = climb.up ? THREE.MathUtils.lerp(climb.ground, climb.seat, done) : THREE.MathUtils.lerp(climb.seat, climb.ground, done);
      }
      // Sitz- und Reithaltung der Beine
      if (kim.pose && driving) poseLegs(kim.pose);
      // Schnittebene knapp über dem Fahrzeugboden: nichts von Kim schaut unten heraus
      if (driving && !driving.item.ride && kim.group.parent !== scene) {
        driving.tilt.updateWorldMatrix(true, false);
        seatUp.set(0, 1, 0).transformDirection(driving.tilt.matrixWorld);
        seatFloor.set(0, driving.item.hover ? 0.1 : 0.03, 0).applyMatrix4(driving.tilt.matrixWorld);
        floorClip.setFromNormalAndCoplanarPoint(seatUp, seatFloor);
      }
    }
    for (const thing of things) {
      if (thing.doors.length) moveDoors(thing, dt);
      const flying = thing.lift > 0.3 || thing === driving;
      // Rotoren drehen, sobald etwas fliegt oder der Motor läuft
      if (thing.rotors.length && (flying || thing.item.orbit) && thing.down <= 0) {
        for (const [node, axis] of thing.rotors) node.rotation[axis] += dt * 28;
      }
      if (thing.item.engine === "rotor") sound.loop(`rotor${thing.key}`, "rotor", flying ? (thing === driving ? 0.42 : 0.5 * loudness(thing.group.position, 12, 120)) : 0);
      if (thing.held || thing === driving) { thing.mixer?.update(dt); continue; }
      if (thing.item.npc) {
        setupNpc(thing);
        if (thing.mixer) {
          if (thing.item.npc.chase && !reduceMotion) chase(thing, dt);
          else { thing.wait -= dt; if (thing.wait <= 0) { thing.wait = 6 + Math.random() * 6; npcPlay(thing, thing.pose === "Idle" ? "Look" : "Idle"); } }
        }
      } else if (thing.item.patrol && !reduceMotion) patrol(thing, dt);
      else if (thing.item.follow && !reduceMotion) follow(thing, dt);
      else if (thing.item.fly && (thing.alt > 0 || thing.airborne)) {
        // Verlassener Flieger gleitet von selbst hinunter
        thing.airborne = false;
        thing.alt = Math.max(0, thing.alt - 3.2 * dt);
        settle(thing, 1);
      } else if (thing.item.orbit) {
        if (thing.down > 0) {
          // Abgeschossen: nach einer Weile startet der Pilot eine neue Drohne
          thing.down -= dt;
          if (thing.down <= 0) { thing.group.visible = true; thing.float = 0.05; }
        } else if (!reduceMotion) {
          // Ruhige Acht um den Piloten (das nächste Kind mit Fernsteuerung), auf Höhe der fliegenden Autos
          let cx = thing.home.x;
          let cz = thing.home.y;
          let best = 30;
          for (const other of things) {
            if (other.id !== "kind") continue;
            const away = Math.hypot(other.x - thing.home.x, other.z - thing.home.y);
            if (away < best) { best = away; cx = other.x; cz = other.z; }
          }
          thing.float = damp(thing.float, 1, 0.7, dt);
          thing.phase += dt * 0.35;
          thing.x = THREE.MathUtils.clamp(cx + Math.sin(thing.phase) * 7, -EDGE, EDGE);
          thing.z = THREE.MathUtils.clamp(cz + Math.sin(thing.phase * 2) * 3.5, -EDGE, EDGE);
          thing.yaw = Math.atan2(Math.cos(thing.phase) * 7, Math.cos(thing.phase * 2) * 7);
        }
        settle(thing, 1);
      }
      else if (thing.item.wander && !reduceMotion) wander(thing, dt);
      else if (thing.item.hover) settle(thing, 1);
      thing.mixer?.update(dt);
    }
    moveBits(dt);
    for (const thing of things) if (thing.item.drive && thing.hp < 45) smoke(thing, dt);
    if (hpBar) {
      const show = Boolean(driving && driving.item.drive);
      hpBar.hidden = !show;
      if (show) { hpBar.style.setProperty("--hp", `${Math.round(driving.hp)}%`); hpBar.classList.toggle("is-low", driving.hp < 45); }
    }
    // Motoren, Schweber, Fahrtwind, Hufe
    const ratio = driving && driving.item.drive ? Math.min(1.3, Math.abs(driving.speed) / driving.item.drive.speed) : 0;
    for (const engine of ["v8", "boxer"]) {
      const runs = driving?.motor && driving.item.engine === engine;
      sound.loop(`${engine}-stand`, `${engine}_leerlauf`, runs ? 0.3 * (1 - Math.min(1, ratio)) + 0.06 : 0, 0.9 + 0.3 * ratio);
      sound.loop(`${engine}-fahrt`, `${engine}_fahrt`, runs ? 0.46 * Math.min(1, ratio * 1.4) : 0, 0.72 + 0.6 * ratio);
    }
    const hums = driving?.motor && driving.item.engine === "summen";
    sound.loop("summen", "summen", hums ? 0.13 + 0.08 * ratio : 0, 0.8 + 0.45 * ratio + (driving ? driving.alt * 0.012 : 0));
    sound.loop("wind", "wind", driving?.motor && (hums || driving.item.engine === "rotor") ? 0.35 * ratio * (driving.alt > 1 ? 1 : 0.5) : 0, 0.8 + 0.4 * ratio);
    for (const gait of ["schritt", "trab", "galopp"]) sound.loop(`hufe-${gait}`, `hufe_${gait}`, driving?.riding?.clip === gait && !kim.busy ? 0.55 : 0);
  }
  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);
    sound.loop("atmo", "voegel", 0.3);
    if (mode === "build") {
      // Bauen: das Spiel steht still, nur aufgestellte Dinge werden gesetzt
      for (const thing of things) if (thing.held) settle(thing, 1);
    } else simulate(dt);
    if (selected) {
      const size = Math.max(0.6, selected.radius * 1.15);
      ring.scale.setScalar(size);
      ring.position.set(selected.x, height(selected.x, selected.z) + 0.06, selected.z);
    }
    const lead = driving ? driving.group.position : kim.group.position;
    if (mode === "build") {
      // Vogelperspektive: fast senkrecht von oben, verschieben mit Ziehen, Mausrad zoomt
      focus.set(damp(focus.x, build.x, 12, dt), damp(focus.y, height(build.x, build.z), 12, dt), damp(focus.z, build.z, 12, dt));
      const pitch = 1.32;
      cameraGoal.set(focus.x + Math.sin(build.yaw) * Math.cos(pitch) * build.distance, focus.y + Math.sin(pitch) * build.distance, focus.z + Math.cos(build.yaw) * Math.cos(pitch) * build.distance);
      camera.position.lerp(cameraGoal, 1 - Math.exp(-10 * dt));
    } else {
      // Kamera folgt Kim oder dem Fahrzeug. Im Fahrzeug schwenkt sie nach kurzer Zeit wieder hinter das Heck.
      if (driving && !drag && clock.elapsedTime - look.last > 2.5 && Math.abs(driving.speed) > 1.5) orbit.yaw = dampAngle(orbit.yaw, driving.yaw + Math.PI, 2.2, dt);
      focus.x = damp(focus.x, lead.x, 8, dt);
      focus.z = damp(focus.z, lead.z, 8, dt);
      focus.y = damp(focus.y, lead.y + (driving ? 1.3 : kim.height * 0.75), 6, dt);
      const distance = orbit.distance * (driving ? 1.25 : 1);
      cameraGoal.set(focus.x + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * distance, focus.y + Math.sin(orbit.pitch) * distance, focus.z + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * distance);
      cameraGoal.y = Math.max(cameraGoal.y, height(cameraGoal.x, cameraGoal.z) + 0.6);
      camera.position.lerp(cameraGoal, 1 - Math.exp(-14 * dt));
    }
    camera.lookAt(focus);
    sun.position.copy(focus).addScaledVector(SUN_DIR, 60);
    dome.position.set(camera.position.x, 0, camera.position.z);
    clouds.rotation.y += dt * 0.004;
    sun.target.position.copy(focus);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  stageEl.classList.add("is-live");
  // Für die Browser-Tests
  window.kbSpielwiese = { kim, things, orbit, build, look, radio, sound, addThing, enter: enterVehicle, leave: leaveVehicle, setMode, get mode() { return mode; }, get driving() { return driving; } };
  requestAnimationFrame(tick);
}
