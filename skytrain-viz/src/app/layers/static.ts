// Static transit layers drawn by MapLibre: route lines from GTFS shapes, and stations.
// Track-level SkyTrain geometry (PLAN.md §4.1) will replace the SkyTrain shapes in M3.

import type { FeatureCollection, Feature } from 'geojson';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { ServicePlan } from '../../core/plan/types.ts';
import { routeSections } from '../../core/plan/coverage.ts';
import { busStopMarkers } from '../../core/plan/bus-stops.ts';
import type { Theme } from '../basemap.ts';

export const ROUTES_SOURCE = 'transit-routes';
export const STATIONS_SOURCE = 'transit-stations';
export const BUS_STOPS_SOURCE = 'transit-bus-stops';
/** Vehicles are inserted beneath this layer, so stop and station labels stay readable above them. */
export const VEHICLES_BEFORE_LAYER = 'bus-stops-label';

const KIND_ORDER: Record<string, number> = { bus: 0, shape: 1, skytrain: 2 };
const BUS_FREQUENT: ExpressionSpecification = ['all', ['==', ['get', 'kind'], 'bus'], ['!', ['get', 'limited']]];
const BUS_LIMITED: ExpressionSpecification = ['all', ['==', ['get', 'kind'], 'bus'], ['get', 'limited']];

function routesGeoJson(plan: ServicePlan): FeatureCollection {
  const features: Feature[] = [];
  const seen = new Set<string>();
  // Buses: split into frequent and limited-service sections (drawn dashed).
  const busRoutes = new Set(plan.routes.filter((r) => r.kind === 'bus').map((r) => r.key));
  for (const sec of routeSections(plan, busRoutes)) {
    const route = plan.routes.find((r) => r.key === sec.route)!;
    features.push({
      type: 'Feature',
      properties: { route: route.key, kind: route.kind, mode: route.mode, color: route.color, order: 0, limited: sec.limited },
      geometry: { type: 'LineString', coordinates: sec.coords },
    });
  }
  const used = new Set(plan.trips.map((t) => t.pattern));
  for (const p of plan.patterns) {
    const key = `${p.route}|${p.shape}`;
    if (seen.has(key) || busRoutes.has(p.route) || !used.has(p.id)) continue;
    seen.add(key);
    const route = plan.routes.find((r) => r.key === p.route)!;
    const coords = plan.shapes[p.shape];
    if (!coords) continue;
    features.push({
      type: 'Feature',
      properties: { route: route.key, kind: route.kind, mode: route.mode, color: route.color, order: KIND_ORDER[route.kind] ?? 0 },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }
  return { type: 'FeatureCollection', features };
}

function busStopsGeoJson(plan: ServicePlan): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: busStopMarkers(plan).map((s) => ({
      type: 'Feature' as const,
      properties: {
        name: s.name,
        // ",99,R4," so filters can test membership with a substring match.
        routes: `,${s.routes.join(',')},`,
        n: s.routes.length,
        color: plan.routes.find((r) => r.key === s.routes[0])?.color ?? '#888',
      },
      geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
    })),
  };
}

function stationsGeoJson(plan: ServicePlan): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: plan.stations.map((s) => {
      const modes = new Set(s.routes.map((k) => plan.routes.find((r) => r.key === k)?.mode));
      return {
        type: 'Feature' as const,
        properties: {
          id: s.id,
          name: s.name,
          routes: s.routes.join(','),
          interchange: s.routes.length > 1,
          skytrain: modes.has('skytrain'),
        },
        geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
      };
    }),
  };
}

