# Photo Galaxy

Every photo is a star. Its position comes from the photo's metadata (when and where it was taken),
and clicking a star flies you to it and reveals the photo, floating in space.

No build step, no server code: plain HTML + JavaScript modules, [three.js](https://threejs.org) for 3D and
[exifr](https://github.com/MikeKovarik/exifr) for reading metadata. Photos are read **in your browser** and never uploaded.

## Run it

```sh
python3 -m http.server 8080   # in this folder
```

Open http://localhost:8080. It starts on a demo galaxy of 7,000 synthetic photos.

## Load your photos

- **LOAD PHOTOS**: pick a folder (desktop browsers). Subfolders are included.
- **Drag & drop** a folder or files onto the page.
- **PICK FILES**: choose individual photos (works on phones). Note: the iOS photo picker can strip
  location data, so for the full map, export originals to a computer first.
- **Google Takeout** exports work: the `.json` sidecars next to each photo are used for date/location.
- **Apple Photos**: File → Export → Export Unmodified Originals gives you the HEIC/JPEG files with full metadata.

### Hosting a library (optional)

To put a photo library online instead of loading it each time:

```sh
pip install pillow pillow-heif
python3 tools/build_manifest.py ~/path/to/photos --out photos
```

This writes web-sized copies to `photos/img/` plus `photos/manifest.json`, which the app loads
automatically on start (or use `?manifest=some/other/manifest.json`; `?demo` forces the demo).
`photos/` is git-ignored so your images don't end up in the repo by accident.

## Arrangements

| Mode | Position means |
| --- | --- |
| GALAXY | Each ring is a year (oldest at the core); around the ring is the season (Jan → Dec). Trips and big days show up as dense clusters. |
| GLOBE | Where on Earth it was taken; newer photos float higher above the surface. Photos without GPS orbit in a ring. |
| ATLAS | Your most common location sits at the center. Everything else is placed at its real compass bearing with distance on a log scale (1 km, 10 km … 10,000 km); time rises upward. |
| TIMELINE | Time runs left → right; hour of day goes around the tube (noon on top, midnight below). |

Colors: hour of day, year, camera model, or place (½° grid). **Constellations** link photos taken on the same day
within 3 hours of each other.

## Controls

Drag to rotate · scroll/pinch to zoom · right-drag to pan · `W A S D` (+`Q`/`E`) to fly, `Shift` faster ·
`←`/`→` previous/next photo in time · `R` random star · `1`–`4` switch arrangement · `Esc` close.

## Where to change things

| File | What's in it |
| --- | --- |
| `js/layouts.js` | The four arrangements: how metadata becomes x/y/z. Add a new function to `LAYOUTS` and a button in `index.html` to create your own. |
| `js/colors.js` | Color palettes and the legend. |
| `js/main.js` | Scene, star shader (size/glow), camera flights, picking, the photo panel. `REVERSE_GEOCODE` at the top turns place names on/off (looked up from OpenStreetMap only for the photo you click). |
| `js/ingest.js` | Reading EXIF, Google Takeout sidecars, the hosted manifest. |
| `js/demo.js` | The synthetic demo library. |
| `style.css` | Look and feel. |
| `tools/build_manifest.py` | Turns a photo folder into a hostable library. |
