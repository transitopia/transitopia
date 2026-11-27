import React from "react";
import type {
  ServiceAlert,
  TransitEngine,
  TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import { routeId } from "@transitopia/transit-map/keys.ts";
import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";

import { Icon } from "../components/Icon.tsx";
import { CardSection } from "../components/InfoCard.tsx";
import { alertPeriod } from "./format.ts";
import { routeColorsFor, type RouteColors } from "./RouteBadge.tsx";

// SkyTrain alerts (apps/web/README.md#skytrain-alerts): the time bar's badge and its popover, and the
// alerts sections of line and station cards.

/** A line's colour as a dot. */
const LineDot: React.FC<{ colors: RouteColors; ring?: boolean }> = ({
  colors,
  ring,
}) => (
  <span
    aria-hidden="true"
    className={`h-2.5 w-2.5 flex-none rounded-full ${ring ? "ring-2 ring-(--card-warn-bg)" : ""}`}
    style={{ background: colors.bg }}
  />
);

/**
 * One alert: its header (two lines until opened), when it applies, and its details when opened.
 * With `lines`, the dots of the lines it's about (a station served by more than one).
 */
const AlertRow: React.FC<{
  alert: ServiceAlert;
  snap: TransitSnapshot;
  lines?: ((r: PlanRoute) => RouteColors) | undefined;
}> = ({ alert: a, snap, lines }) => {
  const period = alertPeriod(a, snap.t, snap.timezone);
  return (
    <details className="group py-2">
      <summary className="-mx-2 flex cursor-pointer list-none items-start gap-2.5 rounded-lg px-2 py-1 hover:bg-(--card-hover) [&::-webkit-details-marker]:hidden">
        {lines ?
          <span className="mt-[5px] flex flex-none gap-1">
            {a.routes.map((r) => (
              <LineDot key={routeId(r)} colors={lines(r)} />
            ))}
          </span>
        : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="line-clamp-2 text-[14px] leading-snug group-open:line-clamp-none">
            {a.header}
          </span>
          {period ?
            <span className="mt-0.5 text-[12.5px] leading-snug text-(--card-muted)">
              {period}
            </span>
          : null}
        </span>
        <span className="mt-0.5 flex-none text-(--card-muted) transition-transform group-open:rotate-180">
          <Icon icon="chevron-down" size={14} />
        </span>
      </summary>
      {a.description ?
        <p className="mt-1 text-[13px] leading-snug whitespace-pre-line text-(--card-muted)">
          {a.description}
        </p>
      : null}
    </details>
  );
};

/** A line or station card's alerts (nothing when there are none). */
export const AlertsSection: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
  alerts: ServiceAlert[];
  title: string;
  /** Show each alert's lines (a station served by more than one). */
  showLines?: boolean;
}> = ({ engine, snap, alerts, title, showLines }) => {
  if (!alerts.length) return null;
  const colors = routeColorsFor(engine);
  return (
    <CardSection title={title}>
      {alerts.map((a) => (
        <AlertRow
          key={a.id}
          alert={a}
          snap={snap}
          lines={showLines ? colors : undefined}
        />
      ))}
    </CardSection>
  );
};

/** Alerts grouped by the lines they're about, in order of first appearance. */
function byLines(
  alerts: ServiceAlert[],
): { routes: PlanRoute[]; alerts: ServiceAlert[] }[] {
  const groups = new Map<
    string,
    { routes: PlanRoute[]; alerts: ServiceAlert[] }
  >();
  for (const a of alerts) {
    const key = a.routes.map(routeId).join();
    const g = groups.get(key);
    if (g) g.alerts.push(a);
    else groups.set(key, { routes: a.routes, alerts: [a] });
  }
  return [...groups.values()];
}

/**
 * The time bar's "Service change" badge (apps/web/README.md#skytrain-alerts): the lines in view whose
 * service an alert changes at the shown time, as dots, opening a popover that lists the alerts by
 * line, each line opening its card. The popover is placed against the time bar: above it, or
 * `below` when the bar is at the top of the screen.
 */
export const ServiceChangeBadge: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
  below?: boolean | undefined;
}> = ({ engine, snap, below }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const any = snap.alerts.length > 0;
  React.useEffect(() => {
    if (!open || !any) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Handled here, so an open card stays open.
      e.preventDefault();
      setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, any]);
  if (!any) return null;

  const colors = routeColorsFor(engine);
  const groups = byLines(snap.alerts);
  const lines = [
    ...new Map(
      snap.alerts.flatMap((a) => a.routes).map((r) => [routeId(r), r]),
    ).values(),
  ];
  const label =
    snap.alerts.length === 1 ?
      "Service change"
    : `${snap.alerts.length} service changes`;
  return (
    // Not positioned: the popover is placed against the time bar.
    <div ref={ref} className="contents">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}: ${lines.map((r) => r.label).join(", ")}`}
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 rounded-full bg-(--card-warn-bg) py-1.5 pr-2 pl-2.5 text-[12.5px] font-semibold whitespace-nowrap text-(--card-warn-fg) hover:ring-1 hover:ring-(--card-warn-fg)/40 ${open ? "ring-1 ring-(--card-warn-fg)/40" : ""}`}>
        <span className="flex -space-x-1">
          {lines.map((r) => (
            <LineDot key={routeId(r)} colors={colors(r)} ring />
          ))}
        </span>
        {label}
        <Icon
          icon={open !== !!below ? "chevron-down" : "chevron-up"}
          size={12}
        />
      </button>
      {open ?
        <div
          role="dialog"
          aria-label="Service changes"
          className={`absolute inset-x-0 z-50 mx-auto flex max-h-[min(60vh,30rem)] w-full max-w-[440px] flex-col overflow-hidden rounded-2xl border border-(--card-border) bg-(--card-bg) text-(--card-text) shadow-[0_6px_24px_rgb(17_24_39/0.18)] ${below ? "top-full mt-2" : "bottom-full mb-2"}`}>
          <div className="flex items-center gap-2 px-4 pt-3 pb-1">
            <h2 className="flex-1 text-[15px] font-bold">Service changes</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="-mr-2 flex h-9 w-9 items-center justify-center rounded-full hover:bg-(--card-hover)">
              <Icon icon="close" size={14} />
            </button>
          </div>
          <div className="overflow-y-auto overscroll-contain px-4 pb-1">
            {groups.map((g) => (
              <section
                key={g.routes.map(routeId).join()}
                className="border-t border-(--card-divider) pt-2 first:border-t-0">
                <div className="flex items-center gap-2">
                  {g.routes.map((r) => (
                    <LineDot key={routeId(r)} colors={colors(r)} />
                  ))}
                  <h3 className="flex-1 text-[13px] font-bold">
                    {g.routes.map((r) => r.label).join(" · ")}
                  </h3>
                  {g.routes.map((r) => (
                    <button
                      key={routeId(r)}
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        engine.selectPlace({
                          kind: "route",
                          feed: r.feed,
                          id: r.key,
                        });
                      }}
                      className="rounded-md px-1.5 py-1 text-[12.5px] font-bold text-(--card-link) hover:bg-(--card-hover)">
                      {g.routes.length > 1 ? `View ${r.label}` : "View line"}
                    </button>
                  ))}
                </div>
                <div className="divide-y divide-(--card-divider)">
                  {g.alerts.map((a) => (
                    <AlertRow key={a.id} alert={a} snap={snap} />
                  ))}
                </div>
              </section>
            ))}
          </div>
          <p className="border-t border-(--card-divider) px-4 py-2 text-[12px] leading-snug text-(--card-muted)">
            From real-time alerts, for the train lines in view. Trains on the
            map still follow the regular timetable. Elevator, escalator and
            entrance notices are on station cards.
          </p>
        </div>
      : null}
    </div>
  );
};
