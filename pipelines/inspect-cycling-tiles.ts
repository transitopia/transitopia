// Look inside a cycling tileset (packages/cycling-core/README.md#tiles), or compare two: per zoom, the
// tiles, bytes and features, and the length of line (km) with each value of each attribute, so
// tilesets that join lines differently still compare; with --compare, a parity check at the highest
// zoom: lines of the first are sampled every few metres and matched to the nearest line of the
// second in the same tile, and every attribute that differs is totalled (km) with an example place.
//
//   tsx pipelines/inspect-cycling-tiles.ts <a.pmtiles> [--compare <b.pmtiles>] [--json <out.json>]

import { writeFile } from "node:fs/promises";
import { VectorTile, type VectorTileFeature } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { PMTilesFile } from "@transitopia/data/pmtiles-file.ts";
import { CYCLING_LAYER } from "@transitopia/cycling-core/tiles.ts";

/** Attributes whose values are totalled; others are counted only by whether they're there. */
const VALUE_KEYS = [
  "class",
  "subclass",
  "comfort",
  "oneway",
  "side",
  "construction",
  "dooring_risk",
  "shared_with_pedestrians",
  "shared_with_vehicles",
  "surface",
];
/** Attributes the parity check ignores: identifiers that differ by construction. */
const IGNORED = new Set(["osm_way_ids"]);
/** Parity sampling: a sample every STEP tile units, matched within TOLERANCE units (4096 to a tile). */
const STEP = 8;
const TOLERANCE = 8;
/** Grid cell for finding nearby segments (tile units). */
const CELL = 64;

type Props = VectorTileFeature["properties"];

interface ZoomSummary {
  tiles: number;
  bytes: number;
  features: Record<string, number>;
  /** km of line per "key=value" (VALUE_KEYS) or "key" (presence of any other attribute). */
  lineKm: Record<string, number>;
  /** Points per "key=value" or "key". */
  points: Record<string, number>;
}

const add = (o: Record<string, number>, k: string, v: number) => {
  o[k] = (o[k] ?? 0) + v;
};

/** Metres per tile unit at a tile's centre (Web Mercator). */
function metresPerUnit(z: number, y: number, extent: number): number {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / 2 ** z;
  const lat = Math.atan(Math.sinh(n));
  return (40_075_016.686 * Math.cos(lat)) / 2 ** z / extent;
}

function lonLat(z: number, x: number, y: number, extent: number, p: Pt) {
  const n = 2 ** z;
  const lon = ((x + p.x / extent) / n) * 360 - 180;
  const m = Math.PI - (2 * Math.PI * (y + p.y / extent)) / n;
  const lat = (Math.atan(Math.sinh(m)) * 180) / Math.PI;
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

interface Pt {
  x: number;
  y: number;
}

const lineLength = (lines: Pt[][]) =>
  lines.reduce(
    (s, l) =>
      s
      + l
        .slice(1)
        .reduce((t, p, i) => t + Math.hypot(p.x - l[i]!.x, p.y - l[i]!.y), 0),
    0,
  );

const label = (k: string, v: unknown) =>
  VALUE_KEYS.includes(k) ? `${k}=${String(v)}` : k;

async function summarise(path: string): Promise<Map<number, ZoomSummary>> {
  const file = await PMTilesFile.open(path);
  const out = new Map<number, ZoomSummary>();
  for await (const t of file.tiles()) {
    let s = out.get(t.z);
    if (!s) {
      s = { tiles: 0, bytes: 0, features: {}, lineKm: {}, points: {} };
      out.set(t.z, s);
    }
    s.tiles++;
    s.bytes += t.data.length;
    const layer = new VectorTile(new PbfReader(t.data)).layers[CYCLING_LAYER];
    if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      add(s.features, ["unknown", "point", "line", "polygon"][f.type]!, 1);
      if (f.type === 2) {
        const km =
          (lineLength(f.loadGeometry()) * metresPerUnit(t.z, t.y, layer.extent))
          / 1000;
        add(s.lineKm, "(all)", km);
        for (const [k, v] of Object.entries(f.properties))
          add(s.lineKm, label(k, v), km);
      } else if (f.type === 1) {
        add(s.points, "(all)", f.loadGeometry().flat().length);
        for (const [k, v] of Object.entries(f.properties))
          add(s.points, label(k, v), 1);
      }
    }
  }
  await file.close();
  return out;
}

