# Open questions: East Kootenay

Each has a **current assumption** that ships as a value in the defaults (`config/defaults/`), BC Transit's `config/operators/bc-transit/operator.json` or the feed's `feed.json`, whose comment cites the question by number ("OPEN-QUESTIONS #N"). Numbers are stable.

1. **How often does BC Transit's static timetable really change?** As for Central Okanagan ([its OPEN-QUESTIONS #1](../bc-transit-kelowna/OPEN-QUESTIONS.md)): the daily exports are assumed to only drop the dates that have passed, which hasn't been checked on these exports yet.
   - *Assumption:* a download that isn't the newest archived version minus past dates is a new timetable, archived and built (`fetch-gtfs`, `rolloffDifference` in `packages/data/src/gtfs-rolloff.ts`).
2. **What request rate is acceptable to BC Transit?** The terms state no limit and the feeds need no key.
   - *Assumption:* positions and trip updates every 5 minutes while buses run, alerts every 15 (less overnight), about 610 requests a day under a cap of 1,000: small systems don't need frequent polling (as for the West Kootenay: Braden MacDonald, 2026-11-02). Cadence thresholds (`staleGraceS`, `coverageSlackS`, `interpolateSlackS`, `extrapolateSlackS`) are guesses for 5-minute fixes (`config/feeds/bc-transit-east-kootenay/feed.json`).
3. **Do Metro Vancouver's prediction settings suit these buses?** (`config/defaults/rt.json` → `prediction`, `carry`, `detourNearM`.) Many of these routes are rural or run between towns on highways, unlike any route they were tuned on.
   - *Assumption:* the same values, tuned on TransLink's 99 and RapidBus; to be checked with `npx tsx pipelines/eval-rt.ts --feed bc-transit-east-kootenay` once recordings exist.
4. **Which buses run the routes?** Fleet types per system (smaller systems run many community shuttles) aren't known; vehicle labels in GTFS-RT are long ids, not fleet numbers.
   - *Assumption:* 12 m long, 2.6 m wide, 90 km/h top speed (`config/defaults/kinematics.json`).
5. **How does BC Transit publish detours?** As for Central Okanagan ([its OPEN-QUESTIONS #5](../bc-transit-kelowna/OPEN-QUESTIONS.md)).
   - *Assumption:* alerts are read as TransLink's are (`packages/transit-core/src/rt/changes.ts`).
