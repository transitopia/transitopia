# Open questions: Metro Vancouver operations

These questions refine how vehicles are placed. None of them block anything. Each has a **current assumption** that ships as a value in `config/`, whose comment cites the question by number ("OPEN-QUESTIONS #N"). When a question is answered, update the config, move the answer and its source to [README.md](README.md), and leave a one-line pointer here so the numbers stay stable.

Evidence cited below comes from feed `26SEP_20260925`, OSM (2026-09-25), and the Wikipedia track diagram v3 (mid-2021).

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
32. **Car numbering** (`config/trackside.json` → `cars`; [packages/trackside](../../packages/trackside/README.md)). Trackside cameras read the numbers painted on cars. Mk I and Mk III cars carry three-digit numbers near each end, and pairs are numbered odd then even (seven pairs seen near Main Street–Science World, 2026-10-01, Braden). Open: the number ranges of each fleet (Mk I, Mk II, Mk III, Mk V, Canada Line), how Mk V sets are numbered, and whether every Mk II and Mk III car is in an odd/even pair.
    - *Assumption:* every car number is three digits; cars pair as (odd, odd + 1), except Mk V.

## Kinematics and dwell

12. **Top speed, acceleration, and braking per line and technology** (LIM Mk I/II/III versus the Canada Line EMUs).
    - *Assumption:* 80 km/h top speed; accel 1.0 m/s²; decel 1.0 m/s² (1.3 m/s² for the Canada Line).
13. **Dwell times.** GTFS arrival equals departure. Are there typical dwells by station, e.g. longer at Commercial–Broadway and Waterfront?
    - *Assumption:* 25 s default, 35 s at major interchanges, with schedule slack absorbed into dwell.

## SeaBus and West Coast Express