/** Lines of one tile, with a grid of their segments. */
interface TileLines {
  extent: number;
  features: { props: Props; lines: Pt[][] }[];
  grid: Map<number, { f: number; a: Pt; b: Pt }[]>;
}

function tileLines(data: Uint8Array): TileLines | undefined {
  const layer = new VectorTile(new PbfReader(data)).layers[CYCLING_LAYER];
  if (!layer) return undefined;
  const t: TileLines = { extent: layer.extent, features: [], grid: new Map() };
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 2) continue;
    const lines = f.loadGeometry();
    const fi = t.features.push({ props: f.properties, lines }) - 1;
    for (const l of lines)
      for (let j = 1; j < l.length; j++) {
        const a = l[j - 1]!;
        const b = l[j]!;
        const x0 = Math.floor((Math.min(a.x, b.x) - TOLERANCE) / CELL);
        const x1 = Math.floor((Math.max(a.x, b.x) + TOLERANCE) / CELL);
        const y0 = Math.floor((Math.min(a.y, b.y) - TOLERANCE) / CELL);
        const y1 = Math.floor((Math.max(a.y, b.y) + TOLERANCE) / CELL);
        for (let gx = x0; gx <= x1; gx++)
          for (let gy = y0; gy <= y1; gy++) {
            const key = gx * 100_000 + gy;
            let cell = t.grid.get(key);
            if (!cell) t.grid.set(key, (cell = []));
            cell.push({ f: fi, a, b });
          }
      }
  }
  return t;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const u =
    len2 ?
      Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    : 0;
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}

const sameProps = (a: Props, b: Props) => differing(a, b).length === 0;

function differing(a: Props, b: Props): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => !IGNORED.has(k) && a[k] !== b[k]);
}

interface Parity {
  zoom: number;
  sampledKm: number;
  /** km of A with no line of B within the tolerance. */
  missingKm: number;
  /** km of A matched to a line of B with every attribute equal. */
  equalKm: number;
  /** "key: a → b" → km and an example "lat,lng". */
  diffs: Map<string, { km: number; at: string }>;
}

/** Sample A's lines at its highest zoom and match them to B's. */
async function parity(aPath: string, bPath: string): Promise<Parity> {
  const a = await PMTilesFile.open(aPath);
  const b = await PMTilesFile.open(bPath);
  const zoom = Math.min(a.header.maxZoom, b.header.maxZoom);
  const bTiles = new Map<string, Uint8Array>();
  for await (const t of b.tiles())
    if (t.z === zoom) bTiles.set(`${t.x}/${t.y}`, t.data);
  const p: Parity = {
    zoom,
    sampledKm: 0,
    missingKm: 0,
    equalKm: 0,
    diffs: new Map(),
  };
  for await (const t of a.tiles()) {
    if (t.z !== zoom) continue;
    const ta = tileLines(t.data);
    if (!ta) continue;
    const bData = bTiles.get(`${t.x}/${t.y}`);
    const tb = bData ? tileLines(bData) : undefined;
    const km = (STEP * metresPerUnit(t.z, t.y, ta.extent)) / 1000;
    for (const fa of ta.features)
      for (const l of fa.lines)
        for (let j = 1; j < l.length; j++) {
          const s = l[j - 1]!;
          const e = l[j]!;
          const len = Math.hypot(e.x - s.x, e.y - s.y);
          for (let d = STEP / 2; d < len; d += STEP) {
            const pt = {
              x: s.x + ((e.x - s.x) * d) / len,
              y: s.y + ((e.y - s.y) * d) / len,
            };
            // Ignore the buffer around the tile: its neighbour samples it.
            if (pt.x < 0 || pt.y < 0 || pt.x >= ta.extent || pt.y >= ta.extent)
              continue;
            p.sampledKm += km;
            const near = new Set<number>();
            let best: number | undefined;
            let bestD = Infinity;
            const cell = tb?.grid.get(
              Math.floor(pt.x / CELL) * 100_000 + Math.floor(pt.y / CELL),
            );
            for (const seg of cell ?? []) {
              const dist = distToSegment(pt, seg.a, seg.b);
              if (dist > TOLERANCE) continue;
              near.add(seg.f);
              if (dist < bestD) [best, bestD] = [seg.f, dist];
            }
            if (best === undefined) {
              p.missingKm += km;
              const k = "(no line in B)";
              const prev = p.diffs.get(k);
              if (prev) prev.km += km;
              else
                p.diffs.set(k, {
                  km,
                  at: lonLat(t.z, t.x, t.y, ta.extent, pt),
                });
              continue;
            }
            // Overlapping lines: prefer one that agrees.
            const match = [...near].find((f) =>
              sameProps(fa.props, tb!.features[f]!.props),
            );
            if (match !== undefined) {
              p.equalKm += km;
              continue;
            }
            const pb = tb!.features[best]!.props;
            for (const k of differing(fa.props, pb)) {
              const key = `${k}: ${String(fa.props[k])} → ${String(pb[k])}`;
              const prev = p.diffs.get(key);
              if (prev) prev.km += km;
              else
                p.diffs.set(key, {
                  km,
                  at: lonLat(t.z, t.x, t.y, ta.extent, pt),
                });
            }
          }
        }
  }
  await a.close();
  await b.close();
  return p;
}

