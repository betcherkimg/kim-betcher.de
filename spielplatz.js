// Spielplatz: kleine 3D-Wiese. Kim laufen lassen, Dinge aus der Leiste auf die Wiese ziehen, einsteigen und losfahren.
// Die Map wird nur im Browser gemerkt (localStorage "kb-spielplatz-v1"), Kims Aussehen kommt aus dem Charakter-Editor.
import * as THREE from "three";
import { GLTFLoader } from "./vendor/three/GLTFLoader.js";
import { MeshoptDecoder } from "./vendor/three/meshopt_decoder.module.js";

const ASSET_VERSION = "1";
const MAP_KEY = "kb-spielplatz-v1";
const LOOK_KEY = "kb-figur-v1";
const SIZE = 110; // Kantenlänge der Wiese in Metern
const EDGE = SIZE / 2 - 4;

// Dinge für die Leiste. h: Zielhöhe in Metern, yaw: Drehung, damit "vorn" nach +Z zeigt,
// drive: fahrbar, hover: schwebt so hoch, wander: läuft von selbst herum
const CATALOG = [
  { id: "polizeiauto", name: "Polizeiauto", group: "Fahrzeuge", h: 1.2, drive: { speed: 15, turn: 2.2 } },
  { id: "schweber", name: "E-Quester Flight", group: "Fahrzeuge", h: 0.85, hover: 0.45, drive: { speed: 19, turn: 2.4 } },
  { id: "monstertruck", name: "Monstertruck", group: "Fahrzeuge", h: 1.8, drive: { speed: 13, turn: 1.8 } },
  { id: "gokart", name: "Gokart", group: "Fahrzeuge", h: 0.68, drive: { speed: 17, turn: 2.8 } },
  { id: "hubschrauber", name: "Polizei-Hubschrauber", group: "Fahrzeuge", h: 2.9 },
  { id: "polizist", name: "Polizist", group: "Leute", h: 1.7, armsDown: 72 },
  { id: "kind", name: "Kind mit Fernsteuerung", group: "Leute", h: 1.3, armsDown: 62 },
  { id: "drohne", name: "Drohne", group: "Leute", h: 0.22, hover: 2.3, orbit: true, hull: true },
  { id: "pferd", name: "Pferd", group: "Tiere", h: 1.6, wander: { walk: "Schritt", speed: 1.3 } },
  { id: "fuchs", name: "Fuchs", group: "Tiere", h: 0.62, wander: { walk: "Walk", idle: "Idle", speed: 1.1 } },
  { id: "eiche", name: "Eiche", group: "Grün", h: 7.2, hull: true },
  { id: "birke", name: "Birke", group: "Grün", h: 6.3, hull: true },
  { id: "fichte", name: "Fichte", group: "Grün", h: 8, hull: true },
  { id: "busch", name: "Busch", group: "Grün", h: 0.9, hull: true },
  { id: "sonnenblume", name: "Sonnenblume", group: "Grün", h: 1.5, hull: true },
  { id: "mohn", name: "Klatschmohn", group: "Grün", h: 0.7, hull: true }
];
const byId = Object.fromEntries(CATALOG.map((item) => [item.id, item]));

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
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const sky = new THREE.Color("#9fd0f2");
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 45, 115);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
  scene.add(new THREE.HemisphereLight("#ffffff", "#5d7a45", 1.5));
  const sun = new THREE.DirectionalLight("#fff3d6", 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -28;
  sun.shadow.camera.right = sun.shadow.camera.top = 28;
  sun.shadow.camera.far = 120;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

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
  const ground = new THREE.Mesh(groundGeometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
  ground.receiveShadow = true;
  scene.add(ground);

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const clock = new THREE.Clock();
  const damp = (value, target, lambda, dt) => THREE.MathUtils.lerp(value, target, 1 - Math.exp(-lambda * dt));
  const dampAngle = (value, target, lambda, dt) => value + Math.atan2(Math.sin(target - value), Math.cos(target - value)) * (1 - Math.exp(-lambda * dt));
  const say = (text) => { if (statusEl) statusEl.textContent = text; };

  // Kim: dieselbe Figur wie auf der Startseite, mit dem Aussehen aus dem Charakter-Editor
  const kim = { group: new THREE.Group(), mixer: null, actions: {}, current: "", yaw: 0, speed: 0, jump: 0, target: null, ready: false, height: 1.75 };
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
    const box = new THREE.Box3().setFromObject(gltf.scene);
    gltf.scene.position.y = -box.min.y;
    kim.height = box.max.y - box.min.y;
    kim.group.add(gltf.scene);
    kim.mixer = new THREE.AnimationMixer(gltf.scene);
    for (const clip of gltf.animations) kim.actions[clip.name.replace(/^[A-Za-z]+_/, "")] = kim.mixer.clipAction(clip);
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
    next.reset().setEffectiveWeight(1).play();
    if (previous && fade > 0) next.crossFadeFrom(previous, fade, false); else previous?.stop();
    kim.current = name;
  }

  // Modelle: einmal laden, für jedes platzierte Ding klonen
  const models = {};
  function loadModel(id) {
    if (!models[id]) {
      models[id] = loader.loadAsync(`assets/spielplatz/${id}.glb?v=${ASSET_VERSION}`).then((gltf) => {
        const item = byId[id];
        gltf.scene.updateMatrixWorld(true);
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
        return { gltf, scale, offset: new THREE.Vector3(-center.x, -box.min.y, -center.z), radius: Math.max(size.x, size.z) * scale / 2 };
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
    const thing = { key: nextKey, id, item, group, tilt, x, z, yaw, radius: model.radius, speed: 0, home: new THREE.Vector2(x, z), phase: Math.random() * 6.28, mixer: null, actions: {}, wait: 1 + Math.random() * 3, goal: null };
    nextKey += 1;
    group.userData.thing = thing;
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
    if (driving === thing) leaveVehicle();
    scene.remove(thing.group);
    things.splice(things.indexOf(thing), 1);
    if (selected === thing) select(null);
    saveMap();
  }
  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();
  const tiltTarget = new THREE.Quaternion();
  // Auf den Boden setzen: Höhe der Wiese, Fahrzeuge neigen sich mit dem Hang
  function settle(thing, blend) {
    const lift = thing.item.hover ? thing.item.hover + Math.sin(clock.elapsedTime * 2 + thing.phase) * 0.06 : 0;
    thing.group.position.set(thing.x, height(thing.x, thing.z) + lift, thing.z);
    thing.group.rotation.y = thing.yaw;
    if (thing.item.drive || thing.item.wander) {
      normalAt(thing.x, thing.z, normal).applyAxisAngle(up, -thing.yaw);
      tiltTarget.setFromUnitVectors(up, normal);
      thing.tilt.quaternion.slerp(tiltTarget, blend);
    }
  }
  function saveMap() {
    try { window.localStorage.setItem(MAP_KEY, JSON.stringify(things.map((thing) => [thing.id, Math.round(thing.x * 100) / 100, Math.round(thing.z * 100) / 100, Math.round(thing.yaw * 100) / 100]))); } catch { /* nur Bequemlichkeit */ }
  }
  function loadMap() {
    let saved = null;
    try { saved = JSON.parse(window.localStorage.getItem(MAP_KEY) || "null"); } catch { saved = null; }
    // Erster Besuch: ein paar Dinge stehen schon da
    const list = Array.isArray(saved) ? saved : [["eiche", -9, 7, 0.4], ["birke", 11, 9, 1.2], ["fichte", -13, -6, 0], ["busch", 6, -7, 0.7], ["sonnenblume", -4, 9, 0], ["polizeiauto", 7, 3, -0.9], ["fuchs", -6, -3, 1.5]];
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
      button.innerHTML = `<img src="assets/spielplatz/bilder/${item.id}.webp?v=${ASSET_VERSION}" alt="" width="96" height="72" loading="lazy"><span>${item.name}</span>`;
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
        tools.querySelector('[data-tool="drive"]').hidden = !thing.item.drive;
      }
    }
  }
  tools?.addEventListener("click", (event) => {
    const tool = event.target.closest("[data-tool]")?.dataset.tool;
    if (!tool || !selected) return;
    if (tool === "left" || tool === "right") { selected.yaw += tool === "left" ? Math.PI / 8 : -Math.PI / 8; settle(selected, 1); saveMap(); }
    else if (tool === "remove") removeThing(selected);
    else if (tool === "drive") enterVehicle(selected);
    else if (tool === "close") select(null);
  });
  document.querySelector("[data-play-clear]")?.addEventListener("click", () => {
    if (driving) leaveVehicle();
    for (const thing of [...things]) scene.remove(thing.group);
    things.length = 0;
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
      if (!thing.item.drive) continue;
      const distance = Math.hypot(thing.x - kim.group.position.x, thing.z - kim.group.position.z) - thing.radius;
      if (distance < bestDistance) { best = thing; bestDistance = distance; }
    }
    return best;
  }
  function enterVehicle(thing) {
    if (!thing?.item.drive || !kim.ready) return;
    driving = thing;
    thing.speed = 0;
    kim.group.visible = false;
    kim.target = null;
    select(null);
    if (driveButton) driveButton.hidden = false;
    say(`${thing.item.name}: W/S Gas und Bremse, A/D lenken, E aussteigen`);
  }
  function leaveVehicle() {
    if (!driving) return;
    const thing = driving;
    driving = null;
    thing.speed = 0;
    const side = thing.radius + 0.9;
    kim.group.position.set(thing.x + Math.cos(thing.yaw) * side, 0, thing.z - Math.sin(thing.yaw) * side);
    kim.yaw = thing.yaw;
    kim.group.visible = true;
    if (driveButton) driveButton.hidden = true;
    say("");
    saveMap();
  }
  driveButton?.addEventListener("click", leaveVehicle);

  // Eingaben: Tasten, Klick auf die Wiese (hinlaufen), Ziehen dreht die Kamera, Mausrad zoomt
  const keys = new Set();
  const typing = (event) => event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]");
  window.addEventListener("keydown", (event) => {
    if (typing(event) || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " ", "shift", "e", "delete", "backspace", "q", "r"].includes(key)) {
      if (key === " " || key.startsWith("arrow")) event.preventDefault();
      if (!event.repeat) {
        if (key === "e") { if (driving) leaveVehicle(); else enterVehicle(selected?.item.drive ? selected : nearestVehicle()); }
        if ((key === "delete" || key === "backspace") && selected) removeThing(selected);
        if ((key === "q" || key === "r") && selected) { selected.yaw += key === "q" ? Math.PI / 8 : -Math.PI / 8; settle(selected, 1); saveMap(); }
        if (key === " " && !driving && kim.ready && kim.jump <= 0) { kim.jump = 0.0001; kim.vy = 6.2; }
      }
      keys.add(key);
      hint?.classList.add("is-used");
    }
  });
  window.addEventListener("keyup", (event) => keys.delete(event.key.toLowerCase()));
  window.addEventListener("blur", () => keys.clear());
  // Start: schräg, halb von vorn
  const orbit = { yaw: Math.PI - 0.65, pitch: 0.24, distance: 8.5 };
  let drag = null;
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button > 1) return;
    const thing = thingAt(event.clientX, event.clientY);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: 0, thing, moving: false };
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
    orbit.yaw -= dx * 0.006;
    orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + dy * 0.004, 0.06, 1.25);
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const mine = drag;
    drag = null;
    if (mine.thing) mine.thing.held = false;
    if (mine.moving) { saveMap(); return; }
    if (mine.moved >= 8 || event.type === "pointercancel") return;
    if (mine.thing) { select(mine.thing === selected ? null : mine.thing); return; }
    select(null);
    const spot = groundAt(event.clientX, event.clientY);
    if (spot && !driving && kim.ready) { kim.target = spot.clone(); kim.run = false; hint?.classList.add("is-used"); }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    orbit.distance = THREE.MathUtils.clamp(orbit.distance * (event.deltaY > 0 ? 1.1 : 0.9), 4, 30);
  }, { passive: false });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  // Steuerkreuz für Finger
  const pad = document.querySelector("[data-play-pad]");
  pad?.querySelectorAll("[data-key]").forEach((button) => {
    const key = button.dataset.key;
    const press = (event) => { event.preventDefault(); if (key === "e") { if (driving) leaveVehicle(); else enterVehicle(nearestVehicle()); } else if (key === " ") { if (!driving && kim.ready && kim.jump <= 0) { kim.jump = 0.0001; kim.vy = 6.2; } } else keys.add(key); };
    const lift = () => keys.delete(key);
    button.addEventListener("pointerdown", press);
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) button.addEventListener(type, lift);
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
    const wanted = length > 0.001 ? (running ? 6.4 : 2.5) : 0;
    kim.speed = damp(kim.speed, wanted, 9, dt);
    if (length > 0.001) {
      kim.yaw = dampAngle(kim.yaw, Math.atan2(moveX, moveZ), 12, dt);
      position.x = THREE.MathUtils.clamp(position.x + (moveX / length) * kim.speed * dt, -EDGE, EDGE);
      position.z = THREE.MathUtils.clamp(position.z + (moveZ / length) * kim.speed * dt, -EDGE, EDGE);
    }
    // Um Bäume, Autos und Leute herum statt hindurch
    for (const thing of things) {
      if (thing.held || thing.item.hover > 1) continue;
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
      if (kim.jump <= 0) kim.jump = 0;
    }
    position.y = floor + Math.max(0, kim.jump);
    kim.group.rotation.y = kim.yaw;
    if (kim.jump > 0) kimPlay("Jump", 0.15, 1.6);
    else if (kim.speed > 4) kimPlay("Run", 0.2, kim.speed / 5.2);
    else if (kim.speed > 0.4) kimPlay("Walk", 0.2, kim.speed / 1.9);
    else kimPlay("Idle", 0.3);
  }
  function drive(thing, dt) {
    const gas = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
    const steer = (keys.has("a") || keys.has("arrowleft") ? 1 : 0) - (keys.has("d") || keys.has("arrowright") ? 1 : 0);
    const top = thing.item.drive.speed * (keys.has("shift") ? 1.35 : 1);
    thing.speed = damp(thing.speed, gas > 0 ? top : gas < 0 ? -top * 0.45 : 0, gas ? 1.6 : 1.1, dt);
    const grip = THREE.MathUtils.clamp(Math.abs(thing.speed) / 4, 0, 1) * Math.sign(thing.speed || 1);
    thing.yaw += steer * thing.item.drive.turn * grip * dt;
    const nx = thing.x + Math.sin(thing.yaw) * thing.speed * dt;
    const nz = thing.z + Math.cos(thing.yaw) * thing.speed * dt;
    if (Math.abs(nx) > EDGE || Math.abs(nz) > EDGE) thing.speed *= -0.3;
    thing.x = THREE.MathUtils.clamp(nx, -EDGE, EDGE);
    thing.z = THREE.MathUtils.clamp(nz, -EDGE, EDGE);
    // Anstoßen: andere Dinge bremsen, kleine Pflanzen werden überfahren
    for (const other of things) {
      if (other === thing || other.held || other.item.hover > 1 || (other.item.group === "Grün" && other.item.h < 2)) continue;
      const reach = (other.item.group === "Grün" ? 0.5 : other.radius * 0.8) + thing.radius * 0.7;
      const dx = thing.x - other.x;
      const dz = thing.z - other.z;
      const distance = Math.hypot(dx, dz);
      if (distance < reach && distance > 0.0001) {
        thing.x = other.x + (dx / distance) * reach;
        thing.z = other.z + (dz / distance) * reach;
        thing.speed *= 0.5;
        if (other.item.wander) { other.goal = new THREE.Vector2(other.x - dx * 3, other.z - dz * 3); other.wait = 0; other.scared = 2.5; }
      }
    }
    settle(thing, 1 - Math.exp(-8 * dt));
    kim.group.position.set(thing.x, height(thing.x, thing.z), thing.z);
    kim.yaw = thing.yaw;
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

  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (kim.ready) {
      if (driving) drive(driving, dt); else moveKim(dt);
      kim.mixer.update(dt);
    }
    for (const thing of things) {
      if (thing.held || thing === driving) continue;
      if (thing.item.wander && !reduceMotion) wander(thing, dt);
      else if (thing.item.orbit && !reduceMotion) {
        // Drohne kreist langsam um ihren Platz
        thing.phase += dt * 0.5;
        thing.x = thing.home.x + Math.cos(thing.phase) * 2.2;
        thing.z = thing.home.y + Math.sin(thing.phase) * 2.2;
        thing.yaw = -thing.phase;
        settle(thing, 1);
      } else if (thing.item.hover) settle(thing, 1);
      thing.mixer?.update(dt);
    }
    if (selected) {
      const size = Math.max(0.6, selected.radius * 1.15);
      ring.scale.setScalar(size);
      ring.position.set(selected.x, height(selected.x, selected.z) + 0.06, selected.z);
    }
    // Kamera folgt Kim oder dem Fahrzeug
    const lead = driving ? driving.group.position : kim.group.position;
    if (driving && !drag) orbit.yaw = dampAngle(orbit.yaw, driving.yaw + Math.PI, 2.2, dt);
    focus.x = damp(focus.x, lead.x, 8, dt);
    focus.z = damp(focus.z, lead.z, 8, dt);
    focus.y = damp(focus.y, lead.y + (driving ? 1.2 : kim.height * 0.75), 6, dt);
    const distance = orbit.distance * (driving ? 1.25 : 1);
    cameraGoal.set(focus.x + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * distance, focus.y + Math.sin(orbit.pitch) * distance, focus.z + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * distance);
    cameraGoal.y = Math.max(cameraGoal.y, height(cameraGoal.x, cameraGoal.z) + 0.6);
    camera.position.copy(cameraGoal);
    camera.lookAt(focus);
    sun.position.set(focus.x + 22, focus.y + 38, focus.z + 14);
    sun.target.position.copy(focus);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  stageEl.classList.add("is-live");
  // Für die Browser-Tests
  window.kbSpielplatz = { kim, things, orbit, addThing };
  requestAnimationFrame(tick);
}
