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
   - *Assumption:* reverse via the tail track beyond the platform where one exists, otherwise via the nearest crossover; minimum layover 2 min. Turnback moves run at 0.8 × line speed (`turnback.speedFactor`, guess): at the pull-out speed (0.55) the timetable's 4-minute turnaround at Production Way–University was infeasible, so trains waited 16 min for a later departure on Millennium platforms.
7. **Daytime use of named pockets:** Metrotown, Vanness, Holdom, Moody Centre, Great Northern, "Mainline Pocket" near OMC 1. Are gap trains or spares stored there during the day?
   - *Assumption:* unused except for turnbacks that GTFS requires.
8. ✅ **Richmond-Brighouse and YVR-Airport terminus platforms.** GTFS has an "@ Platform 1" stop and an unnumbered "@ Canada Line" stop at each. Both are single-platform, single-track stations (Braden, 2026-09-28). OSM agrees: the platform mapping puts both GTFS stops at each station ("@ Platform 1" and "@ Canada Line") on the one track there (`w551355748.0` at Richmond-Brighouse, `w551364384.0` at YVR-Airport). Trains arrive and depart from the same platform, so each terminus holds one train at a time.

## Fleet and consists

9. **Consist lengths by line and time of day.** *Partly answered.* Rolling stock by line (CPTDB wiki, "SkyTrain" § Rolling Stock and "BCRTC 1700/1800 series"; Braden, 2026-09-28):
   - **Expo:** Mk I (2-car pairs, run as 4 or 6 cars), Mk III (4-car sets) and ✅ **Mk V, in service since 2025-07-10**. Mk V cars run in semi-permanent articulated 5-car sets, about 84.8 m long (2 × 17.35 m end cars + 3 × 16.70 m middle cars), 2.65 m wide, 80 km/h in service. Twelve sets were in service by September 2026 (Braden, from CPTDB), of 41 ordered; they replace Mk I and are based at OMC 1.
   - **Millennium:** ✅ Mk II only, with rare exceptions (2-car pairs, run as 2 or 4 cars).
   - **Canada Line:** ✅ Hyundai Rotem EMU only, always 2 cars.
   - *Still open:* the mix of Mk I, Mk III and Mk V on the Expo Line (and whether Mk II still runs there), and Mk I and Millennium consist lengths by time of day.
   - *Assumption:* the consist of a given run is unknown unless observed. Expo trains are drawn at 80 m (between a 6-car Mk I and a Mk V), Millennium at 68 m (4-car Mk II), Canada Line at 41 m.
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

14. ✅ **SeaBus vessels.** Two vessels normally, three at weekday peaks (Braden, 2026-09-28), confirmed against GTFS feed 26SEP_20260925. Every crossing is 12 min, with 2–4 min layovers. GTFS blocks follow one vessel each: every trip in a block starts where the last one ended.
    - **Weekdays** (4 blocks, at most 3 at once): 15-min service with 2 vessels from 06:02, 10-min service with 3 vessels 07:10–09:47 and 15:10–18:47 (Lonsdale Quay departures every 10 min 07:00–09:30 and 15:00–18:30, Waterfront 07:15–09:35 and 15:15–18:45), 15-min service with 2 vessels in between and until 21:13, then 30-min service with 1 vessel until 01:34. One vessel runs 05:47–06:02. The AM (05:47–09:47) and PM (15:10–21:13) peak extras are separate blocks; whether they're the same vessel isn't in the data.
    - **Saturday:** 1 vessel 06:02–07:17 (30 min), 2 until 21:13 (15 min), then 1 until 01:34. **Sunday/holidays:** 1 vessel 08:02–08:17, 2 until 21:14, then 1 until 23:34.
    - Only vessels in service are shown. A vessel is drawn from its block's first departure to its last arrival and waits at the dock between crossings; vessels out of service (spares, the Lonsdale maintenance berth) are hidden. *Future:* live positions from AIS.
15. **West Coast Express storage.** Show trainsets parked mid-day near Waterfront and overnight at Mission?
    - *Assumption:* shown only while in service.