const fmt = (n: number | undefined) =>
  n === undefined ? "–"
  : n >= 100 ? n.toFixed(0)
  : n.toFixed(1);

function printSummaries(
  names: string[],
  sums: Map<number, ZoomSummary>[],
): void {
  const zooms = [...new Set(sums.flatMap((s) => [...s.keys()]))].sort(
    (x, y) => x - y,
  );
  for (const z of zooms) {
    const zs = sums.map((s) => s.get(z));
    console.log(`\n## z${z}`);
    const row = (label: string, vals: (number | undefined)[]) =>
      console.log(
        `${label.padEnd(42)}${vals.map((v) => fmt(v).padStart(12)).join("")}`,
      );
    row(
      "tiles",
      zs.map((s) => s?.tiles),
    );
    row(
      "kB",
      zs.map((s) => s && s.bytes / 1024),
    );
    for (const g of ["point", "line", "polygon"])
      if (zs.some((s) => s?.features[g]))
        row(
          `${g} features`,
          zs.map((s) => s?.features[g]),
        );
    const keys = (pick: (s: ZoomSummary) => Record<string, number>) =>
      [...new Set(zs.flatMap((s) => (s ? Object.keys(pick(s)) : [])))].sort();
    for (const k of keys((s) => s.lineKm))
      row(
        `line km ${k}`,
        zs.map((s) => s?.lineKm[k]),
      );
    for (const k of keys((s) => s.points))
      row(
        `points ${k}`,
        zs.map((s) => s?.points[k]),
      );
  }
  console.log(`\nColumns: ${names.join(" | ")}`);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const compare = opt("--compare");
  const json = opt("--json");
  const [a] = args;
  if (!a) {
    console.error(
      "usage: inspect-cycling-tiles.ts <a.pmtiles> [--compare <b.pmtiles>] [--json <out.json>]",
    );
    process.exit(2);
  }
  const files = compare ? [a, compare] : [a];
  const sums = await Promise.all(files.map(summarise));
  printSummaries(files, sums);
  let report: Parity | undefined;
  if (compare) {
    report = await parity(a, compare);
    const pct = (km: number) =>
      `${((100 * km) / report!.sampledKm).toFixed(2)} %`;
    console.log(
      `\n## Parity at z${report.zoom}: A's lines sampled every ${STEP} units, matched within ${TOLERANCE}`,
    );
    console.log(`sampled            ${fmt(report.sampledKm)} km`);
    console.log(
      `all attributes =   ${fmt(report.equalKm)} km (${pct(report.equalKm)})`,
    );
    console.log(
      `no line in B       ${fmt(report.missingKm)} km (${pct(report.missingKm)})`,
    );
    console.log("\nDifferences (km, example lat,lng):");
    for (const [k, v] of [...report.diffs].sort((x, y) => y[1].km - x[1].km))
      console.log(`${fmt(v.km).padStart(8)}  ${k}  @ ${v.at}`);
  }
  if (json)
    await writeFile(
      json,
      JSON.stringify(
        {
          files,
          zooms: sums.map((s) => Object.fromEntries(s)),
          parity: report && {
            ...report,
            diffs: Object.fromEntries(report.diffs),
          },
        },
        null,
        1,
      ),
    );
}

await main();
