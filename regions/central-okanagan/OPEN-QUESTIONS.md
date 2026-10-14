# Open questions: Central Okanagan

Each has a **current assumption** that ships as a value in `config/` or the feed's `feed.json`, whose comment cites the question by number ("OPEN-QUESTIONS #N"). Numbers are stable.

1. **How often does BC Transit's static feed really change?** Its `feed_version` changes with every daily export.
   - *Assumption:* a download whose files are the same as the newest archived version's isn't archived or built again (`fetch-gtfs`). If calendar dates roll daily, every export differs and is archived (about 1 MB a day for Kelowna).
2. **What request rate is acceptable to BC Transit?** The terms state no limit and the feeds need no key.
   - *Assumption:* positions every 30 s while buses run, trip updates every 2 minutes, alerts every 5 (less overnight), about 3,500 requests a day under a cap of 4,000; cadence thresholds (`staleGraceS`, `coverageSlackS`, `interpolateSlackS`, `extrapolateSlackS`) are guesses for 30 s fixes (`feeds/bc-transit-kelowna/feed.json`).
3. **Do Metro Vancouver's prediction settings suit BC Transit's buses?** (`config/rt.json` → `prediction`, `carry`, `detourNearM`.)
   - *Assumption:* the same values, tuned on TransLink's 99 and RapidBus; to be checked with `npx tsx pipelines/eval-rt.ts --feed bc-transit-kelowna` once recordings exist.
4. **Which buses run the drawn routes?** The 97 RapidBus may run articulated buses; the vehicle labels in GTFS-RT are long ids (`3131357525`), not fleet numbers.
   - *Assumption:* 12 m long, 2.6 m wide, 90 km/h top speed (`config/kinematics.json`).
5. **How does BC Transit publish detours?** Alerts seen so far name stops (closures) with `NO_SERVICE`, and some routes.
   - *Assumption:* alerts are read as TransLink's are (`packages/transit-core/src/rt/changes.ts`).
