// Spielwiese: kleine 3D-Wiese. Kim laufen lassen, Dinge aus der Leiste auf die Wiese ziehen, einsteigen und losfahren.
// Die Map wird nur im Browser gemerkt (localStorage "kb-spielwiese-v1"), Kims Aussehen kommt aus dem Charakter-Editor.
import * as THREE from "three";
import { GLTFLoader } from "./vendor/three/GLTFLoader.js";
import { MeshoptDecoder } from "./vendor/three/meshopt_decoder.module.js";

const ASSET_VERSION = "4";
const MAP_KEY = "kb-spielwiese-v1";
const LOOK_KEY = "kb-figur-v1";
const SIZE = 110; // Kantenlänge der Wiese in Metern
const EDGE = SIZE / 2 - 4;
const KIM_SCALE = 1.22;
const FLIGHT = 9; // Reiseflughöhe des E-Quester Flight; auf dieser Höhe fliegt auch die Drohne

// Dinge für die Leiste. h: Zielhöhe in Metern, yaw: Drehung, damit "vorn" nach +Z zeigt,
// drive: fahrbar, fly: hebt mit der Leertaste auf Reiseflughöhe ab und landet beim nächsten Druck, hover: schwebt so hoch,
// wander: läuft von selbst herum, ride: reitbar, patrol: Streifenwagen (fährt von selbst, verfolgt Kim),
// follow: fliegt Kim von selbst hinterher, npc: Mensch mit Bewegungen (chase: verfolgt Kim und schießt), radio: hat ein Autoradio,
// mob: Gegner (hp: Leben, hit: Schaden je Treffer, speed: Tempo). Keine Stufen, nur unterschiedlich stark.
// life: Leben von Leuten und Tieren. Jeder mit Leben hat eine Lebensanzeige und lässt sich angreifen:
// der Polizist wehrt sich, alle anderen rennen weg.
const CATALOG = [
  { id: "streife", name: "Polizeiauto", group: "Polizei", h: 1.26, hull: true, flip: true, patrol: { speed: 5, chase: 14, turn: 1.9 } },
  { id: "polizist", name: "Polizist", group: "Polizei", h: 2.08, armsDown: 72, npc: { chase: true }, life: 150 },
  { id: "hubschrauber", name: "Polizei-Hubschrauber", group: "Polizei", h: 2.9, drive: { speed: 17, turn: 1.7 }, fly: { cruise: 16 }, follow: true, engine: "rotor" },
  { id: "arian", name: "Arians Auto", group: "Fahrzeuge", h: 1.02, drive: { speed: 16, turn: 2.3 }, radio: true, engine: "boxer" },
  { id: "schweber", name: "E-Quester Flight", group: "Fahrzeuge", h: 0.85, hover: 0.45, drive: { speed: 19, turn: 2.4 }, fly: { cruise: FLIGHT }, radio: true, engine: "summen" },
  { id: "monstertruck", name: "Monstertruck", group: "Fahrzeuge", h: 1.8, drive: { speed: 13, turn: 1.8 }, radio: true, engine: "v8" },
  { id: "gokart", name: "Gokart", group: "Fahrzeuge", h: 0.68, drive: { speed: 17, turn: 2.8 }, radio: true, engine: "boxer" },
  { id: "pferd", name: "Pferd", group: "Tiere", h: 1.95, wander: { walk: "Schritt", speed: 1.3 }, ride: { seat: [0, 0.69, -0.08], turn: 2.1 }, life: 110 },
  { id: "fuchs", name: "Fuchs", group: "Tiere", h: 0.62, wander: { walk: "Walk", idle: "Idle", speed: 1.1 }, life: 30 },
  { id: "reh", name: "Reh", group: "Tiere", h: 1.5, wander: { walk: "Walk", idle: "Idle", speed: 1.2 }, life: 45 },
  { id: "mann", name: "Mann mit Fernsteuerung", group: "Leute", h: 2.02, armsDown: 58, npc: { keepArms: true, flee: true }, life: 60 },
  { id: "drohne", name: "Drohne", group: "Leute", h: 0.3, hover: FLIGHT + 0.5, orbit: true, hull: true },
  { id: "pilzling", name: "Pilzling", group: "Gegner", h: 0.95, hull: true, mob: { hp: 30, hit: 6, speed: 2.3 } },
  { id: "parkuhr", name: "Parkuhr-Wicht", group: "Gegner", h: 1.25, hull: true, mob: { hp: 45, hit: 8, speed: 2.9 } },
  { id: "kreisel", name: "Kreiselwicht", group: "Gegner", h: 1.25, hull: true, mob: { hp: 55, hit: 10, speed: 3.2 } },
  { id: "lolli", name: "Lolli", group: "Gegner", h: 1.55, hull: true, mob: { hp: 70, hit: 12, speed: 2.9 } },
  { id: "muelltonne", name: "Mülltonnen-Mimik", group: "Gegner", h: 1.5, hull: true, mob: { hp: 85, hit: 15, speed: 2.2 } },
  { id: "eiche", name: "Eiche", group: "Grün", h: 7.2, hull: true },
  { id: "birke", name: "Birke", group: "Grün", h: 6.3, hull: true },
  { id: "fichte", name: "Fichte", group: "Grün", h: 8, hull: true },
  { id: "busch", name: "Busch", group: "Grün", h: 0.9, hull: true },
  { id: "sonnenblume", name: "Sonnenblume", group: "Grün", h: 1.5, hull: true },
  { id: "mohn", name: "Klatschmohn", group: "Grün", h: 0.7, hull: true }
];
const byId = Object.fromEntries(CATALOG.map((item) => [item.id, item]));
const lifeOf = (item) => (item.mob ? item.mob.hp : item.life) || 0;
// Trennstellen für die schmale Leiste
const SOFT = { "Polizei-Hubschrauber": "Polizei-Hub\u00adschrauber", Monstertruck: "Monster\u00adtruck", Sonnenblume: "Sonnen\u00adblume", Klatschmohn: "Klatsch\u00admohn", "Mann mit Fernsteuerung": "Mann mit Fern\u00adsteuerung", Kreiselwicht: "Kreisel\u00adwicht", "Mülltonnen-Mimik": "Müll\u00adtonnen-Mimik" };

