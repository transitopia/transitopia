// Recorded snapshots held column-wise in typed arrays (packages/transit-map/README.md → Buses): a
// day of TransLink buses is ~130 MB as RtSnapshot objects and ~20 MB packed. Strings become indexes
// into a table, coordinates (rounded to 1e-5 in the compact format) integers, and each column takes
// the narrowest typed array its values fit. Unpacking gives back exactly what decodeSnapshot would.

import {
  expandSnapshot,
  type CompactSnapshot,
  type RtSnapshot,
} from "./types.ts";

type IntArray = Int8Array | Int16Array | Int32Array;

/** One field of every row: integers (value × scale) with the type's minimum meaning null, or doubles with NaN. */
interface Column {
  data: IntArray | Float64Array | undefined; // undefined: every row null
  scale: number;
}

export interface PackedSnapshots {
  /** Per snapshot: fetchedAt, headerTs, and the index of its first row (one more entry: the row count). */
  fetchedAt: Float64Array;
  headerTs: Float64Array;
  start: Int32Array;
  strings: string[];
  /** id, label, tripId, routeKey, lat, lon, bearing, ts − headerTs, stopSeq, stopId, status, delay, speed. */
  columns: Column[];
}

/** Columns that hold strings (indexes into `strings`), by SnapshotRow position. */
const STRING_FIELDS = new Set([0, 1, 2, 3, 9]);
const FIELDS = 13;
const TS = 7;
/** Coordinates are rounded to ~1 m (compactSnapshot), so × 1e5 they're integers. */
const SCALES = [1, 1, 1, 1, 1e5, 1e5, 1, 1, 1, 1, 1, 1, 1];
const INT_TYPES = [Int8Array, Int16Array, Int32Array] as const;

function packColumn(values: (number | null)[], scale: number): Column {
  let min = Infinity;
  let max = -Infinity;
  let ints = true;
  const stored = values.map((v) => {
    if (v === null) return null;
    const n = scale === 1 ? v : Math.round(v * scale);
    if (!Number.isInteger(n) || (scale !== 1 && n / scale !== v)) ints = false;
    if (n < min) min = n;
    if (n > max) max = n;
    return n;
  });
  if (min === Infinity) return { data: undefined, scale: 1 };
  if (ints)
    for (const Type of INT_TYPES) {
      const bits = Type.BYTES_PER_ELEMENT * 8;
      const nullValue = -(2 ** (bits - 1));
      if (min <= nullValue || max >= 2 ** (bits - 1)) continue;
      const data = new Type(values.length);
      stored.forEach((n, i) => (data[i] = n ?? nullValue));
      return { data, scale };
    }
  return {
    data: Float64Array.from(values, (v) => v ?? NaN),
    scale: 1,
  };
}

function valueAt(c: Column, i: number): number | null {
  if (!c.data) return null;
  const n = c.data[i]!;
  if (c.data instanceof Float64Array) return Number.isNaN(n) ? null : n;
  const bits = c.data.BYTES_PER_ELEMENT * 8;
  if (n === -(2 ** (bits - 1))) return null;
  return c.scale === 1 ? n : n / c.scale;
}

/** Builds packed snapshots one compact snapshot (history line) at a time. */
export class SnapshotPacker {
  private fetchedAt: number[] = [];
  private headerTs: number[] = [];
  private start: number[] = [];
  private strings: string[] = [];
  private stringIndex = new Map<string, number>();
  private fields: (number | null)[][] = Array.from(
    { length: FIELDS },
    () => [],
  );

  add(s: CompactSnapshot): void {
    this.fetchedAt.push(s.t);
    this.headerTs.push(s.h);
    this.start.push(this.fields[0]!.length);
    for (const row of s.v)
      for (let f = 0; f < FIELDS; f++) {
        const v = row[f] ?? null;
        let x: number | null;
        if (v === null || typeof v === "number")
          x = f === TS && v !== null ? v - s.h : v;
        else {
          x = this.stringIndex.get(v) ?? null;
          if (x === null) {
            x = this.strings.push(v) - 1;
            this.stringIndex.set(v, x);
          }
        }
        this.fields[f]!.push(x);
      }
  }

  finish(): PackedSnapshots {
    return {
      fetchedAt: Float64Array.from(this.fetchedAt),
      headerTs: Float64Array.from(this.headerTs),
      start: Int32Array.from([...this.start, this.fields[0]!.length]),
      strings: this.strings,
      columns: this.fields.map((values, f) => packColumn(values, SCALES[f]!)),
    };
  }
}

export function packSnapshots(
  snapshots: Iterable<CompactSnapshot>,
): PackedSnapshots {
  const p = new SnapshotPacker();
  for (const s of snapshots) p.add(s);
  return p.finish();
}

export function packedCount(p: PackedSnapshots): number {
  return p.fetchedAt.length;
}

/** Approximate bytes held (typed arrays and the string table). */
export function packedBytes(p: PackedSnapshots): number {
  let n = p.fetchedAt.byteLength + p.headerTs.byteLength + p.start.byteLength;
  for (const c of p.columns) n += c.data?.byteLength ?? 0;
  for (const s of p.strings) n += 16 + s.length * 2;
  return n;
}

/** The snapshots as decodeSnapshot gives them. */
export function unpackSnapshots(p: PackedSnapshots): RtSnapshot[] {
  const out: RtSnapshot[] = [];
  const row: (string | number | null)[] = Array.from({ length: FIELDS });
  for (let s = 0; s < p.fetchedAt.length; s++) {
    const h = p.headerTs[s]!;
    const compact: CompactSnapshot = { t: p.fetchedAt[s]!, h, v: [] };
    for (let i = p.start[s]!; i < p.start[s + 1]!; i++) {
      for (let f = 0; f < FIELDS; f++) {
        const x = valueAt(p.columns[f]!, i);
        row[f] =
          x === null ? null
          : STRING_FIELDS.has(f) ? p.strings[x]!
          : f === TS ? x + h
          : x;
      }
      compact.v.push(row.slice() as CompactSnapshot["v"][number]);
    }
    out.push(expandSnapshot(compact));
  }
  return out;
}
