// /admin → Features (apps/web/README.md#admin, docs/DESIGN.md#feature-ids): find a station, exchange,
// stop or route by name, ID or ref; see its refs, the stops inside it and its history; fix what
// reconciliation grouped wrongly (move or detach stops, make an exchange of some, retire one that
// isn't), merge duplicates, and resolve reconciliation's flags. Every change is recorded and the
// places files are republished within minutes.

import React from "react";
import type {
  FeatureFlagsResponse,
  FeatureSummary,
} from "@transitopia/shared/admin-api.ts";
import {
  useFeature,
  useFeatureFlags,
  useFeatureSearch,
  useFeatureWrite,
} from "./api.ts";
import { button, card, errorText, primary } from "./styles.ts";

const input =
  "rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800";

/** The map at a feature, with it selected. */
function mapLink(f: Pick<FeatureSummary, "id" | "lon" | "lat">): string {
  const at =
    f.lon !== null && f.lat !== null ?
      `#map=17/${f.lat.toFixed(5)}/${f.lon.toFixed(5)}`
    : "";
  return `/transit?select=${encodeURIComponent(f.id)}${at}`;
}

export function Features() {
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState<string>();
  const search = useFeatureSearch(q);
  return (
    <section className={`${card} flex flex-col gap-3`}>
      <h2 className="text-base font-semibold">Features</h2>
      <input
        className={input}
        placeholder="Name, ID (sn-…) or ref (stop:translink:50123)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {search.error ?
        <p className={errorText}>{search.error.message}</p>
      : null}
      {search.data?.results.length ?
        <ul className="max-h-60 overflow-auto text-sm">
          {search.data.results.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className="text-left hover:underline"
                onClick={() => setOpen(f.id)}>
                <FeatureLabel f={f} />
              </button>
            </li>
          ))}
        </ul>
      : null}
      {open ?
        <FeatureDetail id={open} onOpen={setOpen} />
      : null}
      <Flags onOpen={setOpen} />
    </section>
  );
}

const FeatureLabel: React.FC<{ f: FeatureSummary }> = ({ f }) => (
  <>
    <span className="font-medium">{f.name}</span>{" "}
    <span className="text-gray-600 dark:text-gray-400">
      {f.kind} · {f.id}
      {f.feedId ? ` · ${f.feedId}` : ""}
      {f.status === "active" ? "" : ` · ${f.status}`}
    </span>
  </>
);

