import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yazl from "yazl";
import { mergeGtfs } from "../src/gtfs-merge.ts";
import { readCsvAll, zipSignature } from "../src/gtfs-zip.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gtfs-merge-test-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** A GTFS zip of CSV files, by name. */
async function zip(name: string, files: Record<string, string>) {
  const z = new yazl.ZipFile();
  for (const [f, text] of Object.entries(files))
    z.addBuffer(Buffer.from(text), f);
  z.end();
  const path = join(dir, name);
  await pipeline(z.outputStream, createWriteStream(path));
  return path;
}

// Two systems' exports, as BC Transit's: one shared stop (written a little differently) and one
// shared service.
const comox = {
  "feed_info.txt":
    "feed_publisher_name,feed_version,feed_start_date,feed_end_date\nConsat,202611020/a,20261031,20270331\n",
  "agency.txt": "agency_id,agency_name\n0,BCTransit\n",
  "routes.txt":
    "route_id,route_short_name,route_long_name\n1-COM,1,Comox Mall\n",
  "stops.txt":
    'stop_id,stop_name,stop_lat\n111486,Downtown Courtenay,49.69\n104033,"Village Green Mall, Bay A",48.77465\n',
  "trips.txt": "route_id,service_id,trip_id\n1-COM,5484,t1\n",
  "stop_times.txt": "trip_id,stop_id,stop_sequence\nt1,111486,1\nt1,104033,2\n",
  "calendar_dates.txt":
    "service_id,date,exception_type\n5484,20261102,1\n5484,20261103,1\n",
};
const campbell = {
  "feed_info.txt":
    "feed_publisher_name,feed_version,feed_start_date,feed_end_date\nConsat,202611020/a,20261029,20270905\n",
  "agency.txt": "agency_id,agency_name\n0,BCTransit\n",
  "routes.txt":
    "route_id,route_short_name,route_long_name,route_color\n1-CAM,1,Campbellton,004B8D\n",
  "stops.txt":
    'stop_id,stop_name,stop_lat\n104033,"Village Green Mall, Bay A",48.77503\n120001,Willow Point,50.0\n',
  "trips.txt": "route_id,service_id,trip_id\n1-CAM,5484,t2\n",
  "stop_times.txt": "trip_id,stop_id,stop_sequence\nt2,104033,1\nt2,120001,2\n",
  "calendar_dates.txt":
    "service_id,date,exception_type\n5484,20261102,1\n5484,20261103,1\n",
};

describe("mergeGtfs", () => {
  it("merges exports, the first winning a stop they write differently", async () => {
    const out = join(dir, "merged.zip");
    const report = await mergeGtfs(
      [await zip("comox.zip", comox), await zip("campbell.zip", campbell)],
      out,
    );
    expect(report.keptFirst).toEqual({ "stops.txt": 1 });
    expect(await readCsvAll(out, "routes.txt")).toEqual([
      {
        route_id: "1-COM",
        route_short_name: "1",
        route_long_name: "Comox Mall",
        route_color: "",
      },
      {
        route_id: "1-CAM",
        route_short_name: "1",
        route_long_name: "Campbellton",
        route_color: "004B8D",
      },
    ]);
    const stops = await readCsvAll(out, "stops.txt");
    expect(stops.map((s) => [s.stop_id, s.stop_name, s.stop_lat])).toEqual([
      ["111486", "Downtown Courtenay", "49.69"],
      ["104033", "Village Green Mall, Bay A", "48.77465"],
      ["120001", "Willow Point", "50.0"],
    ]);
    expect(
      (await readCsvAll(out, "stop_times.txt")).map((r) => r.trip_id),
    ).toEqual(["t1", "t1", "t2", "t2"]);
    // A service both list the same way is written once; the agency too.
    expect(await readCsvAll(out, "calendar_dates.txt")).toHaveLength(2);
    expect(await readCsvAll(out, "agency.txt")).toHaveLength(1);
    expect(await readCsvAll(out, "feed_info.txt")).toEqual([
      {
        feed_publisher_name: "Consat",
        feed_version: "202611020/a",
        feed_start_date: "20261029",
        feed_end_date: "20270331",
      },
    ]);
  });

  it("gives the same timetable for the same exports", async () => {
    const parts = [
      await zip("comox.zip", comox),
      await zip("campbell.zip", campbell),
    ];
    const a = join(dir, "a.zip");
    const b = join(dir, "b.zip");
    await mergeGtfs(parts, a);
    await mergeGtfs(parts, b);
    expect(await zipSignature(a)).toBe(await zipSignature(b));
  });

  it("renames a time zone the feed takes as its own", async () => {
    const tz = (zone: string) =>
      `agency_id,agency_name,agency_timezone\n0,BCTransit,${zone}\n`;
    const out = join(dir, "zones.zip");
    await mergeGtfs(
      [
        await zip("comox-tz.zip", {
          ...comox,
          "agency.txt": tz("America/Vancouver"),
        }),
        await zip("dawson.zip", {
          ...campbell,
          "agency.txt": tz("America/Dawson_Creek"),
        }),
      ],
      out,
      { timezones: { "America/Dawson_Creek": "America/Vancouver" } },
    );
    expect(await readCsvAll(out, "agency.txt")).toEqual([
      {
        agency_id: "0",
        agency_name: "BCTransit",
        agency_timezone: "America/Vancouver",
      },
    ]);
  });

  it("fails when two exports list a service differently", async () => {
    const other = {
      ...campbell,
      "calendar_dates.txt": "service_id,date,exception_type\n5484,20261104,1\n",
    };
    await expect(
      mergeGtfs(
        [await zip("comox.zip", comox), await zip("other.zip", other)],
        join(dir, "bad.zip"),
      ),
    ).rejects.toThrow(/calendar_dates.txt: 5484 differs/);
  });
});
