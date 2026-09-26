import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { Map as MlMap, NavigationControl, ScaleControl, addProtocol, setWorkerUrl } from 'maplibre-gl';
// maplibre locates its worker relative to its own module URL, which bundling breaks; hand it a
// Vite-built worker (with its shared chunk inlined) instead.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol } from 'pmtiles';
import { Clock } from './clock.ts';
import { PlanStore, displayServiceDate, kinematics } from './plans.ts';
import { basemapStyle, type Theme } from './basemap.ts';
import { addStaticLayers, applyRouteFilter } from './layers/static.ts';
import { VehicleLayer } from './layers/vehicles.ts';
import { Timebar } from './ui/timebar.ts';
import { Legend } from './ui/legend.ts';
import { InspectCard } from './ui/inspect.ts';
import { readUrl, writeUrl } from './url.ts';
import { RtClient, type RtMode } from './rt.ts';
import { loadPref, savePref } from './prefs.ts';
import { makeServiceDescriber, type ServiceDayInfo } from '../core/gtfs/describe.ts';
import { feedForDate } from '../core/plan/types.ts';
import type { PreparedPlan, VehicleState } from '../core/schedule/engine.ts';

type ThemePref = 'auto' | Theme;

/** First view (when the URL has no map position): the SkyTrain network, UBC to King George. */
const INITIAL_BOUNDS: [[number, number], [number, number]] = [
  [-123.2, 49.17],
  [-122.79, 49.32],
];
const MAX_BOUNDS: [[number, number], [number, number]] = [
  [-123.6, 48.95],
  [-121.9, 49.55],
];