export function addStaticLayers(map: MlMap, plan: ServicePlan, theme: Theme, hiddenRoutes: Set<string>): void {
  const routes: GeoJSONSourceSpecification = { type: 'geojson', data: routesGeoJson(plan) };
  const stations: GeoJSONSourceSpecification = { type: 'geojson', data: stationsGeoJson(plan) };
  if (map.getSource(ROUTES_SOURCE)) {
    (map.getSource(ROUTES_SOURCE) as GeoJSONSource).setData(routes.data as FeatureCollection);
    (map.getSource(STATIONS_SOURCE) as GeoJSONSource).setData(stations.data as FeatureCollection);
    (map.getSource(BUS_STOPS_SOURCE) as GeoJSONSource).setData(busStopsGeoJson(plan));
    applyRouteFilter(map, hiddenRoutes);
    return;
  }
  map.addSource(ROUTES_SOURCE, routes);
  map.addSource(STATIONS_SOURCE, stations);
  map.addSource(BUS_STOPS_SOURCE, { type: 'geojson', data: busStopsGeoJson(plan) });
  const dark = theme === 'dark';
  const casing = dark ? '#111418' : '#ffffff';
  const text = dark ? '#e6e8eb' : '#1f2328';
  const halo = dark ? '#111418' : '#ffffff';
  const mutedText = dark ? '#aeb4bb' : '#4b525a';

  map.addLayer({
    id: 'routes-bus',
    type: 'line',
    source: ROUTES_SOURCE,
    filter: BUS_FREQUENT,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-opacity': 0.55,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 13, 2, 16, 4],
    },
  });
  map.addLayer({
    id: 'routes-bus-limited',
    type: 'line',
    source: ROUTES_SOURCE,
    filter: BUS_LIMITED,
    layout: { 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-opacity': 0.5,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 13, 2, 16, 4],
      'line-dasharray': [1, 2],
    },
  });
  map.addLayer({
    id: 'routes-shape',
    type: 'line',
    source: ROUTES_SOURCE,
    filter: ['==', ['get', 'kind'], 'shape'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 13, 3, 16, 5],
    },
  });
  map.addLayer({
    id: 'routes-skytrain-casing',
    type: 'line',
    source: ROUTES_SOURCE,
    filter: ['==', ['get', 'kind'], 'skytrain'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': casing,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 13, 7, 15, 8, 18, 6],
    },
  });
  map.addLayer({
    id: 'routes-skytrain',
    type: 'line',
    source: ROUTES_SOURCE,
    filter: ['==', ['get', 'kind'], 'skytrain'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 13, 4.5, 15, 5, 18, 3.5],
    },
  });
  // Express bus stops: smaller than stations, ringed in the route colour, labelled only close in.
  map.addLayer({
    id: 'bus-stops',
    type: 'circle',
    source: BUS_STOPS_SOURCE,
    minzoom: 12,
    paint: {
      'circle-color': casing,
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 2],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 14, 3, 17, 5],
    },
  });
  map.addLayer({
    id: 'stations',
    type: 'circle',
    source: STATIONS_SOURCE,
    paint: {
      'circle-color': casing,
      'circle-stroke-color': text,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 14, 2],
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        9,
        ['case', ['get', 'interchange'], 3, 2],
        14,
        ['case', ['get', 'interchange'], 7, 5],
        17,
        ['case', ['get', 'interchange'], 10, 8],
      ],
    },
  });
  map.addLayer({
    id: 'stations-label',
    type: 'symbol',
    source: STATIONS_SOURCE,
    minzoom: 11,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Medium'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 15, 13],
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-optional': true,
      'symbol-sort-key': ['case', ['get', 'interchange'], 0, 1],
    },
    paint: { 'text-color': text, 'text-halo-color': halo, 'text-halo-width': 1.5 },
  });
  map.addLayer(
    {
      id: VEHICLES_BEFORE_LAYER,
      type: 'symbol',
      source: BUS_STOPS_SOURCE,
      minzoom: 14,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 9, 17, 11],
        'text-offset': [0, 0.8],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: { 'text-color': mutedText, 'text-halo-color': halo, 'text-halo-width': 1.2 },
    },
    'stations-label',
  );
  applyRouteFilter(map, hiddenRoutes);
}

export function applyRouteFilter(map: MlMap, hidden: Set<string>): void {
  const visible: ExpressionSpecification = ['!', ['in', ['get', 'route'], ['literal', [...hidden]]]];
  for (const [id, base] of [
    ['routes-bus', BUS_FREQUENT],
    ['routes-bus-limited', BUS_LIMITED],
    ['routes-shape', ['==', ['get', 'kind'], 'shape']],
    ['routes-skytrain-casing', ['==', ['get', 'kind'], 'skytrain']],
    ['routes-skytrain', ['==', ['get', 'kind'], 'skytrain']],
  ] as [string, ExpressionSpecification][]) {
    if (map.getLayer(id)) map.setFilter(id, ['all', base, visible]);
  }
  // A bus stop shows while any of its routes is visible.
  const hiddenAtStop: ExpressionSpecification = ['+', 0, 0, ...[...hidden].map((r) => ['case', ['in', `,${r},`, ['get', 'routes']], 1, 0] as ExpressionSpecification)];
  const stopVisible: ExpressionSpecification = ['<', hiddenAtStop, ['get', 'n']];
  for (const id of ['bus-stops', VEHICLES_BEFORE_LAYER]) if (map.getLayer(id)) map.setFilter(id, stopVisible);
}
