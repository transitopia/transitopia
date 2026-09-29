// Validation of observation records (shared by build:observations and the RT service's live dispatch).

import type { Observation } from "./types.ts";

const KINDS = new Set(["at_platform", "delay", "cancel", "consist", "parked"]);

/** What's wrong with an observation (empty if it's usable). */
export function observationProblems(o: Observation): string[] {
  const p: string[] = [];
  if (!KINDS.has(o.kind))
    p.push(`unknown kind "${(o as { kind: string }).kind}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date ?? ""))
    p.push("date must be YYYY-MM-DD");
  if (!o.source) p.push("source is required");
  if (o.kind === "at_platform") {
    if (!o.stop) p.push("stop is required");
    if (!o.time || Number.isNaN(Date.parse(o.time)))
      p.push("time must be ISO 8601 with offset");
  } else if (o.kind === "parked") {
    if (!Array.isArray(o.at) || o.at.length !== 2)
      p.push("at must be [lon, lat]");
    if (!o.time || Number.isNaN(Date.parse(o.time)))
      p.push("time must be ISO 8601 with offset");
  } else if (!("trip" in o) || !o.trip) p.push("trip is required");
  if (o.kind === "delay" && !Number.isFinite(o.seconds))
    p.push("seconds must be a number");
  return p;
}
