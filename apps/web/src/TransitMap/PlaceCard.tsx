import React from "react";
import type {
  Departure,
  PlaceGroup,
  PlaceSnapshot,
  TransitEngine,
  TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";
import { DATASETS } from "@transitopia/shared/datasets.ts";

import {
  CardSection,
  InfoCard,
  TimeMark,
  shareLink,
  type CardAction,
  type Mark,
} from "../components/InfoCard.tsx";
import { clockMinutes, timeState } from "./format.ts";
import { bandOf, everyText } from "./frequency.ts";

/** "Eastbound E Hastings St @ Main St" → ["Eastbound", "E Hastings St @ Main St"]. */
function splitDirection(name: string): [string | undefined, string] {
  const m = /^(North|South|East|West)bound\s+(.*)$/i.exec(name);
  return m ? [`${m[1]}bound`, m[2]!] : [undefined, name];
}

const stationName = (name: string) => name.replace(/\s+Station$/i, "");

/** "To King George" from GTFS headsigns like "Expo Line To King George". */
const headsign = (h: string) => h.replace(/^.*?\bTo\s+/i, "To ");

/** A route's badge: buses by number, rail and ferries by initial (E, M, C, S, W). */
function badge(r: PlanRoute): string {
  return r.mode === "bus" ? r.key : r.label[0]!.toUpperCase();
}

/** Live green only while live; otherwise recorded (from real-time data) or estimated (timetable). */
function markOf(d: Departure, live: boolean): Mark {
  if (d.source === "schedule") return "estimated";
  return live ? "live" : "recorded";
}

/** Live: "Now", "3 min" (first) or "9m" (later); otherwise clock times, no countdowns. */
function timeText(d: Departure, now: number, live: boolean, first: boolean) {
  if (!live) return clockMinutes(d.t);
  const m = Math.max(0, Math.round((d.t - now) / 60_000));
  if (m === 0) return "Now";
  return first ? `${m} min` : `${m}m`;
}

/** "Either branch" (two groups of one route), "Any of these" (more), or "R5 or 14". */
function sharedLabel(routes: PlanRoute[], groups: number): string {
  if (routes.length > 1) return routes.map(badge).join(" or ");
  return groups === 2 ? "Either branch" : "Any of these";
}

const RouteBadge: React.FC<{ route: PlanRoute; ring?: boolean }> = ({
  route,
  ring,
}) => (
  <span
    className={`flex h-[22px] min-w-8 items-center justify-center rounded-[5px] px-[5px] text-xs font-extrabold ${ring ? "-ml-1.5 shadow-[0_0_0_2px_var(--card-combined-bg)] first:ml-0" : ""}`}
    style={{ background: route.color, color: route.textColor }}>
    {badge(route)}
  </span>
);

const Frequency: React.FC<{ minutes: number; approx?: boolean }> = ({
  minutes,
  approx,
}) => {
  const band = bandOf(minutes);
  return (
    <span className="mt-0.5 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-(--card-muted)">
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 flex-none rounded-[3px]"
        style={{ background: band.color }}
      />
      {everyText(minutes, approx)} ·{" "}
      <strong className="text-(--card-text)">{band.name}</strong>
    </span>
  );
};

const GroupRow: React.FC<{
  group: PlaceGroup;
  now: number;
  live: boolean;
}> = ({ group, now, live }) => {
  const [first, ...rest] = group.departures;
  const cancelled = group.departures.filter((d) => d.cancelled);
  const note = [
    group.platforms.length ?
      `Platform${group.platforms.length > 1 ? "s" : ""} ${group.platforms.join(", ")}`
    : "",
    cancelled.length ?
      `${cancelled.map((d) => clockMinutes(d.sched)).join(", ")} cancelled`
    : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const time = (d: Departure, isFirst: boolean) => (
    <span
      key={d.tripId}
      className={`flex items-center gap-[3px] ${d.cancelled ? "text-(--card-faint) line-through" : ""}`}>
      {d.cancelled ? null : (
        <TimeMark mark={markOf(d, live)} size={isFirst ? "md" : "sm"} />
      )}
      {timeText(d, now, live, isFirst)}
    </span>
  );
  return (
    <div className="flex min-h-10 items-center gap-2.5 py-2">
      <RouteBadge route={group.route} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[14.5px] leading-snug">
          {headsign(group.headsign)}
        </span>
        {note ?
          <span className="text-[12.5px] leading-snug text-(--card-muted)">
            {note}
          </span>
        : null}
        {group.minutes !== undefined ?
          <Frequency minutes={group.minutes} />
        : null}
      </div>
      {first ?
        <span className="flex flex-col items-end gap-px whitespace-nowrap tabular-nums">
          <span className="text-[15px] font-extrabold">
            {time(first, true)}
          </span>
          {rest.length ?
            <span className="flex items-center gap-2 text-[12.5px] font-semibold text-(--card-muted)">
              {rest.map((d) => time(d, false))}
            </span>
          : null}
        </span>
      : null}
    </div>
  );
};

/**
 * A station or bus stop (apps/web/README.md#station-and-stop-cards): what leaves after the map's
 * time, one row per route and destination ordered by the soonest, with how often each runs in the
 * next hour, and a combined row for routes that share a stretch from here.
 */
export const PlaceCard: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
}> = ({ engine, snap }) => {
  const place = snap.place;
  if (!place || place.kind === "route") return null;
  return <PlaceCardBody engine={engine} snap={snap} place={place} />;
};

const PlaceCardBody: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
  place: PlaceSnapshot;
}> = ({ engine, snap, place }) => {
  const state = timeState(snap);
  const station = place.kind === "station";
  const rail = place.routes.some((r) => r.mode !== "bus");
  const [direction, stopName] = splitDirection(place.name);
  const title = station ? stationName(place.name) : stopName;
  const mainRoute = place.routes[0];
  const realtime = place.groups.some((g) =>
    g.departures.some((d) => d.source !== "schedule"),
  );
  const noun = station && rail ? "trains" : "departures";
  const actions: CardAction[] = [
    {
      id: "centre",
      label: "Centre on map",
      icon: "centre",
      onSelect: () => engine.locateSelected(),
    },
    {
      id: "share",
      label: "Share link",
      icon: "share",
      onSelect: () => shareLink(location.href, `${title} · Transitopia`),
    },
  ];
  const eyebrow =
    !station ? `Bus stop${direction ? ` · ${direction}` : ""}`
    : place.routes.every((r) => r.mode === "skytrain") ? "SkyTrain station"
    : place.routes.every((r) => r.mode === "ferry") ? "Ferry terminal"
    : "Station";
  return (
    <InfoCard
      tile={
        station ?
          {
            icon: "station",
            bg: mainRoute?.color ?? "#4b5563",
            fg: mainRoute?.textColor ?? "#fff",
          }
        : { icon: "stop", bg: "#4b5563", fg: "#fff" }
      }
      eyebrow={eyebrow}
      title={title}
      subtitle={
        station ? place.routes.map((r) => r.label).join(" · ") : undefined
      }
      status={
        state.future ?
          { tone: "estimated", text: "Projected from the timetable" }
        : realtime && snap.live ?
          { tone: "live", text: "Live where buses report GPS" }
        : { tone: "estimated", text: "Times estimated from the schedule" }
      }
      chips={place.routes.map((r) => ({
        label: r.mode === "bus" ? r.key : r.label,
        color: { bg: r.color, fg: r.textColor },
      }))}
      actions={actions}
      notLive={
        snap.live ? undefined : { ...state, onGoLive: () => engine.goLive() }
      }
      onClose={() => engine.select(undefined)}
      footer={
        <>
          <p>
            {rail ?
              "From the TransLink timetable. Trains on the map follow our inferred runs, which can differ by a minute or two."
            : "Live where the bus reports GPS; otherwise from the timetable."}
          </p>
          <p className="mt-1">{DATASETS["translink-gtfs"].legend}</p>
        </>
      }>
      <CardSection
        title={
          snap.live ?
            `Next ${noun}`
          : `${noun[0]!.toUpperCase()}${noun.slice(1)} after ${clockMinutes(snap.t)}`
        }>
        {place.shared.map((s) => (
          <div
            key={s.routes.map((r) => r.key).join() + s.to}
            className="my-1 flex items-center gap-2.5 rounded-[10px] border-0! bg-(--card-combined-bg) px-3 py-2.5">
            <span className="flex">
              {s.routes.map((r) => (
                <RouteBadge key={r.key} route={r} ring />
              ))}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm leading-snug font-bold">
                {sharedLabel(s.routes, s.groups)}, to {s.to}
              </span>
              {s.minutes !== undefined ?
                <Frequency minutes={s.minutes} approx />
              : null}
            </div>
          </div>
        ))}
        {place.groups.length ?
          place.groups.map((g) => (
            <GroupRow
              key={`${g.route.key}|${g.headsign}`}
              group={g}
              now={snap.t}
              live={snap.live}
            />
          ))
        : <p className="py-2 text-sm text-(--card-muted)">
            Nothing leaves here in the next two hours.
          </p>
        }
      </CardSection>
    </InfoCard>
  );
};
