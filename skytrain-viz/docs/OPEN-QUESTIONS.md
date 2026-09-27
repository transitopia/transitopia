# Open questions: operations knowledge

These questions refine how trains are placed. None of them block implementation. Each has a **current assumption** that ships as a value in `data/config/`. When a question is answered, update the config, record the answer and its source here, and mark it ✅.

Evidence cited below comes from feed `26SEP_20260925`, OSM (2026-09-25), and the Wikipedia track diagram v3 (mid-2021).

## Yards and layup

1. **Which yard serves which trains?**
   - Evidence: OSM shows three rail yards: OMC 1 south of Edmonds (~75 yard tracks), the Canada Line OMC east of Bridgeport (~50), and a ~16-track yard near Inlet Centre/Coquitlam Central. The diagram says Expo and Millennium share a central OMC south of Edmonds, "with an extra storage facility in Coquitlam".
   - *Assumption:* Expo uses OMC 1. Millennium uses the Coquitlam yard for its eastern end and OMC 1 otherwise. Canada Line uses its own OMC.
2. **Do trains lay up overnight on tail, pocket, or platform tracks instead of returning to a yard?**
   - Evidence: weekday Expo runs start at King George (33) and Waterfront (30), and 50 of 89 Millennium runs start at Lafarge Lake–Douglas.
   - *Assumption:* trains run light from the nearest yard before the first trip, and back after the last trip. No on-line layup.
3. **How do Expo trains reach King George for early departures?** Is it a deadhead from OMC 1 via the Skybridge, or overnight storage on the King George tail tracks?
   - *Assumption:* a deadhead from OMC 1.
4. **Where does the Millennium Line / Coquitlam yard lead join the mainline, and is it the "Falcon Drive" facility on the diagram?** OSM places the yard around 49.28, −122.82.
   - *Assumption:* use the OSM lead location.
5. **Expo trips ending at Lougheed P2, and Millennium trips starting at Lougheed P3.** Are these yard transfers between lines?
   - *Assumption:* yes. Expo trains continue light to the Coquitlam yard or back to OMC 1.

## Turnbacks and pockets

6. **Turnback practice at each terminus and short-turn point:** which tail, pocket, or crossover is used, and the typical minimum layover. Points to cover:
   - Waterfront (Expo; Canada P4/P5)
   - King George
   - Production Way
   - Braid
   - New Westminster
   - VCC–Clark
   - Lafarge Lake–Douglas
   - Lougheed
   - YVR-Airport
   - Richmond-Brighouse
   - Bridgeport
   - *Assumption:* reverse via the tail track beyond the platform where one exists, otherwise via the nearest crossover; minimum layover 2 min.
7. **Daytime use of named pockets:** Metrotown, Vanness, Holdom, Moody Centre, Great Northern, "Mainline Pocket" near OMC 1. Are gap trains or spares stored there during the day?
   - *Assumption:* unused except for turnbacks that GTFS requires.
8. **Richmond-Brighouse and YVR-Airport terminus platforms.** GTFS gives no platform number at these termini. Are they single-platform or two-platform stations?
   - *Assumption:* taken from OSM geometry.

## Fleet and consists

9. **Consist lengths by line and time of day.** Mk I 4- or 6-car, Mk II and Mk III 2- or 4-car, Canada Line 2-car EMU. Are Mk V trains in service yet on the Expo Line, and in what lengths?
   - *Assumption:* consist type unknown. Expo trains are drawn at 80 m, Millennium at 68 m, Canada Line at 41 m.
10. **Peak trains in service per line** (weekday AM, PM, midday, weekend). This is the main sanity check for run inference.
    - *Assumption:* none. Inference output is reported, not constrained, until caps are known.
11. **Any public source for train or car numbers per run?** Examples: fan logs, TransLink releases, ground observation.
    - *Assumption:* none.

## Kinematics and dwell

12. **Top speed, acceleration, and braking per line and technology** (LIM Mk I/II/III versus the Canada Line EMUs).
    - *Assumption:* 80 km/h top speed; accel 1.0 m/s²; decel 1.0 m/s² (1.3 m/s² for the Canada Line).
13. **Dwell times.** GTFS arrival equals departure. Are there typical dwells by station, e.g. longer at Commercial–Broadway and Waterfront?
    - *Assumption:* 25 s default, 35 s at major interchanges, with schedule slack absorbed into dwell.

## SeaBus and West Coast Express

