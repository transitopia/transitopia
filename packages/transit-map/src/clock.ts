// The simulation clock. Time is derived, not stepped: t = anchorT + elapsed × rate, so any rate
// (including negative) and any seek are exact. Listeners fire on discrete changes (seek, rate,
// play/pause), not per frame; the render loop reads now() each frame.

export type ClockListener = (clock: Clock) => void;

/** How close to wall-clock time counts as "live". */
const LIVE_TOLERANCE_MS = 5_000;

export class Clock {
  private anchorT: number;
  private anchorPerf: number;
  private _rate = 1;
  private _playing = true;
  private listeners = new Set<ClockListener>();
  private bounds: [number, number] = [-Infinity, Infinity];

  constructor(t = Date.now()) {
    this.anchorT = t;
    this.anchorPerf = performance.now();
  }

  get rate(): number {
    return this._rate;
  }

  get playing(): boolean {
    return this._playing;
  }

  now(): number {
    if (!this._playing) return this.anchorT;
    const t = this.anchorT + (performance.now() - this.anchorPerf) * this._rate;
    const [lo, hi] = this.bounds;
    if (t < lo || t > hi) {
      // Hit the end of the available timetables: stop there.
      this.reanchor(Math.min(hi, Math.max(lo, t)));
      this._playing = false;
      this.emit();
      return this.anchorT;
    }
    return t;
  }

  /** Live = playing at 1× within a few seconds of wall-clock time. */
  isLive(): boolean {
    return (
      this._playing
      && this._rate === 1
      && Math.abs(this.now() - Date.now()) < LIVE_TOLERANCE_MS
    );
  }

  setBounds(lo: number, hi: number): void {
    this.bounds = [lo, hi];
  }

  seek(t: number): void {
    const [lo, hi] = this.bounds;
    this.reanchor(Math.min(hi, Math.max(lo, t)));
    this.emit();
  }

  setRate(rate: number): void {
    this.reanchor(this.now());
    this._rate = rate;
    this.emit();
  }

  play(): void {
    if (this._playing) return;
    this.reanchor(this.anchorT);
    this._playing = true;
    this.emit();
  }

  pause(): void {
    if (!this._playing) return;
    this.reanchor(this.now());
    this._playing = false;
    this.emit();
  }

  toggle(): void {
    if (this._playing) this.pause();
    else this.play();
  }

  goLive(): void {
    this.reanchor(Date.now());
    this._rate = 1;
    this._playing = true;
    this.emit();
  }

  subscribe(fn: ClockListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private reanchor(t: number): void {
    this.anchorT = t;
    this.anchorPerf = performance.now();
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this);
  }
}
