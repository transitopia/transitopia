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

17. **Braid–Lougheed Expo track "under works".** OSM tags one Expo track between Braid and Lougheed (ways 87493028, 87493029, 392377336, 923211605) as `railway=construction`/`disused` with `opening_date=2027-06`, although it has a 2002 `start_date` and is still in the route relations. GTFS keeps scheduling westbound trains through Braid Platform 1, which needs that track. Is this track in service today, or is the section single-tracked?
    - *Assumption:* in service. It's drawn dashed. If it's single-tracked, add its way ids to `osm.excludeWays` in `data/infrastructure/overrides.json`.
18. **Terminal berths.** At stub termini, GTFS uses separate arrival-only and departure-only platforms (e.g. Waterfront Expo arrive P1 / depart P2; Lafarge Lake–Douglas arrive P2 / depart P1). Do trains unload and load at the same berth and reverse in place, or shunt between berths via the tail tracks? Which berths do consecutive trains use (alternating)?
    - *Assumption:* the solver picks the cheapest feasible option. It currently maps Waterfront Expo P1 and P2 to one berth (reverse in place). Berth alternation is future work.
19. **Diagram crossovers.** The Wikipedia diagram's crossovers haven't been transcribed into `data/infrastructure/diagram-checklist.json` yet, so OSM's crossovers are only validated indirectly: every timetabled move must be routable.
20. **Expo short-turns at Braid.** GTFS has Expo trips ending at Braid Platform 2 and others starting at Braid Platform 1, but OSM shows no crossover near Braid that could turn a train. The nearest turnback would take three reversals over 3 km. A temporary crossover for the Braid–Lougheed works (#17) would explain it.
    - *Assumption:* none. Those trains pull in to a yard instead of turning back. Adding a crossover near Braid via `turns.add` in `overrides.json` would fix it.

## Operations (found while inferring runs)

21. **Terminus capacity and layovers.** Waterfront (Expo) sees slightly more arrivals than departures from about 09:00 (a cumulative surplus of up to 4 trains), and Lafarge Lake–Douglas, Production Way and King George are busy too. With FIFO matching, surplus trains wait at the terminus, and at peak three trains can want two stub berths. `npm run validate:plan` counts these overlaps (Waterfront ≈ 570 conflicting pairs on a weekday). Where do surplus trains really go after the AM peak: back to OMC, into pocket tracks, or longer layovers elsewhere? How many trains can each terminus hold (tail tracks included)?
    - *Assumption:* trains queue at the terminus. Berths alternate between stub tracks when free.
22. **Pull-out and pull-in paths and timing.** Deadheads to and from OMC 1 run on main track at about 55 % of line speed and aren't slotted between service trains, so some overlap with trains in service near 22nd Street, New Westminster and Sapperton. Which way do trains enter and leave OMC 1, and at what times?
    - *Assumption:* the nearest yard by track distance, timed to arrive 90 s before the first departure.
23. **GTFS `block_id` for SkyTrain.** Blocks don't follow physical trains: a block reaching Waterfront at 06:23 continues from 22nd Street at 06:24. They're used only when the next trip starts where the last one ended.
