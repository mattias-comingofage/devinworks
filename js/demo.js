import { rng, gauss } from "./util.js";

// A synthetic photo library so the galaxy has something to show before real photos are loaded.
const HOME = { name: "Stockholm", lat: 59.334, lon: 18.063 };
const TRIPS = [
  ["Paris", 48.857, 2.352], ["New York", 40.713, -74.006], ["Tokyo", 35.68, 139.69], ["Lisbon", 38.722, -9.139],
  ["Los Angeles", 34.052, -118.244], ["Berlin", 52.52, 13.405], ["London", 51.507, -0.128], ["Mexico City", 19.433, -99.133],
  ["Cape Town", -33.925, 18.424], ["Reykjavik", 64.147, -21.942], ["Marrakech", 31.63, -7.99], ["Seoul", 37.566, 126.978],
  ["Copenhagen", 55.676, 12.568], ["Gotland", 57.64, 18.29], ["Barcelona", 41.385, 2.173], ["Sydney", -33.868, 151.209],
];
const CAMERAS = [
  [2017, "Apple", "iPhone 8"], [2018, "Apple", "iPhone X"], [2020, "Apple", "iPhone 11 Pro"],
  [2022, "Apple", "iPhone 13 Pro"], [2024, "Apple", "iPhone 15 Pro"],
];

function hourSample(r) {
  // Mostly daytime, peaking late afternoon, with a tail into the night.
  const h = 15 + gauss(r) * 4.2;
  return ((h % 24) + 24) % 24;
}

export function makeDemo(count = 7000) {
  const r = rng(42);
  const start = new Date(2017, 2, 1).getTime();
  const end = new Date(2026, 9, 20).getTime();
  const photos = [];
  let id = 0;

  const add = (ms, place, spread) => {
    const y = new Date(ms).getFullYear();
    let cam = CAMERAS[0];
    for (const c of CAMERAS) if (y >= c[0]) cam = c;
    const fuji = r() < 0.06;
    const screenshot = r() < 0.05;
    const geo = !screenshot && r() > 0.07;
    photos.push({
      id: "demo-" + id,
      name: screenshot ? `IMG_${4000 + id}.PNG` : fuji ? `DSCF${1000 + id}.JPG` : `IMG_${4000 + id}.HEIC`,
      date: ms,
      lat: geo ? place.lat + gauss(r) * spread : null,
      lon: geo ? place.lon + gauss(r) * spread * 1.6 : null,
      make: screenshot ? null : fuji ? "FUJIFILM" : cam[1],
      model: screenshot ? null : fuji ? "X100V" : cam[2],
      lens: screenshot ? null : fuji ? "23mm F2" : "back camera",
      fnum: screenshot ? null : fuji ? [2, 2.8, 4, 5.6][Math.floor(r() * 4)] : 1.8,
      exp: screenshot ? null : 1 / [30, 60, 120, 250, 1000][Math.floor(r() * 5)],
      iso: screenshot ? null : [32, 50, 100, 200, 640, 1600][Math.floor(r() * 6)],
      focal: screenshot ? null : fuji ? 23 : 6,
      src: { type: "demo", seed: id },
    });
    id++;
  };

  // Everyday life at home, in bursts.
  while (photos.length < count * 0.6) {
    const t = start + r() * (end - start);
    const burst = 1 + Math.floor(Math.pow(r(), 3) * 18);
    const day = new Date(t); day.setHours(0, 0, 0, 0);
    for (let i = 0; i < burst; i++) {
      add(day.getTime() + hourSample(r) * 36e5, HOME, 0.03);
    }
  }
  // Trips: dense star clusters.
  while (photos.length < count) {
    const [name, lat, lon] = TRIPS[Math.floor(r() * TRIPS.length)];
    const tripStart = start + r() * (end - start);
    const days = 2 + Math.floor(r() * 9);
    const n = 20 + Math.floor(r() * 140);
    for (let i = 0; i < n && photos.length < count; i++) {
      const day = new Date(tripStart + Math.floor(r() * days) * 864e5); day.setHours(0, 0, 0, 0);
      add(day.getTime() + hourSample(r) * 36e5, { name, lat, lon }, 0.06);
    }
  }
  return photos;
}

export function demoImageUrl(p) {
  return `https://picsum.photos/seed/galaxy${p.src.seed}/900/${p.src.seed % 3 === 0 ? 1200 : 640}`;
}
