import React from "react";
import type {
  TransitEngine,
  TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";
import { ProvenanceSwatch, RouteSwatch } from "./Swatches.tsx";

const GROUPS: { title: string; kinds: PlanRoute["kind"][] }[] = [
  { title: "SkyTrain", kinds: ["skytrain"] },
  { title: "SeaBus & West Coast Express", kinds: ["shape"] },
  { title: "Express buses", kinds: ["bus"] },
];

const COLLAPSED_KEY = "transitopia:transit:legendCollapsed";

function loadCollapsed(): boolean {
  try {
    const v = localStorage.getItem(COLLAPSED_KEY);
    if (v !== null) return v === "1";
  } catch {
    // Storage unavailable.
  }
  return window.matchMedia("(max-width: 640px)").matches;
}

/** Routes with visibility toggles (remembered per browser), and what the vehicle fills mean. */
export const TransitLegend: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
}> = ({ engine, snap }) => {
  const [collapsed, setCollapsed] = React.useState(loadCollapsed);
  const toggle = () => {
    setCollapsed(!collapsed);
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "0" : "1");
    } catch {
      // Preferences are optional.
    }
  };
  return (
    <section
      aria-label="Routes"
      className="absolute left-5 top-20 z-40 max-h-[calc(100dvh-13rem)] w-64 overflow-y-auto rounded-sm border border-gray-500 bg-white/95 shadow-md lg:top-24 dark:border-gray-600 dark:bg-gray-900/95 dark:text-gray-100">
      <button
        type="button"
        className="flex h-11 w-full items-center justify-between px-3 text-sm font-semibold"
        aria-expanded={!collapsed}
        aria-controls="transit-legend-body"
        onClick={toggle}>
        <span title={snap.scenario?.description}>
          {snap.scenario ? `Scenario: ${snap.scenario.name}` : "Routes"}
        </span>
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
      </button>
      {collapsed ? null : (
        <div id="transit-legend-body" className="px-3 pb-3 text-sm">
          {GROUPS.map((g) => {
            const routes = snap.routes.filter((r) => g.kinds.includes(r.kind));
            if (!routes.length) return null;
            return (
              <div key={g.title}>
                <h3 className="mb-0.5 mt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {g.title}
                </h3>
                {routes.map((r) => (
                  <label
                    key={r.key}
                    className="flex min-h-8 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!snap.hidden.has(r.key)}
                      onChange={(e) =>
                        engine.setRouteHidden(r.key, !e.target.checked)
                      }
                    />
                    <RouteSwatch route={r} />
                    <span>{r.label}</span>
                  </label>
                ))}
              </div>
            );
          })}
          <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
            <ProvenanceSwatch estimated /> estimated from schedule{" "}
            <ProvenanceSwatch estimated={false} /> observed
            <br />
            <span
              aria-hidden="true"
              className="mr-1 inline-block h-[3px] w-6 align-[2px] bg-[repeating-linear-gradient(90deg,currentColor_0_3px,transparent_3px_7px)]"
            />
            bus route: limited service, or no passengers (to/from a layover)
          </p>
        </div>
      )}
    </section>
  );
};
