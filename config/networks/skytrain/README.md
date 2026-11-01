# SkyTrain

The SkyTrain rail network: the Expo, Millennium and Canada Lines' track, and how trains run on it (design: [docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)). TransLink's feed ([config/feeds/translink/](../../feeds/translink/)) runs on it.

| Path | What |
|---|---|
| `network.json` | Its id, name, time zone, signalling, and the feeds whose track-level routes run on it |
| `operations.json`, `dispatch.json` | Its settings, each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md): operations (layovers, turnbacks, yards) and dispatch (signalling). Vehicles (kinematics) are the defaults' ([config/defaults/](../../defaults/)) with TransLink's overrides ([operator.json](../../operators/translink/operator.json)) and its routes' ([routes.json](../../feeds/translink/routes.json)). The server's own settings (port, live dispatch, retention, statistics) are in [config/server/](../../server/). |
| `infrastructure/` | The track network: `tracks.generated.geojson` and `future.generated.geojson` (imported from OSM; don't hand-edit), `overrides.json` (our fixes), `diagram-checklist.json` |
| `scenarios/` | Alternate track and service ([README](scenarios/README.md)) |
| `disruptions/` | Disruptions in the file format ([README](disruptions/README.md)): imported into a new database, and read by local pipeline runs (`npm run data`). Observations are the feed's ([config/feeds/translink/observations/](../../feeds/translink/observations/README.md)). |

This page records what we've learned about how the SkyTrain actually runs, and where it came from. Questions still open are in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config, move the answer here with its source, and leave a pointer in its place. Evidence comes from GTFS feed `26SEP_20260925`, OSM (2026-09-25), the Wikipedia track diagram v3 (mid-2021), and field observations (GPS rides and sightings, in [TransLink's observations](../../feeds/translink/observations/)).

## Yards and overnight layup

*Was OPEN-QUESTIONS #3 and #4, and part of #2.*

