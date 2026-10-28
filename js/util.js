export const YEAR_MS = 365.2425 * 864e5;

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r) {
  const u = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

// Fractional calendar year, e.g. 2023.45
export function yearFrac(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const start = new Date(y, 0, 1).getTime();
  const end = new Date(y + 1, 0, 1).getTime();
  return y + (ms - start) / (end - start);
}

export function hourOf(ms) {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60;
}

// Gives every photo stable random offsets so layouts don't shimmer between rebuilds.
export function normalizePhoto(p) {
  const r = rng(hashString(p.id));
  p.j = [gauss(r), gauss(r), gauss(r), r()];
  p.mag = 0.55 + 1.9 * Math.pow(r(), 4);
  if (p.lat != null && (!isFinite(p.lat) || !isFinite(p.lon) || (p.lat === 0 && p.lon === 0))) {
    p.lat = p.lon = null;
  }
  if (p.date != null && !isFinite(p.date)) p.date = null;
  return p;
}

export function fmtDate(ms) {
  if (ms == null) return "UNKNOWN DATE";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) +
    " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function fmtShort(ms) {
  if (ms == null) return "undated";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
