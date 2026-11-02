// Every feed's layers stacked by type (packages/transit-map/README.md#feeds): each layer goes with
// the other feeds' layers of the same name, in the order one feed's are drawn, so every feed's
// SkyTrain and ferries draw over every feed's buses, and every feed's labels over every feed's lines.
// A layer is placed by its name's rank whatever order the feeds' layers are added in (a feed's plan
// can be redrawn while another's stay), and layers of the host's or the engine's own in between
// (the vehicles, the selected place's ring) keep their place among them.

import type { LayerSpecification, Map as MlMap } from "maplibre-gl";

/** Layer names (`FeedIds.layer`), bottom to top: static.ts's, then tracks.ts's. */
const LAYER_ORDER = [
  // Bus corridors (static.ts → addStaticLayers), zoomed out and close in.
  ...["corridors-overview", "corridors"].flatMap((c) => [
    `${c}-casing`,
    `${c}-idle`,
    c,
    `${c}-brand-casing`,
    `${c}-brand`,
  ]),
  "routes-bus",
  "routes-bus-limited",
  "routes-shape-inactive",
  "routes-shape",
  "routes-skytrain-casing",
  "routes-skytrain",
  "bus-stops",
  // SkyTrain's track (tracks.ts → addTrackLayers).
  "tracks-yard",
  "tracks-other",
  "rail-casing",
  "tracks-minor",
  "rail-centre",
  "rail-shared",
  "rail-centre-focus",
  "rail-shared-focus",
  "rail-ribbon",
  "tracks-works",
  "tracks-hairline",
  "tracks-focus",
  // The focused route over everything but places and labels (FOCUS_LAYERS_START).
  ...["corridors-overview", "corridors"].flatMap((c) => [
    `${c}-focus-casing`,
    `${c}-focus`,
    `${c}-brand-focus-casing`,
    `${c}-brand-focus`,
  ]),
  "bus-stops-focus",
  "exchanges",
  "stations",
  // Labels: where they collide, stations' win over exchanges', and exchanges' over stops'.
  "bus-stops-label",
  "exchanges-label",
  "stations-label",
  // ?debug=1 (tracks.ts → addTrackDebugLayers).
  "tracks-nodes",
  "debug-seg-labels",
  "debug-platforms",
];
const RANK = new Map(LAYER_ORDER.map((name, i) => [name, i]));

/** A feed's layer's rank ("<feed>/<name>"), or undefined for any other layer. */
function rankOf(layerId: string): number | undefined {
  const slash = layerId.indexOf("/");
  return slash < 0 ? undefined : RANK.get(layerId.slice(slash + 1));
}

/**
 * Add a feed's layer (its id "<feed>/<name>", a name in LAYER_ORDER) just above the last layer of
 * its rank or lower, else beneath the first of a higher rank, else on top.
 */
export function addFeedLayer(map: MlMap, layer: LayerSpecification): void {
  const rank = rankOf(layer.id);
  if (rank === undefined)
    throw new Error(`${layer.id} isn't a feed layer in LAYER_ORDER`);
  const order = map.getLayersOrder();
  let last = -1;
  let above: string | undefined;
  for (let i = 0; i < order.length; i++) {
    const r = rankOf(order[i]!);
    if (r === undefined) continue;
    if (r <= rank) last = i;
    else above ??= order[i];
  }
  map.addLayer(layer, last >= 0 ? order[last + 1] : above);
}

/** The lowest of every feed's layers named `name` or ranked above it, if any is on the map. */
export function firstFeedLayer(map: MlMap, name: string): string | undefined {
  const rank = RANK.get(name);
  if (rank === undefined) throw new Error(`${name} isn't in LAYER_ORDER`);
  return map.getLayersOrder().find((id) => (rankOf(id) ?? -1) >= rank);
}