- **Yards**: OMC 1 south of Edmonds (Expo and Millennium; ~75 yard tracks in OSM), the Canada Line OMC east of Bridgeport (~50), and the small **OMC 3** at Falcon Drive in Coquitlam (~16 tracks, near Inlet Centre/Coquitlam Central), the "extra storage facility in Coquitlam" on the Wikipedia diagram. OSM's location and track connections for OMC 3 are correct, and the map already shows it connected to the Millennium Line (Braden, 2026-10-02).
- **Overnight layup on the line**: "Most of the SkyTrains refuge [near] Edmonds SkyTrain station in TransLink's Maintenance and Storage Facility [OMC 1]. Yet, 15 trains sleep on the tracks along the Millennium Line and near King George Station." (Vancouver Is Awesome, 2022, ["Do not board"](https://www.vancouverisawesome.com/local-news/translink-skytrain-bus-seabus-train-do-not-board-vancouver-bc-6082544), quoted by Braden, 2026-10-02.) So King George's early departures come from trains stored overnight near the station, not from empty runs out of OMC 1.
- **Not modelled yet**: run inference starts and ends every run in the nearest yard, including runs that really lay up on the line overnight, so the map shows empty moves to and from the yards around the start and end of service that don't happen. Which tracks the 15 trains use is still open (OPEN-QUESTIONS #2).

## Terminus platforms at Richmond-Brighouse and YVR-Airport

*Was OPEN-QUESTIONS #8.* GTFS has an "@ Platform 1" stop and an unnumbered "@ Canada Line" stop at each. Both are single-platform, single-track stations (Braden, 2026-09-28). OSM agrees: the platform mapping puts both GTFS stops at each station on the one track there (`w551355748.0` at Richmond-Brighouse, `w551364384.0` at YVR-Airport). Trains arrive and depart from the same platform, so each terminus holds one train at a time.

## Waterfront (Expo) terminal berths

*Was OPEN-QUESTIONS #18 (the Expo part).* Platform 1 is on the south approach track, Platform 2 on the north one (the left side when arriving), both west of the throat switches; the stubs beyond are tail tracks (OSM platform refs + Braden, 2026-09-26). Usual pattern: drop off at Platform 1, reverse in a tail track, board at Platform 2. When the station is quiet, trains may go straight to Platform 2 and turn there (observed 14:02 on a Saturday); that variant isn't modelled.

## Braid and the OMC4 works

*Was OPEN-QUESTIONS #17 and #20.*

**Braid–Lougheed track.** Single-tracked until about 2027 for the OMC4 flyover works. The west/south track, the one that serves Braid Platform 1, is closed beyond that platform. The east/north track, which normally carries trains from Braid to Lougheed, stays open and carries the smaller Lougheed and Production Way–University service in both directions (Braden, 2026-09-26 and 2026-09-27). The closed ways are excluded via `osm.excludeWays` in `overrides.json`. OSM way 83590063 keeps ~430 m of the closed track beyond Braid Platform 1 as a dead-end stub. It's left in place because the barrier's position isn't known, and `turnback.maxPullUpM` keeps short-turns at the platform instead of pulling them up to the stub's end.

**Braid short-turns.** 2026 satellite imagery shows no crossover near Braid (Braden, 2026-09-26). Short-turns switch to the west track at the crossover ~460 m south of Sapperton (OSM way 426641643), stop at Sapperton Platform 1, and terminate at Braid Platform 1, the west side, where the track ends. They start back from Braid Platform 1 on the same track. Trains to and from Lougheed and Production Way–University use the east track and Platform 2 at both stations, in both directions.

- Platform signs on 2026-09-27: Sapperton Platform 1 "Braid" and "Waterfront"; Sapperton Platform 2 "Production Way–University" and "Waterfront"; Braid Platform 1 "Waterfront" only; Braid Platform 2 both directions.
- GPS on a short-turn that day (block 2205212, `config/feeds/translink/observations/2026-09-27-braden-expo.json`) confirms the crossover and the layover at Braid Platform 1 (17:14:37–17:21:16). The train held ~30 s before the crossover, presumably for the departing short-turn to clear the shared track (see OPEN-QUESTIONS #26).
- GTFS uses the normal assignments (outbound Platform 2, inbound Platform 1), which is wrong for trips terminating at Braid and for through trips toward Waterfront, so it's modelled with role-based `patternPlatforms` rules in `overrides.json`. Remove them, and the excluded ways, when the works finish (~2027).

TransLink announces the arrangement only by an alert ("temporary platform assignments … between Braid & Lougheed", since 2024-02-25).

## Surplus trains at termini

*Was part of OPEN-QUESTIONS #21.* Operators run surplus trains back to the OMC empty ("do not board") between scheduled trains (Braden, 2026-09-26). Modelled with `turnback.stubMaxLayoverS` (600 s): at stub termini, a train that would wait longer returns to the yard. That cut Waterfront overlaps from 496 to 210 and weekday conflicts from 1,629 to about 1,400, for 14 extra empty trips; stricter limits (420 s) cascade into many more empty trips. With the dispatcher, a stub terminus also holds at most one waiting train per dead-ended track (Waterfront Expo: the turnback stub and Platform 2), and a train arriving when they're full returns to the yard. The questions still open about terminus capacity are in OPEN-QUESTIONS #21.

## GTFS blocks

*Was OPEN-QUESTIONS #23.* SkyTrain blocks don't follow physical trains: for example, a block reaching Waterfront at 06:23 continues from 22nd Street at 06:24. Run inference uses a block's next trip only when it starts where the last one ended.

## Rolling stock by line

*The answered part of OPEN-QUESTIONS #9.* From the CPTDB wiki ("SkyTrain" § Rolling Stock, and "BCRTC 1700/1800 series"; Braden, 2026-09-28):

- **Expo:** Mk I (2-car pairs, run as 4 or 6 cars), Mk III (4-car sets) and **Mk V, in service since 2025-07-10**. Mk V cars run in semi-permanent articulated 5-car sets, about 84.8 m long (2 × 17.35 m end cars + 3 × 16.70 m middle cars), 2.65 m wide, 80 km/h in service. Twelve sets were in service by September 2026, of 41 ordered; they replace Mk I and are based at OMC 1.
- **Millennium:** Mk II only, with rare exceptions (2-car pairs, run as 2 or 4 cars).
- **Canada Line:** Hyundai Rotem EMU only, always 2 cars.

The mix on the Expo Line and consist lengths by time of day are still open (#9).