function resolveTheme(pref: ThemePref): Theme {
  if (pref !== 'auto') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function showError(message: string): void {
  const box = document.getElementById('error')!;
  box.textContent = message;
  box.hidden = false;
}

async function main(): Promise<void> {
  setWorkerUrl(maplibreWorkerUrl);
  const protocol = new Protocol();
  addProtocol('pmtiles', protocol.tile);

  const store = await PlanStore.load();
  const range = store.range();
  if (!range) throw new Error('The timetable manifest lists no feeds. Run "npm run data".');

  const url = readUrl();
  const clock = new Clock(url.t ?? Date.now());
  clock.setBounds(range[0], range[1]);
  if (url.t === undefined && (Date.now() < range[0] || Date.now() > range[1])) clock.seek(range[0] + 8 * 3600_000);
  if (url.rate !== undefined) clock.setRate(url.rate);
  if (url.paused) clock.pause();

  let themePref = loadPref<ThemePref>('theme', 'auto');
  let theme = resolveTheme(themePref);
  document.documentElement.dataset.theme = theme;

  const map = new MlMap({
    container: 'map',
    style: basemapStyle(theme),
    bounds: location.hash.includes('map=') ? undefined : INITIAL_BOUNDS,
    fitBoundsOptions: { padding: { top: 40, bottom: 130, left: 20, right: 50 } },
    maxBounds: MAX_BOUNDS,
    hash: 'map',
    attributionControl: { compact: true },
    dragRotate: true,
    pitchWithRotate: false,
  });
  map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');

  const vehicles = new VehicleLayer(map, kinematics.sizing);
  const legend = new Legend('legend');
  const inspect = new InspectCard('inspect');
  let selected: string | undefined = url.vehicle;
  vehicles.selectedId = selected;
  inspect.onClose = () => {
    selected = vehicles.selectedId = undefined;
    writeUrl(clock, selected);
  };

  // Service-day descriptions, per feed.
  const describers = new Map<string, (d: string) => ServiceDayInfo>();
  const describeDate = (date: string): string => {
    const feed = feedForDate(store.manifest, date);
    const pp = store.planFor(date);
    if (!feed) return 'No timetable for this date';
    if (!pp) return '…';
    let fn = describers.get(feed.version);
    if (!fn) describers.set(feed.version, (fn = makeServiceDescriber(pp.servicesOn, pp.plan.feedStart, pp.plan.feedEnd)));
    return fn(date).label;
  };

  const timebar = new Timebar({
    clock,
    describeDate,
    dateRange: () => {
      const f = store.manifest.feeds;
      return f.length ? [f.map((x) => x.start).sort()[0]!, f.map((x) => x.end).sort().at(-1)!] : undefined;
    },
  });

  // Static layers follow the feed of the displayed date.
  let shownFeed: PreparedPlan | undefined;
  const syncStatic = (force = false) => {
    const pp = store.planFor(displayServiceDate(clock.now()));
    if (!pp || !map.isStyleLoaded()) return;
    if (pp === shownFeed && !force) return;
    shownFeed = pp;
    addStaticLayers(map, pp.plan, theme, legend.hidden);
    vehicles.attach();
    vehicles.setRouteColors(pp.plan.routes);
    legend.render(pp.plan.routes);
  };
  map.on('style.load', () => syncStatic(true));
  store.onChange(() => {
    syncStatic();
    timebar.invalidate();
  });
  legend.onChange = () => applyRouteFilter(map, legend.hidden);

  // Theme toggle: auto → light → dark.
  const themeBtn = document.getElementById('theme-toggle') as HTMLButtonElement;
  const renderThemeBtn = () => {
    themeBtn.textContent = { auto: '◐', light: '☀', dark: '☾' }[themePref];
    themeBtn.title = `Theme: ${themePref}`;
  };
  renderThemeBtn();
  themeBtn.addEventListener('click', () => {
    themePref = themePref === 'auto' ? 'light' : themePref === 'light' ? 'dark' : 'auto';
    savePref('theme', themePref);
    renderThemeBtn();
    const next = resolveTheme(themePref);
    if (next !== theme) {
      theme = next;
      document.documentElement.dataset.theme = theme;
      map.setStyle(basemapStyle(theme));
    }
  });

  // Selection and hover.
  map.on('click', (e) => {
    const v = vehicles.pickAt(e.point.x, e.point.y);
    selected = vehicles.selectedId = v?.id;
    writeUrl(clock, selected);
  });
  map.on('mousemove', (e) => {
    map.getCanvas().style.cursor = vehicles.pickAt(e.point.x, e.point.y) ? 'pointer' : '';
  });

  // URL sync: on discrete changes, and periodically while playing away from live.
  clock.subscribe(() => writeUrl(clock, selected));
  let lastUrlWrite = 0;

  // Real-time buses: replace schedule estimates wherever RT data covers the instant.
  const rt = new RtClient();
  const RT_BADGE: Record<RtMode, [string, string]> = {
    live: ['Buses: live', 'Bus positions from TransLink real-time data'],
    recorded: ['Buses: recorded', 'Bus positions replayed from recorded real-time data'],
    estimated: ['Buses: estimated', 'No real-time data recorded for this time: bus positions estimated from the schedule'],
    unavailable: ['Buses: estimated', 'Real-time service unavailable: bus positions estimated from the schedule'],
  };
  let lastCoverageUpdate = 0;

  // Render loop.
  let lastVehicles: VehicleState[] = [];
  const frame = () => {
    const t = clock.now();
    const visible = legend.hidden.size ? new Set(routeKeys(shownFeed).filter((k) => !legend.hidden.has(k))) : undefined;
    rt.update(t);
    const live = rt.vehiclesAt(t, store.planFor(displayServiceDate(t)), visible);
    const scheduled = store.vehiclesAt(t, visible);
    lastVehicles = live.vehicles ? [...scheduled.filter((v) => v.mode !== 'bus'), ...live.vehicles] : scheduled;
    const [badge, badgeTitle] = RT_BADGE[live.mode];
    timebar.setRtBadge(badge, live.mode, rt.liveStatus() ? `${badgeTitle} (${rt.liveStatus()})` : badgeTitle);
    if (performance.now() - lastCoverageUpdate > 1000) {
      lastCoverageUpdate = performance.now();
      const [lo, hi] = timebar.sliderRange(t);
      timebar.setCoverage(t, rt.coverageFor(lo, hi));
    }
    vehicles.update(lastVehicles, theme === 'dark');
    timebar.tick(t);
    syncStatic();
    if (selected) {
      const v = lastVehicles.find((x) => x.id === selected);
      inspect.show(v, v ? shownFeed?.routes.get(v.routeKey) : undefined, !v, t);
    } else inspect.show(undefined, undefined, false);
    const now = performance.now();
    if (now - lastUrlWrite > 2000 && clock.playing && !clock.isLive()) {
      lastUrlWrite = now;
      writeUrl(clock, selected);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Debug handle for the console.
  Object.assign(window, { skytrain: { map, clock, store, rt, vehicles: () => lastVehicles } });
}

function routeKeys(pp: PreparedPlan | undefined): string[] {
  return pp ? pp.plan.routes.map((r) => r.key) : [];
}

main().catch((e: unknown) => {
  console.error(e);
  showError(e instanceof Error ? e.message : String(e));
});
