// Time controls: play/pause, speed, date, scrub slider across the service day, and Live.
// The slider covers 03:00 → 27:00 of the displayed service date (GTFS service-day seconds).

import type { Clock } from '../clock.ts';
import { displayServiceDate, SERVICE_DAY_ROLLOVER_H } from '../plans.ts';
import { formatServiceDate, parseServiceDate, serviceDayStart, toWallTime } from '../../core/time.ts';

export const RATES = [-300, -60, -10, -1, 1, 10, 60, 300];
const SLIDER_START_S = SERVICE_DAY_ROLLOVER_H * 3600;
const SLIDER_END_S = (24 + SERVICE_DAY_ROLLOVER_H) * 3600;

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e as T;
}

function isoDate(d: string): string {
  const { year, month, day } = parseServiceDate(d);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function fromIsoDate(s: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? formatServiceDate(+m[1]!, +m[2]!, +m[3]!) : undefined;
}

function rateLabel(r: number): string {
  return r === 1 ? '1×' : r === -1 ? '−1×' : `${r < 0 ? '−' : ''}${Math.abs(r)}×`;
}

export interface TimebarDeps {
  clock: Clock;
  describeDate: (date: string) => string;
  dateRange: () => [string, string] | undefined;
}

export class Timebar {
  private play = el<HTMLButtonElement>('tb-play');
  private rate = el<HTMLSelectElement>('tb-rate');
  private date = el<HTMLInputElement>('tb-date');
  private time = el<HTMLElement>('tb-time');
  private service = el<HTMLElement>('tb-service');
  private live = el<HTMLButtonElement>('tb-live');
  private slider = el<HTMLInputElement>('tb-slider');
  private coverage = el<HTMLElement>('tb-coverage');
  private rtBadge = el<HTMLElement>('tb-rt');
  private lastCoverageKey = '';
  private scrubbing = false;
  private lastDate = '';

  constructor(private deps: TimebarDeps) {
    const { clock } = deps;
    for (const r of RATES) {
      const o = document.createElement('option');
      o.value = String(r);
      o.textContent = rateLabel(r);
      this.rate.append(o);
    }
    this.slider.min = String(SLIDER_START_S);
    this.slider.max = String(SLIDER_END_S);
    this.slider.step = '1';
    this.renderTicks();

    this.play.addEventListener('click', () => clock.toggle());
    this.rate.addEventListener('change', () => clock.setRate(Number(this.rate.value)));
    this.live.addEventListener('click', () => clock.goLive());
    this.date.addEventListener('change', () => {
      const d = fromIsoDate(this.date.value);
      if (!d) return;
      const sec = this.serviceSeconds(clock.now());
      clock.seek(serviceDayStart(d) + sec * 1000);
    });
    this.slider.addEventListener('pointerdown', () => (this.scrubbing = true));
    this.slider.addEventListener('pointerup', () => (this.scrubbing = false));
    this.slider.addEventListener('input', () => {
      const d = displayServiceDate(clock.now());
      clock.seek(serviceDayStart(d) + Number(this.slider.value) * 1000);
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const step = (e.shiftKey ? 10 : 1) * 60_000;
      if (e.key === ' ') {
        clock.toggle();
        e.preventDefault();
      } else if (e.key === 'ArrowRight') clock.seek(clock.now() + step);
      else if (e.key === 'ArrowLeft') clock.seek(clock.now() - step);
      else if (e.key === 'l' || e.key === 'L') clock.goLive();
      else if (e.key === ']' || e.key === '[') {
        const i = RATES.indexOf(clock.rate);
        const next = RATES[Math.min(RATES.length - 1, Math.max(0, (i < 0 ? 4 : i) + (e.key === ']' ? 1 : -1)))]!;
        clock.setRate(next);
      }
    });

    clock.subscribe(() => this.renderState());
    this.renderState();
  }

  private serviceSeconds(t: number): number {
    return (t - serviceDayStart(displayServiceDate(t))) / 1000;
  }

  private renderTicks(): void {
    const ticks = document.getElementById('tb-ticks');
    if (!ticks) return;
    ticks.replaceChildren();
    for (let h = 4; h <= 26; h += 2) {
      const s = document.createElement('span');
      s.style.left = `${((h * 3600 - SLIDER_START_S) / (SLIDER_END_S - SLIDER_START_S)) * 100}%`;
      s.textContent = String(h % 24).padStart(2, '0');
      ticks.append(s);
    }
  }

  /** Slider span of the displayed service day, as epoch ms. */
  sliderRange(t: number): [number, number] {
    const start = serviceDayStart(displayServiceDate(t));
    return [start + SLIDER_START_S * 1000, start + SLIDER_END_S * 1000];
  }

  /** Shade the slider where real bus positions exist (epoch-ms intervals). */
  setCoverage(t: number, intervals: [number, number][]): void {
    const [lo, hi] = this.sliderRange(t);
    const segs = intervals
      .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as const)
      .filter(([a, b]) => b > a)
      .map(([a, b]) => [((a - lo) / (hi - lo)) * 100, ((b - a) / (hi - lo)) * 100] as const);
    const key = segs.map(([l, w]) => `${l.toFixed(2)}:${w.toFixed(2)}`).join(',');
    if (key === this.lastCoverageKey) return;
    this.lastCoverageKey = key;
    this.coverage.replaceChildren(
      ...segs.map(([left, width]) => {
        const d = document.createElement('span');
        d.style.left = `${left}%`;
        d.style.width = `max(2px, ${width}%)`;
        return d;
      }),
    );
  }

  setRtBadge(text: string, mode: string, title: string): void {
    if (this.rtBadge.textContent !== text) this.rtBadge.textContent = text;
    this.rtBadge.dataset.mode = mode;
    this.rtBadge.title = title;
  }

  /** Recompute date-dependent labels (e.g. once a timetable finishes loading). */
  invalidate(): void {
    this.lastDate = '';
  }

  /** Discrete state: buttons, rate, bounds. */
  renderState(): void {
    const { clock } = this.deps;
    this.play.textContent = clock.playing ? '❚❚' : '▶';
    this.play.setAttribute('aria-label', clock.playing ? 'Pause' : 'Play');
    this.rate.value = String(clock.rate);
    const range = this.deps.dateRange();
    if (range) {
      this.date.min = isoDate(range[0]);
      this.date.max = isoDate(range[1]);
    }
  }

  /** Per-frame: time readout and slider position. */
  tick(t: number): void {
    const { clock } = this.deps;
    const d = displayServiceDate(t);
    if (d !== this.lastDate) {
      this.lastDate = d;
      this.date.value = isoDate(d);
      this.service.textContent = this.deps.describeDate(d);
    }
    const w = toWallTime(t);
    this.time.textContent = `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}:${String(w.second).padStart(2, '0')}`;
    if (!this.scrubbing) this.slider.value = String(Math.round(this.serviceSeconds(t)));
    const live = clock.isLive();
    this.live.classList.toggle('on', live);
    this.live.setAttribute('aria-pressed', String(live));
  }
}
