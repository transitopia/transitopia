// Every dataset the site shows, with its credit and license (docs/DESIGN.md#attribution, DATA-LICENSES.md). Map layers and
// the transit engine declare which of these they draw from, and the attribution control credits
// exactly the ones visible.

export type DatasetId =
  | "osm"
  | "protomaps"
  | "transitopia"
  | "translink-gtfs"
  | "translink-gtfs-rt"
  | "bc-transit-gtfs"
  | "bc-transit-gtfs-rt"
  | "aisstream";

export interface Dataset {
  id: DatasetId;
  /** Short credit for the collapsed control, e.g. "© OpenStreetMap". */
  credit: string;
  /** Full text for the expanded control, when the license asks for more than the credit. */
  legend?: string;
  url: string;
  /** Omitted when the provider publishes no terms or license to cite. */
  license?: { name: string; url?: string };
  /** A schedule's real-time companion from the same provider (its GTFS-RT). */
  realtime?: DatasetId;
}

const TRANSLINK_LEGEND =
  "Some of the data used in this product or service is provided by permission of TransLink. TransLink assumes no responsibility for the accuracy or currency of the Data used in this product or service.";
const TRANSLINK_TERMS = {
  name: "TransLink Open API terms of use",
  url: "https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/terms-of-use",
};

// BC Transit's terms ask that it be identified as the source, with no wording prescribed, and
// forbid using its marks: the credit names it, no legend.
const BC_TRANSIT_TERMS = {
  name: "BC Transit open data terms of use",
  url: "https://www.bctransit.com/open-data/terms-of-use/",
};

export const DATASETS: Record<DatasetId, Dataset> = {
  osm: {
    id: "osm",
    credit: "© OpenStreetMap contributors",
    url: "https://www.openstreetmap.org/copyright",
    license: {
      name: "ODbL 1.0",
      url: "https://opendatacommons.org/licenses/odbl/1-0/",
    },
  },
  protomaps: {
    id: "protomaps",
    credit: "Protomaps",
    url: "https://protomaps.com",
    license: {
      name: "Basemap tiles derived from OpenStreetMap (ODbL)",
      url: "https://github.com/protomaps/basemaps",
    },
  },
  transitopia: {
    id: "transitopia",
    credit: "© Transitopia contributors",
    legend:
      "Track infrastructure, corrections and cycling data curated by Transitopia contributors.",
    url: "https://github.com/transitopia/transitopia/blob/main/DATA-LICENSES.md",
    license: {
      name: "ODbL 1.0",
      url: "https://opendatacommons.org/licenses/odbl/1-0/",
    },
  },
  "translink-gtfs": {
    id: "translink-gtfs",
    credit: "Schedules: TransLink",
    legend: TRANSLINK_LEGEND,
    realtime: "translink-gtfs-rt",
    url: "https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources",
    license: TRANSLINK_TERMS,
  },
  "translink-gtfs-rt": {
    id: "translink-gtfs-rt",
    credit: "Real-time: TransLink",
    legend: TRANSLINK_LEGEND,
    url: "https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-realtime",
    license: TRANSLINK_TERMS,
  },
  "bc-transit-gtfs": {
    id: "bc-transit-gtfs",
    credit: "Schedules: BC Transit",
    realtime: "bc-transit-gtfs-rt",
    url: "https://www.bctransit.com/open-data/",
    license: BC_TRANSIT_TERMS,
  },
  "bc-transit-gtfs-rt": {
    id: "bc-transit-gtfs-rt",
    credit: "Real-time: BC Transit",
    url: "https://www.bctransit.com/open-data/",
    license: BC_TRANSIT_TERMS,
  },
  aisstream: {
    id: "aisstream",
    credit: "Vessel positions: aisstream.io",
    url: "https://aisstream.io",
  },
};

/** The real-time dataset that goes with a schedule dataset, if its provider has one. */
export function realtimeOf(id: string): DatasetId | undefined {
  return (DATASETS as Record<string, Dataset | undefined>)[id]?.realtime;
}

/** The datasets to credit, deduplicated, in registry order. Unknown ids are ignored. */
export function creditsFor(ids: Iterable<string>): Dataset[] {
  const want = new Set(ids);
  return Object.values(DATASETS).filter((d) => want.has(d.id));
}

/** Legends to show in full, deduplicated (both TransLink datasets share one legend). */
export function legendsFor(datasets: Dataset[]): string[] {
  return [...new Set(datasets.flatMap((d) => (d.legend ? [d.legend] : [])))];
}
