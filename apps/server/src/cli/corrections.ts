// Corrections in the database, as files (docs/DESIGN.md#corrections-and-previews), e.g. for tests and
// reproducible bug reports. /admin is where they're reviewed; this is for moving them around.
//
//   DATABASE_URL=… npm run corrections -- export <dir>   # confirmed ones → <dir>/{observations,disruptions}/*.json
//   DATABASE_URL=… npm run corrections -- import [<dir>] # files → database (default: regions/metro-vancouver); existing ids are kept
//   npm run corrections -- pull [<api>] [<dir>]          # a server's confirmed ones (admin token in ADMIN_TOKEN) → <dir>

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import region from "@transitopia/region-metro-vancouver/region.json" with { type: "json" };
import { createDb } from "@transitopia/db/connect.ts";
import { migrate } from "@transitopia/db/migrate.ts";
import { CorrectionsRepo } from "../corrections.ts";

const [cmd, a, b] = process.argv.slice(2);
const usage = () => {
  console.error(
    "Usage: npm run corrections -- export <dir> | import [<dir>] | pull [<api>] [<dir>]",
  );
  process.exit(1);
};

if (cmd === "pull") {
  const api = (a ?? "https://api.transitopia.org").replace(/\/$/, "");
  const dir = b ?? "var/corrections-pulled";
  const res = await fetch(`${api}/admin/api/export`, {
    headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN ?? ""}` },
  });
  if (!res.ok)
    throw new Error(
      `${api}/admin/api/export: HTTP ${res.status} (set ADMIN_TOKEN)`,
    );
  const body = (await res.json()) as {
    observations: Record<string, unknown>;
    disruptions: Record<string, unknown>;
  };
  for (const [kind, files] of Object.entries(body)) {
    await mkdir(join(dir, kind), { recursive: true });
    for (const [id, file] of Object.entries(files))
      await writeFile(
        join(dir, kind, `${id}.json`),
        JSON.stringify(file, null, 2) + "\n",
      );
  }
  console.log(
    `${Object.keys(body.observations).length} observation sets and ${Object.keys(body.disruptions).length} disruptions → ${dir}`,
  );
} else if (cmd === "export" || cmd === "import") {
  const url = process.env.DATABASE_URL;
  if (!url) usage();
  const { db, pool } = createDb(url!);
  await migrate(pool);
  const repo = new CorrectionsRepo(db, region.id);
  if (cmd === "export") {
    if (!a) usage();
    const n = await repo.exportFiles(a!);
    console.log(
      `${n.observationSets} observation sets and ${n.disruptions} disruptions → ${a}`,
    );
  } else {
    const n =
      a ?
        await repo.importFiles(join(a, "observations"), join(a, "disruptions"))
      : await repo.importFiles();
    console.log(
      `imported ${n.observationSets} observation sets and ${n.disruptions} disruptions`,
    );
  }
  await db.destroy();
} else usage();
