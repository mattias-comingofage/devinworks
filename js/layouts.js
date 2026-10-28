import * as THREE from "three";
import { YEAR_MS, yearFrac, hourOf } from "./util.js";

// Each layout maps photo metadata to a 3D position.
// Returns { positions, labels: [{text, pos}], guides: Object3D, view: {target, position} }.

const guideMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, depthWrite: false });

function circle(radius, y = 0, segments = 128) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius));
  }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), guideMat);
}

function halo(p, out, i, radius) {
  const [g1, g2, g3] = p.j;
  const v = new THREE.Vector3(g1, g2 * 0.6, g3).normalize().multiplyScalar(radius * (1 + p.j[3] * 0.25));
  out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
}

export function galaxy(photos, stats) {
  const out = new Float32Array(photos.length * 3);
  const years = Math.max(1, stats.maxYear - stats.minYear + 1);
  const core = 24;
  const gap = 230 / years;
  photos.forEach((p, i) => {
    if (p.date == null) return halo(p, out, i, core + years * gap + 90);
    const yf = yearFrac(p.date);
    const ring = yf - stats.minYear;
    const r = core + ring * gap + p.j[0] * gap * 0.12;
    const theta = (yf % 1) * Math.PI * 2 + p.j[2] * 0.015;
    const thickness = 5 + 26 * Math.exp(-r / 50);
    out[i * 3] = Math.cos(theta) * r;
    out[i * 3 + 1] = p.j[1] * thickness * 0.5;
    out[i * 3 + 2] = Math.sin(theta) * r;
  });
  const guides = new THREE.Group();
  const labels = [];
  for (let y = 0; y < years; y++) {
    const r = core + y * gap;
    guides.add(circle(r));
    labels.push({ text: String(stats.minYear + y), pos: [r + 2, 0, -4] });
  }
  const months = ["JAN", "APR", "JUL", "OCT"];
  const outer = core + years * gap + 14;
  months.forEach((m, k) => {
    const a = (k / 4) * Math.PI * 2;
    labels.push({ text: m, pos: [Math.cos(a) * outer, 0, Math.sin(a) * outer] });
  });
  const R = core + years * gap;
  return { positions: out, labels, guides, view: { target: [0, 0, 0], position: [0, R * 0.95, R * 1.15] } };
}

export function globe(photos, stats) {
  const out = new Float32Array(photos.length * 3);
  const R = 150;
  const span = Math.max(1, stats.maxDate - stats.minDate);
  photos.forEach((p, i) => {
    const [g1, g2, g3] = p.j;
    if (p.lat == null) {
      const t = p.date == null ? p.j[3] : (p.date - stats.minDate) / span;
      const a = t * Math.PI * 2;
      const rr = R * 1.9 + g1 * 4;
      out[i * 3] = Math.cos(a) * rr; out[i * 3 + 1] = g2 * 3; out[i * 3 + 2] = Math.sin(a) * rr;
      return;
    }
    const t = p.date == null ? 0 : (p.date - stats.minDate) / span;
    const rad = R + t * 30 + g1 * 0.4;
    const phi = ((90 - p.lat) * Math.PI) / 180;
    const th = ((p.lon + 180) * Math.PI) / 180;
    out[i * 3] = -rad * Math.sin(phi) * Math.cos(th) + g2 * 0.35;
    out[i * 3 + 1] = rad * Math.cos(phi) + g3 * 0.35;
    out[i * 3 + 2] = rad * Math.sin(phi) * Math.sin(th) + g1 * 0.35;
  });
  const guides = new THREE.Group();
  for (let lat = -75; lat <= 75; lat += 15) {
    const phi = ((90 - lat) * Math.PI) / 180;
    guides.add(circle(R * Math.sin(phi), R * Math.cos(phi)));
  }
  for (let lon = 0; lon < 180; lon += 15) {
    const c = circle(R);
    c.rotation.x = Math.PI / 2;
    c.rotation.z = (lon * Math.PI) / 180;
    const holder = new THREE.Group();
    holder.add(c);
    holder.rotation.y = (lon * Math.PI) / 180;
    c.rotation.z = 0;
    guides.add(holder);
  }
  const labels = [{ text: "NO LOCATION", pos: [R * 1.9, 8, 0] }];
  return { positions: out, labels, guides, view: { target: [0, 0, 0], position: [0, R * 0.6, R * 3.2] } };
}

// Home (the median location) sits at the center; every other place sits at its real compass
// bearing, with distance on a log scale so your street and the other side of the world both fit.
const EARTH_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;
function median(arr) { const a = [...arr].sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; }
const logR = (km) => 38 * Math.log10(1 + km / 0.2);

