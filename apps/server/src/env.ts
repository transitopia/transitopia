// The server's deployment settings, from environment variables (infra/.env.example lists them for
// production). Everything that differs between environments is here; region assumptions stay in
// regions/metro-vancouver/config/.

import rtConfig from "@transitopia/region-metro-vancouver/config/rt.json" with { type: "json" };

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const flag = (v: string | undefined) => v === "1" || v === "true";
const url = (v: string | undefined) => (v ? v.replace(/\/$/, "") : undefined);

export interface ServerEnv {
  port: number;
  /** postgres://…; without it the server records to files only, as skytrain-viz did. */
  databaseUrl: string | undefined;
  /**
   * Poll TransLink and aisstream.io with the keys in the environment or .secrets. Off unless set:
   * every poll spends the key's daily budget, which production needs (docs/DESIGN.md#upstream-request-budget).
   */
  poll: boolean;
  /** Only forward /rt/* here (e.g. https://api.transitopia.org) instead of polling. */
  forwardTo: string | undefined;
  /** How followers reach this process if it becomes the leader (e.g. http://server:8787). */
  advertiseUrl: string | undefined;
  /** This server's public URL (for the GitHub sign-in callback), e.g. https://api.transitopia.org. */
  publicUrl: string;
  /** The site, where /admin lives, e.g. https://www.transitopia.org. */
  siteUrl: string;
  /** Origins allowed to call the admin API (`*` matches one subdomain label). */
  allowedOrigins: string[];
  github: { clientId: string; clientSecret: string } | undefined;
  /** GitHub logins that are admins. */
  adminLogins: string[];
  /** A fixed admin token for local development only: refused unless PUBLIC_URL is local. */
  adminDevToken: string | undefined;
  /** Run the leader's scheduled jobs (retention, statistics, data builds, archiving). */
  jobs: boolean;
  /** Build the transit data on the server (daily), rather than only reading var/public/data. */
  buildData: boolean;
  /** rclone destination for the published transit data (e.g. r2:transitopia-data). */
  dataPublishRemote: string | undefined;
  /** rclone destination for archives: raw recordings, GTFS feeds, backups (e.g. r2:transitopia-archive). */
  archiveRemote: string | undefined;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const port = Number(env.PORT ?? rtConfig.serverPort);
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  const publicUrl = url(env.PUBLIC_URL) ?? `http://localhost:${port}`;
  // The dev token signs anyone in as an admin, so it only works on a server reached locally.
  if (env.ADMIN_DEV_TOKEN && !isLocalUrl(publicUrl))
    throw new Error(
      `ADMIN_DEV_TOKEN is for local development only, but PUBLIC_URL is ${publicUrl}: unset it`,
    );
  return {
    port,
    databaseUrl: env.DATABASE_URL || undefined,
    poll: flag(env.RT_POLL),
    forwardTo: url(env.RT_FORWARD_TO),
    advertiseUrl: url(env.ADVERTISE_URL),
    publicUrl,
    siteUrl: url(env.SITE_URL) ?? "http://localhost:5173",
    allowedOrigins:
      env.ALLOWED_ORIGINS ?
        list(env.ALLOWED_ORIGINS)
      : ["http://localhost:5173"],
    github: clientId && clientSecret ? { clientId, clientSecret } : undefined,
    adminLogins: list(env.ADMIN_GITHUB_LOGINS).map((l) => l.toLowerCase()),
    adminDevToken: env.ADMIN_DEV_TOKEN || undefined,
    jobs: env.JOBS === undefined ? true : flag(env.JOBS),
    buildData: flag(env.BUILD_DATA),
    dataPublishRemote: env.DATA_PUBLISH_REMOTE || undefined,
    archiveRemote: env.ARCHIVE_REMOTE || undefined,
  };
}

/** Is `u` on this machine (localhost or a loopback address)? */
export function isLocalUrl(u: string): boolean {
  try {
    const host = new URL(u).hostname;
    return (
      host === "localhost"
      || host.endsWith(".localhost")
      || host === "[::1]"
      || /^127(\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

/** Does `origin` match an allowed origin (entries may use `*` for one subdomain label)? */
export function originAllowed(origin: string, allowed: string[]): boolean {
  return allowed.some((pattern) => {
    if (!pattern.includes("*")) return pattern === origin;
    const re = new RegExp(
      `^${pattern
        .split("*")
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^./]+")}$`,
    );
    return re.test(origin);
  });
}
