// /admin (apps/web/README.md#admin): the server's status and the review queue for corrections. Disruptions
// drafted from TransLink alerts, and observation sets, are edited here, previewed on the map as
// dispatch versions nobody else sees, then confirmed (or discarded). Admins sign in with GitHub;
// the server returns a bearer token in the URL fragment, kept in localStorage.

import React from "react";
import { transitApi } from "../config.ts";
import region from "@transitopia/region-metro-vancouver/region.json";
import type { Disruption } from "@transitopia/transit-core/disruption/types.ts";
import type { ObservationFile } from "@transitopia/transit-core/corrections/types.ts";

type ReviewState = "draft" | "previewing" | "confirmed" | "discarded";

interface Row<T> {
  id: string;
  state: ReviewState;
  dates: string[];
  body: T;
  updated_at: string;
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}
type DisruptionRow = Row<Disruption> & { alert_id: string | null };
type ObservationRow = Row<ObservationFile> & { title: string };

interface Corrections {
  disruptions: DisruptionRow[];
  observationSets: ObservationRow[];
  unparsedAlerts: {
    id: string;
    lines: string[];
    header: string;
    reason: string;
  }[];
  liveDispatch: Record<string, string>;
}

type Previews = Record<
  string,
  { version: string; summary: { inputs: string[] } }
>;

const TOKEN_KEY = "transitopia:admin-token";

function loadToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveToken(token: string | undefined): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // The token only lasts this page view then.
  }
}

const SIGN_IN_ERRORS: Record<string, string> = {
  "not-admin": "That GitHub account isn't an admin here.",
  expired: "The sign-in took too long or was started elsewhere. Try again.",
  github: "GitHub didn't confirm the sign-in. Try again.",
};

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function useApi(token: string | undefined) {
  return React.useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const res = await fetch(`${transitApi}${path}`, {
        ...init,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
      const body = (await res.json().catch(() => ({}))) as T & {
        error?: string;
      };
      if (!res.ok)
        throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
      return body;
    },
    [token],
  );
}

const card =
  "rounded-lg border border-gray-300 bg-white p-4 dark:border-gray-700 dark:bg-gray-900";
const button =
  "rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800";
const primary =
  "rounded bg-blue-700 px-3 py-1.5 text-sm text-white hover:bg-blue-800 disabled:opacity-50";

export default function Admin() {
  const [token, setToken] = React.useState<string | undefined>(() => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const fromHash = hash.get("token");
    if (fromHash) {
      saveToken(fromHash);
      history.replaceState(null, "", location.pathname);
      return fromHash;
    }
    return loadToken();
  });
  const [signInError] = React.useState(() => {
    const e = new URLSearchParams(location.hash.slice(1)).get("error");
    if (e) history.replaceState(null, "", location.pathname);
    return e ? (SIGN_IN_ERRORS[e] ?? e) : undefined;
  });
  const [me, setMe] = React.useState<{ login: string } | null | undefined>();
  const api = useApi(token);

  React.useEffect(() => {
    if (!transitApi) return;
    api<{ user: { login: string; role: string } | null }>("auth/me")
      .then((r) => setMe(r.user?.role === "admin" ? r.user : null))
      .catch(() => setMe(null));
  }, [api]);

  const signOut = () => {
    void api("auth/logout", { method: "POST" }).catch(() => {});
    saveToken(undefined);
    setToken(undefined);
    setMe(null);
  };

  return (
    <div className="min-h-dvh bg-gray-100 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="flex items-center gap-3 border-b border-gray-300 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
        <a href="/transit">
          <img
            src="/transitopia-logo-h.svg"
            alt="Transitopia"
            className="h-7 dark:rounded-sm dark:bg-white dark:px-1"
          />
        </a>
        <h1 className="text-lg font-semibold">Admin</h1>
        <div className="flex-1" />
        {me ?
          <>
            <span className="text-sm text-gray-600 dark:text-gray-300">
              {me.login}
            </span>
            <button type="button" className={button} onClick={signOut}>
              Sign out
            </button>
          </>
        : null}
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
        {!transitApi ?
          <p className={card}>
            No server configured: set <code>VITE_TRANSIT_API</code> (e.g.
            http://localhost:8787/).
          </p>
        : me === undefined ?
          <p>Loading…</p>
        : me === null ?
          <div className={card}>
            {signInError ?
              <p className="mb-3 text-red-700 dark:text-red-400">
                {signInError}
              </p>
            : null}
            <p className="mb-3">
              Sign in with a GitHub account that's an admin on this server.
            </p>
            <a className={primary} href={`${transitApi}auth/github/login`}>
              Sign in with GitHub
            </a>
          </div>
        : <Dashboard api={api} />}
      </main>
    </div>
  );
}

