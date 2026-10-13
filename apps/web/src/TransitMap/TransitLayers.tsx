import React from "react";
import type {
  TransitEngine,
  TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import type {
  PlanRoute,
  RouteCategory,
} from "@transitopia/transit-core/plan/types.ts";

import {
  LayersPanel,
  PanelDivider,
  SwitchRow,
} from "../components/LayersPanel.tsx";
import { SegmentedChoice } from "../components/SegmentedChoice.tsx";
import { ProvenanceSwatch } from "./Swatches.tsx";

const CATEGORIES: {
  id: RouteCategory;
  title: string;
  description: string;
}[] = [
  {
    id: "rapid",
    title: "Rapid Transit",
    description: "SkyTrain, SeaBus, West Coast Express, RapidBus",
  },
  {
    id: "frequent",
    title: "Frequent Bus",
    description: "Every 15 min or better, all day",
  },
  { id: "regular", title: "Regular Bus", description: "Every other route" },
];

// Plans built before routes had categories are all rapid transit (config/routes.json → category).
const categoryOf = (r: PlanRoute): RouteCategory => r.category ?? "rapid";

/** A few of the category's route colours, as line samples (thinner for buses). */
const CategorySwatch: React.FC<{ routes: PlanRoute[] }> = ({ routes }) => {
  // One sample per mode, so SkyTrain, ferries and buses each show up.
  const samples = [
    ...new Map(routes.map((r) => [r.mode, r] as const)).values(),
  ].slice(0, 3);
  return (
    <span className="flex w-7 flex-col justify-center gap-[3px]">
      {samples.map((r) => (
        <span
          key={r.key}
          className={`rounded-full ${r.kind === "bus" ? "h-1" : "h-[5px]"}`}
          style={{ background: r.color }}
        />
      ))}
    </span>
  );
};

/**
 * The transit layers panel (apps/web/README.md#header-and-layers): route categories, which vehicles
 * to draw, stations and stops, and the key. Choices are remembered per browser by the engine.
 */
export const TransitLayers: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
}> = ({ engine, snap }) => (
  <LayersPanel label="Transit layers">
    {snap.scenario ?
      <p className="px-4 pb-1 text-sm" title={snap.scenario.description}>
        Scenario: <strong>{snap.scenario.name}</strong>
      </p>
    : null}
    {CATEGORIES.map((c) => {
      // Categories without routes yet (all-buses work) stay out of the panel.
      const routes = snap.routes.filter((r) => categoryOf(r) === c.id);
      if (!routes.length) return null;
      const keys = routes.map((r) => r.key);
      return (
        <SwitchRow
          key={c.id}
          title={c.title}
          description={c.description}
          swatch={<CategorySwatch routes={routes} />}
          on={keys.some((k) => !snap.hidden.has(k))}
          onChange={(on) => engine.setRoutesHidden(keys, !on)}
        />
      );
    })}
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
    <SwitchRow
      title="Stations & stops"
      on={snap.showStops}
      onChange={(on) => engine.setStopsShown(on)}
    />
    <PanelDivider />
    <dl className="grid grid-cols-[2.125rem_1fr] items-center gap-x-2 gap-y-2 px-4 pt-1 text-[13px] text-gray-700 dark:text-gray-300">
      <dt>
        <ProvenanceSwatch estimated={false} />
      </dt>
      <dd>Live position (GPS, AIS or a sighting)</dd>
      <dt>
        <ProvenanceSwatch estimated />
      </dt>
      <dd>Estimated from the schedule</dd>
      <dt>
        <span
          aria-hidden="true"
          className="block h-[3px] w-7 bg-[repeating-linear-gradient(90deg,currentColor_0_4px,transparent_4px_8px)]"
        />
      </dt>
      <dd>Limited service, or not in service</dd>
    </dl>
  </LayersPanel>
);
