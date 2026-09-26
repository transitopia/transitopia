// Convert the OSM extract (scripts/fetch-osm.ts) into our track model (PLAN.md §4.1):
//   data/infrastructure/tracks.generated.geojson   in-service track (committed; don't hand-edit)
//   data/infrastructure/future.generated.geojson   track with a future opening_date (scenario material)
//
// The network itself (segments, turns, stop positions) is built by src/core/infra/network.ts.

import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ROOT, RAW_DIR, log } from './lib/paths.ts';
import { loadOverrides } from './lib/infra.ts';
import { buildNetwork, type OsmNode, type OsmWay } from '../src/core/infra/network.ts';
import { composeNetwork } from '../src/core/scenario/network.ts';
import type { LineKey } from '../src/core/infra/types.ts';

const INFRA_DIR = join(ROOT, 'data', 'infrastructure');

interface OsmRelation {
  type: 'relation';
  id: number;
  members: { type: string; ref: number; role: string }[];
  tags?: Record<string, string>;
}
type OsmElement = OsmNode | OsmWay | OsmRelation;

function lineOf(name: string | undefined): LineKey | undefined {
  if (!name) return undefined;
  if (/^Expo Line/i.test(name)) return 'expo';
  if (/^Millennium Line/i.test(name)) return 'millennium';
  if (/^Canada Line/i.test(name)) return 'canada';
  return undefined;
}

function isFuture(tags: Record<string, string>, today: string): boolean {
  const d = tags.opening_date;
  // Existing track under works has a past start_date and a future (re)opening_date: it's current.
  const started = tags.start_date && tags.start_date <= today.slice(0, tags.start_date.length);
  return Boolean(d && d > today.slice(0, d.length) && !started);
}

/**
 * Track ways we model: railway=subway, plus existing SkyTrain track that OSM marks as under
 * construction/disused (e.g. the Braid–Lougheed Expo track, "opening_date 2027-06") when it is still
 * a member of a current route relation. GTFS keeps scheduling both tracks there, so we treat it as in
 * service but flag it (docs/OPEN-QUESTIONS.md #17).
 */
function isTrack(w: OsmWay, routeMembers: Set<number>): boolean {
  const t = w.tags ?? {};
  if (t.railway === 'subway') return true;
  const underWorks =
    (t.railway === 'construction' && t.construction === 'subway') ||
    (t.railway === 'disused' && (t['disused:railway'] === 'subway' || t.disused === 'subway'));
  return underWorks && routeMembers.has(w.id);
}

async function main() {
  const src = join(RAW_DIR, 'osm', 'latest.json');
  const raw = JSON.parse(await readFile(src, 'utf8')) as { osm3s?: { timestamp_osm_base?: string }; elements: OsmElement[] };
  const nodes = new Map<number, OsmNode>();
  const allWays = new Map<number, OsmWay>();
  const ways: OsmWay[] = [];
  const relations: OsmRelation[] = [];
  for (const e of raw.elements) {
    if (e.type === 'node') {
      // `out skel` repeats nodes without tags; keep the tagged copy.
      const prev = nodes.get(e.id);
      if (!prev || (!prev.tags && e.tags)) nodes.set(e.id, e);
    } else if (e.type === 'way') {
      // `out skel` also repeats ways without tags; keep the tagged copy.
      if (e.tags) allWays.set(e.id, e);
    } else relations.push(e);
  }
  const routeMembers = new Set<number>();
  for (const r of relations) if (lineOf(r.tags?.name)) for (const m of r.members) if (m.type === 'way') routeMembers.add(m.ref);
  const { osm: osmOverrides } = await loadOverrides();
  const include = new Set(osmOverrides.includeWays);
  const exclude = new Set(osmOverrides.excludeWays);
  for (const w of allWays.values()) if (!exclude.has(w.id) && (include.has(w.id) || isTrack(w, routeMembers))) ways.push(w);
  const wayLines = new Map<number, Set<LineKey>>();
  for (const r of relations) {
    const line = lineOf(r.tags?.name);
    if (!line) continue;
    for (const m of r.members) {
      if (m.type !== 'way' || (m.role !== '' && m.role !== 'forward' && m.role !== 'backward')) continue;
      (wayLines.get(m.ref) ?? wayLines.set(m.ref, new Set()).get(m.ref)!).add(line);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const current = ways.filter((w) => !isFuture(w.tags ?? {}, today));
  const future = ways.filter((w) => isFuture(w.tags ?? {}, today));
  const stopNodes = [...nodes.values()].filter(
    (n) => n.tags && (n.tags.public_transport === 'stop_position' || n.tags.railway === 'stop'),
  );
  const meta = {
    source: 'OpenStreetMap (© OpenStreetMap contributors, ODbL) via Overpass; scripts/import-osm.ts',
    ...(raw.osm3s?.timestamp_osm_base ? { osmTimestamp: raw.osm3s.timestamp_osm_base } : {}),
    generatedAt: new Date().toISOString(),
  };
  await mkdir(INFRA_DIR, { recursive: true });

  let base = buildNetwork(current, nodes, wayLines, stopNodes, meta);
  // Track missing from OSM (overrides.addTrack), joined by coordinates like scenario track.
  const { addTrack } = await loadOverrides();
  if (addTrack) {
    const custom = JSON.parse(await readFile(join(INFRA_DIR, addTrack), 'utf8'));
    const composed = composeNetwork({ base: base.fc, custom });
    composed.fc.metadata = { ...meta, note: `Includes ${custom.features.length} added track pieces from ${addTrack}` };
    base = composed;
  }
  await writeFile(join(INFRA_DIR, 'tracks.generated.geojson'), `${JSON.stringify(base.fc)}\n`);
  log(`tracks.generated.geojson: ${JSON.stringify(base.stats)}`);

  // Future track is imported together with the base network so its connections are correct, then
  // only the future segments are kept.
  const all = buildNetwork(ways, nodes, wayLines, [], { ...meta, note: 'Track with a future opening_date; for scenarios' });
  const futureIds = new Set(future.map((w) => w.id));
  all.fc.features = all.fc.features.filter((f) => f.properties.type === 'segment' && futureIds.has(f.properties.osmWay));
  await writeFile(join(INFRA_DIR, 'future.generated.geojson'), `${JSON.stringify(all.fc)}\n`);
  log(`future.generated.geojson: ${all.fc.features.length} segments (${future.length} OSM ways with a future opening_date)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
