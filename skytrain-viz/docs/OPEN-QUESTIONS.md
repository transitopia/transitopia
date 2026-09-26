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
