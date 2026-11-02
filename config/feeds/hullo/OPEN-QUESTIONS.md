# Open questions: Hullo

Each has a **current assumption** that ships as a value in the feed's `feed.json`, `routes.json` or `ferries/hullo.json`, whose comment cites the question by number ("OPEN-QUESTIONS #N"). Numbers are stable.

1. **Where exactly are the berths and lanes?** The lane is the average of five crossings' AIS tracks, read off one screenshot (Braden, 2026-11-02) and georeferenced on the two terminals and Lions Gate Bridge, so it's good to about ±200 m; the berths come from where the tracks end (Vancouver's moved onto the water beside the terminal's pier, as the basemap draws it).
   - *Assumption:* one lane run both ways (no keep-right lanes as for the SeaBus), one berth at each terminal, leaving and entering it straight for 150 m (`ferries/hullo.json`). Better: trace each direction from a day of recorded fixes (`var/ais-history/hullo/`) once there are some, as for the SeaBus.
2. **How big and fast are the vessels?** *spuhéls* and *sthuqi'* are fast catamarans; their length, beam and service speed weren't looked up.
   - *Assumption:* 45 m × 12 m, 60 km/h (~32 kn) in open water, accelerating at 0.15 m/s² (`routes.json` → `kinematics`): the 75-minute timetabled crossing of ~65 km averages 52 km/h with the slow harbour legs.
3. **Will the next timetable be published before this one ends?** The feed checked on 2026-11-01 (version `20261020115220`) runs to 2026-12-31.
   - *Assumption:* yes; `fetch-gtfs` archives every version it sees, and without a newer one the route has no trips after 2026-12-31.
4. **May the GTFS be republished?** Hullo publishes the zip without terms; its website terms don't mention it ([DATA-LICENSES.md](../../../DATA-LICENSES.md)).
   - *Assumption:* Assume fair use and credit as "Schedules: Hullo" (`packages/shared/src/datasets.ts`).
5. **How well do the vessels' AIS fixes cover the crossing, and match the timetable?** Not probed yet: aisstream.io relies on shore receivers, which may miss mid-strait.
   - *Assumption:* the SeaBus's matching with looser limits for an averaged lane and a long crossing (`feed.json` → `ais.match`, `ais.glide`); gaps are filled from the timetable. Check with `npx tsx pipelines/eval-ais.ts --feed hullo` once fixes are recorded.
