import React from "react";
import type {
  TransitEngine,
  TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import type { VehicleState } from "@transitopia/transit-core/schedule/engine.ts";
import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";
import { creditsFor, legendsFor } from "@transitopia/shared/datasets.ts";

import { clockMinutes, timeState } from "./format.ts";
import {
  CardRow,
  CardSection,
  InfoCard,
  shareLink,
  type CardAction,
  type CardChip,
  type Mark,
} from "../components/InfoCard.tsx";
import type { IconId } from "../components/Icon.tsx";

const STATUS: Record<VehicleState["status"], string> = {
  moving: "Next stop",
  dwell: "At",
  layover: "Layover at",
  turnback: "Turning back",
  pullout: "Leaving the yard",
  pullin: "To the yard",
  held: "Held at a signal · next stop",
};

const MODE: Record<
  PlanRoute["mode"],
  { eyebrow: (r: PlanRoute) => string; icon?: IconId }
> = {
  skytrain: { eyebrow: (r) => `SkyTrain · ${r.label}`, icon: "train" },
  rail: { eyebrow: (r) => `Commuter rail · ${r.label}`, icon: "train" },
  ferry: { eyebrow: (r) => `Ferry · ${r.label}`, icon: "ferry" },
  bus: { eyebrow: () => "Bus" },
};

function cleanStopName(name: string | undefined): string {
  return (name ?? "")
    .replace(/\s+Station\s+@\s+/i, " · ")
    .replace(/\s+Station$/i, "");
}

function headsign(v: VehicleState): string {
  return v.headsign.replace(/^.*?\bTo\s+/i, "To ");
}

function seconds(s: number): string {
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/**
 * Where the position comes from, in plain words, with the map's marks: green only when live, a grey
 * dot for recorded data, "~" for estimates (never an estimate presented as observed).
 */
function status(
  v: VehicleState,
  snap: TransitSnapshot,
): { tone: Mark; text: string } {
  if (v.provenance === "estimated")
    return { tone: "estimated", text: "Estimated from the schedule" };
  const tone: Mark = snap.live ? "live" : "recorded";
  const what =
    v.provenance === "observed" ? "Observed" : "Predicted from observations";
  if (v.observedAt === undefined)
    return { tone, text: snap.live ? `Live · ${what.toLowerCase()}` : what };
  const ago = Math.round((snap.t - v.observedAt) / 1000);
  const fix = v.mode === "bus" ? "GPS fix" : "fix";
  return {
    tone,
    text:
      snap.live ?
        `Live · ${fix} ${seconds(Math.max(0, ago))} ago`
      : `Recorded · ${fix} ${seconds(Math.abs(ago))} ${ago >= 0 ? "before" : "after"} the shown time`,
  };
}

function chips(v: VehicleState): CardChip[] {
  const out: CardChip[] = [];
  if (v.delay !== undefined)
    out.push(
      Math.abs(v.delay) < 60 ?
        { label: "On time", tone: "good" }
      : {
          label: `${Math.round(Math.abs(v.delay) / 60)} min ${v.delay > 0 ? "late" : "early"}`,
          tone: v.delay > 0 ? "warn" : "info",
        },
    );
  if (v.speed !== undefined && v.status === "moving")
    out.push({ label: `${Math.round(v.speed * 3.6)} km/h` });
  return out;
}

function consist(c: NonNullable<VehicleState["consist"]>): string | undefined {
  const text = [
    c.cars ? `${c.cars}-car` : "",
    c.type ?? "",
    c.carNumbers?.length ? `(${c.carNumbers.join(" ")})` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return text || undefined;
}

/**
 * The selected vehicle (apps/web/README.md#feature-cards), following it by id each frame, and saying
 * plainly whether its position is observed or estimated.
 */
export const VehicleCard: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
}> = ({ engine, snap }) => {
  const sel = snap.selected;
  if (!sel) return null;
  const close = () => engine.select(undefined);
  const back =
    snap.back ? { label: snap.back, onBack: () => engine.back() } : undefined;
  const v = sel.vehicle;
  const route = sel.route;
  if (!v || !route)
    return (
      <InfoCard
        tile={{
          icon: "train",
          bg: "var(--card-chip-bg)",
          fg: "var(--card-muted)",
        }}
        eyebrow="Vehicle"
        title="Not in service at this time"
        subtitle="It may be in service at another time of day."
        back={back}
        onClose={close}
      />
    );

  const mode = MODE[route.mode];
  const others = snap.routes.filter((r) => r.key !== route.key);
  const onlyThis = others.every((r) => snap.hidden.has(r.key));
  const actions: CardAction[] = [
    snap.following ?
      {
        id: "follow",
        label: "Stop following",
        icon: "navigation",
        onSelect: () => engine.setFollowing(false),
      }
    : {
        id: "follow",
        label: "Follow on map",
        icon: "navigation",
        onSelect: () => engine.setFollowing(true),
      },
    {
      id: "centre",
      label: "Centre on map",
      icon: "crosshair",
      onSelect: () => engine.locateSelected(),
    },
    {
      id: "share",
      label: "Share link",
      icon: "share",
      // The URL already names the selected vehicle and the shown time.
      onSelect: () => shareLink(location.href, `${route.label} · Transitopia`),
    },
    onlyThis ?
      {
        id: "only",
        label: "Show all routes",
        icon: "filter",
        onSelect: () =>
          engine.setRoutesHidden(
            others.map((r) => r.key),
            false,
          ),
      }
    : {
        id: "only",
        label: `Show only ${route.label}`,
        icon: "filter",
        onSelect: () => {
          engine.setRoutesHidden([route.key], false);
          engine.setRoutesHidden(
            others.map((r) => r.key),
            true,
          );
        },
      },
  ];
  const details: [string, string | undefined][] = [
    // "08:05 from Langford Exchange · 11898518": as a rider names it, with the agency's short id.
    [
      "Trip",
      sel.trip ?
        `${clockMinutes(sel.trip.start)} from ${sel.trip.from} · ${sel.trip.shortId}`
      : v.tripId || undefined,
    ],
    ["Train (inferred run)", v.runId],
    ["Vehicle", v.label],
    ["Name", v.consist?.name],
    ["Consist", v.consist && consist(v.consist)],
  ];
  return (
    <InfoCard
      tile={
        mode.icon ?
          { icon: mode.icon, bg: route.color, fg: route.textColor }
        : { text: route.key, bg: route.color, fg: route.textColor }
      }
      eyebrow={mode.eyebrow(route)}
      title={route.mode === "bus" ? route.label : headsign(v)}
      subtitle={
        route.mode === "bus" ?
          [headsign(v), v.label ? `vehicle ${v.label}` : ""]
            .filter(Boolean)
            .join(" · ")
        : v.runId ?
          `Train ${v.runId} (inferred run)`
        : v.consist?.name
      }
      status={status(v, snap)}
      chips={chips(v)}
      actions={actions}
      notLive={
        snap.live ? undefined : (
          { ...timeState(snap), onGoLive: () => engine.goLive() }
        )
      }
      back={back}
      onClose={close}
      footer={
        <>
          {v.mode === "skytrain" && v.provenance === "estimated" ?
            <p className="mb-1">
              There are no live SkyTrain positions, so trains are placed from
              the timetable and our run inference.
            </p>
          : null}
          <p>Source: {v.source}</p>
          {legendsFor(creditsFor(sel.datasets)).map((l) => (
            <p key={l} className="mt-1">
              {l}
            </p>
          ))}
        </>
      }>
      <CardSection title="Now">
        <CardRow
          label={STATUS[v.status]}
          {...(v.stopName ? { value: cleanStopName(v.stopName) } : {})}
        />
        {v.note ?
          <CardRow label="Note" note={v.note} />
        : null}
      </CardSection>
      <CardSection title="Details">
        {details.map(([label, value]) =>
          value ? <CardRow key={label} label={label} value={value} /> : null,
        )}
      </CardSection>
    </InfoCard>
  );
};
