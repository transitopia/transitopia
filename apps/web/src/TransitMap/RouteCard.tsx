import React from "react";
import {
  DAY_HOURS,
  type RouteSnapshot,
  type TransitEngine,
  type TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import { localDate, toWallTime } from "@transitopia/transit-core/time.ts";
import { creditsFor, legendsFor } from "@transitopia/shared/datasets.ts";

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
import { routeColorsFor } from "./RouteBadge.tsx";

const hh = (h: number) => String(h % 24).padStart(2, "0");

/**
 * An hour's cell height, as a fraction of the row: the worse the service, the shorter, so the day's
 * shape shows without the colours. An hour without service is a baseline.
 */
const CELL_HEIGHT: Record<string, number> = {
  good: 1,
  ok: 0.75,
  poor: 0.5,
  bad: 0.25,
};
const NO_SERVICE_PX = 2;

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
  const colors = routeColorsFor(engine, snap)(route);
  const days = engine.routeDays(route.key);
  const [dayIndex, setDayIndex] = React.useState(0);
  const day = days[Math.min(dayIndex, days.length - 1)];
  const today = dayIndex === 0;
  // The shown hour, in service hours (after midnight is 24+).
  const shownDate = localDate(snap.t);
  const hourNow =
    toWallTime(snap.t).hour + (shownDate !== snap.serviceDate ? 24 : 0);
  const nowIndex = today ? DAY_HOURS.indexOf(hourNow) : -1;

  const share: CardAction = {
    id: "share",
    label: "Share link",
    icon: "share",
    onSelect: () => shareLink(location.href, `${route.label} · Transitopia`),
  };
  // A route the map doesn't draw (the catalogue) has no line to centre on. While the card is open,
  // the map dims every other route (packages/transit-map/README.md#route-focus).
  const actions: CardAction[] =
    !place.drawn ?
      [share]
    : [
        {
          id: "centre",
          label: "Centre on map",
          icon: "crosshair",
          onSelect: () => engine.locateSelected(),
        },
        share,
      ];
  const noun =
    route.mode === "bus" ? "buses"
    : route.mode === "ferry" ? "vessels"
    : "trains";
  const chips: CardChip[] =
    !place.drawn ?
      [{ label: "Not on the map yet" }]
    : [
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
          { text: route.key, ...colors }
        : { icon: route.mode === "ferry" ? "ferry" : "train", ...colors }
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
      back={
        snap.back ?
          { label: snap.back, onBack: () => engine.back() }
        : undefined
      }
      onClose={() => engine.select(undefined)}
      footer={
        <>
          <p>From the timetable: trips per hour in the busier direction.</p>
          {legendsFor(creditsFor(place.datasets)).map((l) => (
            <p key={l} className="mt-1">
              {l}
            </p>
          ))}
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
        <CardSection title="Frequency through the day">
          <div>
            <div className="relative mb-2.5 flex w-fit max-w-full">
              <select
                aria-label="Kind of day"
                value={Math.min(dayIndex, days.length - 1)}
                disabled={days.length < 2}
                onChange={(e) => setDayIndex(Number(e.target.value))}
                className="h-9 max-w-full min-w-0 appearance-none truncate rounded-[9px] border border-(--card-border) bg-(--card-bg) pr-7 pl-2.5 text-[13px] font-bold text-(--card-text) hover:bg-(--card-hover) disabled:opacity-60">
                {days.map((d, i) => (
                  <option key={i} value={i}>
                    {d.label}
                    {i === 0 ? " (today)" : ""}
                  </option>
                ))}
              </select>
              {days.length > 1 ?
                <Icon
                  icon="chevron-down"
                  size={14}
                  className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
                />
              : null}
            </div>
            <div
              className="flex h-6 gap-0.5 px-0.5"
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
                    // The hour's whole column, so "now" is ringed the same however short its cell.
                    className={`flex h-full flex-1 items-end rounded`}>
                    <span
                      className={`w-full ${b ? "rounded" : "rounded-xs"}`}
                      style={{
                        background: b?.color ?? "var(--card-chip-bg)",
                        height:
                          b ?
                            `${(CELL_HEIGHT[b.id] ?? 1) * 100}%`
                          : NO_SERVICE_PX,
                      }}
                    />
                  </span>
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
                <span key={b.id} className="inline-flex items-center gap-[4px]">
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