## Buses

16. **Show buses outside revenue trips** (layover, deadhead) when RT reports them?
    - *Assumption:* show only vehicles assigned to a trip on our routes.

## Infrastructure (found while building the track graph)

17. ✅ **Braid–Lougheed Expo track.** Single-tracked until about 2027 for the OMC4 flyover works. The west/south track, the one that serves Braid Platform 1, is closed beyond that platform. The east/north track, which normally carries trains from Braid to Lougheed, stays open and carries the smaller Lougheed and Production Way–University service in both directions (Braden, 2026-09-26 and 2026-09-27). The closed ways are excluded via `osm.excludeWays`. OSM way 83590063 keeps ~430 m of the closed track beyond Braid Platform 1 as a dead-end stub. It's left in place because the barrier's position isn't known, and `turnback.maxPullUpM` keeps short-turns at the platform instead of pulling them up to the stub's end.
18. ✅ **Terminal berths (Waterfront Expo).** Platform 1 is on the south approach track, Platform 2 on the north one (the left side when arriving), both west of the throat switches; the stubs beyond are tail tracks (OSM platform refs + Braden, 2026-09-26). Usual pattern: drop off at Platform 1, reverse in a tail track, board at Platform 2. When the station is quiet, trains may go straight to Platform 2 and turn there (observed 14:02 Saturday); that variant isn't modelled. *Still open:* the same question for Lafarge Lake–Douglas and the Canada Line's Waterfront platforms.
19. **Diagram crossovers.** The Wikipedia diagram's crossovers haven't been transcribed into `data/infrastructure/diagram-checklist.json` yet, so OSM's crossovers are only validated indirectly: every timetabled move must be routable.
20. ✅ **Braid short-turns (OMC4 works).** 2026 satellite imagery shows no crossover near Braid (Braden, 2026-09-26). Short-turns switch to the west track at the crossover ~460 m south of Sapperton (OSM way 426641643), stop at Sapperton Platform 1, and terminate at Braid Platform 1, the west side, where the track ends. They start back from Braid Platform 1 on the same track. Trains to and from Lougheed and Production Way–University use the east track and Platform 2 at both stations, in both directions. Platform signs on 2026-09-27: Sapperton Platform 1 "Braid" and "Waterfront"; Sapperton Platform 2 "Production Way–University" and "Waterfront"; Braid Platform 1 "Waterfront" only; Braid Platform 2 both directions. GPS on a short-turn that day (block 2205212, `data/observations/2026-09-27-braden-expo.json`) confirms the crossover and the layover at Braid Platform 1 (17:14:37–17:21:16); the train held ~30 s before the crossover, presumably for the departing short-turn to clear the shared track. GTFS uses the normal assignments (outbound Platform 2, inbound Platform 1), which is wrong for trips terminating at Braid and for through trips toward Waterfront, so it's modelled with role-based `patternPlatforms` rules in `overrides.json`. Remove them when the works finish (~2027).

## Operations (found while inferring runs)

21. **Terminus capacity and layovers.** ✅ *Surplus trains:* operators run them back to the OMC empty ("do not board") between scheduled trains (Braden, 2026-09-26). Modelled with `turnback.stubMaxLayoverS` (600 s): at stub termini, a train that would wait longer returns to the yard. That cut Waterfront overlaps from 496 to 210 and weekday conflicts from 1,629 to about 1,400, for 14 extra empty trips. Stricter limits (420 s) cascade into many more empty trips. *Still open:* how many trains each terminus holds, and where trains wait at King George, VCC–Clark and Production Way–University (their tails/pockets). These account for most remaining overlaps (≈950 of ≈1,400 conflicting pairs). *Since the dispatcher (2026-09-28):* terminus overlaps became queues, and first-come-first-served chaining turned out to keep the morning's pool of trains at Waterfront all day (8-minute layovers at 3-minute headways). A stub terminus now holds at most one waiting train per dead-ended track (Waterfront Expo: the turnback stub and Platform 2); a train arriving when they're full is surplus and returns to the yard. That's ~100 extra empty trips per weekday from Waterfront, probably more than reality; the real turnaround may be shorter (the timetable has departures 2 min after arrivals, our turnback needs ~2.1 min).
22. **Pull-out and pull-in paths and timing.** Deadheads to and from OMC 1 run on main track at about 55 % of line speed and aren't slotted between service trains, so some overlap with trains in service near 22nd Street, New Westminster and Sapperton. Which way do trains enter and leave OMC 1, and at what times?
    - *Assumption:* the nearest yard by track distance, timed to arrive 90 s before the first departure. Pull-outs and pull-ins keep to the normal direction of traffic where they can: running against it costs 3 extra metres per metre when choosing their path (`yard.againstTrafficPenalty`, guess). Plain shortest paths ran them against traffic over ~74 km of main line, now ~5 km.
