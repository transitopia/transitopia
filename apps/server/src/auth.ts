// Admin sign-in with GitHub (apps/server/README.md#admin-api-and-sign-in). Only admins sign in for
// now; reports and submissions will open sign-in to everyone.
//
// The site and the API are on different origins, and a mobile app can't rely on cookies,
// so a session is a bearer token: GitHub redirects back to /auth/github/callback, which creates a
// session and sends the browser to <site>/admin#token=…; the site keeps the token and sends
// `Authorization: Bearer …`. Only the token's SHA-256 is stored.

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@transitopia/db/connect.ts";
import type { ServerEnv } from "./env.ts";

const SESSION_DAYS = 30;
const STATE_TTL_MS = 10 * 60_000;

export interface SessionUser {
  id: number;
  login: string;
  role: "user" | "admin";
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class Auth {
  /** OAuth state → when it was issued (in memory: a restart only fails sign-ins in progress). */
  private states = new Map<string, number>();

  private readonly db: Db | undefined;
  private readonly env: ServerEnv;
  private readonly fetch: typeof fetch;

  constructor(
    db: Db | undefined,
    env: ServerEnv,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.db = db;
    this.env = env;
    this.fetch = fetchImpl;
  }

  get enabled(): boolean {
    return Boolean(this.db && this.env.github);
  }

  /** Where to send the browser to sign in. */
  loginUrl(): string | undefined {
    if (!this.env.github) return undefined;
    const now = Date.now();
    for (const [s, t] of this.states)
      if (now - t > STATE_TTL_MS) this.states.delete(s);
    const state = randomBytes(16).toString("hex");
    this.states.set(state, now);
    const q = new URLSearchParams({
      client_id: this.env.github.clientId,
      redirect_uri: `${this.env.publicUrl}/auth/github/callback`,
      state,
      // Only the public profile (login and id) is needed.
      scope: "",
      allow_signup: "false",
    });
    return `https://github.com/login/oauth/authorize?${q.toString()}`;
  }

  /** Finish the GitHub redirect: the site URL to send the browser to (with a token, or an error). */
  async callback(code: string, state: string): Promise<string> {
    const back = (hash: string) => `${this.env.siteUrl}/admin#${hash}`;
    const issued = this.states.get(state);
    this.states.delete(state);
    if (
      !issued
      || Date.now() - issued > STATE_TTL_MS
      || !this.env.github
      || !this.db
    )
      return back("error=expired");
    const tokenRes = await this.fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: this.env.github.clientId,
          client_secret: this.env.github.clientSecret,
          code,
          redirect_uri: `${this.env.publicUrl}/auth/github/callback`,
        }),
      },
    );
    const { access_token } = (await tokenRes.json()) as {
      access_token?: string;
    };
    if (!access_token) return back("error=github");
    const userRes = await this.fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "transitopia",
      },
    });
    if (!userRes.ok) return back("error=github");
    const gh = (await userRes.json()) as { id: number; login: string };
    const admin = this.env.adminLogins.includes(gh.login.toLowerCase());
    // There's nothing for non-admins to sign in to yet.
    if (!admin) return back("error=not-admin");
    const user = await this.db
      .insertInto("users")
      .values({ github_id: gh.id, login: gh.login, role: "admin" })
      .onConflict((oc) =>
        oc.column("github_id").doUpdateSet({ login: gh.login, role: "admin" }),
      )
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const token = randomBytes(32).toString("base64url");
    await this.db
      .insertInto("sessions")
      .values({
        token_hash: sha256(token),
        user_id: user.id,
        expires_at: new Date(Date.now() + SESSION_DAYS * 86_400_000),
      })
      .execute();
    return back(`token=${token}`);
  }

  /** The user a request's bearer token belongs to. */
  async user(
    authorization: string | undefined,
  ): Promise<SessionUser | undefined> {
    const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
    if (!token) return undefined;
    if (this.env.adminDevToken && token === this.env.adminDevToken)
      return { id: 0, login: "dev", role: "admin" };
    if (!this.db) return undefined;
    const row = await this.db
      .selectFrom("sessions")
      .innerJoin("users", "users.id", "sessions.user_id")
      .select(["users.id", "users.login", "users.role", "sessions.expires_at"])
      .where("sessions.token_hash", "=", sha256(token))
      .executeTakeFirst();
    if (!row || row.expires_at.getTime() < Date.now()) return undefined;
    // An admin removed from ADMIN_GITHUB_LOGINS loses access at once.
    const role =
      (
        row.role === "admin"
        && this.env.adminLogins.includes(row.login.toLowerCase())
      ) ?
        "admin"
      : "user";
    return { id: row.id, login: row.login, role };
  }

  async logout(authorization: string | undefined): Promise<void> {
    const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
    if (!token || !this.db) return;
    await this.db
      .deleteFrom("sessions")
      .where("token_hash", "=", sha256(token))
      .execute();
  }
}
