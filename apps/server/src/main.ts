// The Transitopia server (apps/server/README.md): the real-time API, and on the leader the budgeted
// pollers, recorder, live dispatcher and scheduled jobs. Settings come from the environment (env.ts).
//
//   npm run server                                   # local: schedules only, or forward (below)
//   RT_FORWARD_TO=https://api.transitopia.org npm run server   # local, with production's live data
//   DATABASE_URL=postgres://… RT_POLL=1 npm run server         # production (infra/compose.yml)

import { serve } from "@hono/node-server";
import region from "@transitopia/region-metro-vancouver/region.json" with { type: "json" };
import { checkTimezoneData } from "@transitopia/transit-core/time.ts";
import { createDb } from "@transitopia/db/connect.ts";
import { migrate } from "@transitopia/db/migrate.ts";
import { ensurePartitions } from "@transitopia/db/partitions.ts";
import { RtService } from "./rt/service.ts";
import { readEnv } from "./env.ts";
import { Store } from "./store.ts";
import { PgLeaderLock } from "./leader.ts";
import { CorrectionsRepo } from "./corrections.ts";
import { Auth } from "./auth.ts";
import { createApp } from "./app.ts";
import { Jobs } from "./jobs/scheduler.ts";

const log = (m: string) => console.log(`[server] ${m}`);

// Every local time (service days, recordings, dispatch dates) comes from the runtime's time zone
// data, so refuse to start on an outdated copy rather than record and dispatch against wrong times.
const tzProblems = checkTimezoneData(region.timezoneChecks, region.timezone);
if (tzProblems.length) {
  console.error(
    [
      `[server] Outdated time zone data (tzdata ${process.versions.tz ?? "unknown"} in this Node.js):`,
      ...tzProblems.map((p) => `  - ${p}`),
      "Update Node.js. Builds using the system's ICU (e.g. Homebrew's node) take their data from",
      "icu4c instead: use an official Node.js build, or point ICU_TIMEZONE_FILES_DIR at current data",
      "(https://github.com/unicode-org/icu-data/tree/main/tzdata/icunew).",
    ].join("\n"),
  );
  process.exit(1);
}

let env: ReturnType<typeof readEnv>;
try {
  env = readEnv();
} catch (e) {
  console.error(`[server] ${(e as Error).message}`);
  process.exit(1);
}
let db: ReturnType<typeof createDb> | undefined;
if (env.databaseUrl) {
  db = createDb(env.databaseUrl);
  const applied = await migrate(db.pool, log);
  if (!applied.length) log("database schema up to date");
  await ensurePartitions(db.db);
}
const store = db ? new Store(db.db, region.id) : undefined;
const repo = db ? new CorrectionsRepo(db.db, region.id) : undefined;
if (repo) {
  // First start on a new database: bring in the committed corrections (existing ids are kept).
  const n = await repo.importFiles();
  if (n.observationSets || n.disruptions)
    log(
      `imported ${n.observationSets} observation sets and ${n.disruptions} disruptions from files`,
    );
}

const jobs =
  env.jobs && !env.forwardTo ?
    new Jobs({ db: db?.db, regionId: region.id, repo, env })
  : undefined;

const service = new RtService({
  // Without RT_POLL, keys in .secrets or the environment are ignored: polling spends the key's
  // daily budget, and production needs all of it (docs/DESIGN.md#upstream-request-budget).
  ...(env.poll ? {} : { apiKey: null, aisApiKey: null }),
  forwardTo: env.forwardTo,
  store,
  corrections: repo,
  leaderLock:
    db && env.databaseUrl ?
      new PgLeaderLock({
        url: env.databaseUrl,
        db: db.db,
        regionId: region.id,
        advertiseUrl: env.advertiseUrl,
        onLost: () => {
          console.error(
            "[server] lost the leader lock's database connection; exiting to restart",
          );
          process.exit(1);
        },
      })
    : undefined,
  onLead: () => jobs?.start(),
});
if (!env.poll && !env.forwardTo)
  log(
    "Not polling TransLink or aisstream.io (set RT_POLL=1 to, which spends the API key's daily budget; "
      + "or RT_FORWARD_TO=https://api.transitopia.org to use production's live data)",
  );

const auth = new Auth(db?.db, env);
const app = createApp({ service, auth, env, db: db?.db, repo, jobs });
const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  log(`Listening on http://localhost:${info.port} (/rt/live, /healthz)`);
  void service.start(info.port);
});

const shutdown = () => {
  jobs?.stop();
  service.stop();
  server.close(() => {
    void db?.db.destroy().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
