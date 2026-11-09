import { describe, expect, it } from "vitest";
import { FreezeWatch, frozenFixes, type FreezeFix } from "../src/rt/stale.ts";

const cfg = { stopFarM: 1000, movedM: 300 };
// A stop ~2.2 km north of the frozen position, one beside it.
const far: [number, number] = [-123.1166, 49.344];
const near: [number, number] = [-123.1166, 49.3241];
const fix = (
  lat: number,
  tripId: string,
  stop: string,
  stopAt: [number, number] | undefined,
): FreezeFix => ({ lat, lon: -123.1166, tripId, stop, stopAt });
const frozen = (fixes: FreezeFix[]) => [...frozenFixes(fixes, cfg)];

describe("frozenFixes", () => {
  it("drops a repeated position once its reported stop runs on far away, back to the run's first fix", () => {
    expect(
      frozen([
        fix(49.32, "t1", "a", near),
        fix(49.324, "t1", "b", near), // the GPS's last real position
        fix(49.324, "t1", "c", near), // a stop close by: not yet given away
        fix(49.324, "t1", "d", far),
        fix(49.324, "t2", "e", far),
        fix(49.281, "t2", "e", far), // back, 4.8 km away
      ]),
    ).toEqual([2, 3, 4]);
  });

  it("takes a freeze still going on as frozen", () => {
    expect(
      frozen([fix(49.324, "t1", "b", near), fix(49.324, "t1", "d", far)]),
    ).toEqual([1]);
  });

  it("keeps a bus that reappears close by: it really stood there", () => {
    expect(
      frozen([
        fix(49.324, "t1", "b", near),
        fix(49.324, "t1", "d", far),
        fix(49.3241, "t1", "d", far), // 11 m on
      ]),
    ).toEqual([]);
  });

  it("does not count a change of trip alone, nor a stop that isn't far", () => {
    expect(
      frozen([
        fix(49.324, "t1", "b", near),
        fix(49.324, "t2", "x", far), // its next trip starts far away
        fix(49.324, "t2", "x", far),
        fix(49.281, "t2", "y", far),
      ]),
    ).toEqual([]);
    expect(
      frozen([
        fix(49.324, "t1", "b", near),
        fix(49.324, "t1", "c", near),
        fix(49.281, "t1", "d", far),
      ]),
    ).toEqual([]);
  });

  it("drops a run's first fix too when the fixes start partway through it (openStart)", () => {
    const fixes = [
      fix(49.324, "t1", "c", near),
      fix(49.324, "t1", "d", far),
      fix(49.281, "t1", "e", far),
    ];
    expect(frozen(fixes)).toEqual([1]);
    expect([...frozenFixes(fixes, cfg, true)]).toEqual([0, 1]);
    // Only the run they start in: a later one keeps its first fix.
    expect([
      ...frozenFixes(
        [fix(49.32, "t1", "a", near), ...fixes.map((f) => ({ ...f }))],
        cfg,
        true,
      ),
    ]).toEqual([2]);
  });

  it("only takes exact repeats as a run: a working GPS jitters", () => {
    expect(
      frozen([
        fix(49.324, "t1", "b", near),
        fix(49.32401, "t1", "d", far),
        fix(49.281, "t1", "e", far),
      ]),
    ).toEqual([]);
  });
});

describe("FreezeWatch", () => {
  const watch = (fixes: FreezeFix[], w = new FreezeWatch<number>(cfg)) => {
    const out: (number | undefined)[] = [];
    fixes.forEach((f, k) => {
      w.add("bus", k * 30_000, f, k);
      out.push(w.lastReal("bus"));
    });
    return out;
  };

  it("names the run's first fix while a suspect run goes on, as frozenFixes would", () => {
    expect(
      watch([
        fix(49.32, "t1", "a", near),
        fix(49.324, "t1", "b", near), // the GPS's last real position
        fix(49.324, "t1", "c", near),
        fix(49.324, "t1", "d", far), // given away
        fix(49.324, "t2", "e", far),
        fix(49.281, "t2", "e", far), // back
      ]),
    ).toEqual([undefined, undefined, undefined, 1, 1, undefined]);
  });

  it("ignores repeats of a fix time", () => {
    const w = new FreezeWatch<number>(cfg);
    w.add("bus", 0, fix(49.324, "t1", "b", near), 0);
    w.add("bus", 30_000, fix(49.324, "t1", "d", far), 1);
    w.add("bus", 30_000, fix(49.281, "t1", "d", far), 2);
    expect(w.lastReal("bus")).toBe(0);
  });

  it("resumes a freeze it knows began, and not one that began unseen", () => {
    const known = new FreezeWatch<number>(cfg);
    known.resume("bus", 0, fix(49.324, "t1", "d", far), 7);
    expect(known.lastReal("bus")).toBe(7);
    known.add("bus", 30_000, fix(49.324, "t1", "e", far), 8);
    expect(known.lastReal("bus")).toBe(7);

    const unseen = new FreezeWatch<number>(cfg);
    unseen.resume("bus", 0, fix(49.324, "t1", "c", near));
    expect(
      watch(
        [fix(49.324, "t1", "c", near), fix(49.324, "t1", "d", far)],
        unseen,
      ),
    ).toEqual([undefined, undefined]);
  });
});
