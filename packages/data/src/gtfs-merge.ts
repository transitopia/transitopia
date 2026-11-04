// Several GTFS exports merged into one feed (config/feeds/<feed>/feed.json → static.merge): BC
// Transit publishes each transit system on its own, and its server returns an empty feed when asked
// for several at once (packages/transit-core/DESIGN.md#timetables). Its ids come from one database, so
// the exports' records never clash, except stops two neighbouring systems share, which each export
// writes a little differently: the first export listing one wins. Anything else listed twice must
// be the same in both, or the merge fails. Exports in a zone the feed takes as its own
// (feed.json → equivalentTimezones) have it renamed first.

import { createHash, type Hash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { csvColumns, listEntries, readCsv, type Row } from "./gtfs-zip.ts";

/** How a file's records are told apart, and what happens when two exports list one differently. */
interface Rule {
  /** The record a row belongs to: all of a shape's points, a trip's stop times, a service's dates. */
  key: (r: Row) => string;
  /** "first": the first export's wins (counted in the report); "fail": the merge fails. */
  differs: "first" | "fail";
}

const field =
  (...names: string[]) =>
  (r: Row) =>
    names.map((n) => r[n] ?? "").join("\0");

const RULES: Record<string, Rule> = {
  "agency.txt": { key: field("agency_id"), differs: "fail" },
  "stops.txt": { key: field("stop_id"), differs: "first" },
  "routes.txt": { key: field("route_id"), differs: "fail" },
  "trips.txt": { key: field("trip_id"), differs: "fail" },
  "stop_times.txt": { key: field("trip_id"), differs: "fail" },
  "calendar.txt": { key: field("service_id"), differs: "fail" },
  "calendar_dates.txt": { key: field("service_id"), differs: "fail" },
  "shapes.txt": { key: field("shape_id"), differs: "fail" },
};
/** Any other file: identical rows are written once. */
const WHOLE_ROW: Rule = { key: (r) => JSON.stringify(r), differs: "first" };

export interface MergeOptions {
  /** Time zones renamed wherever a file names one (agency_timezone, stop_timezone): from → to. */
  timezones?: Readonly<Record<string, string>> | undefined;
}

/** Column values a merge rewrites before comparing exports. */
const TIMEZONE_COLUMNS = ["agency_timezone", "stop_timezone"];

/** A row as `options` rewrite it. */
function rewriter(options: MergeOptions): (r: Row) => Row {
  const zones = options.timezones ?? {};
  if (!Object.keys(zones).length) return (r) => r;
  return (r) => {
    let out = r;
    for (const c of TIMEZONE_COLUMNS) {
      const to = r[c] !== undefined ? zones[r[c]] : undefined;
      if (to !== undefined) out = { ...out, [c]: to };
    }
    return out;
  };
}

export interface MergeReport {
  /** Per file, records listed differently by two exports, where the first export's was kept. */
  keptFirst: Record<string, number>;
}

/** CSV field, quoted when it needs to be. */
const csvField = (v: string) =>
  /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/** Each record's digest in one export (its rows in order), to compare with another export's. */
async function digests(
  zip: string,
  name: string,
  rule: Rule,
  fix: (r: Row) => Row,
): Promise<Map<string, string>> {
  const hashes = new Map<string, Hash>();
  for await (const raw of readCsv(zip, name)) {
    const r = fix(raw);
    const k = rule.key(r);
    let h = hashes.get(k);
    if (!h) hashes.set(k, (h = createHash("sha1")));
    h.update(JSON.stringify(r));
  }
  return new Map([...hashes].map(([k, h]) => [k, h.digest("base64")]));
}

/** One file of the merged feed, written to `out`. */
async function mergeFile(
  parts: readonly string[],
  name: string,
  out: string,
  report: MergeReport,
  fix: (r: Row) => Row,
): Promise<void> {
  const rule = RULES[name] ?? WHOLE_ROW;
  const columns: string[] = [];
  for (const p of parts)
    for (const c of await csvColumns(p, name))
      if (!columns.includes(c)) columns.push(c);
  const file = createWriteStream(out);
  const write = async (line: string) => {
    if (!file.write(`${line}\n`)) await once(file, "drain");
  };
  await write(columns.map(csvField).join(","));
  /** Which export each record is taken from, and its digest there. */
  const owner = new Map<string, { part: number; digest: string }>();
  for (const [i, p] of parts.entries()) {
    const mine = await digests(p, name, rule, fix);
    const taken = new Set<string>();
    for (const [k, digest] of mine) {
      const o = owner.get(k);
      if (!o) {
        owner.set(k, { part: i, digest });
        taken.add(k);
      } else if (o.digest !== digest) {
        if (rule.differs === "fail")
          throw new Error(
            `${name}: ${k.replace(/\0/g, " ")} differs between the exports merged`,
          );
        report.keptFirst[name] = (report.keptFirst[name] ?? 0) + 1;
      }
    }
    if (!taken.size) continue;
    for await (const raw of readCsv(p, name)) {
      const r = fix(raw);
      if (taken.has(rule.key(r)))
        await write(columns.map((c) => csvField(r[c] ?? "")).join(","));
    }
  }
  file.end();
  await once(file, "finish");
}

/**
 * feed_info.txt: the first export's, with the newest version, the earliest start and the earliest
 * end. Past the end of one export's dates its system's services are missing, and over months of
 * them the most common set of services on a weekday (schedule/frequency.ts → regularWeek,
 * gtfs/describe.ts) would be one without them; an export starting a day or two after the others
 * leaves only those days without it.
 */
async function mergeFeedInfo(
  parts: readonly string[],
  out: string,
): Promise<void> {
  const infos: Row[] = [];
  for (const p of parts)
    for await (const r of readCsv(p, "feed_info.txt")) infos.push(r);
  if (!infos.length) throw new Error("no feed_info.txt in the exports merged");
  const pick = (f: string, best: (a: string, b: string) => boolean) =>
    infos
      .map((r) => r[f] ?? "")
      .filter(Boolean)
      .reduce<string | undefined>(
        (a, b) => (a === undefined || best(b, a) ? b : a),
        undefined,
      ) ?? "";
  const row: Row = {
    ...infos[0]!,
    feed_version: pick("feed_version", (a, b) => a > b),
    feed_start_date: pick("feed_start_date", (a, b) => a < b),
    feed_end_date: pick("feed_end_date", (a, b) => a < b),
  };
  const columns = Object.keys(row);
  const file = createWriteStream(out);
  file.end(
    `${columns.map(csvField).join(",")}\n${columns.map((c) => csvField(row[c] ?? "")).join(",")}\n`,
  );
  await once(file, "finish");
}

/** A fixed time for every entry, so merging the same exports gives the same zip. */
const ENTRY_TIME = new Date("2000-01-01T00:00:00Z");

/** The GTFS zips `parts`, in order, merged into one at `dest`. */
export async function mergeGtfs(
  parts: readonly string[],
  dest: string,
  options: MergeOptions = {},
): Promise<MergeReport> {
  const fix = rewriter(options);
  const names: string[] = [];
  for (const p of parts)
    for (const n of await listEntries(p)) if (!names.includes(n)) names.push(n);
  const dir = await mkdtemp(join(tmpdir(), "gtfs-merge-"));
  const report: MergeReport = { keptFirst: {} };
  try {
    const zip = new yazl.ZipFile();
    for (const name of names) {
      const out = join(dir, name);
      if (name === "feed_info.txt") await mergeFeedInfo(parts, out);
      else await mergeFile(parts, name, out, report, fix);
      zip.addFile(out, name, { mtime: ENTRY_TIME });
    }
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(dest));
    return report;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
