// Details card for the selected vehicle. It follows the vehicle by id each frame and says plainly
// whether the position is observed or estimated.

import type { VehicleState } from '../../core/schedule/engine.ts';
import type { PlanRoute } from '../../core/plan/types.ts';

const STATUS: Record<VehicleState['status'], string> = {
  moving: 'Next stop',
  dwell: 'At',
  layover: 'Layover at',
  turnback: 'Turning back',
  pullout: 'Leaving yard',
  pullin: 'To yard',
};

const PROVENANCE: Record<VehicleState['provenance'], string> = {
  observed: 'Observed position',
  interpolated: 'Interpolated or predicted from observations',
  estimated: 'Estimated from schedule',
};

function cleanStopName(name: string | undefined): string {
  return (name ?? '').replace(/\s+Station\s+@\s+/i, ' · ').replace(/\s+Station$/i, '');
}

export class InspectCard {
  private root: HTMLElement;
  private lastHtml = '';
  onClose: (() => void) | undefined;
  onLocate: (() => void) | undefined;

  constructor(id: string) {
    this.root = document.getElementById(id)!;
    this.root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.inspect-close')) this.onClose?.();
      if (target.closest('.inspect-locate')) this.onLocate?.();
    });
  }

  show(v: VehicleState | undefined, route: PlanRoute | undefined, missing: boolean, now = 0): void {
    if (!v || !route) {
      this.root.hidden = !missing;
      if (missing) this.set('<button class="inspect-close" aria-label="Close">×</button><p class="muted">Vehicle not in service at this time.</p>');
      return;
    }
    this.root.hidden = false;
    const speed = v.speed !== undefined && v.status === 'moving' ? `${Math.round(v.speed * 3.6)} km/h` : '';
    const delay =
      v.delay !== undefined && Math.abs(v.delay) >= 30
        ? `${Math.round(Math.abs(v.delay) / 60)} min ${v.delay > 0 ? 'late' : 'early'}`
        : v.delay !== undefined
          ? 'on time'
          : '';
    const ago = v.observedAt !== undefined ? Math.max(0, Math.round((now - v.observedAt) / 1000)) : undefined;
    const rows = [
      [STATUS[v.status], cleanStopName(v.stopName)],
      v.tripId ? ['Trip', v.tripId] : undefined,
      v.runId ? ['Train (inferred)', v.runId] : undefined,
      v.label ? ['Vehicle', v.label] : undefined,
      v.consist?.name ? ['Name', v.consist.name] : undefined,
      v.consist && (v.consist.cars || v.consist.type || v.consist.carNumbers?.length)
        ? ['Consist', [v.consist.cars ? `${v.consist.cars}-car` : '', v.consist.type ?? '', v.consist.carNumbers?.length ? `(${v.consist.carNumbers.join(' ')})` : ''].filter(Boolean).join(' ')]
        : undefined,
      speed ? ['Speed', speed] : undefined,
      delay ? ['Schedule', delay] : undefined,
      ago !== undefined ? ['Last fix', ago < 90 ? `${ago} s from shown time` : `${Math.round(ago / 60)} min from shown time`] : undefined,
    ].filter(Boolean) as [string, string][];
    this.set(`
      <button class="inspect-close" aria-label="Close">×</button>
      <button class="inspect-locate" aria-label="Centre map on this vehicle" title="Centre map on this vehicle">⌖</button>
      <div class="inspect-head"><span class="swatch swatch-${route.kind}" style="--c:${route.color}"></span>
        <strong>${escapeHtml(route.label)}</strong></div>
      <div class="inspect-headsign">${escapeHtml(v.headsign.replace(/^.*?\bTo\s+/i, 'To '))}</div>
      <dl>${rows.map(([k, val]) => `<dt>${k}</dt><dd>${escapeHtml(val)}</dd>`).join('')}</dl>
      <div class="inspect-prov"><span class="prov prov-${v.provenance}"></span>${PROVENANCE[v.provenance]}
        <span class="muted">· ${escapeHtml(v.source)}</span></div>`);
  }

  private set(html: string): void {
    if (html === this.lastHtml) return;
    this.lastHtml = html;
    this.root.innerHTML = html;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
