// Collapsible legend with per-route visibility toggles. Hidden routes persist per browser.

import type { PlanRoute } from '../../core/plan/types.ts';
import { loadPref, savePref } from '../prefs.ts';

const GROUPS: { title: string; kinds: PlanRoute['kind'][] }[] = [
  { title: 'SkyTrain', kinds: ['skytrain'] },
  { title: 'SeaBus & West Coast Express', kinds: ['shape'] },
  { title: 'Express buses', kinds: ['bus'] },
];

export class Legend {
  readonly hidden: Set<string>;
  private root: HTMLElement;
  private body: HTMLElement;
  onChange: (() => void) | undefined;

  constructor(rootId: string) {
    this.root = document.getElementById(rootId)!;
    this.hidden = new Set(loadPref<string[]>('hiddenRoutes', []));
    const toggle = this.root.querySelector<HTMLButtonElement>('.legend-toggle')!;
    this.body = this.root.querySelector<HTMLElement>('.legend-body')!;
    const collapsed = loadPref<boolean>('legendCollapsed', window.matchMedia('(max-width: 640px)').matches);
    this.setCollapsed(collapsed);
    toggle.addEventListener('click', () => {
      const next = !this.root.classList.contains('collapsed');
      this.setCollapsed(next);
      savePref('legendCollapsed', next);
    });
  }

  private setCollapsed(c: boolean): void {
    this.root.classList.toggle('collapsed', c);
    this.root.querySelector('.legend-toggle')?.setAttribute('aria-expanded', String(!c));
  }

  render(routes: PlanRoute[]): void {
    this.body.replaceChildren();
    for (const g of GROUPS) {
      const rs = routes.filter((r) => g.kinds.includes(r.kind));
      if (!rs.length) continue;
      const h = document.createElement('h3');
      h.textContent = g.title;
      this.body.append(h);
      for (const r of rs) {
        const label = document.createElement('label');
        label.className = 'legend-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !this.hidden.has(r.key);
        cb.addEventListener('change', () => {
          if (cb.checked) this.hidden.delete(r.key);
          else this.hidden.add(r.key);
          savePref('hiddenRoutes', [...this.hidden]);
          this.onChange?.();
        });
        const sw = document.createElement('span');
        sw.className = `swatch swatch-${r.kind}`;
        sw.style.setProperty('--c', r.color);
        const name = document.createElement('span');
        name.textContent = r.label;
        label.append(cb, sw, name);
        this.body.append(label);
      }
    }
    const note = document.createElement('p');
    note.className = 'legend-note';
    note.innerHTML =
      '<span class="prov prov-estimated"></span> estimated from schedule &nbsp; <span class="prov prov-observed"></span> observed<br>' +
      '<span class="swatch swatch-limited"></span> bus route: limited service';
    this.body.append(note);
  }
}
