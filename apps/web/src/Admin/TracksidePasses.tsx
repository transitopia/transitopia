// /admin: the latest passes uploaded by trackside cameras (packages/trackside/README.md#reports), with the
// crops of the numbers read, to check how well the reader does. Shadow mode: nothing here changes
// the map yet.

import React from "react";
import { trainsets } from "@transitopia/trackside/cars.ts";
import type { PassReport } from "@transitopia/trackside/types.ts";
import { transitApi } from "../config.ts";
import type { useApi } from "./api.ts";

interface Crop {
  idx: number;
  reading: string;
  confidence: number;
  accepted: boolean;
  label: string | null;
}

interface StoredPass {
  id: string;
  report: PassReport;
  createdBy: string | null;
  receivedAt: string;
  crops: Crop[];
}

const card =
  "rounded-lg border border-gray-300 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900";

export function TracksidePasses({
  api,
  token,
}: {
  api: ReturnType<typeof useApi>;
  token: string | undefined;
}) {
  const [passes, setPasses] = React.useState<StoredPass[]>();
  const [error, setError] = React.useState<string>();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    api<{ passes: StoredPass[] }>("admin/api/trackside/passes?limit=50")
      .then((r) => setPasses(r.passes))
      .catch((e: Error) => setError(e.message));
  }, [api, open]);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">
        <button type="button" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} Trackside camera passes
        </button>
      </h2>
      {open && (
        <>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Trains seen by phones running{" "}
            <a className="underline" href="/trackside">
              /trackside
            </a>
            . Stored only, for now: they don't change the map.
          </p>
          {error && <p className="text-red-700 dark:text-red-400">{error}</p>}
          {passes && !passes.length && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              None yet.
            </p>
          )}
          {passes?.map((p) => (
            <PassCard key={p.id} pass={p} token={token} />
          ))}
        </>
      )}
    </section>
  );
}

function PassCard({
  pass,
  token,
}: {
  pass: StoredPass;
  token: string | undefined;
}) {
  const r = pass.report;
  const s = r.setup;
  return (
    <div className={card}>
      <div className="flex flex-wrap gap-x-3">
        <span className="font-mono">{new Date(r.start).toLocaleString()}</span>
        <span>
          {s.lines.join(", ")} {trackLabel(r)},{" "}
          {r.screen === "right" ? "→" : "←"} {Math.round(r.bearing)}°
          {r.toward && ` toward ${r.toward}`}
        </span>
        <span>
          {r.speedKmh !== null ? `~${r.speedKmh} km/h` : `${r.pxPerS} px/s`}
        </span>
        {r.occluded && <span>partly hidden</span>}
        <span className="text-gray-500">by {pass.createdBy ?? "?"}</span>
      </div>
      <div className="mt-1">
        Cars:{" "}
        <span className="font-mono">
          {trainsets(r.cars.map((c) => c.number)).join("  ") || "none read"}
        </span>
      </div>
      {pass.crops.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {pass.crops.map((c) => (
            <figure key={c.idx} className="text-center text-xs">
              <CropImage passId={pass.id} idx={c.idx} token={token} />
              <figcaption className={c.accepted ? "" : "text-gray-500"}>
                {c.reading} ({Math.round(c.confidence * 100)} %)
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

/** Crops need the bearer token, so they're fetched rather than linked. */
function CropImage({
  passId,
  idx,
  token,
}: {
  passId: string;
  idx: number;
  token: string | undefined;
}) {
  const [url, setUrl] = React.useState<string>();
  React.useEffect(() => {
    let objectUrl: string | undefined;
    void fetch(`${transitApi}admin/api/trackside/crops/${passId}/${idx}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => (res.ok ? res.blob() : undefined))
      .then((blob) => {
        if (!blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      });
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [passId, idx, token]);
  return url ?
      <img
        src={url}
        alt=""
        className="h-10 rounded border border-gray-300 dark:border-gray-700"
      />
    : <div className="h-10 w-16 rounded bg-gray-200 dark:bg-gray-800" />;
}

/** "track 2 of 3 (siding)"; passes stored before 1–3 track support say "near" or "far". */
function trackLabel(r: PassReport): string {
  const t = r.track as number | string | undefined;
  if (typeof t === "string") return `${t} track`;
  const tracks = r.setup.tracks ?? [];
  if (t === undefined) return `track ? of ${tracks.length}`;
  const kind = tracks[t]?.kind;
  return `track ${t + 1} of ${tracks.length}${kind && kind !== "main" ? ` (${kind})` : ""}`;
}