type Api = ReturnType<typeof useApi>;

function Dashboard({ api }: { api: Api }) {
  const [data, setData] = React.useState<Corrections>();
  const [error, setError] = React.useState<string>();
  const reload = React.useCallback(() => {
    api<Corrections>("admin/api/corrections")
      .then((d) => {
        setData(d);
        setError(undefined);
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);
  React.useEffect(reload, [reload]);

  const open = (s: ReviewState) => s === "draft" || s === "previewing";
  return (
    <>
      <Status api={api} />
      {error ?
        <p className="text-red-700 dark:text-red-400">{error}</p>
      : null}
      {data ?
        <>
          <Section title="Disruptions to review" empty="Nothing to review.">
            {data.disruptions
              .filter((d) => open(d.state))
              .map((d) => (
                <DisruptionCard
                  key={d.id}
                  row={d}
                  api={api}
                  onChange={reload}
                />
              ))}
          </Section>
          <Section title="Observations to review" empty="Nothing to review.">
            {data.observationSets
              .filter((o) => open(o.state))
              .map((o) => (
                <ObservationCard
                  key={o.id}
                  row={o}
                  api={api}
                  onChange={reload}
                />
              ))}
          </Section>
          <NewCorrection api={api} onChange={reload} />
          {data.unparsedAlerts.length ?
            <Section title="SkyTrain alerts without a draft" empty="">
              {data.unparsedAlerts.map((a) => (
                <div key={a.id} className={card}>
                  <p className="text-sm font-medium">
                    {a.lines.join(", ")}: {a.header}
                  </p>
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    Alert {a.id}: {a.reason}. Add a disruption by hand if it
                    changes service.
                  </p>
                </div>
              ))}
            </Section>
          : null}
          <Section title="Confirmed and discarded" empty="None yet.">
            {data.disruptions
              .filter((d) => !open(d.state))
              .map((d) => (
                <DisruptionCard
                  key={d.id}
                  row={d}
                  api={api}
                  onChange={reload}
                />
              ))}
            {data.observationSets
              .filter((o) => !open(o.state))
              .map((o) => (
                <ObservationCard
                  key={o.id}
                  row={o}
                  api={api}
                  onChange={reload}
                />
              ))}
          </Section>
        </>
      : null}
    </>
  );
}

function Section(props: {
  title: string;
  empty: string;
  children: React.ReactNode[] | React.ReactNode;
}) {
  const items = React.Children.toArray(props.children);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{props.title}</h2>
      {items.length ?
        items
      : <p className="text-sm text-gray-600 dark:text-gray-400">
          {props.empty}
        </p>
      }
    </section>
  );
}

interface Health {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}
interface StatusResponse {
  rt: {
    leader: boolean;
    hasKey: boolean;
    vehicles: number;
    lastSnapshotAgeS: number | null;
    budget: {
      cap: number;
      used24h: number;
      capped: boolean;
      intervalsS: Record<string, number>;
    };
    ais: { connected: boolean; lastMessageAgeS: number | null } | null;
  };
  health: Health;
  jobs: {
    job: string;
    key: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    error: string | null;
  }[];
}

function Status({ api }: { api: Api }) {
  const [s, setS] = React.useState<StatusResponse>();
  React.useEffect(() => {
    const load = () =>
      void api<StatusResponse>("admin/api/status").then(setS, () => {});
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [api]);
  if (!s) return null;
  const b = s.rt.budget;
  return (
    <section className={`${card} flex flex-col gap-2`}>
      <h2 className="text-base font-semibold">
        Server{" "}
        <span
          className={
            s.health.ok ?
              "text-green-700 dark:text-green-400"
            : "text-red-700 dark:text-red-400"
          }>
          {s.health.ok ? "healthy" : "unhealthy"}
        </span>
      </h2>
      <ul className="text-sm">
        {Object.entries(s.health.checks).map(([k, c]) => (
          <li key={k}>
            {c.ok ? "✓" : "✗"} {k}
            {c.detail ? `: ${c.detail}` : ""}
          </li>
        ))}
        <li>
          TransLink requests in the last 24 h: {b.used24h} of {b.cap}
          {b.capped ? " (cap reached)" : ""}; positions every{" "}
          {b.intervalsS.positions} s
        </li>
        <li>
          {s.rt.leader ? "Leader" : "Follower"}, {s.rt.vehicles} drawn vehicles
          in the last poll
          {s.rt.lastSnapshotAgeS !== null ?
            `, ${Math.round(s.rt.lastSnapshotAgeS)} s ago`
          : ""}
          {s.rt.ais ?
            `; AIS ${s.rt.ais.connected ? "connected" : "disconnected"}`
          : ""}
        </li>
      </ul>
      <details>
        <summary className="cursor-pointer text-sm">Recent jobs</summary>
        <table className="mt-2 w-full text-left text-xs">
          <tbody>
            {s.jobs.map((j) => (
              <tr key={`${j.job}:${j.key}`} className="align-top">
                <td className="pr-2">{j.job}</td>
                <td className="pr-2">{j.key}</td>
                <td
                  className={`pr-2 ${j.status === "failed" ? "text-red-700 dark:text-red-400" : ""}`}>
                  {j.status}
                </td>
                <td className="pr-2">
                  {new Date(j.started_at).toLocaleString()}
                </td>
                <td className="whitespace-pre-wrap">
                  {j.error?.split("\n")[0] ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function StateBadge({ row }: { row: Row<unknown> }) {
  const colour: Record<ReviewState, string> = {
    draft: "bg-gray-200 dark:bg-gray-700",
    previewing: "bg-purple-700 text-white",
    confirmed: "bg-green-700 text-white",
    discarded: "bg-gray-400 text-white dark:bg-gray-600",
  };
  return (
    <span
      className={`rounded px-1.5 text-xs ${colour[row.state]}`}
      title={
        row.reviewed_by ?
          `${row.state} by ${row.reviewed_by}${row.reviewed_at ? ` on ${new Date(row.reviewed_at).toLocaleString()}` : ""}`
        : undefined
      }>
      {row.state}
    </span>
  );
}

/** Links to the map for each previewed date, starting at the first period (or 08:00). */
function PreviewLinks({
  previews,
  from,
}: {
  previews: Previews;
  from?: string | undefined;
}) {
  const entries = Object.entries(previews);
  if (!entries.length)
    return (
      <p className="text-sm">
        Nothing to preview: no date within a week of today, or no dispatched
        plan for it.
      </p>
    );
  const startTime =
    from ?
      new Date(from).toLocaleTimeString("en-CA", {
        hour12: false,
        timeZone: region.timezone,
      })
    : "08:00:00";
  return (
    <ul className="text-sm">
      {entries.map(([date, p]) => {
        const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
        return (
          <li key={date}>
            <a
              className="text-blue-700 underline dark:text-blue-400"
              href={`/transit?date=${iso}&t=${startTime}&paused=1&preview=${date}:${p.version}`}
              target="_blank"
              rel="noreferrer">
              Preview {iso}
            </a>{" "}
            <span className="text-gray-600 dark:text-gray-400">
              ({p.summary.inputs.join(", ")})
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Actions(props: {
  kind: "disruptions" | "observations";
  row: Row<unknown>;
  api: Api;
  onChange: () => void;
  onPreview: (p: Previews) => void;
  setError: (e: string | undefined) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const act = async (action: string) => {
    setBusy(true);
    props.setError(undefined);
    try {
      const r = await props.api<{ versions?: Previews }>(
        `admin/api/${props.kind}/${props.row.id}/${action}`,
        { method: "POST" },
      );
      if (r.versions) props.onPreview(r.versions);
      props.onChange();
    } catch (e) {
      props.setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const { state } = props.row;
  return (
    <div className="flex flex-wrap gap-2">
      {state !== "discarded" ?
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => void act("preview")}>
          {busy ? "Dispatching…" : "Preview"}
        </button>
      : null}
      {state === "draft" || state === "previewing" ?
        <>
          <button
            type="button"
            className={primary}
            disabled={busy}
            onClick={() => void act("confirm")}>
            Confirm
          </button>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => void act("discard")}>
            Discard
          </button>
        </>
      : <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => void act("reopen")}>
          Reopen
        </button>
      }
    </div>
  );
}

function periods(d: Disruption): string {
  const f = (iso: string) =>
    new Date(iso).toLocaleString("en-CA", {
      timeZone: region.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    });
  return d.active.map((p) => `${f(p.from)} → ${f(p.until)}`).join("; ");
}

function DisruptionCard({
  row,
  api,
  onChange,
}: {
  row: DisruptionRow;
  api: Api;
  onChange: () => void;
}) {
  const d = row.body;
  const [previews, setPreviews] = React.useState<Previews>();
  const [error, setError] = React.useState<string>();
  const [editing, setEditing] = React.useState(false);
  const save = async (body: Disruption) => {
    setError(undefined);
    try {
      await api(`admin/api/disruptions/${row.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setPreviews(undefined);
      onChange();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  return (
    <article className={`${card} flex flex-col gap-2`}>
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge row={row} />
        <h3 className="font-medium">{d.text}</h3>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {row.id} · {d.source}
        {row.alert_id ? ` · alert ${row.alert_id}` : ""} · {periods(d)}
      </p>
      {d.note ?
        <p className="whitespace-pre-wrap text-sm">{d.note.trim()}</p>
      : null}
      {(d.singleTrack ?? []).map((s, i) => (
        <KeepInput
          key={i}
          label={`Single track, ${s.line} ${s.between.join("–")}: open track through`}
          value={s.keep}
          onSave={(keep) =>
            save({
              ...d,
              singleTrack: d.singleTrack!.map((x, j) =>
                j === i ? { ...x, keep } : x,
              ),
            })
          }
        />
      ))}
      {(d.headway ?? []).map((h, i) => (
        <p key={i} className="text-sm">
          Every {h.minS / 60} min: {h.line}
          {h.between ? ` ${h.between.join("–")}` : ""}
        </p>
      ))}
      <Actions
        kind="disruptions"
        row={row}
        api={api}
        onChange={onChange}
        onPreview={setPreviews}
        setError={setError}
      />
      {previews ?
        <PreviewLinks previews={previews} from={d.active[0]?.from} />
      : null}
      {error ?
        <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
      : null}
      <button
        type="button"
        className="self-start text-xs underline"
        onClick={() => setEditing(!editing)}>
        {editing ? "Close editor" : "Edit JSON"}
      </button>
      {editing ?
        <JsonEditor
          value={d}
          onSave={async (v) => {
            if (await save(v as Disruption)) setEditing(false);
          }}
        />
      : null}
    </article>
  );
}

function ObservationCard({
  row,
  api,
  onChange,
}: {
  row: ObservationRow;
  api: Api;
  onChange: () => void;
}) {
  const [previews, setPreviews] = React.useState<Previews>();
  const [error, setError] = React.useState<string>();
  const [editing, setEditing] = React.useState(false);
  return (
    <article className={`${card} flex flex-col gap-2`}>
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge row={row} />
        <h3 className="font-medium">{row.title}</h3>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {row.id} · {row.body.observations.length} observations ·{" "}
        {row.dates.join(", ")}
        {row.created_by ? ` · from ${row.created_by}` : ""}
      </p>
      <Actions
        kind="observations"
        row={row}
        api={api}
        onChange={onChange}
        onPreview={setPreviews}
        setError={setError}
      />
      {previews ?
        <PreviewLinks previews={previews} />
      : null}
      {error ?
        <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
      : null}
      <button
        type="button"
        className="self-start text-xs underline"
        onClick={() => setEditing(!editing)}>
        {editing ? "Close editor" : "Edit JSON"}
      </button>
      {editing ?
        <JsonEditor
          value={row.body}
          onSave={async (v) => {
            setError(undefined);
            try {
              await api(`admin/api/observations/${row.id}`, {
                method: "PUT",
                body: JSON.stringify({ title: row.title, file: v }),
              });
              setEditing(false);
              onChange();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      : null}
    </article>
  );
}

function KeepInput(props: {
  label: string;
  value: string;
  onSave: (v: string) => Promise<boolean>;
}) {
  const [v, setV] = React.useState(props.value);
  React.useEffect(() => setV(props.value), [props.value]);
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      {props.label}
      <input
        className="min-w-64 flex-1 rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
        placeholder='a platform stop, e.g. "Lansdowne Station @ Platform 1"'
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <button
        type="button"
        className={button}
        disabled={v === props.value}
        onClick={() => void props.onSave(v)}>
        Save
      </button>
    </label>
  );
}

function JsonEditor(props: {
  value: unknown;
  onSave: (v: unknown) => Promise<void>;
}) {
  const [text, setText] = React.useState(() =>
    JSON.stringify(props.value, null, 2),
  );
  const [error, setError] = React.useState<string>();
  return (
    <div className="flex flex-col gap-2">
      <textarea
        className="h-80 w-full rounded border border-gray-300 bg-transparent p-2 font-mono text-xs dark:border-gray-600"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error ?
        <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
      : null}
      <button
        type="button"
        className={`${primary} self-start`}
        onClick={() => {
          try {
            setError(undefined);
            void props.onSave(JSON.parse(text));
          } catch (e) {
            setError((e as Error).message);
          }
        }}>
        Save
      </button>
    </div>
  );
}

const DISRUPTION_TEMPLATE: Disruption = {
  id: "2026-10-01-expo-single-track",
  source: "TransLink alert",
  text: "Expo Line single-tracking between Edmonds and Royal Oak",
  active: [
    { from: "2026-10-01T21:30:00-07:00", until: "2026-10-02T02:00:00-07:00" },
  ],
  singleTrack: [
    {
      line: "expo",
      between: ["Edmonds", "Royal Oak"],
      keep: "Edmonds Station @ Platform 2",
      pinEnds: true,
    },
  ],
};

const OBSERVATION_TEMPLATE: ObservationFile = {
  $comment: "Rider report",
  observations: [
    {
      kind: "at_platform",
      date: "2026-10-01",
      source: "rider report",
      stop: "Waterfront Station @ Platform 1",
      time: "2026-10-01T08:15:30-07:00",
      line: "expo",
    },
  ],
};

/** Write a new disruption or observation set (see the formats in regions/metro-vancouver/*\/README.md). */
function NewCorrection({ api, onChange }: { api: Api; onChange: () => void }) {
  const [kind, setKind] = React.useState<
    "disruption" | "observations" | undefined
  >();
  const [id, setId] = React.useState("");
  const [error, setError] = React.useState<string>();
  if (!kind)
    return (
      <div className="flex gap-2">
        <button
          type="button"
          className={button}
          onClick={() => setKind("disruption")}>
          New disruption
        </button>
        <button
          type="button"
          className={button}
          onClick={() => setKind("observations")}>
          New observations
        </button>
      </div>
    );
  return (
    <div className={`${card} flex flex-col gap-2`}>
      <h3 className="font-medium">
        New {kind === "disruption" ? "disruption" : "observation set"}
      </h3>
      {kind === "observations" ?
        <label className="text-sm">
          Id{" "}
          <input
            className="rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
            placeholder="2026-10-01-rider-expo"
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
        </label>
      : null}
      {error ?
        <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
      : null}
      <JsonEditor
        value={
          kind === "disruption" ? DISRUPTION_TEMPLATE : OBSERVATION_TEMPLATE
        }
        onSave={async (v) => {
          setError(undefined);
          try {
            if (kind === "disruption") {
              const d = v as Disruption;
              await api(`admin/api/disruptions/${encodeURIComponent(d.id)}`, {
                method: "PUT",
                body: JSON.stringify(d),
              });
            } else {
              await api(`admin/api/observations/${encodeURIComponent(id)}`, {
                method: "PUT",
                body: JSON.stringify({
                  title: (v as ObservationFile).$comment ?? id,
                  file: v,
                }),
              });
            }
            setKind(undefined);
            onChange();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
      <button
        type="button"
        className={`${button} self-start`}
        onClick={() => setKind(undefined)}>
        Cancel
      </button>
    </div>
  );
}
