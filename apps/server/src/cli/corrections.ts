// Corrections in the database, as files (docs/DESIGN.md#corrections), e.g. for tests and
// reproducible bug reports. /admin is where they're edited; this is for moving them around.
//
//   npm run corrections -- export <dir>          # the database's → <dir>, laid out like config/ (below)
//   npm run corrections -- import [<dir>]        # files → database (default: config/); existing ids are kept
//   npm run corrections -- pull [<api>] [<dir>]  # a server's (admin token in ADMIN_TOKEN) → <dir>
//
// They're the rail network's (railNetwork): its feed's observations in <dir>/feeds/<feed>/observations/
// (correctionPaths). export and import use DATABASE_URL, else the local database (npm run db:up).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { correctionPaths, railNetwork } from "@transitopia/data/paths.ts";
import { createDb, databaseUrl } from "@transitopia/db/connect.ts";
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
  };
  const { observations } = correctionPaths(await railNetwork(), dir);
  await mkdir(observations, { recursive: true });
  for (const [id, file] of Object.entries(body.observations))
    await writeFile(
      join(observations, `${id}.json`),
      JSON.stringify(file, null, 2) + "\n",
    );
  console.log(
    `${Object.keys(body.observations).length} observation sets → ${dir}`,
  );
} else if (cmd === "export" || cmd === "import") {
  const { db, pool } = createDb(databaseUrl());
  await migrate(pool);
  const repo = new CorrectionsRepo(db, await railNetwork());
  if (cmd === "export") {
    if (!a) usage();
    const n = await repo.exportFiles(a!);
    console.log(`${n.observationSets} observation sets → ${a}`);
  } else {
    const n = await repo.importFiles(a);
    console.log(`imported ${n.observationSets} observation sets`);
  }
  await db.destroy();
} else usage();