14. **SeaBus vessels.** How many operate at once, and are spare vessels shown at the Lonsdale maintenance berth?
    - *Assumption:* only vessels in service are shown.
15. **West Coast Express storage.** Show trainsets parked mid-day near Waterfront and overnight at Mission?
    - *Assumption:* shown only while in service.

## Buses

16. **Show buses outside revenue trips** (layover, deadhead) when RT reports them?
    - *Assumption:* show only vehicles assigned to a trip on our routes.

## Infrastructure (found while building the track graph)

17. ✅ **Braid–Lougheed Expo track.** Closed until about 2027 for the OMC4 flyover works (Braden, 2026-09-26). The other track is single-tracked. The closed ways are excluded via `osm.excludeWays`.
18. ✅ **Terminal berths (Waterfront Expo).** Platform 1 is on the south approach track, Platform 2 on the north one (the left side when arriving), both west of the throat switches; the stubs beyond are tail tracks (OSM platform refs + Braden, 2026-09-26). Usual pattern: drop off at Platform 1, reverse in a tail track, board at Platform 2. When the station is quiet, trains may go straight to Platform 2 and turn there (observed 14:02 Saturday); that variant isn't modelled. *Still open:* the same question for Lafarge Lake–Douglas and the Canada Line's Waterfront platforms.
19. **Diagram crossovers.** The Wikipedia diagram's crossovers haven't been transcribed into `data/infrastructure/diagram-checklist.json` yet, so OSM's crossovers are only validated indirectly: every timetabled move must be routable.
20. ✅ **Braid short-turns (OMC4 works).** 2026 satellite imagery shows no crossover near Braid, and the west track is blocked just north of the station (Braden, 2026-09-26). Short-turns use that west-track stub (TransLink calls it Platform 2) in both directions, between Braid and the crossover just south of Sapperton. Trains to and from Lougheed and Production Way–University use the east track in both directions (Platform 1). GTFS platform numbers at Braid and Sapperton don't reflect this, so it's modelled with role-based `patternPlatforms` rules in `overrides.json`. Remove them when the works finish (~2027).

## Operations (found while inferring runs)

21. **Terminus capacity and layovers.** ✅ *Surplus trains:* operators run them back to the OMC empty ("do not board") between scheduled trains (Braden, 2026-09-26). Modelled with `turnback.stubMaxLayoverS` (600 s): at stub termini, a train that would wait longer returns to the yard. That cut Waterfront overlaps from 496 to 210 and weekday conflicts from 1,629 to about 1,400, for 14 extra empty trips. Stricter limits (420 s) cascade into many more empty trips. *Still open:* how many trains each terminus holds, and where trains wait at King George, VCC–Clark and Production Way–University (their tails/pockets). These account for most remaining overlaps (≈950 of ≈1,400 conflicting pairs).
22. **Pull-out and pull-in paths and timing.** Deadheads to and from OMC 1 run on main track at about 55 % of line speed and aren't slotted between service trains, so some overlap with trains in service near 22nd Street, New Westminster and Sapperton. Which way do trains enter and leave OMC 1, and at what times?
    - *Assumption:* the nearest yard by track distance, timed to arrive 90 s before the first departure.
23. **GTFS `block_id` for SkyTrain.** Blocks don't follow physical trains: a block reaching Waterfront at 06:23 continues from 22nd Street at 06:24. They're used only when the next trip starts where the last one ended.
24. **SeaBus berths.** Waterfront and Lonsdale Quay each have two berths (Sep 26: the Burrard Pacific Breeze used the West berth at Waterfront at 14:15 and the western berth at Lonsdale Quay at 14:29 (Braden)). The SeaBus is drawn along its GTFS shapes, so berths aren't modelled. Braden's guess: each terminal uses one berth all day. Needs sightings at different times of day (or on different days) to confirm.
25. **Live bus prediction** (`data/config/rt.json` → `prediction`). Tuned against recorded data only (13 h on 2026-09-25/26), not ground truth. Open: (a) when a predicted dwell ends without a new fix, the bus leaves on time: is missing RT data really likelier than a long dwell? (b) Pace adaptation to the individual bus is off (it didn't help with this little history); re-test as history grows. (c) Time-of-day bands (0/6/9/15/18 h) and weekday vs weekend aren't separated yet. (d) Stops and signals are only resolved as well as ~30 s fixes allow: slow time within 75 m of a stop is treated as dwell (learned dwells p25/p50/p75 ≈ 22/32/45 s, including signal delay at the stop's intersection). Verify with field observations (GPS rides) of actual dwell and signal times.
