import React from "react";
import type {
  Departure,
  Frequency as FrequencyFigures,
  PlaceGroup,
  PlaceSnapshot,
  TransitEngine,
  TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import type { Place } from "@transitopia/transit-map/url.ts";
import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";
import { bayLabel } from "@transitopia/transit-core/plan/exchanges.ts";
import { creditsFor, legendsFor } from "@transitopia/shared/datasets.ts";

import {
  CardSection,
  InfoCard,
  TimeMark,
  shareLink,
  type CardAction,
  type Mark,
} from "../components/InfoCard.tsx";
import { Menu, type MenuItem } from "../components/Menu.tsx";
import type { IconId } from "../components/Icon.tsx";
import { clockMinutes, timeState } from "./format.ts";
import {
  badge,
  RouteBadge,
  RouteBadgeStack,
  routeColorsFor,
  type RouteColors,
} from "./RouteBadge.tsx";
import { bandOf, waitText } from "./frequency.ts";

/** "Eastbound E Hastings St @ Main St" → ["Eastbound", "E Hastings St @ Main St"]. */
function splitDirection(name: string): [string | undefined, string] {
  const m = /^(North|South|East|West)bound\s+(.*)$/i.exec(name);
  return m ? [`${m[1]}bound`, m[2]!] : [undefined, name];
}

const stationName = (name: string) => name.replace(/\s+Station$/i, "");

/** "To King George" from GTFS headsigns like "Expo Line To King George". */
const headsign = (h: string) => h.replace(/^.*?\bTo\s+/i, "To ");

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

/** "Any Canada Line to Bridgeport" (one route), or "R5 or 14, to Renfrew St". */
function sharedLabel(routes: PlanRoute[], to: string): string {
  return routes.length === 1 ?
      `Any ${routes[0]!.label} to ${to}`
    : `${routes.map(badge).join(" or ")}, to ${to}`;
}

/** "Platform 2", "Platforms 1, 2" (or "Bay 5" for buses), or "" where unknown. */
function platformsText(platforms: readonly string[], bus: boolean): string {
  const noun = bus ? "Bay" : "Platform";
  return platforms.length ?
      `${noun}${platforms.length > 1 ? "s" : ""} ${platforms.join(", ")}`
    : "";
}

/** "Wait up to 15m · OK": the worst wait in the next hour, and its band. */
const Frequency: React.FC<{
  frequency: FrequencyFigures;
  /** Bold, in the text colour, within a sentence (a bracket's footnote), rather than muted. */
  strong?: boolean;
}> = ({ frequency: f, strong }) => {
  const band = bandOf(f.wait);
  return (
    <span
      className={`inline-flex flex-wrap items-center gap-x-1.5 text-[12.5px] ${strong ? "font-bold" : "mt-0.5 font-semibold text-(--card-muted)"}`}>
      {waitText(f.wait, strong)} ·
      <span className="inline-flex items-center gap-1">
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 flex-none rounded-[3px]"
          style={{ background: band.color }}
        />
        <strong className="text-(--card-text)">{band.name}</strong>
      </span>
    </span>
  );
};

/** A departure row's look; as a menu trigger it fills the section's width and highlights while open. */
const rowClass = (open: boolean) =>
  `-mx-2 flex min-h-10 w-[calc(100%+1rem)] items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-(--card-hover) ${open ? "bg-(--card-combined-bg)" : ""}`;

/**
 * A departure row opens a menu of what it names (apps/web/README.md#cross-references): its route,
 * its bus bay, and the vehicle on its next trip when that's on the map. Always a menu, even with only
 * the route in it, so a row behaves the same whether or not its vehicle is out yet.
 */
const GroupRow: React.FC<{
  group: PlaceGroup;
  now: number;
  live: boolean;
  items: MenuItem[];
  colors: (r: PlanRoute) => RouteColors;
}> = ({ group, now, live, items, colors }) => {
  const [first, ...rest] = group.departures;
  const cancelled = group.departures.filter((d) => d.cancelled);
  const note = [
    platformsText(group.platforms, group.route.mode === "bus"),
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
  const content = (
    <>
      <RouteBadge route={group.route} colors={colors(group.route)} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[14.5px] leading-snug">
          {headsign(group.headsign)}
        </span>
        {note ?
          <span className="text-[12.5px] leading-snug text-(--card-muted)">
            {note}
          </span>
        : null}
        {group.frequency ?
          <Frequency frequency={group.frequency} />
        : null}
      </span>
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
    </>
  );
  return (
    <Menu
      label={`${group.route.label} ${headsign(group.headsign).toLowerCase()}`}
      iconTrigger={false}
      trigger={content}
      items={items}
      triggerClassName={rowClass}
    />
  );
};

/**
 * A station, bus exchange or bus stop (apps/web/README.md#station-and-stop-cards): what leaves after
 * the map's time, one row per route and destination ordered by platform or bay, then the soonest, with how often each runs
 * in the next hour, and a combined row for routes that share a stretch from here. A station lists its
 * trains, then its sailings, then the buses from its bays.
 */
export const PlaceCard: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
}> = ({ engine, snap }) => {
  const place = snap.place;
  if (!place || place.kind === "route") return null;
  return <PlaceCardBody engine={engine} snap={snap} place={place} />;
};

type Shared = PlaceSnapshot["shared"][number];

/** A station card's sections: trains (SkyTrain and West Coast Express), sailings, buses. */
type DepartureKind = "train" | "ferry" | "bus";
const kindOf = (r: PlanRoute): DepartureKind =>
  r.mode === "bus" || r.mode === "ferry" ? r.mode : "train";
const VEHICLE: Record<DepartureKind, { noun: string; icon: IconId }> = {
  train: { noun: "train", icon: "train" },
  ferry: { noun: "ferry", icon: "ferry" },
  bus: { noun: "bus", icon: "bus-front-fill" },
};
const NOUNS: Record<DepartureKind, string> = {
  train: "trains",
  ferry: "sailings",
  bus: "buses",
};

const SharedRow: React.FC<{
  shared: Shared;
  colors: (r: PlanRoute) => RouteColors;
}> = ({ shared: s, colors }) => (
  <div className="my-1 flex items-center gap-2.5 rounded-[10px] border-0! bg-(--card-combined-bg) px-3 py-2.5">
    <RouteBadgeStack routes={s.routes} colors={colors} />
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-sm leading-snug font-bold">
        {sharedLabel(s.routes, s.to)}
      </span>
      {s.platforms.length ?
        <span className="text-[12.5px] leading-snug text-(--card-muted)">
          {platformsText(s.platforms, s.routes[0]?.mode === "bus")}
        </span>
      : null}
      {s.frequency ?
        <Frequency frequency={s.frequency} />
      : null}
    </div>
  </div>
);

const groupKey = (g: PlaceGroup) => `${g.route.key}|${g.headsign}`;
const sharedKey = (s: Shared) => s.routes.map((r) => r.key).join() + s.to;

/**
 * The rows of a shared stretch whose trips all leave from one platform or bay, tied by a rail on
 * the left, with what they add up to under them ("Either one, to Columbia · every ~6m · Good").
 */
const SharedBracket: React.FC<{
  shared: Shared;
  children: React.ReactNode;
  count: number;
}> = ({ shared: s, children, count }) => (
  <div className="flex gap-2">
    <span
      aria-hidden="true"
      className="mt-2.5 mb-2 w-[3px] flex-none rounded-sm bg-(--card-bracket)"
    />
    <div className="min-w-0 flex-1">
      <div className="divide-y divide-(--card-divider)">{children}</div>
      <p className="flex flex-wrap items-center gap-x-1.5 pb-2 text-[12.5px] leading-snug font-bold">
        {count === 2 ? "Either one" : "Any of these"}, to {s.to}
        {s.frequency ?
          <>
            {" ·"}
            <Frequency frequency={s.frequency} strong />
          </>
        : null}
      </p>
    </div>
  </div>
);

/**
 * One kind of departure (trains, sailings or buses), a row per group in platform order. A shared
 * stretch whose trips all leave from one platform or bay brackets its rows there (kept together, in
 * the place of its soonest); any other (several platforms, or a street stop) is a combined row on top.
 */
const DepartureList: React.FC<{
  title: string;
  groups: PlaceGroup[];
  shared: Shared[];
  empty: string;
  snap: TransitSnapshot;
  itemsFor: (g: PlaceGroup) => MenuItem[];
  colors: (r: PlanRoute) => RouteColors;
}> = ({ title, groups, shared, empty, snap, itemsFor, colors }) => {
  const owner = new Map<string, Shared>();
  for (const s of shared)
    if (s.platforms.length === 1) for (const k of s.groups) owner.set(k, s);
  const shown = new Set(groups.map(groupKey));
  const row = (g: PlaceGroup) => (
    <GroupRow
      key={groupKey(g)}
      group={g}
      now={snap.t}
      live={snap.live}
      items={itemsFor(g)}
      colors={colors}
    />
  );
  const done = new Set<Shared>();
  const blocks: React.ReactNode[] = [];
  for (const g of groups) {
    const s = owner.get(groupKey(g));
    const members = s ? groups.filter((x) => owner.get(groupKey(x)) === s) : [];
    if (!s || members.length < 2) blocks.push(row(g));
    else if (!done.has(s)) {
      done.add(s);
      blocks.push(
        <SharedBracket key={sharedKey(s)} shared={s} count={members.length}>
          {members.map(row)}
        </SharedBracket>,
      );
    }
  }
  // A stretch is bracketed only when its rows are all in this list; otherwise it stays on top.
  const onTop = shared.filter(
    (s) => !done.has(s) && s.groups.some((k) => shown.has(k)),
  );
  return (
    <CardSection title={title}>
      {onTop.map((s) => (
        <SharedRow key={sharedKey(s)} shared={s} colors={colors} />
      ))}
      {groups.length ?
        blocks
      : <p className="py-2 text-sm text-(--card-muted)">{empty}</p>}
    </CardSection>
  );
};

const PlaceCardBody: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
  place: PlaceSnapshot;
}> = ({ engine, snap, place }) => {
  const state = timeState(snap);
  const colors = routeColorsFor(engine, snap);
  const station = place.kind === "station";
  const exchange = place.kind === "exchange";
  const isBus = (r: PlanRoute) => r.mode === "bus";
  const railRoutes = place.routes.filter((r) => !isBus(r));
  const rail = railRoutes.length > 0;
  const [direction, stopName] = splitDirection(place.name);
  const title =
    station ? stationName(place.name)
    : exchange ? place.name
    : place.partOf ? bayLabel(place.name)
    : stopName;
  const mainRoute = railRoutes[0];
  const realtime = place.groups.some((g) =>
    g.departures.some((d) => d.source !== "schedule"),
  );
  // A station lists its trains, then its sailings, then the buses from its bays.
  const sections = (["train", "ferry", "bus"] as const)
    .map((kind) => ({
      kind,
      groups: place.groups.filter((g) => kindOf(g.route) === kind),
      shared: place.shared.filter((s) => kindOf(s.routes[0]!) === kind),
    }))
    .filter(
      (x) =>
        x.groups.length
        || place.routes.some((r) => kindOf(r) === x.kind)
        || (x.kind === "bus" && place.bays.length),
    );
  const has = (kind: DepartureKind) => sections.some((x) => x.kind === kind);
  // Cards opened from this one get a back strip returning here.
  const go = (p: Place) => () => engine.open({ place: p }, title);
  const itemsFor = (g: PlaceGroup): MenuItem[] => {
    const items: MenuItem[] = [
      {
        id: "route",
        label: `View route: ${g.route.label}`,
        lead: <RouteBadge route={g.route} colors={colors(g.route)} />,
        onSelect: go({ kind: "route", id: g.route.key }),
      },
    ];
    const bay =
      g.stopIds.length === 1 ?
        place.bays.find((b) => b.id === g.stopIds[0])
      : undefined;
    if (bay)
      items.push({
        id: "stop",
        label: `View stop: ${bay.label}`,
        icon: "bus-stop",
        onSelect: go({ kind: "stop", id: bay.id }),
      });
    // Where it ends, so a rider new to the route sees which way it goes (and a short turn's end).
    if (g.terminus)
      items.push({
        id: "terminus",
        label: `View destination: ${g.terminus.name}`,
        icon: g.terminus.place.kind === "station" ? "station" : "bus-stop",
        onSelect: go(g.terminus.place),
      });
    const next = g.departures.find((d) => !d.cancelled);
    const vehicle = g.vehicle;
    if (vehicle && next) {
      const kind = kindOf(g.route);
      items.push({
        id: "vehicle",
        label: `View ${VEHICLE[kind].noun}`,
        icon: VEHICLE[kind].icon,
        note: `${headsign(g.headsign)} · ${timeText(next, snap.t, snap.live, true)}`,
        onSelect: () => engine.open({ vehicle }, title),
      });
    }
    return items;
  };
  const actions: CardAction[] = [
    {
      id: "centre",
      label: "Centre on map",
      icon: "crosshair",
      onSelect: () => engine.locateSelected(),
    },
    ...(place.partOf ?
      [
        {
          id: "part-of",
          label: `All of ${stationName(place.partOf.name)}`,
          icon: place.partOf.kind === "station" ? "station" : "bus-stop",
          onSelect: go(place.partOf),
        } satisfies CardAction,
      ]
    : []),
    ...place.bays.map((b): CardAction => ({
      id: `bay-${b.id}`,
      label: `Only ${b.label}`,
      icon: "bus-stop",
      onSelect: go({ kind: "stop", id: b.id }),
    })),
    {
      id: "share",
      label: "Share link",
      icon: "share",
      onSelect: () => shareLink(location.href, `${title} · Transitopia`),
    },
  ];
  const eyebrow =
    exchange ? "Bus exchange"
    : !station ?
      place.partOf ?
        `Bus bay · ${stationName(place.partOf.name)}`
      : `Bus stop${direction ? ` · ${direction}` : ""}`
    : railRoutes.every((r) => r.mode === "skytrain") ? "SkyTrain station"
    : railRoutes.every((r) => r.mode === "ferry") ? "Ferry terminal"
    : "Station";
  const when = (noun: string) =>
    snap.live ?
      `Next ${noun}`
    : `${noun[0]!.toUpperCase()}${noun.slice(1)} after ${clockMinutes(snap.t)}`;
  return (
    <InfoCard
      tile={
        station ?
          {
            icon: "station",
            bg: mainRoute?.color ?? "#4b5563",
            fg: mainRoute?.textColor ?? "#fff",
          }
        : { icon: "bus-stop", bg: "#4b5563", fg: "#fff" }
      }
      eyebrow={eyebrow}
      title={title}
      subtitle={
        station ? railRoutes.map((r) => r.label).join(" · ")
        : place.code ?
          `Stop #${place.code}`
        : undefined
      }
      status={
        state.future ?
          { tone: "estimated", text: "Projected from the timetable" }
        : realtime && snap.live ?
          { tone: "live", text: "Live where buses report GPS" }
        : { tone: "estimated", text: "Times estimated from the schedule" }
      }
      chips={place.routes.map((r) => ({
        label: isBus(r) ? r.key : r.label,
        color: colors(r),
        onSelect: go({ kind: "route", id: r.key }),
        action: `View route: ${r.label}`,
      }))}
      actions={actions}
      notLive={
        snap.live ? undefined : { ...state, onGoLive: () => engine.goLive() }
      }
      back={
        snap.back ?
          { label: snap.back, onBack: () => engine.back() }
        : undefined
      }
      onClose={() => engine.select(undefined)}
      footer={
        <>
          {rail ?
            <p>
              From the timetable.
              {has("train") ?
                " Trains on the map follow our inferred runs, which can differ by a minute or two."
              : ""}
            </p>
          : null}
          {has("bus") ?
            <p className={rail ? "mt-1" : undefined}>
              Buses: live where the bus reports GPS; otherwise from the
              timetable.
            </p>
          : null}
          {place.listed.length ?
            <p className={rail || has("bus") ? "mt-1" : undefined}>
              Routes in grey aren't on the map yet, so their times aren't listed
              here.
            </p>
          : null}
          {legendsFor(creditsFor(place.datasets)).map((l) => (
            <p key={l} className="mt-1">
              {l}
            </p>
          ))}
        </>
      }>
      {sections.map((x) => (
        <DepartureList
          key={x.kind}
          title={when(
            sections.length > 1 || station ? NOUNS[x.kind] : "departures",
          )}
          groups={x.groups}
          shared={x.shared}
          itemsFor={itemsFor}
          colors={colors}
          empty={
            sections.length > 1 ?
              `No ${NOUNS[x.kind]} leave here in the next two hours.`
            : "Nothing leaves here in the next two hours."
          }
          snap={snap}
        />
      ))}
    </InfoCard>
  );
};
