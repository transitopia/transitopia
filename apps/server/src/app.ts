// The server's HTTP API (Hono):
//
//   /rt/*              public real-time API (rt/service.ts), CORS *, cached at the edge
//   /healthz           freshness checks for monitoring (503 when data is stale)
//   /auth/*            admin sign-in with GitHub (auth.ts)
//   /admin/api/*       the review queue behind /admin: disruptions and observations with previews,
//                      jobs and status. Admins only; CORS for ALLOWED_ORIGINS.

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { sql } from "kysely";
import type { Db } from "@transitopia/db/connect.ts";
import { recentRuns } from "@transitopia/db/jobs.ts";
import type { ReviewState } from "@transitopia/db/schema.ts";
import type {
  Disruption,
  DisruptionFile,
} from "@transitopia/transit-core/disruption/types.ts";
import type { ObservationFile } from "@transitopia/transit-core/corrections/types.ts";
import { observationProblems } from "@transitopia/transit-core/corrections/validate.ts";
import type { RtService } from "./rt/service.ts";
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
  app.on(["GET", "HEAD", "OPTIONS"], "/rt/*", async (c) => {
    if (c.req.method === "OPTIONS")
      return c.body(null, 204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      });
    const url = new URL(c.req.url);
    const r = await service.handle(url.pathname, url.searchParams);
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
    });
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
      rt: JSON.parse(
        String(
          (await service.handle("/rt/status", new URLSearchParams())).body,
        ),
      ),
      health: await health(deps),
      jobs: db ? await recentRuns(db, 40) : [],
    }),
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
      unparsedAlerts: service.alertDrafts.unparsed,
      liveDispatch: service.dispatcher?.pointer() ?? {},
    });
  });

  // Edit (or create) a disruption. Edits keep the review state, except that a confirmed one goes
  // back to draft: it has to be previewed and confirmed again.
  app.put("/admin/api/disruptions/:id", async (c) => {
    if (!repo) return needRepo(c)!;
    const id = c.req.param("id");
    const d = (await c.req.json()) as Disruption;
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
    const { title, file } = (await c.req.json()) as {
      title?: string;
      file: ObservationFile;
    };
    const problems = (file?.observations ?? []).flatMap((o, i) =>
      observationProblems(o).map((p) => `#${i + 1}: ${p}`),
    );
    if (!Array.isArray(file?.observations) || !file.observations.length)
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
      return c.json({ versions });
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

/** What the disruption format requires (regions/metro-vancouver/disruptions/README.md). */
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
    if (!(Date.parse(a.from) < Date.parse(a.until)))
      p.push(`period ${a.from} → ${a.until} is not a valid ISO 8601 range`);
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

export interface Health {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
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
  const status = JSON.parse(
    String((await service.handle("/rt/status", new URLSearchParams())).body),
  ) as {
    leader?: boolean;
    hasKey: boolean;
    lastSnapshotAgeS: number | null;
    budget?: { intervalsS: { positions: number }; capped: boolean };
    ais: { connected: boolean; lastMessageAgeS: number | null } | null;
  };
  if (status.leader && status.hasKey) {
    const age = status.lastSnapshotAgeS;
    const limit = 3 * (status.budget?.intervalsS.positions ?? 300);
    checks.positions = {
      ok: age !== null && age <= limit,
      detail:
        age === null ? "no poll yet" : (
          `last poll ${Math.round(age)} s ago (limit ${limit} s)${status.budget?.capped ? ", daily cap reached" : ""}`
        ),
    };
  }
  if (status.leader && status.ais) {
    const age = status.ais.lastMessageAgeS;
    checks.ais = {
      // Moored vessels still report every few minutes.
      ok: status.ais.connected && age !== null && age <= 1800,
      detail: `${status.ais.connected ? "connected" : "disconnected"}, last message ${age ?? "never"} s ago`,
    };
  }
  if (jobs) Object.assign(checks, await jobs.health());
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}
