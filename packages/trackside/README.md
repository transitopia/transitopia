# Trackside cameras

A camera beside a SkyTrain guideway that reports each passing train: which track (near or far), which way, roughly how fast, and the numbers of the cars it read. SkyTrain has no real-time feed, so these sightings are the only live data we can get for it. The goal is a permanent camera with a small computer; for now an admin tests the idea with a phone at `/trackside` ([apps/web](../../apps/web/README.md#trackside)).

**Only metadata leaves the device**: the report below, plus small crops of the car numbers it read, which are kept to check and improve the reader. No video or frames are stored or sent. The phone shows its own camera preview so it can be aimed, and optionally the train images on that phone only.

This package is DOM-free: the page runs it on the main thread and in a worker, and `pipelines/trackside-replay.ts` runs it in Node.

| File | What |
|---|---|
| `src/detector.ts` | `PassDetector`: frames in, passes out (track, direction, image speed, a panorama of the train) |
| `src/ocr.ts`, `src/read.ts` | Text detection and recognition (PaddleOCR models, run by any ONNX Runtime) and the pass reader |
| `src/cars.ts` | Car numbers from readings: filtering, merging, ordering, married pairs |
| `src/geometry.ts` | The camera's setup from where it is and what it looks at; speeds |
| `src/types.ts`, `src/validate.ts` | The report format, and what the server accepts |
| `src/image.ts` | Minimal RGBA helpers (crop, resize), no canvas |

## Setup

The camera's position (GPS, or tapped on the map) and the guideway point in the middle of its view (tapped) are snapped to the track network (`tracks.geojson`, tunnels excluded). Of the tracks within 15 m of the point in view, the one nearest the camera is the **near track**, and the next parallel one beyond it is the **far track**. The camera faces from its position to that point, so screen-right is that bearing plus 90°: a train moving right travels along the track in whichever direction is closer to it. "Toward" labels name the nearest station on the same line roughly ahead each way (approximate on curves). Distances to each track give speeds (below).

## Detecting passes

The region of interest (ROI) is the guideway: from just above a near-track train's roof down to the top of the near wall. A **split line** divides it: above it only a near-track train can appear (far-track trains sit lower, half hidden behind the near wall). So the near track is busy when the upper band moves, and the far track when only the lower band does; a near train hides any far one, which is then marked `occluded`.

In each band, the horizontal shift between frames comes from block matching on moving pixels at ¼ resolution, refined to sub-pixel with a parabola. A pass starts after 3 moving frames and ends after 0.5 s without motion; it must carry the train at least 1.5 ROI widths past the slit, which rejects camera shake and passing objects. A near train's sloped ends leave the upper band before the lower one, so lower-band motion matching a near pass in progress (same direction, speed within 35 %) continues it rather than starting a far pass.

While a train passes, a strip as wide as its shift is cut from the centre column of each frame (a **slit scan**). Together the strips make a panorama of the whole train, side-on, sharper than any single frame, and never mirrored (moving right, strips are reversed so it reads left to right).

**Speed** is approximate: at distance d, a frame `frameWidth` pixels wide spans 2·d·tan(hfov/2) metres. The field of view is a guess for a phone's main camera at 1× (65°, `DEFAULT_HFOV_DEG`), narrowed by any zoom the camera reports, so errors in position and field of view carry straight through (±20 % or so). The image speed (`pxPerS`) is reported too, so a better calibration can recompute it later.

## Reading car numbers

The panorama goes through PaddleOCR's PP-OCRv4 mobile models (text detection, then recognition) in ONNX form, from the npm package `@gutenye/ocr-models`. Neither they nor onnxruntime-web ship with the site: the page fetches both from jsDelivr at pinned versions when the camera starts (~16 MB, then kept in Cache Storage). Detection runs at 2× scale in overlapping 480 px tiles, because Mk I numbers are only ~20 px tall at 1080p. Recognition decodes twice: unconstrained (for logs), and with only digits allowed, since car numbers are digits.

Readings become car numbers (`src/cars.ts`, rules in `regions/metro-vancouver/config/trackside.json`, OPEN-QUESTIONS #32): three digits, mean digit probability ≥ 0.85, boxes no taller than 15 % of the image (taller ones are windows). Repeats merge (cars carry their number at both ends), and the list is ordered front of the train first. Cars run in married pairs numbered odd then even, so one reading names both cars of a pair; the server, not the device, turns numbers into trainsets. Number-like text below the threshold is reported as `uncertain`, with its crop, for a person to check.

**What the test video showed** (`var/video/IMG_6067.MOV`, 2026-10-01, near Main Street–Science World, handheld): all three passes found, on the right tracks and in the right directions, with no false passes. Every Mk III number was read (335·336 309·310 on the far track, 317·318 333·334 on the near one), at 0.9–1.0 confidence. No Mk I numbers were: at that zoom they're ~16–20 px tall and smeared by motion blur, and read wrongly at 0.6–0.75 confidence, which the threshold drops. A camera zoomed in on the number band, with a short exposure, should do much better. Reading takes 12–18 s per pass in single-threaded WebAssembly on a laptop, in a worker, so it never holds up detection.

## Reports

`PassReport` (`src/types.ts`): the setup, start and end times, track, screen direction and compass bearing, "toward" station, approximate speed and image speed, whether it was occluded, the cars read (each with a JPEG crop of its number) and uncertain readings (with crops). The page uploads each one to `POST /admin/api/trackside/passes` ([apps/server](../../apps/server/README.md#trackside-cameras)), which validates it (`src/validate.ts`) and stores it once (the device makes the id, so retries don't duplicate). Passes from a replayed clip are never uploaded.

For now passes are only stored and listed at `/admin` (shadow mode): nothing feeds the dispatcher yet. Turning a pass at a point between stations into dispatcher inputs, and matching it to a run, is the next step.

## Replaying clips

```sh
npx tsx pipelines/trackside-replay.ts var/video/IMG_6067.MOV --roi 0,180,1920,540 --split 0.38 [--fps 30] [--ocr]
```

`--roi x,y,w,h` is the guideway in the video's pixels, `--split` the split line as a fraction of the ROI height. Needs ffmpeg; `--ocr` needs onnxruntime-node, which isn't a dependency (~300 MB): `npm i --no-save onnxruntime-node`. Panoramas go to `var/trackside/replay/`, models are cached in `var/trackside/models/`. The page's "Test with a video…" does the same in the browser.
