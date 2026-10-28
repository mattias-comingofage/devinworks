import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { LAYOUTS, computeStats } from "./layouts.js";
import { colorize, legendHtml } from "./colors.js";
import { ingestFiles, filesFromDataTransfer, loadManifest, embeddedThumbnail } from "./ingest.js";
import { makeDemo, demoImageUrl } from "./demo.js";
import { normalizePhoto, fmtDate, fmtShort } from "./util.js";

// Set to false to never send coordinates to OpenStreetMap for place names.
const REVERSE_GEOCODE = true;

const $ = (s) => document.querySelector(s);
const state = {
  photos: [], stats: null, layout: "galaxy", color: "hour", lines: true,
  selected: -1, hovered: -1, order: [], rank: new Int32Array(0), sourceLabel: "",
};

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$("#stage").appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.className = "labels";
document.body.insertBefore(labelRenderer.domElement, $("#hud"));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 8000);
camera.position.set(0, 250, 300);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.zoomSpeed = 1.2;
controls.minDistance = 0.5;
controls.maxDistance = 3000;

const starMaterial = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 1 }, uMinSize: { value: 2.2 } },
  vertexShader: `
    attribute float size;
    attribute vec3 color;
    uniform float uScale;
    uniform float uMinSize;
    varying vec3 vColor;
    varying float vFade;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float s = size * uScale / max(-mv.z, 0.001);
      vFade = clamp(s / uMinSize, 0.25, 1.0);
      gl_PointSize = clamp(s, uMinSize, 90.0);
      gl_Position = projectionMatrix * mv;
      vColor = color;
    }`,
  fragmentShader: `
    varying vec3 vColor;
    varying float vFade;
    void main() {
      float d = length(gl_PointCoord - 0.5) * 2.0;
      if (d > 1.0) discard;
      float glow = pow(1.0 - d, 2.2);
      float core = pow(1.0 - d, 10.0);
      vec3 c = vColor * glow + vec3(1.0) * core * 0.9;
      gl_FragColor = vec4(c * vFade, 1.0);
    }`,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

const starGeo = new THREE.BufferGeometry();
const stars = new THREE.Points(starGeo, starMaterial);
stars.frustumCulled = false;
scene.add(stars);

const lineGeo = new THREE.BufferGeometry();
const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false,
}));
lines.frustumCulled = false;
scene.add(lines);

// Faint distant dust for depth.
{
  const n = 5000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(1400 + Math.random() * 2400);
    pos.set([v.x, v.y, v.z], i * 3);
    const b = 0.25 + Math.random() * 0.35;
    col.set([b * 0.9, b * 0.95, b * 1.1], i * 3);
    size[i] = 2 + Math.random() * 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("size", new THREE.BufferAttribute(size, 1));
  const dust = new THREE.Points(g, starMaterial);
  dust.frustumCulled = false;
  scene.add(dust);
}

// Reticle that marks the hovered / selected star.
function ringTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d");
  x.strokeStyle = "white"; x.lineWidth = 5;
  x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.stroke();
  return new THREE.CanvasTexture(c);
}
const reticleMat = new THREE.SpriteMaterial({ map: ringTexture(), sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.8 });
const hoverRing = new THREE.Sprite(reticleMat);
hoverRing.scale.setScalar(0.035);
hoverRing.visible = false;
hoverRing.renderOrder = 10;
scene.add(hoverRing);
const selectRing = new THREE.Sprite(reticleMat.clone());
selectRing.material.color.set("#ffd27a");
selectRing.scale.setScalar(0.05);
selectRing.visible = false;
selectRing.renderOrder = 10;
scene.add(selectRing);

// The photo itself, floating in space where its star is.
const photoSprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, opacity: 0, depthWrite: false }));
photoSprite.visible = false;
photoSprite.renderOrder = 5;
scene.add(photoSprite);

let guides = null;
const labelGroup = new THREE.Group();
scene.add(labelGroup);

// ---------- building the galaxy ----------
let anim = null;

function setPhotos(photos, label) {
  state.photos = photos.map(normalizePhoto);
  state.sourceLabel = label;
  deselect();
  rebuild({ animate: false, frame: true });
}

