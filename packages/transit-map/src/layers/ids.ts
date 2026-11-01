// Each feed's sources and layers have ids of their own, so feeds' layers never collide on the map
// (packages/transit-map/README.md#feeds): "<feed>/<name>", e.g. "translink/lines" and
// "translink/bus-stops". Map global state that holds one feed's data (its route colours, its ferry
// berth pair) is per feed too; the focus is map-wide and names its route with the feed (src/keys.ts).

export interface FeedIds {
  feed: string;
  /** The plan's tiles: every line drawn (PLAN_TILE_LAYERS). */
  lines: string;
  stations: string;
  exchanges: string;
  busStops: string;
  busTicks: string;
  /** The rail network's track (?debug=1), and its debug markers. */
  tracks: string;
  debug: string;
  /** Every source above. */
  sources: readonly string[];
  /** One of the feed's layers (static.ts, tracks.ts) by name: "bus-stops" → "<feed>/bus-stops". */
  layer: (name: string) => string;
  /** A layer id's name, or undefined for another feed's layer (or none of ours). */
  nameOf: (layerId: string) => string | undefined;
  /** A map global state property that holds this feed's data. */
  state: (name: string) => string;
}

const cache = new Map<string, FeedIds>();

export function feedIds(feed: string): FeedIds {
  let ids = cache.get(feed);
  if (ids) return ids;
  const prefix = `${feed}/`;
  const id = (name: string) => prefix + name;
  const sources = {
    lines: id("lines"),
    stations: id("stations"),
    exchanges: id("exchanges"),
    busStops: id("bus-stops-source"),
    busTicks: id("bus-ticks"),
    tracks: id("tracks-source"),
    debug: id("tracks-debug"),
  };
  ids = {
    feed,
    ...sources,
    sources: Object.values(sources),
    layer: id,
    nameOf: (layerId) =>
      layerId.startsWith(prefix) ? layerId.slice(prefix.length) : undefined,
    state: (name) => `${name}:${feed}`,
  };
  cache.set(feed, ids);
  return ids;
}
