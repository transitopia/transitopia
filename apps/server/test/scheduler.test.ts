import { describe, expect, it } from "vitest";
import { dueDataBuilds } from "../src/jobs/scheduler.ts";

/** The keys dueDataBuilds runs; `published` turns true once a build runs (it publishes every feed). */
async function keys(due: boolean, published: boolean): Promise<string[]> {
  const ran: string[] = [];
  await dueDataBuilds({
    today: "20261015",
    due,
    missing: () => !published,
    run: async (key) => {
      ran.push(key);
      published = true;
    },
  });
  return ran;
}

describe("dueDataBuilds", () => {
  it("builds at the set time, and not before", async () => {
    expect(await keys(true, true)).toEqual(["20261015"]);
    expect(await keys(false, true)).toEqual([]);
  });

  it("builds at once when a feed has nothing published, before the set time", async () => {
    expect(await keys(false, false)).toEqual(["20261015-initial"]);
  });

  it("doesn't build twice when the day's build publishes what was missing", async () => {
    expect(await keys(true, false)).toEqual(["20261015"]);
  });

  it("builds again when the day's build already ran but a feed has nothing published", async () => {
    // A deploy after dataBuildAt that moved the published data: job_runs skips the day's key.
    const ran: string[] = [];
    await dueDataBuilds({
      today: "20261015",
      due: true,
      missing: () => !ran.includes("20261015-initial"),
      run: async (key) => {
        ran.push(key);
      },
    });
    expect(ran).toEqual(["20261015", "20261015-initial"]);
  });
});