function addPhotos(batch) {
  const seen = new Set(state.photos.map((p) => p.id));
  for (const p of batch) if (!seen.has(p.id)) state.photos.push(normalizePhoto(p));
  rebuild({ animate: false, frame: false });
}

function rebuild({ animate, frame }) {
  const photos = state.photos;
  const n = photos.length;
  state.stats = computeStats(photos);

  // Chronological order, used for prev/next navigation and constellations.
  state.order = photos.map((_, i) => i).filter((i) => photos[i].date != null)
    .sort((a, b) => photos[a].date - photos[b].date);
  state.rank = new Int32Array(n).fill(-1);
  state.order.forEach((idx, r) => (state.rank[idx] = r));

  const L = LAYOUTS[state.layout](photos, state.stats);
  const prev = starGeo.getAttribute("position");
  if (animate && prev && prev.count === n) {
    anim = { from: prev.array.slice(), to: L.positions, t0: performance.now(), dur: 1400 };
  } else {
    starGeo.setAttribute("position", new THREE.BufferAttribute(L.positions, 3));
    anim = null;
  }
  if (!animate || !starGeo.getAttribute("color") || starGeo.getAttribute("color").count !== n) {
    starGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const size = new Float32Array(n);
    photos.forEach((p, i) => (size[i] = p.mag));
    starGeo.setAttribute("size", new THREE.BufferAttribute(size, 1));
  }
  recolor();
  buildConstellations();

  if (guides) scene.remove(guides);
  guides = L.guides;
  scene.add(guides);

  labelGroup.clear();
  for (const l of L.labels) {
    const el = document.createElement("div");
    el.className = "axis-label";
    el.textContent = l.text;
    const o = new CSS2DObject(el);
    o.position.set(...l.pos);
    labelGroup.add(o);
  }

  if (frame) flyTo(new THREE.Vector3(...L.view.target), new THREE.Vector3(...L.view.position), 1600);
  updateHud();
}

function recolor() {
  const attr = starGeo.getAttribute("color");
  colorize(state.photos, state.color, state.stats, attr.array);
  attr.needsUpdate = true;
  $("#legend").innerHTML = legendHtml(state.photos, state.color, state.stats);
  buildConstellations();
}

// Photos from the same day, shot within 3 hours of each other, are linked into constellations.
let linePairs = new Uint32Array(0);
function buildConstellations() {
  const pairs = [];
  const { order } = state;
  const photos = state.photos;
  for (let k = 1; k < order.length; k++) {
    const a = photos[order[k - 1]], b = photos[order[k]];
    if (b.date - a.date < 3 * 36e5 && (a.lat == null) === (b.lat == null) &&
        new Date(a.date).toDateString() === new Date(b.date).toDateString()) {
      pairs.push(order[k - 1], order[k]);
    }
  }
  linePairs = Uint32Array.from(pairs);
  lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3));
  const col = new Float32Array(pairs.length * 3);
  const sc = starGeo.getAttribute("color");
  if (sc) for (let i = 0; i < pairs.length; i++) col.set(sc.array.subarray(pairs[i] * 3, pairs[i] * 3 + 3), i * 3);
  lineGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  updateLinePositions();
}

function updateLinePositions() {
  const pos = starGeo.getAttribute("position");
  const lp = lineGeo.getAttribute("position");
  if (!pos || !lp) return;
  for (let i = 0; i < linePairs.length; i++) lp.array.set(pos.array.subarray(linePairs[i] * 3, linePairs[i] * 3 + 3), i * 3);
  lp.needsUpdate = true;
  lines.visible = state.lines;
}

function starPos(i, out = new THREE.Vector3()) {
  const a = starGeo.getAttribute("position").array;
  const target = anim ? anim.to : a;
  return out.set(target[i * 3], target[i * 3 + 1], target[i * 3 + 2]);
}

// ---------- camera flights ----------
let flight = null;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function flyTo(target, position, dur = 1200) {
  flight = {
    t0: performance.now(), dur,
    fromT: controls.target.clone(), toT: target,
    fromP: camera.position.clone(), toP: position,
  };
}

function flyToStar(i) {
  const p = starPos(i);
  const dir = camera.position.clone().sub(controls.target).normalize();
  flyTo(p.clone(), p.clone().add(dir.multiplyScalar(9)), 1300);
}