14. *Answered:* SeaBus vessels and service by day. See [README → Vessels and service](README.md#vessels-and-service).
15. **West Coast Express storage.** Show trainsets parked mid-day near Waterfront and overnight at Mission?
    - *Assumption:* shown only while in service.

## Buses

16. **Show buses outside revenue trips** (layover, deadhead) when RT reports them?
    - *Assumption:* show only vehicles assigned to a trip on our routes.
25. **Live bus prediction** (`config/rt.json` → `prediction`). Tuned against recorded data only (13 h on 2026-09-25/26), not ground truth. Open: (a) when a predicted dwell ends without a new fix, the bus leaves on time: is missing RT data really likelier than a long dwell? (b) Pace adaptation to the individual bus is off (it didn't help with this little history); re-test as history grows. (c) Time-of-day bands (0/6/9/15/18 h) and weekday vs weekend aren't separated yet. (d) Stops and signals are only resolved as well as the fix interval allows: slow time within 75 m of a stop is treated as dwell (learned dwells p25/p50/p75 ≈ 22/32/45 s, including signal delay at the stop's intersection). Verify with field observations (GPS rides) of actual dwell and signal times. (e) Delay carry-forward: 120 s minimum turnaround at termini and carrying into at most 2 following trips are guesses; so is assuming buses that drop out of the feed mid-trip are still running.
28. **Bus detours, cancellations and skipped stops** (GTFS-RT; `packages/transit-core/src/rt/changes.ts`, `config/rt.json` → `detourNearM`). TransLink publishes detours only as alerts: route (sometimes direction), affected stops, and the path in words, with no shape and no GTFS-RT `TripModifications` (checked 2026-09-29). Cancellations come as trip updates (`CANCELED`, dropped from the feed once the trip is over) and as "no service" alerts naming the trip. Some cancellations are partial ("cancelled from Kootenay Loop", "resuming service at Lonsdale Quay"). *Assumptions:* (a) a bus off its route counts as on detour only within 3 km of a stop the alert lists (guess). Long-running detours such as the 99's since 2026-07-20 would otherwise hide GPS offsets route-wide. (b) A cancelled trip is dropped whole, except when a "no service" alert lists stops, which are then only skipped. Open: how partial cancellations look in trip updates, and whether planned detours like the 99's are already in the static GTFS shapes.
29. **TransLink request budget** (`config/rt.json` → `poll`, `packages/transit-core/src/rt/budget.ts`; [docs/DESIGN.md → Upstream request budget](../../docs/DESIGN.md#upstream-request-budget)). TransLink's Open API terms say an API key allows "a maximum of 1,000 requests per day" (checked 2026-09-29); for GTFS-RT this is not very frequent, and we would strongly prefer to fetch every 20 seconds or so - need to confirm these rate limits apply to GTFS-RT and ask about higher limits. For now, all three feeds we pull from TransLink share at most ~970 requests in any 24 hours, weighted to peaks. *Assumptions (guesses):* the peak bands (weekdays 06:30–09:30 and 15:00–18:30, weekends 10:00–18:00), that holidays can run the weekday schedule, and the cadence-dependent slacks (`staleGraceS`, `coverageSlackS`, `interpolateSlackS`, `extrapolateSlackS`, carried over from the 20 s settings). Effect on accuracy, from `pipelines/eval-rt.ts` (2026-09-29 07:00–10:00): profile prediction p50/p90 error is 82/287 m 60 s ahead, 156/559 m at ~150 s and 243/992 m at ~300 s. Open: TransLink's answer; whether to spend more of the budget on positions (trip updates mostly add delays, which positions plus the profile also give); adaptive polling around new SkyTrain disruption alerts.
30. **Observed stop times and route statistics** (`config/recording.json`, `packages/transit-core/src/rt/observed.ts`, `rt/stats.ts`; [docs/DESIGN.md → Retention and statistics](../../docs/DESIGN.md#retention-and-statistics)). With fixes 1–5 min apart, most stop times are interpolated along the shape between two fixes, so they're departures only to within that gap (each row records it as `precision_s`). *Assumptions (guesses):* fixes more than 100 m off the shape are ignored; no time for a stop between fixes more than 10 min apart; a bus has left a stop once it's 30 m past it (arrived at the last stop within 30 m); punctuality and headways only use times precise to 5 min; a trip counts as recorded when the recorder ran for 90 % of its scheduled span; bunching is a delivered gap under a quarter of the scheduled median; time bands (early/AM peak 06:00–09:00/midday/PM peak 15:00–18:30/evening/night). Open: validate interpolated departures against field observations (GPS rides) and against TransLink's own on-time figures; whether departures or arrivals should anchor punctuality at timepoints where buses hold.

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
24. *Answered:* SeaBus berths, lanes and the pair in use each day. See [README → Berths and lanes](README.md#berths-and-lanes).

## SeaBus AIS ([packages/transit-core/DESIGN.md → SeaBus AIS](../../packages/transit-core/DESIGN.md#seabus-ais))

27. **Matching AIS fixes to the timetable.** `config/seabus.json` → `ais.match`: a fix matches a trip within 200 m of its path and ±10 min of its timetable, and lateness carries over layovers down to a 90 s turnaround. All guesses, checked only against one evening's fixes (2026-09-28 from 19:16: every fix from the two vessels in service matched, within ±10 s of the timetable; docked fixes were within ~5 m of the West berth dock points). The glide settings (`ais.glide`: catch up at +4 m/s over ≤ 30 s, hold ≤ 90 s, jump over 400 m) are guesses too. Open: (a) how reliable aisstream.io's coverage of Burrard Inlet is over a whole day (30-minute probe: a median ~1 fix per minute per vessel, gaps up to ~4 min); (b) the real minimum turnaround; (c) whether the spare (Burrard Beaver) ever runs in service. Check with `npx tsx pipelines/eval-ais.ts <date>` as history grows.

## Signalling ([packages/transit-core/DESIGN.md → Dispatcher](../../packages/transit-core/DESIGN.md#dispatcher))

26. **Signalling system and parameters.** Expo, Millennium and Canada Lines are believed to use moving-block CBTC (Thales SelTrac); to verify. What are the safety margin behind the train ahead, the minimum headway, and how conflicts are resolved at junctions and at the entry to single-track sections (e.g. who goes first at the crossover south of Sapperton)? Does dwell extend while a train is held, and do CBTC trains recover lost time by running faster, or only at layovers? Evidence: on 2026-09-27 a northbound Braid short-turn held ~30 s just before that crossover, presumably while the departing short-turn cleared the shared west track ([README](README.md#braid-and-the-omc4-works)).
    - *Assumption:* `config/dispatch.json`, all guesses: 30 m safety margin, a train within 15 m of a switch fouls it, the train timetabled first goes first at a conflict (trains in service before empty moves), and a crossing move may use a section reserved the other way if it clears 30 s before the holder could arrive. When an alert single-tracks a line without giving headways, through trains run every 12 min per direction (`singleTrackHeadwayS`); what operators actually run (the Sep 28 Expo alert mentions extra short-turns Waterfront–Metrotown and Edmonds–King George/Production Way) is unknown.
31. **Single-track working from alerts.** When an alert says only "single-track between X and Y", which track stays open? (The confirm step in `/admin` asks for it, so each case needs ground truth.) How is the reduced-headway pattern timed relative to the rest of the line, and how should alerts whose text changes between polls be treated?
    - *Assumption:* a person names the open track when confirming; the reduced pattern starts at the alert's active period; drafts are keyed by the alert's id and redrafted from its current text (`apps/server/src/rt/alerts.ts`).
