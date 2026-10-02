import React from "react";
import type {
  TransitEngine,
  TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import type { VehicleState } from "@transitopia/transit-core/schedule/engine.ts";
import { DATASETS } from "@transitopia/shared/datasets.ts";
import { RouteSwatch } from "./Swatches.tsx";

const STATUS: Record<VehicleState["status"], string> = {
  moving: "Next stop",
  dwell: "At",
  layover: "Layover at",
  turnback: "Turning back",
  pullout: "Leaving yard",
  pullin: "To yard",
  held: "Held at a signal · next stop",
};

const PROVENANCE: Record<VehicleState["provenance"], string> = {
  observed: "Observed position",
  interpolated: "Interpolated or predicted from observations",
  estimated: "Estimated from schedule",
};

function cleanStopName(name: string | undefined): string {
  return (name ?? "")
    .replace(/\s+Station\s+@\s+/i, " · ")
    .replace(/\s+Station$/i, "");
}

function rows(v: VehicleState, now: number): [string, string][] {
  const speed =
    v.speed !== undefined && v.status === "moving" ?
      `${Math.round(v.speed * 3.6)} km/h`
    : "";
  const delay =
    v.delay !== undefined && Math.abs(v.delay) >= 30 ?
      `${Math.round(Math.abs(v.delay) / 60)} min ${v.delay > 0 ? "late" : "early"}`
    : v.delay !== undefined ? "on time"
    : "";
  const ago =
    v.observedAt !== undefined ?
      Math.max(0, Math.round((now - v.observedAt) / 1000))
    : undefined;
  const consist = v.consist;
  return (
    [
      [STATUS[v.status], cleanStopName(v.stopName)],
      v.tripId ? ["Trip", v.tripId] : undefined,
      v.runId ? ["Train (inferred)", v.runId] : undefined,
      v.label ? ["Vehicle", v.label] : undefined,
      consist?.name ? ["Name", consist.name] : undefined,
      consist && (consist.cars || consist.type || consist.carNumbers?.length) ?
        [
          "Consist",
          [
            consist.cars ? `${consist.cars}-car` : "",
            consist.type ?? "",
            consist.carNumbers?.length ?
              `(${consist.carNumbers.join(" ")})`
            : "",
          ]
            .filter(Boolean)
            .join(" "),
        ]
      : undefined,
      speed ? ["Speed", speed] : undefined,
      delay ? ["Schedule", delay] : undefined,
      ago !== undefined ?
        [
          "Last fix",
          ago < 90 ?
            `${ago} s from shown time`
          : `${Math.round(ago / 60)} min from shown time`,
        ]
      : undefined,
      v.note ? ["Note", v.note] : undefined,
    ] as ([string, string] | undefined)[]
  ).filter((r): r is [string, string] => r !== undefined);
}

/**
 * The selected vehicle (apps/web/README.md#transit-mode), following it by id each frame, and saying plainly whether
 * its position is observed or estimated.
 */
export const VehicleCard: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
}> = ({ engine, snap }) => {
  const sel = snap.selected;
  if (!sel) return null;
  const iconButton =
    "h-11 w-11 shrink-0 rounded-full text-xl leading-none hover:bg-gray-100 dark:hover:bg-gray-800";
  const close = (
    <button
      type="button"
      className={iconButton}
      aria-label="Close"
      onClick={() => engine.select(undefined)}>
      ×
    </button>
  );
  return (
    <aside
      aria-live="polite"
      aria-label="Selected vehicle"
      className="absolute inset-x-2 bottom-44 z-40 max-h-[40dvh] overflow-y-auto rounded-lg border border-gray-300 bg-white/95 p-3 pt-1 text-sm shadow-md sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-32 sm:w-80 dark:border-gray-600 dark:bg-gray-900/95 dark:text-gray-100">
      {!sel.vehicle || !sel.route ?
        <div className="flex items-center justify-between">
          <p className="text-gray-500 dark:text-gray-400">
            Vehicle not in service at this time.
          </p>
          {close}
        </div>
      : <>
          <div className="flex items-center gap-2">
            <RouteSwatch route={sel.route} />
            <strong className="flex-1">{sel.route.label}</strong>
            <button
              type="button"
              className={iconButton}
              aria-label="Centre map on this vehicle"
              title="Centre map on this vehicle"
              onClick={() => engine.locateSelected()}>
              ⌖
            </button>
            {close}
          </div>
          <div className="mb-1">
            {sel.vehicle.headsign.replace(/^.*?\bTo\s+/i, "To ")}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3">
            {rows(sel.vehicle, snap.t).map(([k, v]) => (
              <React.Fragment key={k}>
                <dt className="text-gray-500 dark:text-gray-400">{k}</dt>
                <dd>{v}</dd>
              </React.Fragment>
            ))}
          </dl>
          <p className="mt-2">
            {PROVENANCE[sel.vehicle.provenance]}{" "}
            <span className="text-gray-500 dark:text-gray-400">
              · {sel.vehicle.source}
            </span>
          </p>
          <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
            {DATASETS["translink-gtfs"].legend}
          </p>
        </>
      }
    </aside>
  );
};
