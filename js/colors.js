import * as THREE from "three";
import { hashString, hourOf, yearFrac } from "./util.js";

const HOUR_STOPS = [
  [0, "#4b63ff"], [4.5, "#7d5cff"], [6.5, "#ff8fa3"], [9, "#ffe3b8"], [12, "#ffffff"],
  [16, "#ffe08a"], [18.5, "#ff7a3d"], [20.5, "#c44dff"], [24, "#4b63ff"],
];
const hourColors = HOUR_STOPS.map(([h, c]) => [h, new THREE.Color(c)]);
const UNKNOWN = new THREE.Color("#6f6f78");

function hourColor(h, out) {
  for (let i = 0; i < hourColors.length - 1; i++) {
    const [h0, c0] = hourColors[i], [h1, c1] = hourColors[i + 1];
    if (h >= h0 && h <= h1) return out.copy(c0).lerp(c1, (h - h0) / (h1 - h0));
  }
  return out.copy(hourColors[0][1]);
}

function yearColor(t, out) {
  return out.setHSL(0.62 - 0.62 * t, 0.85, 0.66);
}

function hueColor(key, out) {
  const h = hashString(key);
  return out.setHSL((h % 360) / 360, 0.75, 0.66);
}

function placeKey(p) {
  return p.lat == null ? null : `${Math.round(p.lat * 2) / 2},${Math.round(p.lon * 2) / 2}`;
}

function cameraKey(p) {
  return p.model ? [p.make, p.model].filter(Boolean).join(" ").replace(/^(\w+) \1/i, "$1") : null;
}

export function colorize(photos, mode, stats, out) {
  const c = new THREE.Color();
  const span = Math.max(1, stats.maxYear + 1 - stats.minYear);
  photos.forEach((p, i) => {
    let col = UNKNOWN;
    if (mode === "hour" && p.date != null && !p.approxDate) col = hourColor(hourOf(p.date), c);
    else if (mode === "year" && p.date != null) col = yearColor((yearFrac(p.date) - stats.minYear) / span, c);
    else if (mode === "camera" && cameraKey(p)) col = hueColor(cameraKey(p), c);
    else if (mode === "place" && placeKey(p)) col = hueColor(placeKey(p), c);
    out[i * 3] = col.r; out[i * 3 + 1] = col.g; out[i * 3 + 2] = col.b;
  });
}

function gradientCss(fn, steps = 12) {
  const c = new THREE.Color();
  const stops = [];
  for (let i = 0; i <= steps; i++) stops.push("#" + fn(i / steps, c).getHexString());
  return `linear-gradient(90deg, ${stops.join(",")})`;
}

function topKeys(photos, keyFn, n) {
  const counts = new Map();
  for (const p of photos) { const k = keyFn(p); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function legendHtml(photos, mode, stats) {
  const c = new THREE.Color();
  if (mode === "hour") {
    return `HOUR OF DAY<div class="grad" style="background:${gradientCss((t, o) => hourColor(t * 24, o), 24)}"></div>
      <div class="ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>`;
  }
  if (mode === "year") {
    return `YEAR<div class="grad" style="background:${gradientCss(yearColor)}"></div>
      <div class="ticks"><span>${stats.minYear}</span><span>${stats.maxYear}</span></div>`;
  }
  const keyFn = mode === "camera" ? cameraKey : placeKey;
  const rows = topKeys(photos, keyFn, 7).map(([k, n]) =>
    `<div class="sw"><i style="background:#${hueColor(k, c).getHexString()}"></i>${k} <span>· ${n}</span></div>`);
  return `${mode === "camera" ? "CAMERA" : "PLACE (½° GRID)"}${rows.join("")}`;
}
