// Validate the track graph against GTFS and the diagram checklist (docs/skytrain-viz-PLAN.md §7). Exits non-zero on
// errors; warnings are printed for review.
//
//   npm run validate:infra

import { join } from "node:path";
import { readJson } from "./lib/paths.ts";
import { INFRA_DIR, loadGraph, loadLatestPlan } from "./lib/infra.ts";
import { mapPlatforms } from "@transitopia/transit-core/infra/platforms.ts";
import { routePattern } from "@transitopia/transit-core/infra/patterns.ts";
import type { Dir, TrackGraph } from "@transitopia/transit-core/infra/graph.ts";
import type { SegmentKind } from "@transitopia/transit-core/infra/types.ts";
import type { LonLat } from "@transitopia/transit-core/geo.ts";
import { distM } from "@transitopia/transit-core/geo.ts";

interface ChecklistItem {
  name: string;
  near: LonLat;
  radius: number;
  kinds: SegmentKind[];
}

const errors: string[] = [];
const warnings: string[] = [];
const err = (m: string) => errors.push(m);
const warn = (m: string) => warnings.push(m);

/** Connected components over turns (ignoring direction). */
function components(g: TrackGraph): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const id of g.segments.keys()) {
    if (seen.has(id)) continue;
    const comp: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const s = stack.pop()!;
      comp.push(s);
      for (const d of [1, -1] as Dir[]) {
        for (const n of g.successors(s, d)) {
          if (!seen.has(n.seg)) {
            seen.add(n.seg);
            stack.push(n.seg);
          }
        }
      }
    }
    out.push(comp);
  }
  return out.sort((a, b) => b.length - a.length);
}

async function main() {
  const { graph: g, overrides } = await loadGraph();
  const plan = await loadLatestPlan();
  const railKeys = new Set(
    plan.routes.filter((r) => r.kind === "skytrain").map((r) => r.key),
  );

  // 1. Topology.
  const comps = components(g);
  const big = comps.filter(
    (c) => c.reduce((s, id) => s + g.segment(id).length, 0) > 5000,
  );
  const lineSets = big.map((c) =>
    [...new Set(c.flatMap((id) => g.segment(id).lines))].sort().join("+"),
  );
  console.log(
    `Topology: ${g.segments.size} segments, ${g.nodes.size} nodes, ${comps.length} components; networks: ${lineSets.join(", ")}`,
  );
  for (const c of comps.slice(big.length)) {
    const len = c.reduce((s, id) => s + g.segment(id).length, 0);
    const kinds = [...new Set(c.map((id) => g.segment(id).kind))].join("/");
    if (kinds !== "yard")
      warn(
        `Isolated track (${kinds}, ${Math.round(len)} m): ${c.slice(0, 3).join(", ")}${c.length > 3 ? "…" : ""}`,
      );
  }
  for (const n of g.nodes.values()) {
    if (n.kind !== "end") continue;
    const seg = [...g.segments.values()].find(
      (s) => s.from === n.id || s.to === n.id,
    )!;
    if (seg.kind === "yard") continue;
    warn(
      `Untagged dead end on ${seg.kind} track ${seg.id}${seg.name ? ` (${seg.name})` : ""} at ${n.lat.toFixed(5)},${n.lon.toFixed(5)}`,
    );
  }
  const works = [...g.segments.values()].filter((s) => s.works);
  if (works.length) {
    const ways = [...new Set(works.map((s) => s.osmWay))];
    warn(
      `${works.length} in-service segments are tagged construction/disused in OSM (ways ${ways.join(", ")}); see OPEN-QUESTIONS #17`,
    );
  }

  // 2. Platforms.
  const report = mapPlatforms(
    g,
    plan,
    railKeys,
    overrides.platforms,
    overrides.patternPlatforms,
  );
  for (const u of report.unmapped) err(`Platform not near any track: ${u}`);
  for (const b of report.breaks)
    err(`Stop pair not routable without reversing: ${b}`);
  for (const t of report.turnbackFailures)
    err(
      `No turnback at ${t}: arriving trains can reach neither a departure platform nor a yard`,
    );
  const byTrack = new Map<string, string[]>();
  for (const a of report.assignments.values()) {
    if (a.dist > 35)
      warn(`${a.name}: GTFS position is ${a.dist.toFixed(0)} m from its track`);
    if (a.method === "consistent" && a.agreement < 0.9)
      warn(
        `${a.name}: only ${(a.agreement * 100).toFixed(0)}% of trips agree on its track`,
      );
    const s = plan.stops.find((x) => x.id === a.stopId)!;
    if (s.platform) {
      const k = `${s.parent ?? s.name}|${a.pos.seg}`;
      (byTrack.get(k) ?? byTrack.set(k, []).get(k)!).push(a.name);
    }
  }
  for (const names of byTrack.values())
    if (names.length > 1)
      warn(`Platforms share one track: ${names.join(" / ")}`);
  console.log(
    `Platforms: ${report.assignments.size} mapped (${[...report.assignments.values()].filter((a) => a.method === "override").length} by override)`,
  );

  // 3. Every pattern routes, with lengths close to GTFS shape distances.
  const railPatterns = plan.patterns.filter((p) => railKeys.has(p.route));
  const routes = railPatterns.map((p) =>
    routePattern(g, plan, report.assignments, p, report.patternPositions),
  );
  let hops = 0;
  const lengthWarnings = new Set<string>();
  for (const r of routes) {
    for (const f of r.failures)
      err(`${r.pattern.route} pattern ${r.pattern.id}: no route ${f}`);
    r.hops.forEach((h, i) => {
      if (!h) return;
      hops++;
      const gtfs = r.pattern.dist[i + 1]! - r.pattern.dist[i]!;
      const ratio = h.length / Math.max(1, gtfs);
      if (Math.abs(h.length - gtfs) > 200 && (ratio < 0.8 || ratio > 1.25)) {
        const names = `${plan.stops[r.pattern.stops[i]!]!.name} → ${plan.stops[r.pattern.stops[i + 1]!]!.name}`;
        lengthWarnings.add(
          `${names}: track route ${Math.round(h.length)} m vs GTFS ${Math.round(gtfs)} m`,
        );
      }
    });
  }
  for (const w of lengthWarnings) warn(w);
  console.log(`Routing: ${railPatterns.length} patterns, ${hops} hops routed`);

  // 5. Diagram checklist.
  const checklist = await readJson<{
    items: ChecklistItem[];
    stations: { required: string[] };
  }>(join(INFRA_DIR, "diagram-checklist.json"));
  for (const item of checklist.items) {
    const kinds = new Set(item.kinds);
    const found = [...g.segments.values()].some(
      (s) =>
        kinds.has(s.kind)
        && s.coords.some((c) => distM(c, item.near) <= item.radius),
    );
    if (!found)
      err(
        `Checklist: ${item.name} not found (${item.kinds.join("/")} within ${item.radius} m of ${item.near.join(",")})`,
      );
  }
  for (const name of checklist.stations.required) {
    const has = [...report.assignments.values()].some((a) =>
      a.name.startsWith(name),
    );
    if (!has) err(`Checklist: station ${name} has no mapped platform`);
  }
  console.log(
    `Checklist: ${checklist.items.length} features, ${checklist.stations.required.length} stations checked`,
  );

  for (const w of warnings) console.log(`  warn: ${w}`);
  for (const e of errors) console.log(`  ERROR: ${e}`);
  console.log(`${errors.length} errors, ${warnings.length} warnings`);
  if (errors.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
