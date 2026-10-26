// The server's HTTP API (Hono):
//
//   /rt/*, /regions/*  public real-time API (rt/service.ts), CORS *, cached at the edge
//   /healthz           freshness checks for monitoring (503 when data is stale)
//   /auth/*            admin sign-in with GitHub (auth.ts)
//   /admin/api/*       the review queue behind /admin: disruptions and observations with previews,
//                      jobs and status. Admins only; CORS for ALLOWED_ORIGINS.

import { statfs } from "node:fs/promises";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { isServiceDate } from "@transitopia/transit-core/time.ts";
import {
  featureDetail,
  mergeFeatures,
  newExchange,
  openFlags,
  resolveFlag,
  resolveKey,
  retire,
  searchFeatures,
  setParent,
} from "./features/registry.ts";
import { sql } from "kysely";
import type { Db } from "@transitopia/db/connect.ts";
import { recentRuns } from "@transitopia/db/jobs.ts";
import { storageSizes } from "@transitopia/db/storage.ts";
import type * as z from "zod";
import {
  disruption,
  featureDetailResponse,
  featureFlagsResponse,
  featureSearchResponse,
  mergeRequest,
  newExchangeRequest,
  newExchangeResponse,
  observationSetPut,
  resolveFlagRequest,
  rtStatus,
  setParentRequest,
  type AuthMe,
  type CorrectionsResponse,
  type Health,
  type PreviewResponse,
  type ReviewState,
  type RtStatus,
  type StatusResponse,
} from "@transitopia/shared/admin-api.ts";
import type {
  Disruption,
  DisruptionFile,
} from "@transitopia/transit-core/disruption/types.ts";
import type { ObservationFile } from "@transitopia/transit-core/corrections/types.ts";
import { observationProblems } from "@transitopia/transit-core/corrections/validate.ts";
import { notModified, type RtService } from "./rt/service.ts";
import type { Auth, SessionUser } from "./auth.ts";
import { originAllowed, type ServerEnv } from "./env.ts";
import type { CorrectionsRepo } from "./corrections.ts";
import type { Jobs } from "./jobs/scheduler.ts";
import { serverConfig } from "./config.ts";

export interface AppDeps {
  service: RtService;
  auth: Auth;
  env: ServerEnv;
  db?: Db | undefined;
  repo?: CorrectionsRepo | undefined;
  jobs?: Jobs | undefined;
  /** A directory on the disk /healthz watches (var/); none, no disk check. */
  diskPath?: string | undefined;
}

type Env = { Variables: { user: SessionUser } };

const ID = /^[a-z0-9][a-z0-9._-]{0,120}$/i;

