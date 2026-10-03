# Trackside cameras

A camera beside a SkyTrain guideway that reports each passing train: which of the 1–3 tracks in view it used, which way, roughly how fast, and the numbers of the cars it read. SkyTrain has no real-time feed, so these sightings are the only live data we can get for it. The goal is a permanent camera with a small computer; for now an admin tests the idea with a phone at `/trackside` ([apps/web](../../apps/web/README.md#trackside)).

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

The camera's position (GPS, or tapped on the map) and the guideway point in the middle of its view (tapped) are snapped to the track network (`tracks.geojson`, tunnels excluded). The **tracks in view** are the track at the point tapped and every track running alongside it (within 25° and 20 m of the point tapped), nearest the camera first: 1 to 3 of them (`MAX_TRACKS`), each with its distance (where the camera's line of sight through the point tapped crosses it, not its nearest point anywhere: a long way can curve back close to the camera elsewhere), kind (main line or siding) and lines. With more than 3 side by side, the page asks the user to film somewhere else. The camera faces from its position to the point tapped, so screen-right is that bearing plus 90°: a train moving right travels along the track in whichever direction is closer to it. "Toward" labels name the nearest station on the same line roughly ahead each way (approximate on curves). Distances give speeds (below).

## Detecting passes

The region of interest (ROI) is the rows trains pass through. It's divided into 24 horizontal strips; in each, the horizontal shift between frames comes from block matching on moving pixels at ¼ resolution, refined to sub-pixel with a parabola. Neighbouring moving strips with the same velocity (same direction, speed within 35 %, compared per second because a browser delivers frames irregularly) are one **moving object**: a train, or the part of it that shows movement (plain roofs and skirts barely do). Two trains moving differently, such as two passing each other, are two objects. Objects are followed from frame to frame as **passes**: a pass starts with its first frame, is dropped if it lasts fewer than 3 frames, ends after 0.5 s without motion, and must carry the train at least one ROI width past the slit, which rejects camera shake and passing objects.

**Which track**: each track in view has a **band**, the rows where its trains appear, set by the user over the preview. A pass goes to the band that best matches the rows it covered (overlap over union). From above, the tracks are separate lanes on screen; from level or below, bands overlap, but a near train covers more rows than a far one (it's bigger, and from below its roof is higher), so the match still separates them. The rows (`extent`) are reported too, so the server can reassign tracks later. A pass overlapped by a taller (nearer) object is marked `occluded`.

While a train passes, a strip as wide as its shift is cut from the centre column of each frame (a **slit scan**). Together the strips make a panorama of the whole train, side-on, sharper than any single frame, and never mirrored (moving right, strips are reversed so it reads left to right). It's cropped to the rows the train covered plus half their height above and below (numbers sit near the roof, which barely registers as moving).

**Speed** is approximate: at distance d, a frame `frameWidth` pixels wide spans 2·d·tan(hfov/2) metres, with d the distance to the pass's track. The field of view is a guess for a phone's main camera at 1× (65°, `DEFAULT_HFOV_DEG`), narrowed by any zoom the camera reports, so errors in position and field of view carry straight through (±20 % or so). The image speed (`pxPerS`) is reported too, so a better calibration can recompute it later.

## Reading car numbers

The panorama goes through PaddleOCR's PP-OCRv4 mobile models (text detection, then recognition) in ONNX form, from the npm package `@gutenye/ocr-models`. Neither they nor onnxruntime-web ship with the site: the page fetches both from jsDelivr at pinned versions when the camera starts (~16 MB, then kept in Cache Storage). Detection runs at 2× scale in overlapping 480 px tiles, because Mk I numbers are only ~20 px tall at 1080p. Recognition decodes twice: unconstrained (for logs), and with only digits allowed, since car numbers are digits.

Readings become car numbers (`src/cars.ts`, rules in `regions/metro-vancouver/config/trackside.json`, OPEN-QUESTIONS #32): three or four digits in a known fleet's range, mean digit probability ≥ 0.85, boxes no taller than 15 % of the image (taller ones are windows). Repeats merge (cars carry their number at both ends), and the list is ordered front of the train first. For people, numbers are grouped into the sets that always run together: Mk I and Mk II married pairs (097·098), Mk III 4-car sets (441–444); Mk V numbering doesn't follow a set rule, so its cars are listed one by one. The server, not the device, turns numbers into trainsets. Number-like text below the threshold is reported as `uncertain`, with its crop, for a person to check.

## What the test videos showed

`var/video/` (not committed), filmed by Braden on 2026-10-01 and 2026-10-03 with an iPhone, mostly handheld, 1080p at 60 fps:

- **Detection**: every train found, with no false passes in the three clips without trains or the two with only stationary trains. From a building beside Stadium–Chinatown looking down on three tracks (a siding and two main tracks, 13, 16 and 26 m away), each train's rows matched its lane: the regular Mk III and the wrong-way Mk V and Mk II landed on the tracks they used. Near Main Street–Science World (from below, two tracks) the near and far trains separated by their rows too, including a far train mostly hidden by a near one.
- **Car numbers**: every Mk II, Mk III and Mk V number was read, in order, at 1.00 confidence (421–424, 441–444, 477–480; 309·310 335·336, 331·332 319·320; 6025 6024 6023 6022 6011, 6225 6224 6223 6222 6211). No Mk I numbers were: at that zoom they're ~16–20 px tall and smeared by motion blur, and read wrongly at 0.6–0.75 confidence, which the threshold drops. Zooming in on the number band should help.
- **Not handled**: platform close-ups. Filmed at an angle, different parts of one train move at different speeds on screen and split into several passes; reflections on the cars' stainless sides make short extra passes; trains that stop in view end their pass while stopped. Film the guideway from the side.
- **Speed of reading**: 1–6 s per pass in single-threaded WebAssembly on a laptop (12–18 s before panoramas were cropped to the train), in a worker, so it never holds up detection.

## Reports

`PassReport` (`src/types.ts`): the setup (with the tracks in view), start and end times, track (an index into the setup's tracks, and its segment) and the rows the train covered, screen direction and compass bearing, "toward" station, approximate speed and image speed, whether it was occluded, the cars read (each with a JPEG crop of its number) and uncertain readings (with crops). The page uploads each one to `POST /admin/api/trackside/passes` ([apps/server](../../apps/server/README.md#trackside-cameras)), which validates it (`src/validate.ts`) and stores it by its id (made by the device, so retries don't duplicate). When the user corrects a pass's track, the page sends it again and the stored report is replaced, keeping its crops. Passes from a replayed clip are never uploaded.

For now passes are only stored and listed at `/admin` (shadow mode): nothing feeds the dispatcher yet. Turning a pass at a point between stations into dispatcher inputs, and matching it to a run, is the next step.

## Replaying clips

```sh
npx tsx pipelines/trackside-replay.ts <clip> [--roi x,y,w,h] [--bands "0.55,0.85;0.31,0.52;0.10,0.31"] [--fps 30] [--ocr]
```

`--roi x,y,w,h` is the part of the view trains pass through, in the video's pixels (default: all of it); `--bands` the rows where each track's trains appear, nearest track first, as fractions of the ROI height (without them, passes are listed with their rows but no track). Needs ffmpeg; `--ocr` needs onnxruntime-node, which isn't a dependency (~300 MB): `npm i --no-save onnxruntime-node`. Panoramas go to `var/trackside/replay/`, models are cached in `var/trackside/models/`. The page's "Test with a video…" does the same in the browser.
