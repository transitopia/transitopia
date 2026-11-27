// SkyTrain alerts as the site shows them (packages/transit-core/DESIGN.md#skytrain-alerts): those
// that change how a line runs by the time bar (for the lines in view) and on line cards, and every
// one naming a station's platforms (elevators, escalators, entrances, fares) on its card.

import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";
import {
  alertPeriodAt,
  isServiceAlert,
  type RtRouteAlert,
} from "@transitopia/transit-core/rt/changes.ts";

/** An alert in effect at the shown time. */
export interface ServiceAlert {
  /** Unique across feeds: `<feed>:<alert id>`. */
  id: string;
  feed: string;
  /** The lines it's about, in the plan's order. */
  routes: PlanRoute[];
  header: string;
  /** Its details, with line breaks normalised (paragraphs split by a blank line); may be empty. */
  description: string;
  /** It changes how its lines run (`isServiceAlert`), rather than being about a station or fares. */
  service: boolean;
  /** The active period it's in at the shown time (epoch ms; an open end undefined). */
  start: number | undefined;
  end: number | undefined;
  /** The zone its times are said in (its feed's). */
  timezone: string;
}

/** An alert's snapshot at t, about those of its routes that are in `routes` (the plan's, by key). */
export function serviceAlert(
  a: RtRouteAlert,
  feed: string,
  routes: ReadonlyMap<string, PlanRoute>,
  timezone: string,
  t: number,
): ServiceAlert {
  const keys = new Set(a.entities.map((e) => e.routeKey));
  const period = alertPeriodAt(a, t);
  return {
    id: `${feed}:${a.id}`,
    feed,
    routes: [...routes.values()].filter((r) => keys.has(r.key)),
    header: a.header.trim(),
    description: tidyText(a.description),
    service: isServiceAlert(a),
    start: period.start,
    end: period.end,
    timezone,
  };
}

/**
 * TransLink's descriptions mix \r\n, \n\r and \n, and often start with blank lines: one \n per line
 * break, a blank line between paragraphs, trimmed.
 */
export function tidyText(s: string): string {
  return s
    .replace(/\r\n?|\n\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