export function createApp(deps: AppDeps): Hono<Env> {
  const { service, auth, env, db, repo } = deps;
  const app = new Hono<Env>();

  app.onError((e, c) => {
    console.error("[http] handler error:", e);
    return c.json({ error: "Internal error" }, 500);
  });

  // ---- Real-time API -------------------------------------------------------------------------
  app.on(["GET", "HEAD", "OPTIONS"], ["/rt/*", "/regions/*"], async (c) => {
    if (c.req.method === "OPTIONS")
      return c.body(null, 204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      });
    const url = new URL(c.req.url);
    const r = await service.handle(url.pathname, url.searchParams);
    if (
      r.status === 200
      && notModified(
        c.req.header("If-None-Match"),
        r.headers["ETag"] ?? r.headers["etag"],
      )
    )
      return new Response(null, { status: 304, headers: r.headers });
    return new Response(
      c.req.method === "HEAD" ? null : new Uint8Array(Buffer.from(r.body)),
      { status: r.status, headers: r.headers },
    );
  });

  // ---- Feature resolver (apps/server/README.md#feature-resolver) -------------------------------
  app.get("/features/:key", async (c) => {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    };
    if (!db) return c.json({ error: "No feature registry" }, 503, headers);
    const date = c.req.query("date");
    if (date !== undefined && !isServiceDate(date))
      return c.json({ error: "date is YYYYMMDD" }, 400, headers);
    const r = await resolveKey(db, c.req.param("key"), date);
    if (r === "unminted") return c.json({ unminted: true }, 404, headers);
    if (!r) return c.json({ error: "Unknown feature" }, 404, headers);
    return c.json(r, 200, headers);
  });

  app.get("/healthz", async (c) => {
    const h = await health(deps);
    return c.json(h, h.ok ? 200 : 503, { "Cache-Control": "no-store" });
  });

  // ---- Sign-in -------------------------------------------------------------------------------
  const adminCors = cors({
    origin: (origin) =>
      originAllowed(origin, env.allowedOrigins) ? origin : null,
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  });
  app.use("/auth/*", adminCors);
  app.get("/auth/github/login", (c) => {
    const to = auth.enabled ? auth.loginUrl() : undefined;
    return to ?
        c.redirect(to)
      : c.json({ error: "GitHub sign-in isn't configured" }, 404);
  });
  app.get("/auth/github/callback", async (c) =>
    c.redirect(
      await auth.callback(
        c.req.query("code") ?? "",
        c.req.query("state") ?? "",
      ),
    ),
  );
  app.get("/auth/me", async (c) => {
    const user = await auth.user(c.req.header("Authorization"));
    return c.json({
      user: user ?? null,
      signIn: auth.enabled || Boolean(env.adminDevToken),
    } satisfies AuthMe);
  });
  app.post("/auth/logout", async (c) => {
    await auth.logout(c.req.header("Authorization"));
    return c.json({ ok: true });
  });

  // ---- Admin API -----------------------------------------------------------------------------
  app.use("/admin/api/*", adminCors);
  app.use("/admin/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const user = await auth.user(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Sign in first" }, 401);
    if (user.role !== "admin") return c.json({ error: "Admins only" }, 403);
    c.set("user", user);
    await next();
  });

  app.get("/admin/api/status", async (c) =>
    c.json({
      rt: await rtStatusOf(service),
      health: await health(deps),
      jobs: db ? await recentRuns(db, 40) : [],
      daily: db ? await recentRuns(db, 60, "daily") : [],
      storage: db ? await storageSizes(db) : null,
    } satisfies StatusResponse),
  );

  // ---- Features (docs/DESIGN.md#feature-ids): containment, merges and flags ------------------
  const needDb = (c: Context<Env>) =>
    c.json({ error: "No database: no feature registry" }, 409);
  /**
   * Who made a registry change (feature_changes.user_id): a signed-in admin's users row; none for
   * ADMIN_DEV_TOKEN's local admin, who has no row.
   */
  const userId = (c: Context<Env>) => {
    const id = c.get("user").id;
    return id > 0 ? id : null;
  };
  /** Run a registry change, answering its error (a refused change) as a 400. */
  const change = async (c: Context<Env>, fn: () => Promise<unknown>) => {
    try {
      await fn();
      return c.json({ ok: true } as const);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  };

  app.get("/admin/api/features", async (c) => {
    if (!db) return needDb(c);
    return c.json({
      results: await searchFeatures(db, c.req.query("q") ?? ""),
    } satisfies z.input<typeof featureSearchResponse>);
  });

  app.get("/admin/api/features/:id", async (c) => {
    if (!db) return needDb(c);
    const d = await featureDetail(db, c.req.param("id"));
    if (!d) return c.json({ error: "No such feature" }, 404);
    return c.json(d satisfies z.input<typeof featureDetailResponse>);
  });

  app.post("/admin/api/features/:id/parent", async (c) => {
    if (!db) return needDb(c);
    const body = await parseBody(c, setParentRequest);
    if (!body.ok) return body.response;
    return change(c, () =>
      setParent(db, c.req.param("id"), body.value.parent, userId(c)),
    );
  });

  app.post("/admin/api/features/:id/retire", async (c) => {
    if (!db) return needDb(c);
    return change(c, () => retire(db, c.req.param("id"), userId(c)));
  });

  app.post("/admin/api/features/:id/merge", async (c) => {
    if (!db) return needDb(c);
    const body = await parseBody(c, mergeRequest);
    if (!body.ok) return body.response;
    return change(c, () =>
      mergeFeatures(db, c.req.param("id"), body.value.into, userId(c)),
    );
  });

  app.post("/admin/api/features/exchange", async (c) => {
    if (!db) return needDb(c);
    const body = await parseBody(c, newExchangeRequest);
    if (!body.ok) return body.response;
    try {
      const id = await newExchange(
        db,
        body.value.name,
        body.value.stops,
        userId(c),
      );
      return c.json({ id } satisfies z.input<typeof newExchangeResponse>);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get("/admin/api/feature-flags", async (c) => {
    if (!db) return needDb(c);
    return c.json({
      flags: await openFlags(db),
    } satisfies z.input<typeof featureFlagsResponse>);
  });

  app.post("/admin/api/feature-flags/:id/resolve", async (c) => {
    if (!db) return needDb(c);
    const body = await parseBody(c, resolveFlagRequest);
    if (!body.ok) return body.response;
    return change(c, () =>
      resolveFlag(
        db,
        Number(c.req.param("id")),
        body.value.resolution,
        userId(c),
      ),
    );
  });

  const needRepo = (c: Context<Env>) =>
    repo ? undefined : (
      c.json({ error: "No database: corrections are files" }, 409)
    );

  app.get("/admin/api/corrections", async (c) => {
    if (!repo) return needRepo(c)!;
    const [disruptions, observationSets] = await Promise.all([
      repo.disruptions(),
      repo.observationSets(),
    ]);
    return c.json({
      disruptions,
      observationSets,
      unparsedAlerts: service.alertDrafts?.unparsed ?? [],
      liveDispatch: service.dispatcher?.pointer() ?? {},
    } satisfies CorrectionsResponse);
  });

  // Edit (or create) a disruption. Edits keep the review state, except that a confirmed one goes
  // back to draft: it has to be previewed and confirmed again.
  app.put("/admin/api/disruptions/:id", async (c) => {
    if (!repo) return needRepo(c)!;
    const id = c.req.param("id");
    const body = await parseBody(c, disruption);
    if (!body.ok) return body.response;
    const d = body.value;
    const problems = disruptionProblems(d, id);
    if (problems.length) return c.json({ error: problems.join("; ") }, 400);
    const old = await repo.disruption(id);
    await repo.saveDisruption(d, {
      state: !old || old.state === "confirmed" ? "draft" : old.state,
      by: c.get("user").login,
    });
    return c.json({ ok: true });
  });

  app.put("/admin/api/observations/:id", async (c) => {
    if (!repo) return needRepo(c)!;
    const id = c.req.param("id");
    if (!ID.test(id)) return c.json({ error: "Bad id" }, 400);
    const body = await parseBody(c, observationSetPut);
    if (!body.ok) return body.response;
    const { title, file } = body.value;
    const problems = (file.observations ?? []).flatMap((o, i) =>
      observationProblems(o).map((p) => `#${i + 1}: ${p}`),
    );
    if (!Array.isArray(file.observations) || !file.observations.length)
      problems.push("no observations");
    if (problems.length) return c.json({ error: problems.join("; ") }, 400);
    const old = await repo.observationSet(id);
    await repo.saveObservationSet(id, file, {
      title,
      state: !old || old.state === "confirmed" ? "draft" : old.state,
      by: c.get("user").login,
    });
    return c.json({ ok: true });
  });

  // Dispatch the dates it touches with this correction added: preview versions to look at on /transit.
  app.post(
    "/admin/api/:kind{disruptions|observations}/:id/preview",
    async (c) => {
      if (!repo) return needRepo(c)!;
      if (!service.dispatcher)
        return c.json({ error: "Live dispatch runs on the leader" }, 409);
      const { kind, id } = c.req.param();
      let candidate;
      if (kind === "disruptions") {
        const d = await repo.disruption(id);
        if (!d) return c.notFound();
        const problems = disruptionProblems(d.body, id, true);
        if (problems.length) return c.json({ error: problems.join("; ") }, 400);
        candidate = { disruptions: [d.body] };
      } else {
        const s = await repo.observationSet(id);
        if (!s) return c.notFound();
        candidate = { observations: s.body.observations };
      }
      const versions = await service.dispatcher.preview(
        candidate,
        `${kind}:${id}`,
      );
      await repo.setState(
        kind === "disruptions" ? "disruption" : "observations",
        id,
        "previewing",
        c.get("user").login,
      );
      return c.json({ versions } satisfies PreviewResponse);
    },
  );

  app.post(
    "/admin/api/:kind{disruptions|observations}/:id/:action{confirm|discard|reopen}",
    async (c) => {
      if (!repo) return needRepo(c)!;
      const { kind, id, action } = c.req.param();
      if (kind === "disruptions" && action === "confirm") {
        const d = await repo.disruption(id);
        if (!d) return c.notFound();
        const problems = disruptionProblems(d.body, id, true);
        if (problems.length) return c.json({ error: problems.join("; ") }, 400);
      }
      const state: ReviewState =
        action === "confirm" ? "confirmed"
        : action === "discard" ? "discarded"
        : "draft";
      const ok = await repo.setState(
        kind === "disruptions" ? "disruption" : "observations",
        id,
        state,
        c.get("user").login,
      );
      return ok ? c.json({ ok: true }) : c.notFound();
    },
  );

  // The confirmed corrections in the file format, e.g. for a test fixture or the static build.
  app.get("/admin/api/export", async (c) => {
    if (!repo) return needRepo(c)!;
    const observations: Record<string, ObservationFile> = {};
    for (const s of await repo.observationSets(["confirmed"]))
      observations[s.id] = s.body;
    const disruptions: Record<string, DisruptionFile> = {};
    for (const d of await repo.disruptions(["confirmed"]))
      disruptions[d.id] = { disruptions: [{ ...d.body, status: "confirmed" }] };
    return c.json({ observations, disruptions });
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}

/** What the disruption format requires (config/regions/metro-vancouver/disruptions/README.md). */
export function disruptionProblems(
  d: Disruption,
  id: string,
  forConfirm = false,
): string[] {
  const p: string[] = [];
  if (!d || typeof d !== "object") return ["not a disruption"];
  if (d.id !== id || !ID.test(id))
    p.push("id must match the URL and be [a-z0-9._-]");
  if (!d.text) p.push("text is required");
  if (!d.source) p.push("source is required");
  if (!Array.isArray(d.active) || !d.active.length)
    p.push("active needs at least one period");
  for (const a of d.active ?? [])
    if (!(instantOrNaN(a.from) < instantOrNaN(a.until)))
      p.push(
        `period ${a.from} → ${a.until} is not a valid range of ISO 8601 times with offset`,
      );
  if (!d.singleTrack?.length && !d.headway?.length)
    p.push("needs singleTrack or headway (or both)");
  for (const s of d.singleTrack ?? []) {
    if (!s.line || s.between?.length !== 2)
      p.push("singleTrack needs line and two stations in between");
    if (forConfirm && !s.keep)
      p.push(
        `which track stays open between ${s.between?.join(" and ")}? Set keep to a platform stop`,
      );
  }
  for (const h of d.headway ?? [])
    if (!h.line || !(h.minS > 0)) p.push("headway needs line and minS > 0");
  return p;
}

/** Data freshness (deployment/README.md#monitoring): the poller, AIS, the database, the jobs and the disk. */
export async function health({
  service,
  db,
  jobs,
  diskPath,
}: AppDeps): Promise<Health> {
  const checks: Health["checks"] = {};
  if (db) {
    try {
      await sql`select 1`.execute(db);
      checks.database = { ok: true };
    } catch (e) {
      checks.database = { ok: false, detail: (e as Error).message };
    }
  }
  const status = await rtStatusOf(service);
  // Each feed the leader polls: its positions, and its trip updates' freshness and coverage.
  for (const [feed, p] of Object.entries(status.providers)) {
    if (!status.leader || !p.polling) continue;
    const age = p.lastSnapshotAgeS;
    const limit = 3 * (p.budget.intervalsS.positions ?? 300);
    checks[`${feed}/positions`] = {
      ok: age !== null && age <= limit,
      detail:
        age === null ? "no poll yet" : (
          `last poll ${Math.round(age)} s ago (limit ${limit} s)${p.budget.capped ? ", daily cap reached" : ""}`
        ),
    };
    const tripUpdates = p.feeds.tripUpdates;
    if (!tripUpdates) continue;
    // A failed poll is logged and retried; this catches the feed staying down, or succeeding with
    // nothing that matches the positions (trip updates also carry cancellations and skipped stops)
    // for a while, with enough buses out to tell: at the ends of service, buses are signed on to
    // trips the feed has dropped or doesn't list yet.
    // A restarted leader continues the schedule rather than polling at once, so until the first
    // success the age counts from when polling started (apps/server/README.md#real-time-service).
    const { lastOkAgeS, lastError } = tripUpdates;
    const tuLimit = 3 * (p.budget.intervalsS.tripUpdates ?? 1800);
    const tuAge = lastOkAgeS ?? p.pollingForS;
    const nextInS = p.budget.nextPollInS.tripUpdates;
    const coverage = p.delayCoverage;
    const lowForS = p.lowCoverageForS;
    const fresh = tuAge !== null && tuAge <= tuLimit;
    const covered = lowForS === null || lowForS < p.maxLowCoverageS;
    checks[`${feed}/tripUpdates`] = {
      ok: fresh && covered,
      detail: [
        lastOkAgeS === null ?
          `no successful poll since polling started ${tuAge ?? 0} s ago (limit ${tuLimit} s)${nextInS === undefined ? "" : `; next poll in ${nextInS} s`}`
        : `last successful poll ${lastOkAgeS} s ago (limit ${tuLimit} s)`,
        ...(lastError ? [`last error: ${lastError}`] : []),
        ...(typeof coverage === "number" ?
          [
            `${Math.round(coverage * 100)} % of ${p.busesOnTrips} vehicles have a delay${lowForS === null ? "" : ` (below ${Math.round(p.minDelayCoverage * 100)} % for ${lowForS} s, limit ${p.maxLowCoverageS} s)`}`,
          ]
        : []),
      ].join("; "),
    };
  }
  for (const [feed, ais] of Object.entries(status.ais)) {
    if (!status.leader || !ais) continue;
    const age = ais.lastMessageAgeS;
    checks[`${feed}/ais`] = {
      // Moored vessels still report every few minutes.
      ok: ais.connected && age !== null && age <= 1800,
      detail: `${ais.connected ? "connected" : "disconnected"}, last message ${age ?? "never"} s ago`,
    };
  }
  if (jobs) Object.assign(checks, await jobs.health());
  if (diskPath) {
    try {
      checks.disk = diskCheck(await statfs(diskPath), serverConfig.diskMaxUsed);
    } catch (e) {
      checks.disk = { ok: false, detail: (e as Error).message };
    }
  }
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}

/** A filesystem's use as `df` reports it: used / (used + available to unprivileged users). */
export function diskCheck(
  s: { blocks: number; bfree: number; bavail: number; bsize: number },
  maxUsed: number,
): Health["checks"][string] {
  const used = s.blocks - s.bfree;
  const share = used / (used + s.bavail);
  const gib = (blocks: number) => ((blocks * s.bsize) / 2 ** 30).toFixed(1);
  return {
    ok: share <= maxUsed,
    detail: `${Math.round(share * 100)} % used, ${gib(s.bavail)} GiB free of ${gib(s.blocks)} GiB (limit ${Math.round(maxUsed * 100)} %)`,
  };
}

async function rtStatusOf(service: RtService): Promise<RtStatus> {
  return rtStatus.parse(
    JSON.parse(
      String((await service.handle("/rt/status", new URLSearchParams())).body),
    ),
  );
}

/** A request body checked against its schema, or the 400 response to send. */
async function parseBody<T>(
  c: Context<Env>,
  schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const r = schema.safeParse(await c.req.json().catch(() => undefined));
  return r.success ?
      { ok: true, value: r.data }
    : {
        ok: false,
        response: c.json(
          { error: r.error.issues.map((i) => i.message).join("; ") },
          400,
        ),
      };
}

/** Epoch ms of an ISO 8601 time with offset (what the disruption format requires), else NaN. */
function instantOrNaN(iso: unknown): number {
  try {
    return Temporal.Instant.from(iso as string).epochMilliseconds;
  } catch {
    return NaN;
  }
}