23. **GTFS `block_id` for SkyTrain.** Blocks don't follow physical trains: a block reaching Waterfront at 06:23 continues from 22nd Street at 06:24. They're used only when the next trip starts where the last one ended.
24. **SeaBus berths.** *Partly answered.* Waterfront and Lonsdale Quay each have two berths (Sep 26: the Burrard Pacific Breeze used the West berth at Waterfront at 14:15 and the western berth at Lonsdale Quay at 14:29 (Braden)). ✅ A vessel runs west berth to west berth or east to east, since the wheelhouse sees the ramps better from one side; and ✅ vessels keep right, so the two directions cross on either side of the direct line, up to ~250 m apart (AIS tracks, Braden, 2026-09-28). Modelled in `data/infrastructure/seabus.json` (berths, lanes traced from AIS) and `data/config/seabus.json` (pairing), applied at plan build time instead of the GTFS shapes.
    - *Still open:* which vessel (GTFS block) uses which pair. *Assumption:* one pair per block all day, assigned so berths aren't shared while docked, then to balance vessels in service; on weekdays that puts the AM and PM peak extras and the 07:10–18:47 vessel on West, the all-day vessel on East. Also the berth positions: read off the basemap's pier outlines, not imagery, so verify them. Live AIS would answer both.
25. **Live bus prediction** (`data/config/rt.json` → `prediction`). Tuned against recorded data only (13 h on 2026-09-25/26), not ground truth. Open: (a) when a predicted dwell ends without a new fix, the bus leaves on time: is missing RT data really likelier than a long dwell? (b) Pace adaptation to the individual bus is off (it didn't help with this little history); re-test as history grows. (c) Time-of-day bands (0/6/9/15/18 h) and weekday vs weekend aren't separated yet. (d) Stops and signals are only resolved as well as ~30 s fixes allow: slow time within 75 m of a stop is treated as dwell (learned dwells p25/p50/p75 ≈ 22/32/45 s, including signal delay at the stop's intersection). Verify with field observations (GPS rides) of actual dwell and signal times. (e) Delay carry-forward: 120 s minimum turnaround at termini and carrying into at most 2 following trips are guesses; so is assuming buses that drop out of the feed mid-trip are still running.

## Signalling (for the dispatcher, PLAN.md §4.11)

26. **Signalling system and parameters.** Expo, Millennium and Canada Lines are believed to use moving-block CBTC (Thales SelTrac); to verify. What are the safety margin behind the train ahead, the minimum headway, and how conflicts are resolved at junctions and at the entry to single-track sections (e.g. who goes first at the crossover south of Sapperton)? Evidence: on 2026-09-27 a northbound Braid short-turn held ~30 s just before that crossover, presumably while the departing short-turn cleared the shared west track (#20).
    - *Assumption:* `data/config/dispatch.json`, all guesses: 30 m safety margin, a train within 15 m of a switch fouls it, the train timetabled first goes first at a conflict (trains in service before empty moves), and a crossing move may use a section reserved the other way if it clears 30 s before the holder could arrive. When an alert single-tracks a line without giving headways, through trains run every 12 min per direction (`singleTrackHeadwayS`); what operators actually run (the Sep 28 Expo alert mentions extra short-turns Waterfront–Metrotown and Edmonds–King George/Production Way) is unknown.
