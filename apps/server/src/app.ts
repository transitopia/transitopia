// The server's HTTP API (Hono):
//
//   /rt/*, /regions/*  public real-time API (rt/service.ts), CORS *, cached at the edge
//   /healthz           freshness checks for monitoring (503 when data is stale)
//   /auth/*            admin sign-in with GitHub (auth.ts)
//   /admin/api/*       the review queue behind /admin: disruptions and observations with previews,
//                      jobs and status. Admins only; CORS for ALLOWED_ORIGINS.

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { sql } from "kysely";
import type { Db } from "@transitopia/db/connect.ts";
import { recentRuns } from "@transitopia/db/jobs.ts";
import { storageSizes } from "@transitopia/db/storage.ts";
import type * as z from "zod";
import {
  disruption,
  observationSetPut,
  rtStatus,
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

export interface AppDeps {
  service: RtService;
  auth: Auth;
  env: ServerEnv;
  db?: Db | undefined;
  repo?: CorrectionsRepo | undefined;
  jobs?: Jobs | undefined;
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

/** Data freshness (deployment/README.md#monitoring): the poller, AIS, the database and the jobs. */
export async function health({ service, db, jobs }: AppDeps): Promise<Health> {
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
    // nothing that matches the positions (trip updates also carry cancellations and skipped stops).
    // A restarted leader continues the schedule rather than polling at once, so until the first
    // success the age counts from when polling started (apps/server/README.md#real-time-service).
    const { lastOkAgeS, lastError } = tripUpdates;
    const tuLimit = 3 * (p.budget.intervalsS.tripUpdates ?? 1800);
    const tuAge = lastOkAgeS ?? p.pollingForS;
    const nextInS = p.budget.nextPollInS.tripUpdates;
    const coverage = p.delayCoverage;
    const fresh = tuAge !== null && tuAge <= tuLimit;
    const covered = coverage === null || coverage >= p.minDelayCoverage;
    checks[`${feed}/tripUpdates`] = {
      ok: fresh && covered,
      detail: [
        lastOkAgeS === null ?
          `no successful poll since polling started ${tuAge ?? 0} s ago (limit ${tuLimit} s)${nextInS === undefined ? "" : `; next poll in ${nextInS} s`}`
        : `last successful poll ${lastOkAgeS} s ago (limit ${tuLimit} s)`,
        ...(lastError ? [`last error: ${lastError}`] : []),
        ...(typeof coverage === "number" ?
          [`${Math.round(coverage * 100)} % of vehicles have a delay`]
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
  return { ok: Object.values(checks).every((c) => c.ok), checks };
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