// ---------- selection ----------
let objectUrl = null;
let geoCache = new Map();
let selectToken = 0;

async function select(i, fly = true) {
  if (i < 0 || i >= state.photos.length) return;
  state.selected = i;
  const p = state.photos[i];
  const token = ++selectToken;
  if (fly) flyToStar(i);
  selectRing.visible = true;
  $("#panel").hidden = false;

  $("#p-date").textContent = (p.approxDate ? "≈ " : "") + fmtDate(p.date);
  $("#p-place").textContent = p.lat != null ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` : "No location";
  $("#p-camera").textContent = [p.make && !p.model?.startsWith(p.make) ? p.make : null, p.model, p.lens]
    .filter(Boolean).join(" · ") || "Unknown camera";
  const exp = [
    p.fnum && `ƒ/${+p.fnum.toFixed(1)}`,
    p.exp && (p.exp < 1 ? `1/${Math.round(1 / p.exp)}s` : `${p.exp}s`),
    p.iso && `ISO ${p.iso}`,
    p.focal && `${Math.round(p.focal)}mm`,
  ].filter(Boolean).join(" · ");
  $("#p-exposure").textContent = exp;
  $("#p-file").textContent = p.path || p.name || "";
  const r = state.rank[i];
  if (r >= 0) {
    const day = new Date(p.date).toDateString();
    const sameDay = state.order.filter((k) => new Date(state.photos[k].date).toDateString() === day);
    $("#p-day").textContent = `${sameDay.indexOf(i) + 1} of ${sameDay.length} that day · #${r + 1} of ${state.order.length}`;
  } else $("#p-day").textContent = "";

  if (p.lat != null && REVERSE_GEOCODE) placeName(p).then((name) => {
    if (name && token === selectToken) $("#p-place").textContent = name;
  });

  const img = $("#photo");
  img.crossOrigin = "anonymous";
  const msg = $("#photo-msg");
  img.removeAttribute("src");
  msg.textContent = "loading…";
  photoSprite.material.opacity = 0;
  photoSprite.visible = false;
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }

  const candidates = await imageCandidates(p);
  for (const url of candidates) {
    if (token !== selectToken) return;
    const ok = await new Promise((res) => {
      img.onload = () => res(true);
      img.onerror = () => res(false);
      img.src = url;
    });
    if (ok) {
      msg.textContent = "";
      if (token === selectToken) showPhotoSprite(img, i);
      return;
    }
  }
  msg.textContent = "Preview not supported in this browser";
}

async function imageCandidates(p) {
  const s = p.src;
  if (s.type === "demo") return [demoImageUrl(p)];
  if (s.type === "url") return [s.url, s.thumb].filter(Boolean);
  objectUrl = URL.createObjectURL(s.file);
  const list = [objectUrl];
  if (/\.(heic|heif|dng|tiff?)$/i.test(p.name)) {
    const thumb = await embeddedThumbnail(s.file);
    if (thumb) list.push(thumb);
  }
  return list;
}

function showPhotoSprite(img, i) {
  const max = 1024;
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  photoSprite.material.map?.dispose();
  photoSprite.material.map = tex;
  photoSprite.material.needsUpdate = true;
  const h = 3.2;
  photoSprite.scale.set((h * c.width) / c.height, h, 1);
  photoSprite.userData.index = i;
  photoSprite.userData.fadeStart = performance.now();
  photoSprite.visible = true;
}