const stageEl = document.querySelector("[data-play]");
const canvas = stageEl?.querySelector("canvas");
const palette = document.querySelector("[data-palette]");
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
  renderer.toneMappingExposure = 1.04;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const HORIZON = new THREE.Color("#ecd6c6");
  scene.background = HORIZON;
  scene.fog = new THREE.Fog(HORIZON, 55, 150);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 600);
  // Licht: frühe Abendsonne, etwas tiefer und wärmer, kühles Himmelslicht in den Schatten
  scene.add(new THREE.HemisphereLight("#cdd3f0", "#8a9a58", 1.1));
  const sun = new THREE.DirectionalLight("#ffbf8c", 3.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -34;
  sun.shadow.camera.right = sun.shadow.camera.top = 34;
  sun.shadow.camera.far = 140;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  sun.shadow.radius = 5;
  scene.add(sun, sun.target);
  // Himmel: Verlauf vom hellen Horizont ins Blau, mit einem warmen Schein um die Sonne
  const SUN_DIR = new THREE.Vector3(0.58, 0.33, 0.46).normalize();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(420, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: new THREE.Color("#3a79c4") }, mid: { value: new THREE.Color("#9dbde0") }, low: { value: HORIZON }, sunDir: { value: SUN_DIR }, glow: { value: new THREE.Color("#ffc890") } },
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
        color += vec3(0.22, 0.07, 0.02) * pow(s, 2.5) * (1.0 - smoothstep(0.0, 0.34, h));
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  }));
  dome.renderOrder = -10;
  scene.add(dome);
  // Umgebungslicht aus dem Himmel selbst: Lack und Metall spiegeln Himmel und Wiese, Schatten werden weicher gefüllt
  {
    const around = new THREE.Scene();
    around.add(new THREE.Mesh(dome.geometry, dome.material));
    const floor = new THREE.Mesh(new THREE.CircleGeometry(400, 24), new THREE.MeshBasicMaterial({ color: "#5d8f3f" }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2;
    around.add(floor);
    const maker = new THREE.PMREMGenerator(renderer);
    scene.environment = maker.fromScene(around, 0.03, 1, 900).texture;
    scene.environmentIntensity = 0.62;
    maker.dispose();
    floor.geometry.dispose();
  }
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

  // Wind: Gras, Blumen, Büsche und Bäume wiegen sich. Je höher über dem Fuß der Pflanze, desto weiter der Ausschlag.
  const wind = { value: 0 };
  function sway(material, strength) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.windTime = wind;
      shader.vertexShader = `uniform float windTime;\n${shader.vertexShader}`.replace("#include <project_vertex>", `
        vec4 mvPosition = vec4(transformed, 1.0);
        mat4 windModel = modelMatrix;
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          windModel = modelMatrix * instanceMatrix;
        #endif
        vec4 windPos = modelMatrix * mvPosition;
        float windH = max(0.0, windPos.y - windModel[3].y);
        float windPhase = windModel[3].x * 0.35 + windModel[3].z * 0.27;
        float windAmp = ${strength.toFixed(3)} * windH / (1.0 + 0.08 * windH);
        windPos.x += (sin(windTime * 1.3 + windPhase) + 0.45 * sin(windTime * 2.9 + windPhase * 1.7 + windPos.y * 0.8)) * windAmp;
        windPos.z += cos(windTime * 1.1 + windPhase * 1.3) * windAmp * 0.6;
        mvPosition = viewMatrix * windPos;
        gl_Position = projectionMatrix * mvPosition;`);
    };
    material.customProgramCacheKey = () => `wind${strength}`;
    return material;
  }
  // Wiese: leicht wellig, an den Rändern etwas höher
  function height(x, z) {
    const waves = Math.sin(x * 0.085) * Math.cos(z * 0.07) * 1.1 + Math.sin(x * 0.19 + 1.7) * Math.sin(z * 0.16 + 0.6) * 0.5 + Math.sin((x + z) * 0.045 + 2.1) * 0.8;
    const rim = Math.max(0, Math.max(Math.abs(x), Math.abs(z)) - (SIZE / 2 - 9));
    // Um den Start herum eben, damit Kim nicht schief ankommt
    const flat = THREE.MathUtils.smoothstep(Math.hypot(x, z), 2, 9);
    // Abschluss: rund um die Wiese steigt ein Bergrand auf, mit Graten und Scharten statt einer glatten Wand
    const ridge = 0.78 + 0.22 * Math.sin(x * 0.17 + Math.sin(z * 0.11) * 2.2) * Math.cos(z * 0.15 + Math.sin(x * 0.09) * 2.2);
    const crags = THREE.MathUtils.smoothstep(rim, 5, 15) * (Math.sin(x * 0.83 + z * 0.37) * Math.sin(z * 0.79 - x * 0.31) * 1.7 + Math.sin(x * 0.31 - z * 0.27 + 1.3) * 2.4);
    return waves * flat + rim * rim * 0.085 * ridge + crags;
  }
  const normalAt = (x, z, target) => target.set(height(x - 0.4, z) - height(x + 0.4, z), 0.8, height(x, z - 0.4) - height(x, z + 0.4)).normalize();
  const groundGeometry = new THREE.PlaneGeometry(SIZE + 60, SIZE + 60, 150, 150);
  groundGeometry.rotateX(-Math.PI / 2);
  const groundPos = groundGeometry.attributes.position;
  const colors = new Float32Array(groundPos.count * 3);
  const low = new THREE.Color("#4f9a3f");
  const high = new THREE.Color("#84c055");
  const shade = new THREE.Color();
  const rockLow = new THREE.Color("#6f675c");
  const rockHigh = new THREE.Color("#b9ad9c");
  const stone = new THREE.Color();
  for (let i = 0; i < groundPos.count; i += 1) {
    const x = groundPos.getX(i);
    const z = groundPos.getZ(i);
    const y = height(x, z);
    groundPos.setY(i, y);
    const patch = 0.5 + 0.5 * Math.sin(x * 0.6 + Math.sin(z * 0.45) * 2) * Math.sin(z * 0.52);
    shade.copy(low).lerp(high, THREE.MathUtils.clamp(0.45 + Math.min(y, 3) * 0.22 + patch * 0.25, 0, 1));
    // Am Bergrand geht das Gras in Fels über, oben wird er heller
    const up = Math.max(0, Math.max(Math.abs(x), Math.abs(z)) - (SIZE / 2 - 9));
    if (up > 3) {
      const grain = 0.5 + 0.5 * Math.sin(x * 1.3 + z * 0.7) * Math.sin(z * 1.1 - x * 0.5);
      stone.copy(rockLow).lerp(rockHigh, THREE.MathUtils.clamp(y / 55 + grain * 0.35, 0, 1));
      shade.lerp(stone, THREE.MathUtils.smoothstep(up + grain * 2, 3, 10));
    }
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
  const tufts = new THREE.InstancedMesh(blade, sway(new THREE.MeshLambertMaterial({ color: "#ffffff" }), 0.3), 14000);
  const place = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let i = 0; i < tufts.count; i += 1) {
    const x = (Math.random() * 2 - 1) * (SIZE / 2 - 3);
    const z = (Math.random() * 2 - 1) * (SIZE / 2 - 3);
    place.position.set(x, height(x, z) - 0.03, z);
    place.rotation.set((Math.random() - 0.5) * 0.5, Math.random() * 6.28, (Math.random() - 0.5) * 0.5);
    place.scale.set(0.8 + Math.random() * 0.9, 0.6 + Math.random() * 1.1, 0.8 + Math.random() * 0.9);
    place.updateMatrix();
    tufts.setMatrixAt(i, place.matrix);
    tufts.setColorAt(i, tint.setHSL(0.27 + Math.random() * 0.05, 0.5 + Math.random() * 0.15, 0.36 + Math.random() * 0.12));
  }
  scene.add(tufts);

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
    const FILES = ["voegel", "v8_leerlauf", "v8_fahrt", "boxer_leerlauf", "boxer_fahrt", "wind", "start", "tuer", "hupe", "hufe_schritt", "hufe_trab", "hufe_galopp", "klaps", "schnauben", "schritt_1", "schritt_2", "schritt_3", "schritt_4", "landen", "polizei_anhalten", "polizei_hubschrauber"];
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
      // Schuss (wie im Spiel), Schwerthieb, Treffer, Gegner besiegt
      let crack = 0;
      make("schuss", 0.5, (t) => {
        const noise = Math.random() * 2 - 1;
        crack += (noise - crack) * 0.35;
        return (noise * 0.6 + crack * 0.8) * Math.exp(-t * 22) + Math.sin(tau * 95 * t) * Math.exp(-t * 14) * 0.5;
      });
      let air = 0;
      make("schwung", 0.3, (t) => {
        const noise = Math.random() * 2 - 1;
        air += (noise - air) * (0.08 + 0.5 * Math.sin(Math.PI * t / 0.3));
        return air * 0.9 * Math.sin(Math.PI * t / 0.3) ** 2;
      });
      let thud = 0;
      make("treffer", 0.22, (t) => {
        const noise = Math.random() * 2 - 1;
        thud += (noise - thud) * 0.25;
        return thud * 0.9 * Math.exp(-t * 30) + Math.sin(tau * (150 - 380 * t) * t) * Math.exp(-t * 16) * 0.8;
      });
      make("plopp", 0.2, (t) => Math.sin(tau * (420 - 1500 * t) * t) * Math.exp(-t * 14) * 0.7);
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
  const kim = { group: new THREE.Group(), mixer: null, actions: {}, clips: {}, rest: {}, materials: [], legs: [], current: "", yaw: 0, speed: 0, jump: 0, stepIn: 0, target: null, ready: false, height: 1.75, hip: 0.95, shin: 0.5, busy: null, pose: null, hp: 100, dead: false, safe: 0, hurtAt: -99 };
  const START = new THREE.Vector3(0, 0, 0);
  scene.add(kim.group);
  kim.group.rotation.order = "YXZ";
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
    prepareSword(gltf.scene);
    kim.mixer = new THREE.AnimationMixer(gltf.scene);
    for (const clip of gltf.animations) { kim.clips[clip.name.replace(/^[A-Za-z]+_/, "")] = clip; kim.actions[clip.name.replace(/^[A-Za-z]+_/, "")] = kim.mixer.clipAction(clip); }
    // Umfallen (kim-moves), Ein-/Aussteigen und Sitzen (kim-fahren), Schwert ziehen, wegstecken und zuschlagen (kim-schwert)
    for (const file of ["kim-moves.glb?v=1", "kim-fahren.glb?v=1", "kim-schwert.glb?v=1"]) {
      loader.loadAsync(`assets/figuren/${file}`).then((extra) => {
        for (const clip of extra.animations) {
          const name = clip.name.replace(/^[A-Za-z]+_/, "");
          kim.actions[name] = kim.mixer.clipAction(clip);
          // Aussteigen: Hüfthöhe am Anfang (sitzt) und am Ende (steht), um Kims Höhe an die Bewegung zu koppeln
          const hips = name === "ExitCar" && clip.tracks.find((track) => track.name === "Hips.position");
          if (hips) kim.rise = { bone: gltf.scene.getObjectByName("Hips"), sit: hips.values[1], stand: hips.values[hips.values.length - 2] };
        }
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

  // Schwert: hängt auf dem Rücken, zum Kämpfen kommt es in die rechte Hand.
  // Beide Halterungen werden in der Ruhepose (Arme waagerecht) ausgerichtet und hängen dann am Knochen.
  const sword = { mesh: null, hand: null, back: null, drawn: false, swing: null, moving: null, last: -99, combo: 0, rest: 0, queued: false };
  function prepareSword(figure) {
    figure.updateMatrixWorld(true);
    const at = (name) => figure.getObjectByName(name)?.getWorldPosition(new THREE.Vector3());
    const hand = figure.getObjectByName("RightHand");
    const chest = figure.getObjectByName("Spine");
    const handAt = at("RightHand");
    const elbowAt = at("RightForeArm");
    const shoulderAt = at("RightArm");
    const chestAt = at("Spine");
    if (!hand || !chest || !handAt || !elbowAt || !shoulderAt || !chestAt) return;
    const fore = handAt.distanceTo(elbowAt);
    const size = fore / 0.215;
    const holder = (bone, origin, blade, edge) => {
      const y = blade.clone().normalize();
      const z = new THREE.Vector3().crossVectors(edge, y).normalize();
      const x = new THREE.Vector3().crossVectors(y, z).normalize();
      const world = new THREE.Matrix4().makeBasis(x, y, z).scale(new THREE.Vector3(size, size, size)).setPosition(origin);
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      group.matrix.copy(bone.matrixWorld).invert().multiply(world);
      bone.add(group);
      return group;
    };
    // Hand: Klinge quer zum Arm nach vorn (Faustgriff), Schneide in Armrichtung
    const arm = handAt.clone().sub(elbowAt).normalize();
    const blade = new THREE.Vector3().crossVectors(axisY, arm);
    if (blade.lengthSq() < 0.05) blade.set(0, 0, 1);
    blade.normalize();
    const fist = handAt.clone().addScaledVector(arm, fore * 0.4).addScaledVector(axisY, -fore * 0.05).addScaledVector(blade, 0.11 * size);
    sword.hand = holder(hand, fist, blade, arm);
    // Rücken: Griff über der rechten Schulter, Klinge schräg zur anderen Hüfte, flach am Rücken
    const side = Math.sign(shoulderAt.x - chestAt.x) || -1;
    const down = new THREE.Vector3(-side * 0.5, -1, 0).normalize();
    const origin = new THREE.Vector3(THREE.MathUtils.lerp(chestAt.x, shoulderAt.x, 0.85), shoulderAt.y + fore * 0.3, chestAt.z - fore * 0.62);
    sword.back = holder(chest, origin, down, new THREE.Vector3().crossVectors(down, new THREE.Vector3(0, 0, 1)));
    loader.loadAsync(`assets/spielwiese/schwert.glb?v=${ASSET_VERSION}`).then((model) => {
      model.scene.traverse((object) => {
        if (!object.isMesh) return;
        object.castShadow = true;
        if (object.material.name.startsWith("Outline")) object.material.side = THREE.FrontSide;
      });
      sword.mesh = model.scene;
      sword.back.add(sword.mesh);
    }).catch(() => { /* ohne Schwert: kein Kampf */ });
  }

  // Beinhaltung nach der Bewegung überschreiben. down: Oberschenkel nach unten, spread: nach außen, shin: Unterschenkel nach vorn (negativ)
  const legWorld = new THREE.Quaternion();
  const legParent = new THREE.Quaternion();
  const legTurn = new THREE.Quaternion();
  const legPitch = new THREE.Quaternion();
  const legYaw = new THREE.Quaternion();
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisY = new THREE.Vector3(0, 1, 0);
  const legLocal = new THREE.Quaternion();
  const legBody = new THREE.Quaternion();
  function turnBone(bone, local) {
    // Die Bewegung schreibt einen Knochen nur neu, wenn sich sein Wert ändert. Steht hier noch unser Ergebnis vom
    // letzten Bild, zuerst den Wert der Bewegung zurückholen, sonst dreht sich das Bein jedes Bild weiter.
    const memo = bone.userData.pose || (bone.userData.pose = { base: new THREE.Quaternion(), last: new THREE.Quaternion(), set: false });
    if (memo.set && bone.quaternion.equals(memo.last)) bone.quaternion.copy(memo.base); else memo.base.copy(bone.quaternion);
    // Drehung "local" in Kims Körperachsen auf den Knochen anwenden
    kim.group.getWorldQuaternion(legWorld);
    legBody.copy(legWorld).multiply(local).multiply(legWorld.invert());
    bone.parent.getWorldQuaternion(legParent);
    bone.quaternion.premultiply(legWorld.copy(legParent).invert().multiply(legBody).multiply(legParent));
    bone.updateMatrixWorld(true);
    memo.last.copy(bone.quaternion);
    memo.set = true;
  }
  function poseLegs({ down = 0, spread = 0, shin = 0 }) {
    for (const leg of kim.legs) {
      legYaw.setFromAxisAngle(axisY, leg.out * spread);
      turnBone(leg.thigh, legLocal.copy(legYaw).multiply(legPitch.setFromAxisAngle(axisX, down)));
      turnBone(leg.shin, legLocal.copy(legYaw).multiply(legPitch.setFromAxisAngle(axisX, shin - down)).multiply(legTurn.copy(legYaw).invert()));
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
    thing.arm = ["RightArm", "RightForeArm", "RightHand"].map((name) => thing.inner.getObjectByName(name));
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
        // Pflanzen wiegen sich im Wind (Blumen und Büsche stärker als Bäume)
        if (item.group === "Grün") gltf.scene.traverse((object) => { if (object.isMesh && !object.material.userData.wind) { object.material.userData.wind = true; sway(object.material, item.h < 2 ? 0.05 : 0.026); } });
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
  async function addThing(id, x, z, yaw = 0, { save = true, temp = false } = {}) {
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
    const thing = { key: nextKey, id, item, group, tilt, inner, rest: model.rest, seat: model.seat, exit: model.exit, rotors, lights, doors, hp: lifeOf(item) || 100, temp, wreck: false, alt: 0, float: 1, down: 0, cool: 0, state: "patrol", lost: 0, airborne: false, x, z, yaw, radius: model.radius, speed: 0, home: new THREE.Vector2(x, z), phase: Math.random() * 6.28, mixer: null, actions: {}, wait: 1 + Math.random() * 3, goal: null };
    nextKey += 1;
    group.userData.thing = thing;
    if (item.orbit) thing.float = 0.05;
    if (model.gltf.animations.length && item.wander) {
      thing.mixer = new THREE.AnimationMixer(inner);
      for (const clip of model.gltf.animations) thing.actions[clip.name.split("|").pop().replace(/^\d+_/, "")] = thing.mixer.clipAction(clip);
      const idle = thing.actions[item.wander.idle];
      if (idle) idle.play();
    }
    if (item.mob) {
      // Gegner: eigene Bewegungen (Idle, Walk, Run, Attack, Hit, Death) und eine Lebensanzeige über dem Kopf
      thing.mixer = new THREE.AnimationMixer(inner);
      for (const clip of model.gltf.animations) thing.actions[(clip.name.split("|")[1] || clip.name).replace("HitReact", "Hit")] = thing.mixer.clipAction(clip);
      thing.pose = "";
      thing.grow = 1;
      thing.calm = 0;
      thing.stun = 0;
      thing.pushX = 0;
      thing.pushZ = 0;
      lifeBar(thing);
      mobPlay(thing, "Idle");
    } else if (item.life) lifeBar(thing);
    scene.add(group);
    things.push(thing);
    settle(thing, 1);
    if (save) saveMap();
    return thing;
  }
  function removeThing(thing) {
    if (driving === thing) { thing.alt = 0; kim.busy = null; kim.climb = null; kim.pose = null; clipKim(false); radio.stop(false); if (kim.group.parent !== scene) { scene.add(kim.group); kim.group.scale.x = 1; kim.group.position.set(thing.x, 0, thing.z); kim.group.rotation.set(0, thing.yaw, 0); } kim.group.visible = true; if (sword.mesh) sword.mesh.visible = true; kim.current = ""; driving = null; if (driveButton) driveButton.hidden = true; say(""); }
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
    // ... und das Kind mit der Fernsteuerung: daraus wird der Mann
    for (const row of list) if (Array.isArray(row)) row[0] = { polizeiauto: "streife", kind: "mann" }[row[0]] || row[0];
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
      if ((!thing.item.drive && !thing.item.ride) || thing.dead) continue;
      const distance = Math.hypot(thing.x - kim.group.position.x, thing.z - kim.group.position.z) - thing.radius;
      if (distance < bestDistance) { best = thing; bestDistance = distance; }
    }
    return best;
  }
  function helpFor(thing) {
    if (thing.item.ride) return "W reiten, Leertaste gibt einen Klaps. H zeigt alle Tasten.";
    if (thing.item.fly) return "Leertaste hebt ab und landet. H zeigt alle Tasten.";
    return "W und S: Gas und Bremse. H zeigt alle Tasten.";
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
    if (!thing || !(thing.item.drive || thing.item.ride) || !kim.ready || driving || kim.busy || thing.dead || kim.dead) return;
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
    say(helpFor(thing), 5);
    stowSword();
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
    if (sword.mesh) sword.mesh.visible = false;
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
      if (sword.mesh) sword.mesh.visible = true;
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
    // H blendet die Steuerung ein und aus; solange sie offen ist, steht das Spiel
    if (key === "h") { if (!event.repeat) setHelp(!helpOpen); return; }
    if (helpOpen) { if (key === "escape") setHelp(false); return; }
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " ", "shift", "e", "delete", "backspace", "q", "r", "x", "b"].includes(key)) {
      if (key === " " || key.startsWith("arrow")) event.preventDefault();
      setTouch(false);
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
        if (key === "x") honk();
        if (key === "q" && !driving) setSword(!sword.drawn);
        if (key === " ") act();
        if ((key === "s" || key === "arrowdown") && driving?.riding) { driving.riding.gait = Math.max(0, driving.riding.gait - 1); driving.riding.held = 0; }
      }
      keys.add(key);
    }
  });
  function honk() { if (driving?.item.drive && !driving.item.fly) sound.play("hupe", 0.8); }
  // Leertaste (am Handy der Knopf unten rechts): springen, abheben und landen, dem Pferd einen Klaps geben
  function act() {
    if (kim.busy || !kim.ready) return;
    if (!driving) { if (kim.jump <= 0 && !sword.swing && !sword.moving) { kim.jump = 0.0001; kim.vy = 6.2; } }
    else if (driving.item.fly) {
      // Einmal drücken: auf Reiseflughöhe steigen. Noch einmal: wieder hinuntergleiten.
      driving.airborne = !driving.airborne;
      say(driving.airborne ? "Abheben" : "Landen", 2);
    } else if (driving.riding) {
      // Klaps: nächste Gangart
      driving.riding.gait = Math.min(3, Math.max(1, driving.riding.gait) + 1);
      driving.riding.held = driving.riding.gait === 2 ? 3.5 : 7.5;
      sound.play("klaps", 0.8);
    } else honk();
  }
  window.addEventListener("keyup", (event) => keys.delete(event.key.toLowerCase()));
  window.addEventListener("blur", () => keys.clear());
  // Maus fangen (Klick auf die Wiese): Mausbewegung dreht die Kamera, zu Fuß dreht sich Kim mit. Esc gibt die Maus frei.
  const look = { locked: false, last: -99 };
  document.addEventListener("pointerlockchange", () => {
    look.locked = document.pointerLockElement === canvas;
    stageEl.classList.toggle("is-locked", look.locked);
    if (look.locked) { setTouch(false); say("Maus gefangen: Esc gibt sie wieder frei.", 4); }
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
      say("Dinge aus der Leiste auf die Wiese ziehen. Mit B geht es zurück ins Spiel.", 6);
    } else {
      select(null);
      scene.fog.near = 55;
      scene.fog.far = 150;
      say(stageEl.classList.contains("is-touch") ? "Finger ziehen: laufen. Tippen: einsteigen, zuschlagen." : "Klick auf die Wiese fängt die Maus, Esc gibt sie frei.", 5);
    }
    sound.hush(mode === "build");
  }
  for (const button of modeButtons) button.addEventListener("click", () => setMode(button.dataset.mode));

  // Start: schräg, halb von vorn
  const orbit = { yaw: Math.PI - 0.65, pitch: 0.24, distance: 8.5 };
  let drag = null;
  // Finger und Maus werden am Zeiger erkannt, nicht an der Fensterbreite. Mit dem Finger:
  // auf die Wiese legen und ziehen = laufen (weiter weg von Kim = schneller), die Kamera dreht mit;
  // tippen = hinlaufen, auf ein Fahrzeug = einsteigen, auf einen Gegner = zuschlagen; zwei Finger = Zoom.
  const fingers = new Map();
  // Wie lange ein Finger höchstens liegen darf, damit es als Tippen zählt (Millisekunden; die Tests stellen es hoch)
  const tune = { tap: 320 };
  const stick = { on: false, x: 0, y: 0, power: 0 };
  let pinch = 0;
  let touchTold = false;
  function setTouch(flag) {
    if (stageEl.classList.contains("is-touch") === flag) return;
    stageEl.classList.toggle("is-touch", flag);
    if (flag && !touchTold && mode === "play") { touchTold = true; say("Finger auf die Wiese legen und ziehen: Kim läuft dorthin. Tippen: einsteigen, zuschlagen.", 7); }
  }
  stageEl.addEventListener("pointerdown", (event) => setTouch(event.pointerType !== "mouse"), { capture: true, passive: true });
  // Geräte, deren Hauptzeiger ein Finger ist (Handy, Tablet), starten gleich mit der Fingersteuerung
  if (window.matchMedia("(pointer: coarse)").matches) { touchTold = true; stageEl.classList.add("is-touch"); }
  canvas.addEventListener("pointerdown", (event) => {
    // Gefangene Maus: ein Klick ist ein Schlag
    if (look.locked) { if (event.button === 0) strike(); return; }
    if (event.button > 2) return;
    const touch = event.pointerType !== "mouse";
    if (touch) {
      fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
      // Zweiter Finger: Zoom statt Laufen
      if (fingers.size > 1) { pinch = 0; if (drag) { drag.pinched = true; if (drag.thing) drag.thing.held = false; } return; }
    }
    // Dinge anfassen geht nur beim Bauen
    const thing = mode === "build" && event.button === 0 ? thingAt(event.clientX, event.clientY) : null;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: 0, thing, moving: false, turn: event.button !== 0, touch, at: performance.now(), steer: false, pinched: false };
    canvas.setPointerCapture(event.pointerId);
    // Maus: der Klick auf die Wiese fängt sie sofort (nicht erst beim Loslassen, da galt ein leicht verrutschter Klick als Ziehen)
    if (!touch && event.button === 0 && mode === "play") lockMouse();
  });
  function lockMouse() {
    if (look.locked) return;
    try { canvas.requestPointerLock?.()?.catch?.(() => { /* Meldung kommt über pointerlockerror */ }); } catch { /* ohne gefangene Maus: Ziehen dreht die Kamera */ }
  }
  document.addEventListener("pointerlockerror", () => {
    look.failed = true;
    say("Der Browser gibt die Maus gerade nicht frei. Mit gedrückter Maustaste ziehen dreht die Kamera, ein Klick schlägt zu.", 7);
  });
  canvas.addEventListener("pointermove", (event) => {
    const finger = fingers.get(event.pointerId);
    if (finger) {
      finger.x = event.clientX;
      finger.y = event.clientY;
      if (fingers.size > 1) {
        // Zwei Finger auseinander oder zusammen: Zoom
        const [one, two] = [...fingers.values()];
        const apart = Math.hypot(one.x - two.x, one.y - two.y);
        if (pinch > 0 && apart > 0) {
          if (mode === "build") build.distance = THREE.MathUtils.clamp(build.distance * pinch / apart, 14, 110);
          else orbit.distance = THREE.MathUtils.clamp(orbit.distance * pinch / apart, 4, 30);
        }
        pinch = apart;
        return;
      }
    }
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.moved < 8 || drag.pinched) return;
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
    // Spielen mit dem Finger: gesteuert wird jedes Bild aus der Fingerposition (readStick)
    if (drag.touch) return;
    orbit.yaw -= dx * 0.006;
    orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + dy * 0.004, 0.04, 1.25);
    look.last = clock.elapsedTime;
  });
  const endDrag = (event) => {
    if (fingers.delete(event.pointerId)) pinch = 0;
    if (!drag || event.pointerId !== drag.id) return;
    const mine = drag;
    drag = null;
    stick.on = false;
    if (mine.thing) mine.thing.held = false;
    if (mine.moving) { saveMap(); return; }
    // Finger: kurz und ohne Wandern ist ein Tippen, auch wenn in der Zwischenzeit schon ein Bild lang gesteuert wurde
    const tap = mine.touch ? mine.moved < 14 && performance.now() - mine.at < tune.tap : mine.moved < 8;
    if (!tap || mine.pinched || event.type === "pointercancel") return;
    if (mode === "build") { select(mine.thing && mine.thing !== selected ? mine.thing : null); return; }
    // Spielen. Maus: Klick auf die Wiese fängt die Maus.
    if (!mine.touch) { if (!mine.turn) { if (look.failed) strike(); else lockMouse(); } return; }
    // Finger: tippen. Gegner = zuschlagen, Fahrzeug = hinlaufen und einsteigen, Wiese = hinlaufen.
    if (driving || !kim.ready || kim.busy) return;
    const picked = pickAt(event.clientX, event.clientY);
    kim.foe = null;
    kim.board = null;
    // Fahrzeug oder Pferd: einsteigen. Alle anderen mit Leben: zuschlagen (mehrfach tippen = mehrfach schlagen).
    if (picked && (picked.item.drive || picked.item.ride) && !(picked.item.ride && sword.drawn)) { kim.board = picked; return; }
    if (picked) { kim.foe = picked; return; }
    const spot = groundAt(event.clientX, event.clientY);
    if (spot) { kim.target = spot.clone(); kim.run = false; }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  // Was unter dem Finger liegt: Gegner, Fahrzeug oder Pferd. Finger sind ungenau, deshalb zählt auch das nächste Ziel im Umkreis.
  const pickSpot = new THREE.Vector3();
  function pickAt(clientX, clientY) {
    const wanted = (thing) => (lifeOf(thing.item) > 0 && !thing.dead) || ((thing.item.drive || thing.item.ride) && !thing.item.follow);
    const direct = thingAt(clientX, clientY);
    if (direct && wanted(direct)) return direct;
    const rect = canvas.getBoundingClientRect();
    let best = null;
    let bestDistance = 54;
    for (const thing of things) {
      if (!wanted(thing)) continue;
      pickSpot.set(thing.x, thing.group.position.y + thing.item.h * 0.5, thing.z).project(camera);
      if (pickSpot.z > 1) continue;
      const distance = Math.hypot(rect.left + ((pickSpot.x + 1) / 2) * rect.width - clientX, rect.top + ((1 - pickSpot.y) / 2) * rect.height - clientY);
      if (distance < bestDistance) { best = thing; bestDistance = distance; }
    }
    return best;
  }
  // Fingersteuerung: Richtung und Abstand des Fingers von Kim (oder dem Fahrzeug) auf dem Bildschirm
  function readStick() {
    stick.on = false;
    if (!drag || !drag.touch || drag.pinched || mode !== "play" || kim.dead || !kim.ready) return;
    if (!drag.steer) {
      // Kurzes Tippen ist kein Laufen: erst nach einem Moment oder sobald der Finger wandert
      if (drag.moved < 14 && performance.now() - drag.at < tune.tap * 0.7) return;
      drag.steer = true;
      kim.target = null;
      kim.foe = null;
      kim.board = null;
    }
    const lead = driving ? driving.group.position : kim.group.position;
    pickSpot.set(lead.x, lead.y + (driving ? driving.item.h * 0.5 : kim.height * 0.5), lead.z).project(camera);
    const rect = canvas.getBoundingClientRect();
    const dx = drag.x - (rect.left + ((pickSpot.x + 1) / 2) * rect.width);
    const dy = drag.y - (rect.top + ((1 - pickSpot.y) / 2) * rect.height);
    const distance = Math.hypot(dx, dy);
    const dead = 30;
    const full = Math.max(110, Math.min(rect.width, rect.height) * 0.3);
    if (distance < dead) return;
    stick.on = true;
    stick.x = dx / distance;
    stick.y = -dy / distance;
    stick.power = THREE.MathUtils.clamp((distance - dead) / (full - dead), 0, 1);
  }
  // Angetippte Ziele verfolgen: zum Fahrzeug laufen und einsteigen, zum Gegner laufen und zuschlagen
  function followTap() {
    const at = kim.group.position;
    if (kim.board) {
      const thing = kim.board;
      const distance = Math.hypot(thing.x - at.x, thing.z - at.z) - thing.radius;
      if (things.indexOf(thing) < 0) kim.board = null;
      else if (distance < 2.4) { kim.board = null; kim.target = null; enterVehicle(thing); }
      else { kim.target = kim.target || new THREE.Vector3(); kim.target.set(thing.x, 0, thing.z); kim.run = distance > 5; }
    }
    if (kim.foe) {
      const foe = kim.foe;
      const distance = Math.hypot(foe.x - at.x, foe.z - at.z) - foe.radius;
      if (things.indexOf(foe) < 0 || foe.dead) { kim.foe = null; kim.target = null; }
      else if (distance < 1.9) {
        kim.target = null;
        if (!sword.swing && !sword.moving) {
          kim.yaw = Math.atan2(foe.x - at.x, foe.z - at.z);
          strike();
          kim.foe = null;
        }
      } else { kim.target = kim.target || new THREE.Vector3(); kim.target.set(foe.x, 0, foe.z); kim.run = distance > 3; }
    }
  }
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
  // Steuerung einblenden (Taste H oder der Knopf oben rechts)
  const helpEl = document.querySelector("[data-help]");
  const helpButton = document.querySelector("[data-help-open]");
  let helpOpen = false;
  function setHelp(open) {
    helpOpen = Boolean(open && helpEl);
    if (helpEl) helpEl.hidden = !helpOpen;
    helpButton?.setAttribute("aria-expanded", String(helpOpen));
    keys.clear();
    if (helpOpen) { document.exitPointerLock?.(); helpEl.querySelector("[data-help-close]")?.focus(); }
  }
  helpButton?.addEventListener("click", () => setHelp(!helpOpen));
  helpEl?.addEventListener("click", (event) => { if (event.target === helpEl || event.target.closest("[data-help-close]")) setHelp(false); });
  // HUD unten links: Kims Medaillon, Leben, Schwert; im Fahrzeug dessen Zustand
  const hud = { life: document.querySelector("[data-hud-life]"), sword: document.querySelector("[data-hud-sword]"), car: document.querySelector("[data-hud-car]"), face: document.querySelector("[data-hud-face]"), hp: -1, carHp: -1, drawn: null, portrait: false };
  const fadeEl = document.querySelector("[data-play-fade]");
  const hurtEl = document.querySelector("[data-play-hurt]");
  hud.sword?.addEventListener("click", () => { if (sword.drawn) strike(); else setSword(true); });
  // Knopf unten rechts (nur mit dem Finger): dasselbe wie die Leertaste
  const actButton = document.querySelector("[data-play-act]");
  let actLabel = "";
  actButton?.addEventListener("click", act);
  function showHud() {
    const hp = Math.ceil(kim.hp);
    if (hud.life && hp !== hud.hp) {
      hud.hp = hp;
      hud.life.querySelector("b").textContent = String(hp);
      hud.life.style.setProperty("--fill", `${hp}%`);
      hud.life.classList.toggle("is-low", hp <= 25);
    }
    const label = !driving ? "Springen" : driving.item.fly ? (driving.airborne ? "Landen" : "Abheben") : driving.riding ? "Klaps" : "Hupe";
    if (actButton && label !== actLabel) { actLabel = label; actButton.textContent = label; }
    if (hud.sword && sword.drawn !== hud.drawn) { hud.drawn = sword.drawn; hud.sword.setAttribute("aria-pressed", String(sword.drawn)); }
    if (hud.car) {
      const show = Boolean(driving && driving.item.drive);
      if (hud.car.hidden === show) hud.car.hidden = !show;
      const state = show ? Math.round(driving.hp) : -1;
      if (show && state !== hud.carHp) { hud.car.style.setProperty("--fill", `${state}%`); hud.car.classList.toggle("is-low", state < 45); }
      hud.carHp = state;
    }
  }
  // Medaillon: Kims Gesicht einmal aus der Szene aufnehmen (mit seinem Aussehen aus dem Charakter-Editor)
  const faceCamera = new THREE.PerspectiveCamera(20, 1, 0.1, 40);
  const faceAt = new THREE.Vector3();
  function takePortrait() {
    const head = kim.group.getObjectByName("Head");
    if (!hud.face || !head) { hud.portrait = true; return; }
    head.getWorldPosition(faceAt);
    faceAt.y += kim.height * 0.035;
    faceCamera.aspect = camera.aspect;
    faceCamera.updateProjectionMatrix();
    faceCamera.position.set(faceAt.x + Math.sin(kim.yaw + 0.3) * 2.3, faceAt.y + 0.1, faceAt.z + Math.cos(kim.yaw + 0.3) * 2.3);
    faceCamera.lookAt(faceAt);
    // Nur Kim vor Wiese und Himmel: alles Aufgestellte für dieses eine Bild ausblenden
    const shown = things.filter((thing) => thing.group.visible);
    for (const thing of shown) thing.group.visible = false;
    renderer.render(scene, faceCamera);
    for (const thing of shown) thing.group.visible = true;
    const side = Math.round(Math.min(canvas.width, canvas.height) * 0.62);
    try {
      hud.face.getContext("2d").drawImage(canvas, Math.round((canvas.width - side) / 2), Math.round((canvas.height - side) / 2), side, side, 0, 0, hud.face.width, hud.face.height);
      hud.face.classList.add("is-ready");
    } catch { /* ohne Bild: das Medaillon bleibt leer */ }
    hud.portrait = true;
  }
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
    let ahead = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
    let side = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
    let running = keys.has("shift");
    // Finger: Richtung vom Kim zum Finger; weiter weg = schneller, ab gut der Hälfte rennt er. Die Kamera dreht mit.
    let pace = 0;
    if (!ahead && !side && stick.on) {
      ahead = stick.y;
      side = stick.x;
      running = stick.power > 0.6;
      pace = running ? 6.4 : 1.3 + stick.power * 2.4;
      orbit.yaw -= stick.x * (stick.y < -0.2 ? 0.8 : 1.6) * dt;
    } else if (ahead || side) { kim.foe = null; kim.board = null; }
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
    // Beim Ziehen, Wegstecken und Zuschlagen bleibt Kim stehen
    const acting = Boolean(sword.swing || sword.moving);
    if (acting) kim.target = null;
    const wanted = length > 0.001 && !acting ? pace || (backwards ? 2 : running ? 6.4 : 2.5) : 0;
    kim.speed = damp(kim.speed, wanted, 9, dt);
    if (look.locked) kim.yaw = dampAngle(kim.yaw, orbit.yaw + Math.PI, 16, dt);
    if (length > 0.001) {
      if (!look.locked) kim.yaw = dampAngle(kim.yaw, Math.atan2(moveX, moveZ), 12, dt);
      position.x = THREE.MathUtils.clamp(position.x + (moveX / length) * kim.speed * dt, -EDGE, EDGE);
      position.z = THREE.MathUtils.clamp(position.z + (moveZ / length) * kim.speed * dt, -EDGE, EDGE);
    }
    // Um Bäume, Autos und Leute herum statt hindurch
    for (const thing of things) {
      if (thing.held || thing.lift > 1.2 || thing.dead) continue;
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
    if (acting) return;
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
  const streak = new THREE.BoxGeometry(0.025, 0.025, 1.1);
  function bit(kind, at, color, vx, vy, vz, life) {
    const fog = kind !== "spark" && kind !== "tracer";
    const mesh = new THREE.Mesh(kind === "leaf" ? flake : kind === "spark" ? spark : kind === "tracer" ? streak : cloudlet, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: kind === "smoke" ? 0.5 : 1, side: THREE.DoubleSide, depthWrite: false, fog }));
    mesh.position.copy(at);
    mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    mesh.userData = { kind, vx, vy, vz, life, age: 0, spin: (Math.random() - 0.5) * 12 };
    scene.add(mesh);
    bits.push(mesh);
    return mesh;
  }
  function moveBits(dt) {
    for (let i = bits.length - 1; i >= 0; i -= 1) {
      const mesh = bits[i];
      const data = mesh.userData;
      data.age += dt;
      const k = data.age / data.life;
      if (k >= 1) { scene.remove(mesh); mesh.material.dispose(); bits.splice(i, 1); continue; }
      if (data.kind === "tracer") {
        mesh.material.opacity = 1 - k * 0.5;
      } else if (data.kind === "smoke") {
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
      if (thing.alt > 1.2 || other.dead) continue;
      if (lifeOf(other.item) && other !== driving) {
        // Überfahren: je schneller, desto mehr Schaden; das Fahrzeug nimmt keinen und wird kaum gebremst
        if (fast > 3) { hurtMob(other, fast * 7, thing.x, thing.z); thing.speed *= 0.92; continue; }
        if (other.item.mob) continue;
      }
      thing.x = other.x + (dx / distance) * reach;
      thing.z = other.z + (dz / distance) * reach;
      thing.speed *= 0.5;
      if (fast > 5) harm(thing, fast * 2.4);
      if (other.item.wander && other !== driving) { other.goal = new THREE.Vector2(other.x - dx * 3, other.z - dz * 3); other.wait = 0; other.scared = 2.5; }
    }
  }
  // Schaden: unter 45 % raucht das Fahrzeug, bei 0 ist es ein Wrack und fährt nicht mehr
  function harm(thing, amount) {
    if (!thing.item.drive || thing.wreck) return;
    thing.hp = Math.max(0, thing.hp - amount);
    // Ein harter Aufprall mit dem eigenen Fahrzeug ruft die Polizei auf den Plan
    if (thing === driving && amount >= 12) alarm();
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
    let gas = locked ? 0 : (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
    let steer = locked ? 0 : (keys.has("a") || keys.has("arrowleft") ? 1 : 0) - (keys.has("d") || keys.has("arrowright") ? 1 : 0);
    // Finger: vor dem Fahrzeug = Gas, dahinter = Bremse und rückwärts, seitlich = lenken
    if (!locked && !gas && !steer && stick.on) { gas = stick.y > 0.25 ? 1 : stick.y < -0.45 ? -1 : 0; steer = -stick.x * (gas < 0 ? -1 : 1); }
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
    const go = !locked && (keys.has("w") || keys.has("arrowup") || (stick.on && stick.y > 0.15));
    let steer = locked ? 0 : (keys.has("a") || keys.has("arrowleft") ? 1 : 0) - (keys.has("d") || keys.has("arrowright") ? 1 : 0);
    if (!locked && !steer && stick.on) steer = -stick.x;
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
  // Kämpfen. Kim: 100 Leben, erholt sich nach ein paar ruhigen Sekunden. Fällt er um, wird es kurz dunkel
  // und er steht wieder am Startpunkt. Man verliert nichts.
  function hurtKim(amount, fromX, fromZ) {
    if (kim.dead || kim.safe > 0 || !kim.ready) return;
    kim.hp = Math.max(0, kim.hp - amount);
    kim.hurtAt = now;
    sound.play("treffer", 0.6, 0.8);
    if (hurtEl) { hurtEl.classList.remove("is-on"); void hurtEl.offsetWidth; hurtEl.classList.add("is-on"); }
    if (kim.hp <= 0) { killKim(); return; }
    // Kleiner Stoß weg vom Treffer
    const dx = kim.group.position.x - fromX;
    const dz = kim.group.position.z - fromZ;
    const distance = Math.hypot(dx, dz) || 1;
    kim.group.position.x = THREE.MathUtils.clamp(kim.group.position.x + (dx / distance) * 0.25, -EDGE, EDGE);
    kim.group.position.z = THREE.MathUtils.clamp(kim.group.position.z + (dz / distance) * 0.25, -EDGE, EDGE);
  }
  function killKim() {
    kim.dead = true;
    kim.target = null;
    kim.speed = 0;
    kim.jump = 0;
    stowSword();
    say("Umgefallen. Gleich stehst du wieder am Start.", 5);
    const fall = kimOnce("FallBackward", 1.5) || 0.5;
    // Die Bewegung endet schräg in der Luft: danach legt sich Kim ganz auf den Rücken
    kim.busy = { left: fall * 0.8, then: () => {
      const head = kim.group.getObjectByName("Head");
      const foot = kim.group.getObjectByName("LeftFoot");
      let angle = 0.6;
      if (head && foot) {
        kim.group.updateMatrixWorld(true);
        const top = kim.group.worldToLocal(head.getWorldPosition(new THREE.Vector3()));
        const low = kim.group.worldToLocal(foot.getWorldPosition(new THREE.Vector3()));
        const long = Math.hypot(top.y - low.y, top.z - low.z) || 1;
        angle = Math.max(0, Math.atan2(top.y - low.y, low.z - top.z) - Math.asin(Math.min(0.9, (0.1 * kim.height) / long)));
      }
      kim.lie = { t: 0, time: 0.28, angle };
      kim.busy = { left: 0.95, then: () => {
        fadeEl?.classList.add("is-on");
        kim.busy = { left: 0.75, then: respawn };
      } };
    } };
  }
  let snapCamera = false;
  function respawn() {
    kim.group.position.set(START.x, height(START.x, START.z), START.z);
    kim.yaw = orbit.yaw + Math.PI;
    kim.hp = 100;
    kim.dead = false;
    wanted = 0;
    kim.lie = null;
    kim.group.rotation.x = 0;
    kim.safe = 4;
    kim.actions[kim.current]?.stop();
    kim.current = "";
    kimPlay("Idle", 0);
    // Alle lassen von Kim ab: Polizisten gehen zum Wagen zurück, Gegner beruhigen sich
    for (const thing of things) {
      if (thing.item.npc?.chase) { thing.cool = 20; thing.caught = true; thing.called = false; thing.aiming = false; }
      if (thing.item.patrol && thing.state === "chase") { thing.state = "patrol"; thing.cool = 25; }
      if (thing.item.follow) { thing.cool = 25; thing.called = false; }
      if (thing.item.mob) { thing.calm = 8; thing.angry = false; thing.swing = null; }
    }
    snapCamera = true;
    fadeEl?.classList.remove("is-on");
    say("");
  }
  // Schwert ohne Bewegung zurück auf den Rücken (Einsteigen, Umfallen)
  function stowSword() {
    sword.moving = null;
    sword.swing = null;
    sword.queued = false;
    if (sword.mesh && sword.drawn) sword.back.add(sword.mesh);
    sword.drawn = false;
  }
  // Schwert ziehen oder wegstecken (Q); in der Mitte der Bewegung wechselt es zwischen Rücken und Hand
  function setSword(drawn) {
    if (!sword.mesh || !kim.ready || driving || kim.busy || kim.dead || sword.moving || sword.swing || sword.drawn === drawn || kim.jump > 0) return false;
    const length = kimOnce(drawn ? "Draw" : "Sheath", drawn ? 0.75 : 0.85, 0.12) || 0.3;
    sword.moving = { t: 0, length, at: length * (drawn ? 0.45 : 0.6), drawn, switched: false };
    sound.play("schwung", 0.25, drawn ? 1.5 : 1.1);
    return true;
  }
  // Ein Klick ist ein Schlag. Steckt das Schwert noch, zieht Kim es erst. Wer weiterklickt, lässt einen schweren Hieb folgen.
  function strike() {
    if (!sword.mesh || !kim.ready || driving || kim.busy || kim.dead || mode !== "play" || helpOpen) return;
    if (sword.moving || sword.swing) { sword.queued = true; return; }
    if (kim.jump > 0) return;
    if (!sword.drawn) { sword.queued = setSword(true); return; }
    if (!look.locked) {
      // Ohne gefangene Maus dreht sich Kim zum nächsten Gegner
      let best = null;
      let bestDistance = 5;
      for (const thing of things) {
        if (!lifeOf(thing.item) || thing.dead) continue;
        const distance = Math.hypot(thing.x - kim.group.position.x, thing.z - kim.group.position.z) - (thing.item.mob ? 1.5 : 0);
        if (distance < bestDistance) { best = thing; bestDistance = distance; }
      }
      if (best) { kim.yaw = Math.atan2(best.x - kim.group.position.x, best.z - kim.group.position.z); kim.group.rotation.y = kim.yaw; }
    }
    sword.combo = now - sword.last < 0.5 ? (sword.combo + 1) % 2 : 0;
    const heavy = sword.combo === 1;
    const length = kimOnce(heavy ? "Hieb" : "Slash", 1.7, 0.1);
    if (!length) return;
    sword.swing = { t: 0, length, at: length * (heavy ? 0.4 : 0.34), done: false, power: heavy ? 34 : 25, arc: heavy ? 1.3 : 2.3 };
    sword.rest = 0;
    sound.play("schwung", 0.5, heavy ? 0.85 : 1.1);
  }
  // Der Moment des Treffers: alle Gegner im Bogen vor Kim; Blumen und Büsche werden zerfetzt
  function slash(swing) {
    const at = kim.group.position;
    const fx = Math.sin(kim.yaw);
    const fz = Math.cos(kim.yaw);
    for (const thing of [...things]) {
      const mob = lifeOf(thing.item) > 0 && !thing.dead && thing !== driving;
      const plant = thing.item.group === "Grün" && thing.item.h < 2;
      if (!mob && !plant) continue;
      const dx = thing.x - at.x;
      const dz = thing.z - at.z;
      const distance = Math.hypot(dx, dz);
      if (distance > (mob ? 2.3 + thing.radius : 1.7 + thing.radius * 0.5)) continue;
      if (distance > 1 && Math.abs(Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz)) > swing.arc) continue;
      if (mob) hurtMob(thing, swing.power * (0.85 + Math.random() * 0.3), at.x, at.z);
      else shred(thing, fx * 4, fz * 4);
    }
  }
  function moveSword(dt) {
    if (!sword.mesh || driving) return;
    const move = sword.moving;
    if (move) {
      move.t += dt;
      if (!move.switched && move.t >= move.at) { move.switched = true; (move.drawn ? sword.hand : sword.back).add(sword.mesh); sword.drawn = move.drawn; }
      if (move.t >= move.length) { sword.moving = null; sword.rest = 0; if (sword.queued) { sword.queued = false; strike(); } }
      return;
    }
    const swing = sword.swing;
    if (swing) {
      swing.t += dt;
      if (!swing.done && swing.t >= swing.at) { swing.done = true; slash(swing); }
      if (swing.t >= swing.length) { sword.swing = null; sword.last = now; if (sword.queued) { sword.queued = false; strike(); } }
      return;
    }
    if (!sword.drawn) return;
    // Nach einer Weile ohne Gegner in der Nähe steckt Kim das Schwert von selbst weg
    sword.rest += dt;
    if (sword.rest > 12 && !things.some((thing) => thing.item.mob && !thing.dead && Math.hypot(thing.x - kim.group.position.x, thing.z - kim.group.position.z) < 14)) setSword(false);
  }

  // Gegner: laufen in ihrer Ecke herum, greifen Kim an, wenn er zu Fuß in die Nähe kommt, und haben eine Lebensanzeige.
  // Aufgestellte Gegner kommen nach einer Weile an ihrem Platz wieder, von selbst aufgetauchte nicht.
  function lifeBar(thing) {
    const picture = document.createElement("canvas");
    picture.width = 128;
    picture.height = 20;
    const texture = new THREE.CanvasTexture(picture);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false, toneMapped: false, fog: false }));
    sprite.scale.set(0.8, 0.125, 1);
    sprite.position.y = thing.item.h + 0.3;
    sprite.renderOrder = 5;
    thing.group.add(sprite);
    thing.bar = sprite;
    drawBar(thing);
  }
  function drawBar(thing) {
    const picture = thing.bar.material.map.image;
    const context = picture.getContext("2d");
    const pill = (x, y, w, h) => { context.beginPath(); if (context.roundRect) context.roundRect(x, y, w, h, h / 2); else context.rect(x, y, w, h); context.fill(); };
    context.clearRect(0, 0, picture.width, picture.height);
    context.fillStyle = "rgba(17, 21, 24, .92)";
    pill(0, 0, 128, 20);
    context.fillStyle = "rgba(241, 238, 228, .18)";
    pill(4, 4, 120, 12);
    const fill = 120 * THREE.MathUtils.clamp(thing.hp / lifeOf(thing.item), 0, 1);
    if (fill > 0.5) { context.fillStyle = "#ff5d73"; pill(4, 4, Math.max(12, fill), 12); }
    thing.bar.material.map.needsUpdate = true;
  }
  function mobPlay(thing, name, { once = false, speed = 1 } = {}) {
    const next = thing.actions[name];
    if (!next) return 0;
    if (thing.pose !== name || once) {
      const previous = thing.actions[thing.pose];
      next.reset().setEffectiveWeight(1).setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
      next.clampWhenFinished = once;
      next.play();
      if (previous && previous !== next) next.crossFadeFrom(previous, 0.15, false);
      thing.pose = name;
    }
    next.timeScale = speed;
    return next.getClip().duration / speed;
  }
  function hurtMob(thing, amount, fromX, fromZ) {
    if (thing.dead || !lifeOf(thing.item) || thing === driving) return;
    thing.hp = Math.max(0, thing.hp - amount);
    drawBar(thing);
    if (!thing.item.mob) { hurtOther(thing, fromX, fromZ); return; }
    thing.angry = true;
    thing.calm = 0;
    thing.swing = null;
    const dx = thing.x - fromX;
    const dz = thing.z - fromZ;
    const distance = Math.hypot(dx, dz) || 1;
    thing.pushX = (dx / distance) * 5;
    thing.pushZ = (dz / distance) * 5;
    const near = Math.max(0.3, loudness(thing.group.position, 5, 50));
    sound.play("treffer", 0.7 * near, 1.1);
    burstAt.set(thing.x, thing.group.position.y + thing.item.h * 0.6, thing.z);
    for (let i = 0; i < 6; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      bit("spark", burstAt, ["#fff3c4", "#ecdcaa", "#ffffff"][i % 3], Math.cos(angle) * 2.2, 1 + Math.random() * 2, Math.sin(angle) * 2.2, 0.3 + Math.random() * 0.2);
    }
    if (thing.hp > 0) { thing.stun = mobPlay(thing, "Hit", { once: true }) || 0.4; return; }
    thing.dead = true;
    thing.stun = 0;
    thing.bar.visible = false;
    thing.gone = (mobPlay(thing, "Death", { once: true }) || 0.8) + 1;
    sound.play("plopp", 0.6 * near);
  }
  // Fahndung: Die Polizei ist friedlich. Erst wenn Kim etwas anstellt (Leute, Tiere oder Polizisten angreifen oder anfahren,
  // mit dem Auto irgendwo voll dagegen brettern), geht die Sirene los und Polizisten, Streife und Hubschrauber greifen an.
  // Gegner bekämpfen stört niemanden. Vorbei ist es, wenn Kim umfällt oder eine Weile außer Sicht bleibt.
  let wanted = 0;
  function alarm() {
    if (!things.some((thing) => !thing.dead && (thing.item.npc?.chase || thing.item.patrol || thing.item.follow))) return;
    if (wanted <= 0) say("Das hat die Polizei gesehen. Jetzt ist sie hinter dir her.", 5);
    wanted = 30;
  }
  // Leute und Tiere: der Polizist wehrt sich sofort, alle anderen rennen weg. Bei 0 fallen sie um.
  function hurtOther(thing, fromX, fromZ) {
    alarm();
    const near = Math.max(0.3, loudness(thing.group.position, 5, 50));
    sound.play("treffer", 0.7 * near, 1.1);
    burstAt.set(thing.x, thing.group.position.y + thing.item.h * 0.6, thing.z);
    for (let i = 0; i < 6; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      bit("spark", burstAt, ["#fff3c4", "#ecdcaa", "#ffffff"][i % 3], Math.cos(angle) * 2.2, 1 + Math.random() * 2, Math.sin(angle) * 2.2, 0.3 + Math.random() * 0.2);
    }
    if (thing.hp > 0) {
      if (thing.item.npc?.chase) { thing.cool = 0; thing.back = false; thing.out = 0; thing.aim = Math.min(thing.called ? thing.aim : 9, 0.5); thing.called = true; }
      else { thing.afraid = true; thing.scared = 0; thing.goal = null; thing.wait = 0; }
      return;
    }
    thing.dead = true;
    thing.aiming = false;
    thing.bar.visible = false;
    thing.gone = 3.2;
    thing.fall = 0;
    // Tiere haben eine eigene Bewegung fürs Umfallen, Leute und das Pferd kippen um
    const death = thing.actions.Death;
    if (death) { thing.mixer.stopAllAction(); death.reset().setLoop(THREE.LoopOnce, 1); death.clampWhenFinished = true; death.play(); thing.fall = -1; }
    sound.play("plopp", 0.6 * near, 0.8);
  }
  function fallen(thing, dt) {
    if (thing.gone > 0) {
      thing.gone -= dt;
      if (thing.fall >= 0) {
        thing.fall = Math.min(1, thing.fall + dt * 2.6);
        // Leute fallen auf den Rücken, das Pferd kippt auf die Seite
        const turn = Math.PI / 2 * THREE.MathUtils.smoothstep(thing.fall, 0, 1);
        thing.tilt.rotation.set(thing.item.ride ? 0 : -turn, 0, thing.item.ride ? turn : 0);
        thing.tilt.position.y = 0.12 * thing.fall;
      }
      if (thing.gone < 0.5) thing.group.scale.setScalar(Math.max(0.01, thing.gone / 0.5));
      if (thing.gone <= 0) { if (thing.temp || thing.owner) doomed.push(thing); else { thing.group.visible = false; thing.returnIn = 22 + Math.random() * 10; } }
      return;
    }
    // Aufgestellte kommen nach einer Weile an ihrem Platz wieder
    thing.returnIn -= dt;
    if (thing.returnIn > 0) return;
    thing.dead = false;
    thing.hp = lifeOf(thing.item);
    thing.x = thing.home.x;
    thing.z = thing.home.y;
    thing.goal = null;
    thing.afraid = false;
    thing.scared = 0;
    thing.cool = 6;
    thing.called = false;
    thing.back = false;
    thing.group.visible = true;
    thing.group.scale.setScalar(1);
    thing.tilt.rotation.set(0, 0, 0);
    thing.tilt.position.y = 0;
    thing.bar.visible = true;
    drawBar(thing);
    thing.mixer?.stopAllAction();
    thing.moving = undefined;
    thing.gait = "";
    thing.pose = "";
    if (thing.item.npc) npcPlay(thing, "Idle"); else if (thing.item.ride) horsePlay(thing, "Schritt", 0);
    settle(thing, 1);
  }
  const doomed = [];
  function mob(thing, dt) {
    const rule = thing.item.mob;
    if (thing.pushX || thing.pushZ) {
      thing.x = THREE.MathUtils.clamp(thing.x + thing.pushX * dt, -EDGE, EDGE);
      thing.z = THREE.MathUtils.clamp(thing.z + thing.pushZ * dt, -EDGE, EDGE);
      const keep = Math.exp(-7 * dt);
      thing.pushX *= keep;
      thing.pushZ *= keep;
      if (Math.abs(thing.pushX) + Math.abs(thing.pushZ) < 0.05) { thing.pushX = 0; thing.pushZ = 0; }
    }
    if (thing.dead) {
      if (thing.gone > 0) {
        // Liegen bleiben, dann schrumpfen und verschwinden
        thing.gone -= dt;
        if (thing.gone < 0.5) thing.group.scale.setScalar(Math.max(0.01, thing.gone / 0.5));
        if (thing.gone <= 0) { if (thing.temp) doomed.push(thing); else { thing.group.visible = false; thing.back = 18 + Math.random() * 10; } }
      } else {
        thing.back -= dt;
        if (thing.back <= 0) {
          thing.dead = false;
          thing.hp = rule.hp;
          thing.x = thing.home.x;
          thing.z = thing.home.y;
          thing.goal = null;
          thing.angry = false;
          thing.group.visible = true;
          thing.bar.visible = true;
          thing.grow = 0;
          drawBar(thing);
          thing.mixer.stopAllAction();
          thing.pose = "";
          mobPlay(thing, "Idle");
        }
      }
      settle(thing, 1);
      return;
    }
    if (thing.grow < 1) {
      // Auftauchen: aus dem Boden wachsen
      thing.grow = Math.min(1, thing.grow + dt * 2.2);
      thing.group.scale.setScalar(Math.max(0.01, THREE.MathUtils.smoothstep(thing.grow, 0, 1)));
    }
    thing.cool = Math.max(0, thing.cool - dt);
    thing.calm = Math.max(0, thing.calm - dt);
    const lead = kim.group.position;
    const dx = lead.x - thing.x;
    const dz = lead.z - thing.z;
    const distance = Math.hypot(dx, dz);
    const reach = thing.radius * 0.8 + 0.75;
    if (thing.stun > 0) { thing.stun -= dt; settle(thing, 1); return; }
    const alert = !driving && kim.ready && !kim.dead && kim.safe <= 0 && thing.calm <= 0 && distance < (thing.angry ? 24 : 11);
    if (thing.swing) {
      // Ausholen und zuschlagen: der Treffer sitzt in der Mitte der Bewegung, wenn Kim dann noch nah genug ist
      const swing = thing.swing;
      swing.t += dt;
      thing.yaw = dampAngle(thing.yaw, Math.atan2(dx, dz), 6, dt);
      if (!swing.done && swing.t >= swing.at) { swing.done = true; if (alert && distance < reach + 0.6 && kim.jump < 0.9) hurtKim(rule.hit, thing.x, thing.z); }
      if (swing.t >= swing.length) { thing.swing = null; thing.cool = 0.5 + Math.random() * 0.6; }
    } else if (alert) {
      thing.angry = true;
      thing.goal = null;
      thing.yaw = dampAngle(thing.yaw, Math.atan2(dx, dz), 8, dt);
      if (distance > reach) {
        const fast = distance > 4 && Boolean(thing.actions.Run);
        const speed = rule.speed * (fast ? 1.5 : 1);
        thing.x = THREE.MathUtils.clamp(thing.x + Math.sin(thing.yaw) * speed * dt, -EDGE, EDGE);
        thing.z = THREE.MathUtils.clamp(thing.z + Math.cos(thing.yaw) * speed * dt, -EDGE, EDGE);
        mobPlay(thing, fast ? "Run" : "Walk", { speed: fast ? 1 : rule.speed / 2 });
      } else if (thing.cool <= 0) {
        const length = mobPlay(thing, "Attack", { once: true }) || 0.8;
        thing.swing = { t: 0, at: length * 0.5, length, done: false };
      } else mobPlay(thing, "Idle");
    } else {
      // Ruhig: in der eigenen Ecke herumlaufen
      thing.angry = false;
      if (!thing.goal) {
        thing.wait -= dt;
        if (thing.wait <= 0) {
          const angle = Math.random() * Math.PI * 2;
          const far = 2 + Math.random() * 5;
          thing.goal = new THREE.Vector2(THREE.MathUtils.clamp(thing.home.x + Math.cos(angle) * far, -EDGE, EDGE), THREE.MathUtils.clamp(thing.home.y + Math.sin(angle) * far, -EDGE, EDGE));
        }
      }
      if (thing.goal) {
        const gx = thing.goal.x - thing.x;
        const gz = thing.goal.y - thing.z;
        if (Math.hypot(gx, gz) < 0.3) { thing.goal = null; thing.wait = 2 + Math.random() * 5; }
        else {
          thing.yaw = dampAngle(thing.yaw, Math.atan2(gx, gz), 4, dt);
          thing.x = THREE.MathUtils.clamp(thing.x + Math.sin(thing.yaw) * rule.speed * 0.45 * dt, -EDGE, EDGE);
          thing.z = THREE.MathUtils.clamp(thing.z + Math.cos(thing.yaw) * rule.speed * 0.45 * dt, -EDGE, EDGE);
          mobPlay(thing, "Walk", { speed: 0.7 });
        }
      } else mobPlay(thing, "Idle");
    }
    // Nicht ineinander stehen
    for (const other of things) {
      if (other === thing || !other.item.mob || other.dead) continue;
      const ox = thing.x - other.x;
      const oz = thing.z - other.z;
      const apart = Math.hypot(ox, oz);
      const least = (thing.radius + other.radius) * 0.75;
      if (apart < least && apart > 0.001) { thing.x += (ox / apart) * (least - apart) * 0.5; thing.z += (oz / apart) * (least - apart) * 0.5; }
    }
    settle(thing, 1);
  }
  // Zwischendurch taucht irgendwo in der Nähe ein Gegner auf (höchstens drei zugleich, schwächere häufiger)
  const MOBS = CATALOG.filter((item) => item.mob).map((item) => item.id);
  let spawnIn = 18;
  function spawnMob() {
    const lead = driving ? driving.group.position : kim.group.position;
    const angle = Math.random() * Math.PI * 2;
    const far = 15 + Math.random() * 10;
    const x = THREE.MathUtils.clamp(lead.x + Math.cos(angle) * far, -EDGE + 2, EDGE - 2);
    const z = THREE.MathUtils.clamp(lead.z + Math.sin(angle) * far, -EDGE + 2, EDGE - 2);
    if (Math.hypot(x - lead.x, z - lead.z) < 12) return;
    addThing(MOBS[Math.floor(Math.random() ** 1.6 * MOBS.length)], x, z, Math.random() * Math.PI * 2, { save: false, temp: true }).then((thing) => {
      if (!thing) return;
      thing.grow = 0;
      thing.group.scale.setScalar(0.01);
      burstAt.set(x, height(x, z) + 0.3, z);
      for (let i = 0; i < 10; i += 1) {
        const turn = Math.random() * Math.PI * 2;
        bit("leaf", burstAt, ["#4f8f3a", "#6aa84a", "#6b5a3a"][i % 3], Math.cos(turn) * 1.6, 1.5 + Math.random() * 2, Math.sin(turn) * 1.6, 1.4);
      }
      sound.play("plopp", 0.5 * loudness(thing.group.position, 5, 45), 1.5);
    });
  }
  // Polizei schießt: Mündungsblitz an der Hand, Leuchtspur, Knall. Wer rennt oder weit weg ist, wird seltener getroffen.
  const muzzle = new THREE.Vector3();
  const aimAt = new THREE.Vector3();
  const aimDir = new THREE.Vector3();
  function shoot(thing, distance) {
    const heli = Boolean(thing.item.follow);
    if (thing.arm?.[2]) thing.arm[2].getWorldPosition(muzzle); else muzzle.copy(thing.group.position).setY(thing.group.position.y + (heli ? 0.4 : 1.5));
    if (driving) aimAt.copy(driving.group.position).setY(driving.group.position.y + driving.item.h * 0.5);
    else aimAt.copy(kim.group.position).setY(kim.group.position.y + kim.height * 0.6);
    aimDir.copy(aimAt).sub(muzzle);
    const length = aimDir.length() || 1;
    aimDir.divideScalar(length);
    sound.play("schuss", 0.6 * Math.max(0.25, loudness(thing.group.position, 6, 70)), 0.94 + Math.random() * 0.12);
    bit("spark", muzzle, "#ffe9a8", aimDir.x * 2, 0.4, aimDir.z * 2, 0.09).scale.setScalar(2.4);
    const moving = driving ? Math.abs(driving.speed) : kim.speed;
    const chance = heli ? THREE.MathUtils.clamp(0.95 - moving * 0.025, 0.6, 0.95) : THREE.MathUtils.clamp(0.92 - moving * 0.07 - distance * 0.015 - (kim.jump > 0 ? 0.2 : 0), 0.25, 0.9);
    const hit = Math.random() < chance;
    // Daneben: die Spur geht knapp vorbei
    if (!hit) { aimAt.x += (Math.random() - 0.5) * 2.4; aimAt.y += Math.random() * 0.8; aimAt.z += (Math.random() - 0.5) * 2.4; aimDir.copy(aimAt).sub(muzzle).normalize(); }
    const tracer = bit("tracer", muzzle, "#fff1b8", aimDir.x * 70, aimDir.y * 70, aimDir.z * 70, Math.min(0.3, (length + (hit ? 0 : 6)) / 70));
    tracer.rotation.set(0, 0, 0);
    tracer.lookAt(aimAt);
    if (!hit) return;
    if (driving) harm(driving, heli ? 6 : 5); else hurtKim(heli ? 10 : 14, kim.group.position.x, kim.group.position.z);
  }
  // Arm auf das Ziel richten (nach der Bewegung, jedes Bild)
  const boneFrom = new THREE.Vector3();
  const boneTo = new THREE.Vector3();
  const boneTurn = new THREE.Quaternion();
  const boneWorld = new THREE.Quaternion();
  const boneParent = new THREE.Quaternion();
  function aimArm(thing) {
    const [upper, lower, hand] = thing.arm || [];
    if (!upper || !lower || !hand) return;
    const lead = driving ? driving.group.position : kim.group.position;
    thing.group.updateMatrixWorld(true);
    upper.getWorldPosition(boneFrom);
    aimDir.set(lead.x - boneFrom.x, lead.y + (driving ? driving.item.h * 0.5 : kim.height * 0.6) - boneFrom.y, lead.z - boneFrom.z).normalize();
    for (const [bone, child] of [[upper, lower], [lower, hand]]) {
      bone.getWorldPosition(boneFrom);
      child.getWorldPosition(boneTo);
      boneTurn.setFromUnitVectors(boneTo.sub(boneFrom).normalize(), aimDir);
      bone.getWorldQuaternion(boneWorld);
      bone.parent.getWorldQuaternion(boneParent);
      bone.quaternion.copy(boneParent.invert().multiply(boneTurn).multiply(boneWorld));
      bone.updateMatrixWorld(true);
    }
  }
  // Polizist: ruft Kim an, läuft auf Schussweite heran und schießt, bis Kim umfällt. Kämpfen kann man gegen ihn nicht, nur wegrennen.
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
      if (!thing.back && (wanted <= 0 || thing.cool > 0 || distance > 34 || thing.out > 40 || (driving && Math.abs(driving.speed) > 4 && distance > 14))) thing.back = true;
      if (thing.back) {
        thing.aiming = false;
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
    const hunting = wanted > 0 && thing.cool <= 0 && kim.ready && !kim.dead && kim.safe <= 0 && distance < 45 && !(driving && driving.alt > 3);
    thing.aiming = false;
    if (hunting) {
      if (!thing.called) { thing.called = true; thing.aim = 2.4; sound.play("polizei_anhalten", loudness(thing.group.position, 6, 50)); }
      thing.yaw = dampAngle(thing.yaw, Math.atan2(dx, dz), 7, dt);
      if (distance > 13) {
        // Auf Schussweite heran
        const speed = distance > 18 ? 5.3 : 3.6;
        thing.x = THREE.MathUtils.clamp(thing.x + Math.sin(thing.yaw) * speed * dt, -EDGE, EDGE);
        thing.z = THREE.MathUtils.clamp(thing.z + Math.cos(thing.yaw) * speed * dt, -EDGE, EDGE);
        thing.home.set(thing.x, thing.z);
        npcPlay(thing, thing.actions.Run ? "Run" : "Walk", speed / 5.2);
      } else {
        npcPlay(thing, "Idle");
        thing.aiming = true;
        thing.aim -= dt;
        if (thing.aim <= 0) { thing.aim = 0.85 + Math.random() * 0.6; shoot(thing, distance); }
      }
    } else {
      thing.called = false;
      npcPlay(thing, thing.cool > 0 && thing.cool < 5 ? "Look" : "Idle");
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
    if (thing.state === "chase" && wanted <= 0) { thing.state = "patrol"; thing.cool = 3; }
    if (thing.state === "patrol" && wanted > 0 && thing.cool <= 0 && kim.ready && !kim.dead && kim.safe <= 0 && toLead < 60 && leadAlt < 5) { thing.state = "chase"; thing.lost = 0; thing.hunt = 0; }
    if (thing.state === "chase") {
      thing.lost = toLead > 75 || leadAlt > 6 ? thing.lost + dt : 0;
      thing.hunt += dt;
      const near = thing.radius + (driving ? driving.radius : 0);
      if (thing.lost > 5) { thing.state = "patrol"; thing.cool = 6; }
      // Anhalten, wenn Kim steht. Läuft er zu Fuß immer weiter, hält die Streife nach ein paar Sekunden in Schussweite.
      else if ((toLead < near + 3.4 && leadSpeed < 2.6 && Math.abs(thing.speed) < 2.5) || (!driving && thing.hunt > 6 && toLead < near + 9 && Math.abs(thing.speed) < 9)) {
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
      // Kommt kein Polizist mehr zurück (besiegt), fährt die Streife nach einer Weile weiter
      thing.empty = thing.officer ? 0 : (thing.empty || 0) + dt;
      if (thing.empty > 5) { thing.state = "patrol"; thing.cool = 20; thing.empty = 0; }
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
    // Friedlich: der Hubschrauber bleibt am Boden (oder landet wieder), bis die Polizei alarmiert ist
    if (wanted <= 0) {
      thing.called = false;
      if (thing.alt > 0) { thing.alt = Math.max(0, thing.alt - 3 * dt); settle(thing, 1); }
      return;
    }
    thing.wait -= dt;
    if (thing.wait > 0) return;
    thing.alt = damp(thing.alt, thing.item.fly.cruise, 0.6, dt);
    if (thing.alt < 4) { settle(thing, 1); return; }
    const lead = driving ? driving.group.position : kim.group.position;
    thing.cool = Math.max(0, thing.cool - dt);
    const range = Math.hypot(lead.x - thing.x, lead.z - thing.z);
    if (thing.cool <= 0 && kim.ready && !kim.dead && kim.safe <= 0 && range < 24 && !(driving && driving.alt > 3)) {
      if (!thing.called) { thing.called = true; thing.aim = 2.6; sound.play("polizei_hubschrauber", 1); }
      thing.aim -= dt;
      if (thing.aim <= 0) { thing.aim = 0.2; shoot(thing, range); }
    } else if (range > 40) thing.called = false;
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
  // Weglaufen, solange Kim in der Nähe ist (etwas langsamer als Kim rennt, er kann sie einholen)
  function flee(thing, dt) {
    const lead = driving ? driving.group.position : kim.group.position;
    const dx = thing.x - lead.x;
    const dz = thing.z - lead.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 13 || kim.dead) return false;
    // Am Rand der Wiese seitlich ausweichen statt in der Ecke zu stehen
    let away = Math.atan2(dx, dz);
    if (Math.abs(thing.x) > EDGE - 3 || Math.abs(thing.z) > EDGE - 3) away += 1.2 * (thing.key % 2 ? 1 : -1);
    thing.yaw = dampAngle(thing.yaw, away, 7, dt);
    thing.x = THREE.MathUtils.clamp(thing.x + Math.sin(thing.yaw) * 5.4 * dt, -EDGE, EDGE);
    thing.z = THREE.MathUtils.clamp(thing.z + Math.cos(thing.yaw) * 5.4 * dt, -EDGE, EDGE);
    thing.home.set(thing.x, thing.z);
    settle(thing, 1);
    return true;
  }
  function wander(thing, dt) {
    const rule = thing.item.wander;
    thing.scared = Math.max(0, (thing.scared || 0) - dt);
    if (thing.afraid && thing.scared < 0.6 && !kim.dead) {
      // Angegriffenes Tier: flieht, sobald Kim wieder näher kommt
      const lead = driving ? driving.group.position : kim.group.position;
      const dx = thing.x - lead.x;
      const dz = thing.z - lead.z;
      const distance = Math.hypot(dx, dz) || 1;
      if (distance < 11) {
        const side = Math.abs(thing.x) > EDGE - 4 || Math.abs(thing.z) > EDGE - 4 ? 1.2 * (thing.key % 2 ? 1 : -1) : 0;
        const away = Math.atan2(dx, dz) + side;
        thing.goal = new THREE.Vector2(THREE.MathUtils.clamp(thing.x + Math.sin(away) * 12, -EDGE, EDGE), THREE.MathUtils.clamp(thing.z + Math.cos(away) * 12, -EDGE, EDGE));
        thing.home.set(thing.goal.x, thing.goal.y);
        thing.scared = 2.5;
      }
    }
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
        const speed = rule.speed * (thing.scared ? (thing.afraid ? 4 : 2.6) : 1);
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
  // Spielzeit in Sekunden (steht beim Bauen und bei offener Hilfe)
  let now = 0;
  function simulate(dt) {
    now += dt;
    if (kim.ready) {
      if (kim.busy) {
        kim.busy.left -= dt;
        if (kim.busy.left <= 0) { const then = kim.busy.then; kim.busy = null; then(); }
      }
      readStick();
      if (driving) drive(driving, dt); else { if (!kim.busy) followTap(); moveKim(dt); }
      moveSword(dt);
      // Erholen: nach ein paar ruhigen Sekunden kommt das Leben zurück
      kim.safe = Math.max(0, kim.safe - dt);
      if (!kim.dead && kim.hp < 100 && now - kim.hurtAt > 5) kim.hp = Math.min(100, kim.hp + 7 * dt);
      kim.mixer.update(dt);
      if (kim.lie) {
        kim.lie.t = Math.min(kim.lie.time, kim.lie.t + dt);
        kim.group.rotation.x = -kim.lie.angle * THREE.MathUtils.smoothstep(kim.lie.t / kim.lie.time, 0, 1);
      }
      if (kim.climb) {
        const climb = kim.climb;
        climb.t += dt;
        const k = THREE.MathUtils.clamp((climb.t - (climb.delay || 0)) / climb.time, 0, 1);
        const rise = kim.rise;
        if (climb.seat - climb.ground < 0.3 && rise?.bone && Math.abs(rise.stand - rise.sit) > 0.001) {
          // Flaches Fahrzeug: Kim steht so weit über dem Sitz, wie er sich in der Bewegung aufgerichtet hat.
          // Steht er aufrecht, steht er auf dem Boden und steckt nicht darin.
          const up = THREE.MathUtils.clamp((rise.bone.position.y - rise.sit) / (rise.stand - rise.sit), 0, 1);
          kim.group.position.y = THREE.MathUtils.lerp(climb.seat, climb.ground, up);
        } else {
          // Hohes Fahrzeug: drei Tritte zwischen Boden und Sitzhöhe
          const stepped = (Math.floor(k * 3) + THREE.MathUtils.smoothstep((k * 3) % 1, 0.15, 0.7)) / 3;
          const done = k >= 1 ? 1 : stepped;
          kim.group.position.y = climb.up ? THREE.MathUtils.lerp(climb.ground, climb.seat, done) : THREE.MathUtils.lerp(climb.seat, climb.ground, done);
        }
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
      if (thing.dead && !thing.item.mob) { fallen(thing, dt); thing.mixer?.update(dt); continue; }
      if (thing.item.npc) {
        setupNpc(thing);
        if (thing.mixer) {
          if (thing.item.npc.chase && !reduceMotion) chase(thing, dt);
          else if (thing.afraid && !reduceMotion && flee(thing, dt)) npcPlay(thing, thing.actions.Run ? "Run" : "Walk", 1);
          else { if (thing.pose === "Run") npcPlay(thing, "Idle"); thing.wait -= dt; if (thing.wait <= 0) { thing.wait = 6 + Math.random() * 6; npcPlay(thing, thing.pose === "Idle" ? "Look" : "Idle"); } }
        }
      } else if (thing.item.mob) { if (!reduceMotion) mob(thing, dt); }
      else if (thing.item.patrol && !reduceMotion) patrol(thing, dt);
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
          // Ruhige Acht um den Piloten (den nächsten Mann mit Fernsteuerung), auf Höhe der fliegenden Autos
          let cx = thing.home.x;
          let cz = thing.home.y;
          let best = 30;
          for (const other of things) {
            if (other.id !== "mann") continue;
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
      if (thing.aiming) aimArm(thing);
    }
    while (doomed.length) removeThing(doomed.pop());
    if (wanted > 0) {
      // Solange Polizei in Sichtweite ist, bleibt die Fahndung bestehen; wer weit genug weg ist, wird sie los
      wanted -= dt;
      const lead = driving ? driving.group.position : kim.group.position;
      if (wanted < 10 && things.some((thing) => !thing.dead && (thing.item.npc?.chase || thing.item.patrol || thing.item.follow) && Math.hypot(thing.x - lead.x, thing.z - lead.z) < 45)) wanted = 10;
      if (wanted <= 0) say("Die Polizei hat dich aus den Augen verloren.", 4);
    }
    if (!reduceMotion && kim.ready) {
      spawnIn -= dt;
      if (spawnIn <= 0) {
        spawnIn = 24 + Math.random() * 22;
        if (things.length < 70 && things.filter((thing) => thing.item.mob && thing.temp).length < 3) spawnMob();
      }
    }
    moveBits(dt);
    for (const thing of things) if (thing.item.drive && thing.hp < 45) smoke(thing, dt);
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
    if (!reduceMotion) wind.value = clock.elapsedTime;
    if (mode === "build") {
      // Bauen: das Spiel steht still, nur aufgestellte Dinge werden gesetzt
      for (const thing of things) if (thing.held) settle(thing, 1);
    } else if (!helpOpen) simulate(dt);
    showHud();
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
      if (driving && (!drag || drag.touch) && clock.elapsedTime - look.last > 2.5 && Math.abs(driving.speed) > 1.5) orbit.yaw = dampAngle(orbit.yaw, driving.yaw + Math.PI, 2.2, dt);
      focus.x = damp(focus.x, lead.x, 8, dt);
      focus.z = damp(focus.z, lead.z, 8, dt);
      focus.y = damp(focus.y, lead.y + (driving ? 1.3 : kim.height * 0.75), 6, dt);
      const distance = orbit.distance * (driving ? 1.25 : 1);
      cameraGoal.set(focus.x + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * distance, focus.y + Math.sin(orbit.pitch) * distance, focus.z + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * distance);
      cameraGoal.y = Math.max(cameraGoal.y, height(cameraGoal.x, cameraGoal.z) + 0.6);
      if (snapCamera) {
        // Neustart am Startpunkt: Kamera springt mit, statt über die Wiese zu schwenken
        snapCamera = false;
        focus.set(lead.x, lead.y + kim.height * 0.75, lead.z);
        cameraGoal.set(focus.x + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * distance, focus.y + Math.sin(orbit.pitch) * distance, focus.z + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * distance);
        camera.position.copy(cameraGoal);
      } else camera.position.lerp(cameraGoal, 1 - Math.exp(-14 * dt));
    }
    camera.lookAt(focus);
    sun.position.copy(focus).addScaledVector(SUN_DIR, 60);
    dome.position.set(camera.position.x, 0, camera.position.z);
    clouds.rotation.y += dt * 0.004;
    sun.target.position.copy(focus);
    // Medaillon aufnehmen, sobald Kim angekommen ist und ruhig steht
    if (!hud.portrait && mode === "play" && kim.ready && !driving && !kim.target && !kim.busy && kim.current === "Idle" && kim.speed < 0.05 && clock.elapsedTime > 2) {
      takePortrait();
      say(stageEl.classList.contains("is-touch") ? "Finger auf die Wiese legen und ziehen: Kim läuft dorthin. Tippen: einsteigen, zuschlagen." : "Klick auf die Wiese fängt die Maus. H zeigt die Steuerung.", 8);
    }
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  stageEl.classList.add("is-live");
  // Für die Browser-Tests
  window.kbSpielwiese = { kim, things, orbit, stick, camera, scene, tune,  build, look, radio, sound, sword, hud, alarm, get wanted() { return wanted; }, get now() { return now; }, addThing, enter: enterVehicle, leave: leaveVehicle, setMode, setHelp, setSword, strike, hurtKim, hurtMob, spawnMob, get help() { return helpOpen; }, get mode() { return mode; }, get driving() { return driving; } };
  requestAnimationFrame(tick);
}