function FeatureDetail(props: { id: string; onOpen: (id: string) => void }) {
  const { data, error } = useFeature(props.id);
  const write = useFeatureWrite();
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [moveTo, setMoveTo] = React.useState("");
  const [mergeInto, setMergeInto] = React.useState("");
  const [exchangeName, setExchangeName] = React.useState("");
  React.useEffect(() => setPicked(new Set()), [props.id]);
  if (error) return <p className={errorText}>{error.message}</p>;
  if (!data) return <p className="text-sm">Loading…</p>;
  const f = data.feature;
  const isPlace = f.kind === "station" || f.kind === "exchange";
  const post = (path: string, body?: unknown) =>
    write.mutate({ path: `admin/api/${path}`, body });
  const pickedStops = [...picked];
  return (
    <div className="flex flex-col gap-2 border-t border-gray-200 pt-3 text-sm dark:border-gray-700">
      <h3 className="text-base font-semibold">
        <FeatureLabel f={f} />
      </h3>
      <p>
        <a className="underline" href={mapLink(f)}>
          On the map
        </a>
        {f.mergedInto ?
          <>
            {" · merged into "}
            <button
              type="button"
              className="underline"
              onClick={() => props.onOpen(f.mergedInto!)}>
              {f.mergedInto}
            </button>
          </>
        : null}
      </p>
      {write.error ?
        <p className={errorText}>{write.error.message}</p>
      : null}

      {f.kind === "stop" ?
        <div className="flex flex-wrap items-center gap-2">
          <span>
            In:{" "}
            {data.parent ?
              <button
                type="button"
                className="underline"
                onClick={() => props.onOpen(data.parent!.id)}>
                {data.parent.name} ({data.parent.kind})
              </button>
            : "no station or exchange"}
          </span>
          {data.parent ?
            <button
              type="button"
              className={button}
              disabled={write.isPending}
              onClick={() => post(`features/${f.id}/parent`, { parent: null })}>
              Detach
            </button>
          : null}
          <input
            className={input}
            placeholder="Station or exchange ID"
            value={moveTo}
            onChange={(e) => setMoveTo(e.target.value)}
          />
          <button
            type="button"
            className={button}
            disabled={write.isPending || !moveTo.trim()}
            onClick={() =>
              post(`features/${f.id}/parent`, { parent: moveTo.trim() })
            }>
            Move
          </button>
        </div>
      : null}

      {isPlace ?
        <div className="flex flex-col gap-1">
          <p className="font-medium">Stops ({data.children.length})</p>
          <ul>
            {data.children.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={picked.has(c.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(c.id);
                    else next.delete(c.id);
                    setPicked(next);
                  }}
                />
                <button
                  type="button"
                  className="text-left hover:underline"
                  onClick={() => props.onOpen(c.id)}>
                  <FeatureLabel f={c} />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={button}
              disabled={write.isPending || !pickedStops.length}
              onClick={() => {
                for (const s of pickedStops)
                  post(`features/${s}/parent`, { parent: null });
              }}>
              Detach selected
            </button>
            <input
              className={input}
              placeholder="New exchange's name"
              value={exchangeName}
              onChange={(e) => setExchangeName(e.target.value)}
            />
            <button
              type="button"
              className={button}
              disabled={
                write.isPending || !pickedStops.length || !exchangeName.trim()
              }
              onClick={() =>
                post("features/exchange", {
                  name: exchangeName.trim(),
                  stops: pickedStops,
                })
              }>
              Make an exchange of them
            </button>
          </div>
        </div>
      : null}

      {f.status === "active" ?
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={input}
            placeholder={`Another ${f.kind}'s ID`}
            value={mergeInto}
            onChange={(e) => setMergeInto(e.target.value)}
          />
          <button
            type="button"
            className={button}
            disabled={write.isPending || !mergeInto.trim()}
            onClick={() =>
              post(`features/${f.id}/merge`, { into: mergeInto.trim() })
            }>
            Merge into it
          </button>
          <button
            type="button"
            className={button}
            disabled={write.isPending || (isPlace && data.children.length > 0)}
            title={
              isPlace && data.children.length ?
                "Detach or move its stops first"
              : undefined
            }
            onClick={() => post(`features/${f.id}/retire`)}>
            Retire
          </button>
        </div>
      : null}

      <details>
        <summary className="cursor-pointer">Refs ({data.refs.length})</summary>
        <ul className="font-mono text-xs">
          {data.refs.map((r, i) => (
            <li key={i}>
              {r.ref}
              {r.versions.length ? `  ${r.versions.join(" … ")}` : ""}
            </li>
          ))}
        </ul>
      </details>
      {data.flags.length ?
        <details open>
          <summary className="cursor-pointer">
            Flags ({data.flags.length})
          </summary>
          <ul className="text-xs">
            {data.flags.map((g) => (
              <li key={g.id}>
                {g.reason} ({g.state}
                {g.resolution ? `: ${g.resolution}` : ""}){" "}
                {g.candidates.join(", ")}
              </li>
            ))}
          </ul>
        </details>
      : null}
      {data.changes.length ?
        <details>
          <summary className="cursor-pointer">
            Changes ({data.changes.length})
          </summary>
          <ul className="text-xs">
            {data.changes.map((c, i) => (
              <li key={i}>
                {c.at.toLocaleString()} {c.by ?? "command line"}: {c.action}{" "}
                {JSON.stringify(c.before)} → {JSON.stringify(c.after)}
              </li>
            ))}
          </ul>
        </details>
      : null}
    </div>
  );
}

type FlagRow = FeatureFlagsResponse["flags"][number];

/** What each flag means, for the admin deciding it. */
const REASONS: Record<string, string> = {
  "code-moved-far": "Its stop_id or stop code is the same, but it moved far",
  "disappeared-nearby": "New, beside a stop that disappeared: the same stop?",
  "cross-feed-name-match": "Another feed has a station of this name nearby",
  "exchange-replaced": "New exchange beside one that lost all its stops",
  "grouping-differs": "The heuristics would group it elsewhere",
  "retired-returned":
    "Retired, but back in the feed: made active again (retire it again if that's wrong)",
};

function Flags(props: { onOpen: (id: string) => void }) {
  const { data, error } = useFeatureFlags();
  const write = useFeatureWrite();
  if (error) return <p className={errorText}>{error.message}</p>;
  if (!data?.flags.length) return null;
  const resolve = (g: FlagRow, resolution: string) =>
    write.mutate({
      path: `admin/api/feature-flags/${g.id}/resolve`,
      body: { resolution },
    });
  return (
    <details>
      <summary className="cursor-pointer text-sm font-medium">
        Reconciliation flags ({data.flags.length})
      </summary>
      {write.error ?
        <p className={errorText}>{write.error.message}</p>
      : null}
      <ul className="mt-2 flex flex-col gap-2 text-sm">
        {data.flags.map((g) => (
          <li key={g.id} className="flex flex-col gap-1">
            <span>
              <button
                type="button"
                className="font-medium hover:underline"
                onClick={() => props.onOpen(g.featureId)}>
                {g.name}
              </button>{" "}
              ({g.kind}): {REASONS[g.reason] ?? g.reason}
              {g.candidates.length ?
                <>
                  {"; "}
                  {g.candidates.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="mr-1 underline"
                      onClick={() => props.onOpen(c)}>
                      {c}
                    </button>
                  ))}
                </>
              : null}
            </span>
            <span className="flex flex-wrap gap-2">
              <button
                type="button"
                className={button}
                disabled={write.isPending}
                onClick={() => resolve(g, "kept")}>
                Keep
              </button>
              {g.reason === "grouping-differs" ?
                // The candidate is the station or exchange the heuristics propose for this stop:
                // move it there (or out of any, when they propose none), not a merge.
                (g.candidates.length ? g.candidates : [null]).map((c) => (
                  <button
                    key={c ?? "none"}
                    type="button"
                    className={primary}
                    disabled={write.isPending}
                    onClick={() =>
                      write.mutate(
                        {
                          path: `admin/api/features/${g.featureId}/parent`,
                          body: { parent: c },
                        },
                        { onSuccess: () => resolve(g, `moved:${c ?? "none"}`) },
                      )
                    }>
                    {c ? `Move to ${c}` : "Detach from its station or exchange"}
                  </button>
                ))
              : g.candidates.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={primary}
                    disabled={write.isPending}
                    onClick={() =>
                      write.mutate(
                        {
                          path: `admin/api/features/${g.featureId}/merge`,
                          body: { into: c },
                        },
                        { onSuccess: () => resolve(g, `merged:${c}`) },
                      )
                    }>
                    Merge into {c}
                  </button>
                ))
              }
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