async function placeName(p) {
  const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const req = fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${p.lat}&lon=${p.lon}`)
    .then((r) => r.json())
    .then((j) => {
      const a = j.address || {};
      const local = a.neighbourhood || a.suburb || a.village || a.town || a.city_district;
      const city = a.city || a.town || a.village || a.municipality || a.county;
      return [local !== city ? local : null, city, a.country].filter(Boolean).join(", ") || null;
    })
    .catch(() => null);
  geoCache.set(key, req);
  return req;
}

function deselect() {
  state.selected = -1;
  selectToken++;
  $("#panel").hidden = true;
  selectRing.visible = false;
  photoSprite.visible = false;
}

function step(dir) {
  const r = state.selected >= 0 ? state.rank[state.selected] : -1;
  if (!state.order.length) return;
  const next = r < 0 ? state.order[0] : state.order[Math.max(0, Math.min(state.order.length - 1, r + dir))];
  select(next);
}

// ---------- picking ----------
const projM = new THREE.Matrix4();
const tmp = new THREE.Vector3();
function pick(x, y, radius = 16) {
  const pos = starGeo.getAttribute("position");
  if (!pos) return -1;
  projM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const a = pos.array, w = innerWidth, h = innerHeight;
  let best = -1, bestScore = Infinity;
  const r2 = radius * radius;
  for (let i = 0; i < pos.count; i++) {
    tmp.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).applyMatrix4(projM);
    if (tmp.z < -1 || tmp.z > 1) continue;
    const dx = (tmp.x + 1) * 0.5 * w - x, dy = (1 - tmp.y) * 0.5 * h - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    const score = d2 + tmp.z * 40;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 6) return;
  const i = pick(e.clientX, e.clientY, e.pointerType === "touch" ? 28 : 16);
  if (i >= 0) select(i);
});
let hoverQueued = null;
renderer.domElement.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch" || down) return;
  hoverQueued = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener("pointerleave", () => { state.hovered = -1; $("#tooltip").hidden = true; });

function updateHover() {
  if (!hoverQueued) return;
  const { x, y } = hoverQueued;
  hoverQueued = null;
  const i = pick(x, y);
  state.hovered = i;
  const tip = $("#tooltip");
  renderer.domElement.style.cursor = i >= 0 ? "pointer" : "";
  if (i < 0) { tip.hidden = true; return; }
  const p = state.photos[i];
  tip.hidden = false;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
  tip.textContent = `${fmtShort(p.date)}${p.model ? " · " + p.model : ""}`;
}

// ---------- keyboard flight ----------
const keys = new Set();
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  keys.add(e.key.toLowerCase());
  if (e.key === "ArrowRight") step(1);
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "Escape") deselect();
  if (e.key === "r") randomStar();
  const n = ["1", "2", "3", "4"].indexOf(e.key);
  if (n >= 0) setLayout(Object.keys(LAYOUTS)[n]);
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => keys.clear());

function flyKeys(dt) {
  if (!keys.size) return;
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
  const move = new THREE.Vector3();
  if (keys.has("w")) move.add(fwd);
  if (keys.has("s")) move.sub(fwd);
  if (keys.has("d")) move.add(right);
  if (keys.has("a")) move.sub(right);
  if (keys.has("e")) move.add(camera.up);
  if (keys.has("q")) move.sub(camera.up);
  if (!move.lengthSq()) return;
  const speed = Math.max(8, camera.position.distanceTo(controls.target)) * (keys.has("shift") ? 2.5 : 0.8);
  move.normalize().multiplyScalar(speed * dt);
  camera.position.add(move);
  controls.target.add(move);
  flight = null;
}

// ---------- UI ----------
function setLayout(name) {
  if (!LAYOUTS[name] || name === state.layout) return;
  state.layout = name;
  document.querySelectorAll("[data-layout]").forEach((b) => b.classList.toggle("on", b.dataset.layout === name));
  photoSprite.visible = false;
  rebuild({ animate: true, frame: state.selected < 0 });
  if (state.selected >= 0) setTimeout(() => state.selected >= 0 && select(state.selected), 50);
}

function setColor(mode) {
  state.color = mode;
  document.querySelectorAll("[data-color]").forEach((b) => b.classList.toggle("on", b.dataset.color === mode));
  recolor();
}

function randomStar() {
  if (state.photos.length) select(Math.floor(Math.random() * state.photos.length));
}

document.querySelectorAll("[data-layout]").forEach((b) => b.addEventListener("click", () => setLayout(b.dataset.layout)));
document.querySelectorAll("[data-color]").forEach((b) => b.addEventListener("click", () => setColor(b.dataset.color)));
$("#toggle-lines").addEventListener("click", (e) => {
  state.lines = !state.lines;
  e.currentTarget.classList.toggle("on", state.lines);
  lines.visible = state.lines;
});
$("#random").addEventListener("click", randomStar);
$("#close").addEventListener("click", deselect);
$("#prev").addEventListener("click", () => step(-1));
$("#next").addEventListener("click", () => step(1));

function updateHud() {
  const s = state.stats;
  const pct = (n) => (s.count ? Math.round((100 * n) / s.count) : 0);
  $("#stats").textContent = s.count
    ? `${s.count.toLocaleString()} STARS · ${s.minYear}–${s.maxYear} · ${pct(s.geo)}% GEOTAGGED · ${pct(s.dated)}% DATED`
    : "NO PHOTOS YET";
  $("#source").textContent = state.sourceLabel;
}

// ---------- loading photos ----------
async function loadFiles(files) {
  if (!files.length) return;
  const prog = $("#progress");
  prog.hidden = false;
  const bar = prog.querySelector("i"), text = prog.querySelector("span");
  text.textContent = "READING METADATA…";
  let first = true;
  const total = await ingestFiles(files, {
    onBatch: (batch) => {
      if (first) { setPhotos(batch, "YOUR PHOTOS · read locally, nothing uploaded"); first = false; }
      else addPhotos(batch);
    },
    onProgress: (done, n) => {
      bar.style.width = `${(100 * done) / n}%`;
      text.textContent = `READING METADATA ${done.toLocaleString()} / ${n.toLocaleString()}`;
    },
  });
  prog.hidden = true;
  if (!total) { alert("No photos found in that selection."); return; }
  const L = LAYOUTS[state.layout](state.photos, state.stats);
  flyTo(new THREE.Vector3(...L.view.target), new THREE.Vector3(...L.view.position), 1600);
}

$("#pick-folder").addEventListener("change", (e) => loadFiles([...e.target.files]));
$("#pick-files").addEventListener("change", (e) => loadFiles([...e.target.files]));

let dragDepth = 0;
addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("#dropzone").hidden = false; });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropzone").hidden = true; } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#dropzone").hidden = true;
  loadFiles(await filesFromDataTransfer(e.dataTransfer));
});

// ---------- loop ----------
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

let last = performance.now();
function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (anim) {
    const t = ease(Math.min(1, (now - anim.t0) / anim.dur));
    const attr = starGeo.getAttribute("position");
    const a = attr.array, f = anim.from, to = anim.to;
    for (let i = 0; i < a.length; i++) a[i] = f[i] + (to[i] - f[i]) * t;
    attr.needsUpdate = true;
    updateLinePositions();
    if (t >= 1) anim = null;
  }

  if (flight) {
    const t = ease(Math.min(1, (now - flight.t0) / flight.dur));
    controls.target.lerpVectors(flight.fromT, flight.toT, t);
    camera.position.lerpVectors(flight.fromP, flight.toP, t);
    if (t >= 1) flight = null;
  }
  flyKeys(dt);
  controls.update();
  updateHover();

  starMaterial.uniforms.uScale.value = (renderer.domElement.height / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.6;

  if (state.hovered >= 0 && state.hovered !== state.selected) {
    hoverRing.visible = true;
    starPos(state.hovered, hoverRing.position);
  } else hoverRing.visible = false;
  if (state.selected >= 0) {
    starPos(state.selected, selectRing.position);
    if (anim) { const a = starGeo.getAttribute("position").array, i = state.selected; selectRing.position.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]); }
  }
  if (photoSprite.visible) {
    photoSprite.position.copy(selectRing.position);
    const d = camera.position.distanceTo(photoSprite.position);
    const fade = Math.min(1, (now - photoSprite.userData.fadeStart) / 700);
    photoSprite.material.opacity = fade * THREE.MathUtils.clamp((40 - d) / 25, 0, 1);
    selectRing.material.opacity = 0.8 * (1 - photoSprite.material.opacity);
  } else selectRing.material.opacity = 0.8;

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ---------- start ----------
(async () => {
  const params = new URLSearchParams(location.search);
  let photos = null, label = "";
  const manifestUrl = params.get("manifest") || (params.has("demo") ? null : "photos/manifest.json");
  if (manifestUrl) {
    try { photos = await loadManifest(manifestUrl); label = `LIBRARY · ${manifestUrl}`; } catch { photos = null; }
  }
  if (!photos || !photos.length) {
    photos = makeDemo();
    label = "DEMO GALAXY · synthetic photos — press LOAD PHOTOS or drop a folder";
  }
  setPhotos(photos, label);
  requestAnimationFrame(tick);
})();
