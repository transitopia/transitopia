// The admin API (/auth/* and /admin/api/* in apps/server/src/app.ts) as zod schemas: the server
// types its responses and parses its requests with them, and /admin parses what it gets back.
// Timestamps are Dates on both sides: the server's rows hold Dates, JSON carries ISO strings, and
// parsing turns them back into Dates.
//
// Disruption and observation bodies are checked only for being objects here: their formats belong
// to transit-core, and the server validates them (disruptionProblems, observationProblems) with
// messages the page shows.

import * as z from "zod";
import type { Disruption } from "@transitopia/transit-core/disruption/types.ts";
import type { ObservationFile } from "@transitopia/transit-core/corrections/types.ts";

const object = (v: unknown) =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const disruption = z.custom<Disruption>(object, "not a disruption");
export const observationFile = z.custom<ObservationFile>(
  object,
  "not an observation file",
);

/** A correction's review (docs/DESIGN.md#corrections-and-previews); also the database column. */
export const reviewState = z.enum([
  "draft",
  "previewing",
  "confirmed",
  "discarded",
]);
export type ReviewState = z.infer<typeof reviewState>;

/** Any error: the status says what kind, `error` is for people. */
export const errorResponse = z.object({ error: z.string() });

export const okResponse = z.object({ ok: z.literal(true) });

// ---- Sign-in ----------------------------------------------------------------------------------

export const authMe = z.object({
  user: z
    .object({ login: z.string(), role: z.enum(["user", "admin"]) })
    .nullable(),
  /** Whether signing in is possible here (GitHub configured, or a dev token). */
  signIn: z.boolean(),
});
export type AuthMe = z.infer<typeof authMe>;

// ---- Status -----------------------------------------------------------------------------------

/** What the server's freshness checks found (/healthz, and the status). */
export const health = z.object({
  ok: z.boolean(),
  checks: z.record(
    z.string(),
    z.object({ ok: z.boolean(), detail: z.string().optional() }),
  ),
});
export type Health = z.infer<typeof health>;

const feedStatus = z.object({
  lastOkAgeS: z.number().nullable(),
  lastError: z.string().nullable(),
});

/** One feed's real-time poller in /rt/status (apps/server/src/rt/feed.ts). */
export const providerStatus = z.looseObject({
  name: z.string(),
  /** Whether it fetches upstream (RT_POLL, and its key where it needs one). */
  polling: z.boolean(),
  hasKey: z.boolean(),
  vehicles: z.number(),
  lastSnapshotAgeS: z.number().nullable(),
  budget: z.object({
    cap: z.number(),
    used24h: z.number(),
    capped: z.boolean(),
    intervalsS: z.record(z.string(), z.number()),
    nextPollInS: z.record(z.string(), z.number()),
  }),
  /** Seconds since this leader started polling (null before it has). */
  pollingForS: z.number().nullable(),
  /** Per endpoint: positions, trip updates, alerts. */
  feeds: z.record(z.string(), feedStatus),
  delayCoverage: z.number().nullable(),
  minDelayCoverage: z.number(),
});
export type ProviderStatus = z.infer<typeof providerStatus>;

/** The parts of /rt/status the health checks and /admin read; the rest passes through. */
export const rtStatus = z.looseObject({
  leader: z.boolean(),
  /** Each real-time feed's poller, by feed id (config/feeds/<id>/feed.json). */
  providers: z.record(z.string(), providerStatus),
  ais: z
    .object({
      connected: z.boolean(),
      lastMessageAgeS: z.number().nullable(),
    })
    .nullable(),
});
export type RtStatus = z.infer<typeof rtStatus>;

export const jobRun = z.object({
  job: z.string(),
  key: z.string(),
  status: z.enum(["running", "done", "failed"]),
  started_at: z.coerce.date(),
  finished_at: z.coerce.date().nullable(),
  error: z.string().nullable(),
  detail: z.unknown(),
});

export const statusResponse = z.object({
  rt: rtStatus,
  health,
  /** Latest job runs. */
  jobs: z.array(jobRun),
  /** Every daily run within retention: rows and trips per service date, for sizing. */
  daily: z.array(jobRun),
  /** Disk used per table (deployment/README.md#sizing); null without a database. */
  storage: z
    .object({
      databaseBytes: z.number(),
      tables: z.array(
        z.object({
          table: z.string(),
          bytes: z.number(),
          rows: z.number(),
          partitions: z.number(),
        }),
      ),
    })
    .nullable(),
});
export type StatusResponse = z.infer<typeof statusResponse>;

// ---- Corrections ------------------------------------------------------------------------------

const correctionRow = <T extends z.ZodType>(body: T) =>
  z.object({
    id: z.string(),
    state: reviewState,
    /** Service dates it touches (YYYY-MM-DD). */
    dates: z.array(z.string()),
    body,
    updated_at: z.coerce.date(),
    created_by: z.string().nullable(),
    reviewed_by: z.string().nullable(),
    reviewed_at: z.coerce.date().nullable(),
  });

export const disruptionRow = correctionRow(disruption).extend({
  /** The TransLink alert it was drafted from. */
  alert_id: z.string().nullable(),
});
export type DisruptionRow = z.infer<typeof disruptionRow>;

export const observationRow = correctionRow(observationFile).extend({
  title: z.string(),
});
export type ObservationRow = z.infer<typeof observationRow>;

/** A SkyTrain alert the server couldn't draft a disruption from, and why. */
export const unparsedAlert = z.object({
  id: z.string(),
  lines: z.array(z.string()),
  header: z.string(),
  reason: z.string(),
});
export type UnparsedAlert = z.infer<typeof unparsedAlert>;

export const correctionsResponse = z.object({
  disruptions: z.array(disruptionRow),
  observationSets: z.array(observationRow),
  unparsedAlerts: z.array(unparsedAlert),
  /** Service date (YYYYMMDD) → the live dispatch version. */
  liveDispatch: z.record(z.string(), z.string()),
});
export type CorrectionsResponse = z.infer<typeof correctionsResponse>;

/** PUT /admin/api/observations/:id (a disruption is PUT as it is). */
export const observationSetPut = z.object({
  title: z.string().optional(),
  file: observationFile,
});

/** Service date (YYYYMMDD) → the preview dispatch version and what went into it. */
export const previews = z.record(
  z.string(),
  z.object({
    version: z.string(),
    summary: z.object({ inputs: z.array(z.string()) }),
  }),
);
export type Previews = z.infer<typeof previews>;

/** POST /admin/api/:kind/:id/preview. */
export const previewResponse = z.object({ versions: previews });
export type PreviewResponse = z.infer<typeof previewResponse>;
