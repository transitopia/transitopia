# Open questions: Greater Victoria

Each has a **current assumption** that ships as a value in the defaults (`config/defaults/`), BC Transit's `config/operators/bc-transit/operator.json` or the feed's `feed.json`, whose comment cites the question by number ("OPEN-QUESTIONS #N"). Numbers are stable.

1. **How often does BC Transit's static feed really change?** Its `feed_version` changes with every daily export, and so do its files: from 2026-10-14 to 10-15, calendar_dates.txt, trips.txt and stop_times.txt differed, dropping the dates (and services) that had passed. So every export is archived and built as a new version; whether the timetable itself changes between them, and whether to keep fewer versions, is still open.
   - *Assumption:* a download whose files are the same as the newest archived version's isn't archived or built again (`fetch-gtfs`). If calendar dates roll daily, every export differs and is archived (about 16 MB a day for Victoria).
2. **What request rate is acceptable to BC Transit?** The terms state no limit and the feeds need no key.
   - *Assumption:* positions every 30 s while buses run, trip updates every 2 minutes, alerts every 5 (less overnight), about 3,500 requests a day under a cap of 4,000; cadence thresholds (`staleGraceS`, `coverageSlackS`, `interpolateSlackS`, `extrapolateSlackS`) are guesses for 30 s fixes (`config/feeds/bc-transit-victoria/feed.json`).
3. **Do Metro Vancouver's prediction settings suit BC Transit's buses?** (`config/defaults/rt.json` → `prediction`, `carry`, `detourNearM`.)
   - *Assumption:* the same values, tuned on TransLink's 99 and RapidBus; to be checked with `npx tsx pipelines/eval-rt.ts --feed bc-transit-victoria` once recordings exist.
4. **Which buses run the drawn routes?** Victoria runs double-deckers and 12 m buses; the vehicle labels in GTFS-RT are long ids (`3131357525`), not fleet numbers.
   - *Assumption:* 12 m long, 2.6 m wide, 90 km/h top speed (`config/defaults/kinematics.json`).
5. **How does BC Transit publish detours?** Alerts seen so far name stops (closures) with `NO_SERVICE`, and some routes.
   - *Assumption:* alerts are read as TransLink's are (`packages/transit-core/src/rt/changes.ts`).
