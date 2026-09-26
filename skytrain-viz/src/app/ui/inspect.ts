// Details card for the selected vehicle. It follows the vehicle by id each frame and says plainly
// whether the position is observed or estimated.

import type { VehicleState } from '../../core/schedule/engine.ts';
import type { PlanRoute } from '../../core/plan/types.ts';

const STATUS: Record<VehicleState['status'], string> = {
  moving: 'Next stop',
  dwell: 'At',
  layover: 'Layover at',
};

const PROVENANCE: Record<VehicleState['provenance'], string> = {
  observed: 'Observed position',
  interpolated: 'Interpolated between observations',
  estimated: 'Estimated from schedule',
};

function cleanStopName(name: string | undefined): string {
  return (name ?? '').replace(/\s+Station\s+@\s+/i, ' · ').replace(/\s+Station$/i, '');
}

export class InspectCard {
  private root: HTMLElement;
  private lastHtml = '';
  onClose: (() => void) | undefined;

  constructor(id: string) {
    this.root = document.getElementById(id)!;
    this.root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.inspect-close')) this.onClose?.();
    });
  }

  show(v: VehicleState | undefined, route: PlanRoute | undefined, missing: boolean): void {
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
    const rows = [
      [STATUS[v.status], cleanStopName(v.stopName)],
      ['Trip', v.tripId],
      v.label ? ['Vehicle', v.label] : undefined,
      speed ? ['Speed', speed] : undefined,
      delay ? ['Schedule', delay] : undefined,
    ].filter(Boolean) as [string, string][];
    this.set(`
      <button class="inspect-close" aria-label="Close">×</button>
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
