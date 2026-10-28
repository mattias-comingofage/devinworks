import exifr from "exifr";

const IMAGE_EXT = /\.(jpe?g|heic|heif|png|webp|avif|tiff?|dng|gif)$/i;
const EXIF_OPTS = {
  tiff: true, exif: true, gps: true,
  ifd1: false, interop: false, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false,
  makerNote: false, userComment: false,
};

// Recursively collects files from a drag-and-drop (supports dropped folders).
export async function filesFromDataTransfer(dt) {
  const entries = [...dt.items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry, path) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      Object.defineProperty(f, "relPath", { value: path + f.name });
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, path + entry.name + "/");
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

// Google Takeout puts date/location in JSON sidecars next to each photo.
async function readSidecars(files) {
  const map = new Map();
  const jsons = files.filter((f) => /\.json$/i.test(f.name));
  await Promise.all(jsons.map(async (f) => {
    try {
      const j = JSON.parse(await f.text());
      if (!j.title) return;
      const ts = j.photoTakenTime?.timestamp ? Number(j.photoTakenTime.timestamp) * 1000 : null;
      const g = j.geoData || j.geoDataExif;
      map.set(j.title, { date: ts, lat: g?.latitude || null, lon: g?.longitude || null });
    } catch { /* not a sidecar */ }
  }));
  return map;
}

async function readOne(file, sidecars) {
  let m = null;
  try { m = await exifr.parse(file, EXIF_OPTS); } catch { /* unreadable: keep file with fallbacks */ }
  const exifDate = m?.DateTimeOriginal || m?.CreateDate || m?.DateTimeDigitized;
  const side = sidecars.get(file.name);
  let date = exifDate instanceof Date ? exifDate.getTime() : null;
  let approx = false;
  if (date == null && side?.date) date = side.date;
  if (date == null) { date = file.lastModified || null; approx = true; }
  let lat = m?.latitude, lon = m?.longitude;
  if ((lat == null || (lat === 0 && lon === 0)) && side?.lat) { lat = side.lat; lon = side.lon; }
  return {
    id: `${file.relPath || file.webkitRelativePath || file.name}|${file.size}`,
    name: file.name,
    path: file.relPath || file.webkitRelativePath || file.name,
    date, approxDate: approx,
    lat: lat ?? null, lon: lon ?? null, alt: m?.GPSAltitude ?? null,
    make: m?.Make?.trim() || null, model: m?.Model?.trim() || null, lens: m?.LensModel || null,
    fnum: m?.FNumber ?? null, exp: m?.ExposureTime ?? null, iso: m?.ISO ?? null, focal: m?.FocalLength ?? null,
    w: m?.ExifImageWidth || m?.ImageWidth || null, h: m?.ExifImageHeight || m?.ImageHeight || null,
    src: { type: "file", file },
  };
}

export async function ingestFiles(allFiles, { onBatch, onProgress, concurrency = 8, batchSize = 300 }) {
  const files = allFiles.filter((f) => IMAGE_EXT.test(f.name) || f.type?.startsWith("image/"));
  const sidecars = await readSidecars(allFiles);
  let next = 0, done = 0;
  let pending = [];
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      pending.push(await readOne(f, sidecars));
      done++;
      if (done % 25 === 0 || done === files.length) onProgress(done, files.length);
      if (pending.length >= batchSize) onBatch(pending.splice(0));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (pending.length) onBatch(pending.splice(0));
  return files.length;
}

// Loads a pre-built manifest (see tools/build_manifest.py) for hosting a photo library.
export async function loadManifest(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) return null;
  const data = await res.json();
  const base = new URL(url, location.href);
  return (data.photos || []).map((p, i) => ({
    ...p,
    id: p.id || p.path || p.name || String(i),
    date: p.date ? new Date(p.date).getTime() : null,
    src: {
      type: "url",
      url: p.url ? new URL(p.url, base).href : null,
      thumb: p.thumb ? new URL(p.thumb, base).href : null,
    },
  }));
}

export async function embeddedThumbnail(file) {
  try { return await exifr.thumbnailUrl(file); } catch { return null; }
}
