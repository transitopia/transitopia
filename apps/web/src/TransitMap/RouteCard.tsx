import React from "react";
import {
  DAY_HOURS,
  type RouteSnapshot,
  type TransitEngine,
  type TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import { localDate, toWallTime } from "@transitopia/transit-core/time.ts";
import { DATASETS } from "@transitopia/shared/datasets.ts";

import { Icon } from "../components/Icon.tsx";
import {
  CardSection,
  InfoCard,
  shareLink,
  type CardAction,
  type CardChip,
} from "../components/InfoCard.tsx";
import { timeState } from "./format.ts";
import { bandKey, bandOf } from "./frequency.ts";

const hh = (h: number) => String(h % 24).padStart(2, "0");

/** "Every 4 min", "Every 12 min". */
const everyMinutes = (m: number) => `Every ${Math.max(1, Math.round(m))} min`;

/**
 * A route (apps/web/README.md#route-cards): how often it runs in the hour from the map's time, and
 * through the day as hourly cells, for each kind of day in the feed. From the timetable only; how
 * it actually ran needs the server's statistics.
 */
export const RouteCard: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
}> = ({ engine, snap }) =>
  snap.place?.kind === "route" ?
    <RouteCardBody
      key={snap.place.id}
      engine={engine}
      snap={snap}
      place={snap.place}
    />
  : null;

const RouteCardBody: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
  place: RouteSnapshot;
}> = ({ engine, snap, place }) => {
  const { route } = place;
  const days = engine.routeDays(route.key);
  const [dayIndex, setDayIndex] = React.useState(0);
  const day = days[Math.min(dayIndex, days.length - 1)];
  const today = dayIndex === 0;
  // The shown hour, in service hours (after midnight is 24+).
  const shownDate = localDate(snap.t);
  const hourNow =
    toWallTime(snap.t).hour + (shownDate !== snap.serviceDate ? 24 : 0);
  const nowIndex = today ? DAY_HOURS.indexOf(hourNow) : -1;

  const others = snap.routes.filter((r) => r.key !== route.key);
  const onlyThis = others.every((r) => snap.hidden.has(r.key));
  const actions: CardAction[] = [
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
        label: "Show only this route",
        icon: "filter",
        onSelect: () => {
          engine.setRoutesHidden([route.key], false);
          engine.setRoutesHidden(
            others.map((r) => r.key),
            true,
          );
        },
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
      onSelect: () => shareLink(location.href, `${route.label} · Transitopia`),
    },
  ];
  const noun =
    route.mode === "bus" ? "buses"
    : route.mode === "ferry" ? "vessels"
    : "trains";
  const chips: CardChip[] = [
    { label: `${place.vehicles} ${noun} running` },
    // Green only when live; real positions in the past are recorded.
    ...(place.live ?
      [
        snap.live ?
          { label: `${place.live} live`, tone: "good" as const }
        : { label: `${place.live} recorded` },
      ]
    : []),
  ];
  const band =
    place.nextHour !== undefined ? bandOf(place.nextHour) : undefined;
  return (
    <InfoCard
      tile={
        route.mode === "bus" ?
          { text: route.key, bg: route.color, fg: route.textColor }
        : {
            icon: route.mode === "ferry" ? "ferry" : "train",
            bg: route.color,
            fg: route.textColor,
          }
      }
      eyebrow={
        route.mode === "bus" ? "Bus route"
        : route.mode === "skytrain" ?
          "SkyTrain line"
        : route.mode === "ferry" ?
          "Ferry route"
        : "Commuter rail"
      }
      title={route.label}
      chips={chips}
      actions={actions}
      notLive={
        snap.live ? undefined : (
          { ...timeState(snap), onGoLive: () => engine.goLive() }
        )
      }
      onClose={() => engine.select(undefined)}
      footer={
        <>
          <p>
            From the TransLink timetable: trips per hour in the busier
            direction.
          </p>
          <p className="mt-1">{DATASETS["translink-gtfs"].legend}</p>
        </>
      }>
      <CardSection title="Next hour">
        <div className="flex items-stretch gap-3 pt-1 pb-2">
          <span
            aria-hidden="true"
            className="w-1.5 flex-none rounded-full bg-(--card-chip-bg)"
            style={band ? { background: band.color } : undefined}
          />
          {band && place.nextHour !== undefined ?
            <div className="flex flex-col gap-[3px]">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-[22px] font-extrabold tracking-tight">
                  {everyMinutes(place.nextHour)}
                </span>
                <span className="inline-flex items-center gap-[5px] rounded-md bg-(--card-chip-bg) px-2 py-0.5 text-[13px] font-extrabold">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 rounded-[3px]"
                    style={{ background: band.color }}
                  />
                  {band.name}
                </span>
              </div>
              <span className="text-[13.5px] leading-snug text-(--card-muted)">
                Average wait ~{Math.max(1, Math.round(place.nextHour / 2))} min,
                from the timetable
              </span>
            </div>
          : <span className="text-[15px] font-bold text-(--card-muted)">
              No service in the next hour
            </span>
          }
        </div>
      </CardSection>
      {day ?
        <CardSection title="Through the day">
          <div>
            <div className="mb-2.5 flex">
              <button
                type="button"
                title="Next kind of day"
                disabled={days.length < 2}
                onClick={() => setDayIndex((dayIndex + 1) % days.length)}
                className="flex h-9 items-center gap-1.5 rounded-[9px] border border-(--card-border) bg-(--card-bg) px-2.5 text-[13px] font-bold hover:bg-(--card-hover) disabled:opacity-60">
                {day.label}
                {today ? " (today)" : ""}
                {days.length > 1 ?
                  <Icon icon="chevron-down" size={14} />
                : null}
              </button>
            </div>
            <div
              className="flex gap-0.5 px-0.5"
              role="list"
              aria-label="Hourly frequency">
              {day.hours.map((m, i) => {
                const h = DAY_HOURS[i]!;
                const b = m !== undefined ? bandOf(m) : undefined;
                return (
                  <span
                    key={h}
                    role="listitem"
                    title={`${hh(h)}:00 · ${b && m !== undefined ? `every ${Math.round(m)} min · ${b.name}` : "no service"}`}
                    className={`h-6 flex-1 rounded ${i === nowIndex ? "shadow-[0_0_0_2px_var(--card-bg),0_0_0_4px_var(--card-text)]" : ""}`}
                    style={{ background: b?.color ?? "var(--card-chip-bg)" }}
                  />
                );
              })}
            </div>
            <div className="relative mt-[5px] h-4 text-[11px] text-(--card-muted) tabular-nums">
              {DAY_HOURS.map((h, i) =>
                (
                  i === nowIndex
                  || (i % 3 === 0
                    && (nowIndex < 0 || Math.abs(i - nowIndex) > 1))
                ) ?
                  <span
                    key={h}
                    className={`absolute -translate-x-1/2 ${i === nowIndex ? "font-extrabold text-(--card-text)" : ""}`}
                    style={{
                      left: `${((i + 0.5) / DAY_HOURS.length) * 100}%`,
                    }}>
                    {i === nowIndex ? "now" : hh(h)}
                  </span>
                : null,
              )}
            </div>
            <div className="mt-2 mb-1.5 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-(--card-muted)">
              {bandKey().map((b) => (
                <span key={b.id} className="inline-flex items-center gap-[5px]">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 flex-none rounded-[3px]"
                    style={{ background: b.color }}
                  />
                  {b.name} {b.range}
                </span>
              ))}
            </div>
          </div>
        </CardSection>
      : null}
    </InfoCard>
  );
};
