import { describe, expect, it } from "vitest";
import {
  packSnapshots,
  packedCount,
  unpackSnapshots,
} from "../src/rt/packed.ts";
import { expandSnapshot, type CompactSnapshot } from "../src/rt/types.ts";

const H = 1792454441000;

const snapshots: CompactSnapshot[] = [
  {
    t: H + 11857,
    h: H,
    v: [
      [
        "18330",
        "18330",
        "15455106",
        "translink:099",
        49.28728,
        -123.1417,
        null,
        H - 24000,
        1,
        "1",
        2,
        0,
      ],
      [
        "2144",
        null,
        null,
        "gtfs:6615",
        49.28437,
        -123.1212,
        270,
        H - 34000,
        null,
        null,
        null,
        -245,
      ],
    ],
  },
  { t: H + 40000, h: H + 30000, v: [] },
  {
    t: H + 71000,
    h: H + 60000,
    v: [
      // A fix older than the header by more than an Int16, a fractional bearing and delay, and speed.
      [
        "18330",
        "S1",
        "15455106",
        "translink:099",
        49.29,
        -123.14,
        12.5,
        H - 9_000_000,
        70000,
        "1",
        1,
        3.25,
        4.5,
      ],
      // Unrounded coordinates (not from compactSnapshot) still come back exactly.
      [
        "21015",
        "21015",
        "15458985",
        "translink:099",
        49.123456789,
        -123.987654321,
        null,
        H + 59000,
        13,
        "31",
        2,
        null,
      ],
    ],
  },
];

describe("packed snapshots", () => {
  it("unpack to what decodeSnapshot gives", () => {
    const p = packSnapshots(snapshots);
    expect(packedCount(p)).toBe(3);
    expect(unpackSnapshots(p)).toEqual(snapshots.map(expandSnapshot));
  });

  it("narrow columns to the values they hold", () => {
    const p = packSnapshots(snapshots.slice(0, 1));
    const [id, , , , lat, , bearing, , , , status] = p.columns;
    expect(id!.data).toBeInstanceOf(Int8Array);
    expect(lat!.data).toBeInstanceOf(Int32Array);
    expect(bearing!.data).toBeInstanceOf(Int16Array);
    expect(status!.data).toBeInstanceOf(Int8Array);
    expect(p.columns[12]!.data).toBeUndefined(); // no speeds
  });

  it("handle an hour without snapshots", () => {
    expect(unpackSnapshots(packSnapshots([]))).toEqual([]);
  });
});
