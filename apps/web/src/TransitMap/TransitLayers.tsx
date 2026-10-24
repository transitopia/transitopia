import React from "react";
import type {
  TransitEngine,
  TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";
import type { RouteGroup } from "@transitopia/transit-core/plan/route-groups.ts";

import {
  LayersPanel,
  PanelDivider,
  SwitchRow,
} from "../components/LayersPanel.tsx";
import { SegmentedChoice } from "../components/SegmentedChoice.tsx";
import { ProvenanceSwatch } from "./Swatches.tsx";
import {
  FREQUENCY_BANDS,
  NO_SERVICE,
  bandWait,
} from "@transitopia/shared/frequency.ts";
import { STOP_SPACING_TIERS } from "@transitopia/shared/stop-spacing.ts";
import { DAY_WINDOW } from "@transitopia/transit-core/schedule/frequency.ts";
import { clockMinutes } from "./format.ts";
import { routeColorsFor, type RouteColors } from "./RouteBadge.tsx";
import { spacingText } from "./stopSpacing.ts";

/** The longest worst wait of a frequent band (12 min), and the closest spacing of a fast tier (600 m). */
const FREQUENT_MAX = FREQUENCY_BANDS.filter((b) => b.frequent).at(
  -1,
)!.maxMinutes!;
const FAST_MIN = STOP_SPACING_TIERS.find((t) => t.fast)!.minMetres;

const GROUPS: {
  id: RouteGroup;
  title: string;
  description: string;
}[] = [
  {
    id: "rapid",
    title: "Rapid Transit",
    description: "SkyTrain, SeaBus, West Coast Express",
  },
  {
    id: "frequent",
    title: "Frequent Bus",
    description: `Wait up to ${FREQUENT_MAX} min, most weekday hours`,
  },
  {
    id: "fast",
    title: "Fast Bus",
    description: `Limited stops or Express: ${spacingText(FAST_MIN)} or more between stops`,
  },
  { id: "regular", title: "Regular Bus", description: "Every other route" },
];

/** Key line heights per band: thicker for more frequent, as bus corridors are drawn. */
const BAND_HEIGHTS = ["h-[5px]", "h-[4px]", "h-[2px]", "h-[1.5px]"];

/**
 * The bus frequency window, above its key: the hour the corridors count ("16:30–17:30", in steps
 * of a few minutes), or "Typical weekday, 06:00–21:00".
 */
function windowText(snap: TransitSnapshot): string {
  if (snap.busFrequency === "now") {
    const [from, to] = snap.busFrequencyHour;
    return `Next hour ${clockMinutes(from)}–${clockMinutes(to)}:`;
  }
  const hh = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
  return `Typical weekday, ${hh(DAY_WINDOW.fromH)}–${hh(DAY_WINDOW.toH)} (median):`;
}

/** A few of the group's route colours as the map draws them, as line samples (thinner for buses). */
const GroupSwatch: React.FC<{
  routes: PlanRoute[];
  colors: (r: PlanRoute) => RouteColors;
}> = ({ routes, colors }) => {
  // One sample per mode, so SkyTrain, ferries and buses each show up: its first route (routes in
  // their own colour come first).
  const samples = routes
    .filter((r, i) => routes.findIndex((x) => x.mode === r.mode) === i)
    .slice(0, 3);
  return (
    <span className="flex w-7 flex-col justify-center gap-[3px]">
      {samples.map((r) => (
        <span
          key={r.key}
          className={`rounded-full ${r.kind === "bus" ? "h-1" : "h-[5px]"}`}
          style={{ background: colors(r).bg }}
        />
      ))}
    </span>
  );
};

/**
 * The transit layers panel (apps/web/README.md#header-and-layers): route groups, stations and stops,
 * brand colours, which vehicles to draw, and the key. Choices are remembered per browser by the engine.
 */
export const TransitLayers: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
}> = ({ engine, snap }) => {
  const colors = routeColorsFor(engine);
  return (
    <LayersPanel label="Transit layers">
      {snap.scenario ?
        <p className="px-4 pb-1 text-sm" title={snap.scenario.description}>
          Scenario: <strong>{snap.scenario.name}</strong>
        </p>
      : null}
      {GROUPS.map((g) => {
        // Groups without routes (no rail in Victoria) stay out of the panel.
        const routes = snap.routes.filter((r) =>
          snap.groups.get(r.key)?.includes(g.id),
        );
        if (!routes.length) return null;
        return (
          <SwitchRow
            key={g.id}
            title={g.title}
            description={g.description}
            swatch={<GroupSwatch routes={routes} colors={colors} />}
            on={!snap.hiddenGroups.has(g.id)}
            onChange={(on) => engine.setGroupShown(g.id, on)}
          />
        );
      })}
      <SwitchRow
        title="Stations & stops"
        on={snap.showStops}
        onChange={(on) => engine.setStopsShown(on)}
      />
      <SwitchRow
        title="Brand colours"
        description={
          snap.brandColors ?
            "Rail and some bus routes in their own colours"
          : "Every route coloured by frequency"
        }
        on={snap.brandColors}
        onChange={(on) => engine.setBrandColors(on)}
      />
      <PanelDivider />
      <SegmentedChoice
        label="Vehicles"
        value={snap.liveOnly ? "live" : "all"}
        options={[
          { value: "all", label: "All" },
          { value: "live", label: "Live only" },
        ]}
        onChange={(v) => engine.setLiveOnly(v === "live")}
      />
      <dl className="grid grid-cols-[2.125rem_1fr] items-center gap-x-2 gap-y-2 px-4 pt-1 text-[13px] text-gray-700 dark:text-gray-300">
        <dt>
          <ProvenanceSwatch estimated={false} />
        </dt>
        <dd>Live position (GPS etc.)</dd>
        <dt>
          <ProvenanceSwatch estimated />
        </dt>
        <dd>Estimated from the schedule</dd>
      </dl>
      <PanelDivider />
      {snap.corridors ?
        <>
          <SegmentedChoice
            label="Bus frequency"
            value={snap.busFrequency}
            options={[
              { value: "now", label: "Now" },
              { value: "day", label: "Day" },
            ]}
            onChange={(v) => engine.setBusFrequency(v)}
          />
          <p className="px-4 pb-1 text-[12.5px] text-gray-600 max-sm:text-[13px] dark:text-gray-400">
            {windowText(snap)}
          </p>
          <dl className="grid grid-cols-[2.125rem_1fr] items-center gap-x-2 gap-y-2 px-4 pt-1 text-[13px] text-gray-700 dark:text-gray-300">
            {FREQUENCY_BANDS.map((b, i) => (
              <React.Fragment key={b.id}>
                <dt>
                  <span
                    aria-hidden="true"
                    className={`block w-7 rounded-full ${BAND_HEIGHTS[i]}`}
                    style={{ background: `var(--band-${b.id})` }}
                  />
                </dt>
                <dd>
                  <strong className="font-bold text-gray-900 dark:text-gray-100">
                    {b.name}
                  </strong>{" "}
                  · {bandWait(i)}
                </dd>
              </React.Fragment>
            ))}
            <dt>
              <span
                aria-hidden="true"
                className="block w-7 border-t-[1.5px] border-dashed opacity-80"
                style={{ borderColor: "var(--no-service)" }}
              />
            </dt>
            <dd>
              <strong className="font-bold text-gray-900 dark:text-gray-100">
                {NO_SERVICE.name}
              </strong>{" "}
              · No buses then
            </dd>
          </dl>
        </>
      : null}
    </LayersPanel>
  );
};
