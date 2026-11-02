# Open questions: Greater Victoria

Each has a **current assumption** that ships as a value in the defaults (`config/defaults/`), BC Transit's `config/operators/bc-transit/operator.json` or the feed's `feed.json`, whose comment cites the question by number ("OPEN-QUESTIONS #N"). Numbers are stable.

1. **How often does BC Transit's static timetable really change?** Answered in part: the daily exports only drop the dates that have passed (see [README → Static timetable](README.md#static-timetable)), and aren't archived. Still open: how often a real timetable change comes, and whether storing each as a delta from the previous version is worth it (none were seen in the daily exports of 2026-10-14 to 10-25).
   - *Assumption:* a download that isn't the newest archived version minus past dates is a new timetable, archived and built (`fetch-gtfs`, `rolloffDifference` in `packages/data/src/gtfs-rolloff.ts`; about 16 MB a version).
2. **What request rate is acceptable to BC Transit?** The terms state no limit and the feeds need no key.
   - *Assumption:* positions every 30 s while buses run, trip updates every 2 minutes, alerts every 5 (less overnight), about 3,500 requests a day under a cap of 4,000; cadence thresholds (`staleGraceS`, `coverageSlackS`, `interpolateSlackS`, `extrapolateSlackS`) are guesses for 30 s fixes (`config/feeds/bc-transit-victoria/feed.json`).
3. **Do Metro Vancouver's prediction settings suit BC Transit's buses?** (`config/defaults/rt.json` → `prediction`, `carry`, `detourNearM`.)
   - *Assumption:* the same values, tuned on TransLink's 99 and RapidBus; to be checked with `npx tsx pipelines/eval-rt.ts --feed bc-transit-victoria` once recordings exist.
4. **Which buses run the drawn routes?** Victoria runs double-deckers and 12 m buses; the vehicle labels in GTFS-RT are long ids (`3131357525`), not fleet numbers.
   - *Assumption:* 12 m long, 2.6 m wide, 90 km/h top speed (`config/defaults/kinematics.json`).
5. **How does BC Transit publish detours?** Alerts seen so far name stops (closures) with `NO_SERVICE`, and some routes.
   - *Assumption:* alerts are read as TransLink's are (`packages/transit-core/src/rt/changes.ts`).
