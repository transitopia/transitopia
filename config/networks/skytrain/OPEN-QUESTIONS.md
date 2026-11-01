# Open questions: SkyTrain operations

These questions refine how vehicles are placed. None of them block anything. Each has a **current assumption** that ships as a value in this network's settings files (`operations.json`, `dispatch.json`), `config/defaults/`, TransLink's `operator.json` or its feed's `routes.json`, whose comment cites the question by number ("OPEN-QUESTIONS #N"). When a question is answered, update the config, move the answer and its source to [README.md](README.md), and leave a one-line pointer here so the numbers stay stable.

Evidence cited below comes from feed `26SEP_20260925`, OSM (2026-09-25), and the Wikipedia track diagram v3 (mid-2021).

Questions 14–16, 24, 25 and 27–30 (SeaBus, West Coast Express, buses, AIS and polling) are TransLink's feed's, in [config/feeds/translink/OPEN-QUESTIONS.md](../../feeds/translink/OPEN-QUESTIONS.md), under the same numbers.

## Yards and layup

1. **Which yard serves which trains?**
   - Evidence: three yards: OMC 1 (Edmonds), the Canada Line OMC (Bridgeport) and OMC 3 (Falcon Drive, Coquitlam) ([README → Yards and overnight layup](README.md#yards-and-overnight-layup)). The diagram says Expo and Millennium share OMC 1, "with an extra storage facility in Coquitlam".
   - *Assumption:* each run uses the nearest yard by track distance: in practice Expo uses OMC 1, Millennium uses OMC 3 for its eastern end and OMC 1 otherwise, and Canada Line uses its own OMC.
2. **Where exactly do trains lay up overnight on the line?** Answered in part: most trains stay at OMC 1, but 15 sleep on the tracks along the Millennium Line and near King George (2022; [README](README.md#yards-and-overnight-layup)). *Still open:* which tracks (tails, pockets, platforms) and how many at each, whether the number has changed since 2022, and whether Canada Line trains lay up outside their OMC.
   - Evidence: weekday Expo runs start at King George (33) and Waterfront (30), and 50 of 89 Millennium runs start at Lafarge Lake–Douglas.
   - *Assumption (known to be wrong):* trains run light from the nearest yard before the first trip, and back after the last trip. On-line layup isn't modelled.
3. *Answered:* Expo trains for King George's early departures are stored overnight near the station. See [README → Yards and overnight layup](README.md#yards-and-overnight-layup).
4. *Answered:* the Coquitlam yard is OMC 3 at Falcon Drive, and OSM's location and connections are correct. See [README → Yards and overnight layup](README.md#yards-and-overnight-layup).
5. **Expo trips ending at Lougheed P2, and Millennium trips starting at Lougheed P3.** Are these yard transfers between lines?
   - *Assumption:* yes. Expo trains continue light to OMC 3 or back to OMC 1.

## Turnbacks and pockets

6. **Turnback practice at each terminus and short-turn point:** which tail, pocket, or crossover is used, and the typical minimum layover. Points to cover: Waterfront (Expo; Canada P4/P5), King George, Production Way, Braid, New Westminster, VCC–Clark, Lafarge Lake–Douglas, Lougheed, YVR-Airport, Richmond-Brighouse, Bridgeport.
   - *Assumption:* reverse via the tail track beyond the platform where one exists, otherwise via the nearest crossover; minimum layover 2 min. Turnback moves run at 0.8 × line speed (`turnback.speedFactor`, guess): at the pull-out speed (0.55) the timetable's 4-minute turnaround at Production Way–University was infeasible, so trains waited 16 min for a later departure on Millennium platforms.
7. **Daytime use of named pockets:** Metrotown, Vanness, Holdom, Moody Centre, Great Northern, "Mainline Pocket" near OMC 1. Are gap trains or spares stored there during the day?
   - *Assumption:* unused except for turnbacks that GTFS requires.
8. *Answered:* Richmond-Brighouse and YVR-Airport are single-platform termini. See [README → Terminus platforms](README.md#terminus-platforms-at-richmond-brighouse-and-yvr-airport).

## Fleet and consists

9. **Consist lengths by line and time of day.** Overall rolling stock by line is known ([README → Rolling stock](README.md#rolling-stock-by-line)), but we don't yet have a way to identify individual consists (trainsets).
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

## Infrastructure

17. *Answered:* the Braid–Lougheed track during the OMC4 works. See [README → Braid and the OMC4 works](README.md#braid-and-the-omc4-works).
18. **Terminal berths.** Waterfront (Expo) is answered ([README](README.md#waterfront-expo-terminal-berths)). *Still open:* the same question for Lafarge Lake–Douglas and the Canada Line's Waterfront platforms: which platform trains arrive at, where they reverse, and whether they turn in place when it's quiet.
    - *Assumption:* the platform mapping's choice (GTFS platforms, with tail-track reversals where they exist).
19. *Moved to a GitHub issue:* transcribing the Wikipedia diagram's crossovers into `infrastructure/diagram-checklist.json`.
20. *Answered:* Braid short-turns. See [README → Braid and the OMC4 works](README.md#braid-and-the-omc4-works).

## Operations (found while inferring runs)

21. **Terminus capacity and layovers.** Surplus trains are answered ([README → Surplus trains](README.md#surplus-trains-at-termini)). *Still open:* how many trains each terminus holds, and where trains wait at King George, VCC–Clark and Production Way–University (their tails and pockets). Since the dispatcher (2026-09-28), terminus overlaps became queues, and first-come-first-served chaining kept the morning's pool of trains at Waterfront all day (8-minute layovers at 3-minute headways). Holding at most one waiting train per dead-ended track means ~100 extra empty trips per weekday from Waterfront, probably more than reality; the real turnaround may be shorter (the timetable has departures 2 min after arrivals, our turnback needs ~2.1 min).
22. **Pull-out and pull-in paths and timing.** Deadheads to and from OMC 1 run on main track at about 55 % of line speed and aren't slotted between service trains, so some overlap with trains in service near 22nd Street, New Westminster and Sapperton. Which way do trains enter and leave OMC 1, and at what times?
    - *Assumption:* the nearest yard by track distance, timed to arrive 90 s before the first departure. Pull-outs and pull-ins keep to the normal direction of traffic where they can: running against it costs 3 extra metres per metre when choosing their path (`yard.againstTrafficPenalty`, guess). Plain shortest paths ran them against traffic over ~74 km of main line, now ~5 km.
23. *Answered:* GTFS blocks don't follow physical trains. See [README → GTFS blocks](README.md#gtfs-blocks).

## Signalling ([packages/transit-core/DESIGN.md → Dispatcher](../../../packages/transit-core/DESIGN.md#dispatcher))

26. **Signalling system and parameters.** Expo, Millennium and Canada Lines are believed to use moving-block CBTC (Thales SelTrac); to verify. What are the safety margin behind the train ahead, the minimum headway, and how conflicts are resolved at junctions and at the entry to single-track sections (e.g. who goes first at the crossover south of Sapperton)? Does dwell extend while a train is held, and do CBTC trains recover lost time by running faster, or only at layovers? Evidence: on 2026-09-27 a northbound Braid short-turn held ~30 s just before that crossover, presumably while the departing short-turn cleared the shared west track ([README](README.md#braid-and-the-omc4-works)).
    - *Assumption:* `dispatch.json`, all guesses: 30 m safety margin, a train within 15 m of a switch fouls it, the train timetabled first goes first at a conflict (trains in service before empty moves), and a crossing move may use a section reserved the other way if it clears 30 s before the holder could arrive. When an alert single-tracks a line without giving headways, through trains run every 12 min per direction (`singleTrackHeadwayS`); what operators actually run (the Sep 28 Expo alert mentions extra short-turns Waterfront–Metrotown and Edmonds–King George/Production Way) is unknown.
31. **Single-track working from alerts.** When an alert says only "single-track between X and Y", which track stays open? (The confirm step in `/admin` asks for it, so each case needs ground truth.) How is the reduced-headway pattern timed relative to the rest of the line, and how should alerts whose text changes between polls be treated?
    - *Assumption:* a person names the open track when confirming; the reduced pattern starts at the alert's active period; drafts are keyed by the alert's id and redrafted from its current text (`apps/server/src/rt/alerts.ts`).
