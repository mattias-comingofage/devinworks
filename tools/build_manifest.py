#!/usr/bin/env python3
"""Turn a folder of photos into a hostable Photo Galaxy library.

Reads EXIF (date, GPS, camera) from every image, writes web-sized JPEG copies to
<out>/img/ and a <out>/manifest.json the app loads automatically.

    pip install pillow pillow-heif
    python tools/build_manifest.py ~/Pictures/my-export --out photos

Then serve the project folder; the app picks up photos/manifest.json on load
(or point it elsewhere with ?manifest=path/to/manifest.json).
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    print("note: pillow-heif not installed, HEIC files will be skipped", file=sys.stderr)

EXTS = {".jpg", ".jpeg", ".heic", ".heif", ".png", ".webp", ".tif", ".tiff"}
EXIF_IFD, GPS_IFD = 0x8769, 0x8825


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def gps_coord(values, ref):
    if not values:
        return None
    d, m, s = (to_float(x) or 0 for x in values)
    v = d + m / 60 + s / 3600
    return -v if ref in ("S", "W") else v


def read_meta(img):
    exif = img.getexif()
    ex = exif.get_ifd(EXIF_IFD)
    gps = exif.get_ifd(GPS_IFD)
    raw = ex.get(0x9003) or ex.get(0x9004) or exif.get(0x0132)  # DateTimeOriginal / Digitized / DateTime
    date = None
    if raw:
        try:
            d, t = str(raw).strip().split(" ")
            date = d.replace(":", "-") + "T" + t  # local time, no offset, like the camera wrote it
        except ValueError:
            pass
    lat = gps_coord(gps.get(2), gps.get(1))
    lon = gps_coord(gps.get(4), gps.get(3))
    exposure = to_float(ex.get(0x829A))
    return {
        "date": date,
        "lat": lat,
        "lon": lon,
        "alt": to_float(gps.get(6)),
        "make": (exif.get(0x010F) or "").strip() or None,
        "model": (exif.get(0x0110) or "").strip() or None,
        "lens": ex.get(0xA434),
        "fnum": to_float(ex.get(0x829D)),
        "exp": exposure,
        "iso": ex.get(0x8827),
        "focal": to_float(ex.get(0x920A)),
        "w": img.width,
        "h": img.height,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path, help="folder of photos (searched recursively)")
    ap.add_argument("--out", type=Path, default=Path("photos"), help="output folder (default: photos)")
    ap.add_argument("--size", type=int, default=1600, help="longest edge of web copies in px")
    args = ap.parse_args()

    img_dir = args.out / "img"
    img_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in args.src.rglob("*") if p.suffix.lower() in EXTS)
    photos = []
    for n, path in enumerate(files, 1):
        rel = str(path.relative_to(args.src))
        key = hashlib.sha1(rel.encode()).hexdigest()[:16]
        dest = img_dir / f"{key}.jpg"
        try:
            with Image.open(path) as im:
                meta = read_meta(im)
                if not dest.exists():
                    web = ImageOps.exif_transpose(im).convert("RGB")
                    web.thumbnail((args.size, args.size))
                    web.save(dest, "JPEG", quality=82)
        except Exception as e:  # noqa: BLE001 - keep going on bad files
            print(f"skip {rel}: {e}", file=sys.stderr)
            continue
        photos.append({"id": key, "name": path.name, "path": rel, "url": f"img/{key}.jpg", **meta})
        if n % 100 == 0:
            print(f"{n}/{len(files)}", file=sys.stderr)

    (args.out / "manifest.json").write_text(json.dumps({"photos": photos}, indent=0))
    print(f"wrote {len(photos)} photos to {args.out / 'manifest.json'}")


if __name__ == "__main__":
    main()