export function atlas(photos, stats) {
  const out = new Float32Array(photos.length * 3);
  const H = 22; // height per year
  const geo = photos.filter((p) => p.lat != null);
  const lat0 = toRad(median(geo.map((p) => p.lat)));
  const lon0 = toRad(median(geo.map((p) => p.lon)));
  const years = Math.max(1, stats.maxYear - stats.minYear + 1);
  const rMax = logR(20000);
  photos.forEach((p, i) => {
    const [g1, g2, g3] = p.j;
    const y = p.date == null ? -20 : (yearFrac(p.date) - stats.minYear) * H;
    if (p.lat == null) {
      out[i * 3] = rMax + 40 + g1 * 3; out[i * 3 + 1] = y; out[i * 3 + 2] = g3 * 3;
      return;
    }
    const la = toRad(p.lat), lo = toRad(p.lon);
    const dLat = la - lat0, dLon = lo - lon0;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat0) * Math.cos(la) * Math.sin(dLon / 2) ** 2;
    const km = 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
    const bearing = Math.atan2(Math.sin(dLon) * Math.cos(la),
      Math.cos(lat0) * Math.sin(la) - Math.sin(lat0) * Math.cos(la) * Math.cos(dLon));
    const r = logR(km);
    out[i * 3] = Math.sin(bearing) * r + g1 * 0.3;
    out[i * 3 + 1] = y + g2 * 0.3;
    out[i * 3 + 2] = -Math.cos(bearing) * r + g3 * 0.3;
  });
  const guides = new THREE.Group();
  const labels = [];
  for (const [km, text] of [[1, "1 KM"], [10, "10 KM"], [100, "100 KM"], [1000, "1,000 KM"], [10000, "10,000 KM"]]) {
    guides.add(circle(logR(km), -2));
    labels.push({ text, pos: [0, -2, logR(km) + 4] });
  }
  for (const [a, text] of [[0, "N"], [90, "E"], [180, "S"], [270, "W"]]) {
    const b = toRad(a);
    labels.push({ text, pos: [Math.sin(b) * (rMax + 12), -2, -Math.cos(b) * (rMax + 12)] });
  }
  const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, years * H, 0)]), guideMat);
  guides.add(axis);
  for (let yr = 0; yr < years; yr += Math.max(1, Math.round(years / 6))) {
    labels.push({ text: String(stats.minYear + yr), pos: [-3, yr * H, 0] });
  }
  labels.push({ text: "NO LOCATION", pos: [rMax + 40, -30, 0] });
  const h = years * H;
  return {
    positions: out, labels, guides,
    view: { target: [0, h * 0.35, 0], position: [rMax * 0.9, h * 1.1, rMax * 1.6] },
  };
}

export function timeline(photos, stats) {
  const out = new Float32Array(photos.length * 3);
  const spanYears = Math.max(1, (stats.maxDate - stats.minDate) / YEAR_MS);
  const W = 70; // units per year
  const x0 = -(spanYears * W) / 2;
  photos.forEach((p, i) => {
    const [g1, g2, g3] = p.j;
    if (p.date == null) {
      halo(p, out, i, 20);
      out[i * 3] += -x0 + 60;
      return;
    }
    const x = x0 + ((p.date - stats.minDate) / YEAR_MS) * W;
    const a = (hourOf(p.date) / 24) * Math.PI * 2;
    const r = 22 + g1 * 1.5;
    out[i * 3] = x + g3 * 0.3;
    out[i * 3 + 1] = -Math.cos(a) * r;
    out[i * 3 + 2] = Math.sin(a) * r + g2 * 0.3;
  });
  const guides = new THREE.Group();
  guides.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x0 - 10, 0, 0), new THREE.Vector3(-x0 + 10, 0, 0)]), guideMat));
  const labels = [];
  for (let y = stats.minYear; y <= stats.maxYear + 1; y++) {
    const ms = new Date(y, 0, 1).getTime();
    if (ms < stats.minDate - YEAR_MS * 0.05 || ms > stats.maxDate + YEAR_MS * 0.05) continue;
    const x = x0 + ((ms - stats.minDate) / YEAR_MS) * W;
    labels.push({ text: String(y), pos: [x, -32, 0] });
    const ring = circle(22, 0, 64);
    ring.rotation.z = Math.PI / 2;
    ring.position.x = x;
    guides.add(ring);
  }
  labels.push({ text: "NOON", pos: [x0 - 14, 24, 0] }, { text: "MIDNIGHT", pos: [x0 - 14, -24, 0] });
  return {
    positions: out, labels, guides,
    view: { target: [0, 0, 0], position: [x0 * 0.35, 60, Math.max(160, spanYears * W * 0.55)] },
  };
}

export const LAYOUTS = { galaxy, globe, atlas, timeline };

export function computeStats(photos) {
  let minDate = Infinity, maxDate = -Infinity, geo = 0, dated = 0;
  for (const p of photos) {
    if (p.date != null) { dated++; if (p.date < minDate) minDate = p.date; if (p.date > maxDate) maxDate = p.date; }
    if (p.lat != null) geo++;
  }
  if (!dated) { minDate = Date.now() - YEAR_MS; maxDate = Date.now(); }
  return {
    count: photos.length, dated, geo, minDate, maxDate,
    minYear: new Date(minDate).getFullYear(), maxYear: new Date(maxDate).getFullYear(),
  };
}
