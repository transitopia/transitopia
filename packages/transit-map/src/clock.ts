// The simulation clock. Time is derived, not stepped: t = anchorT + elapsed × rate, so any rate
// (including negative) and any seek are exact. Listeners fire on discrete changes (seek, rate,
// play/pause), not per frame; the render loop reads now() each frame.
//
// Live is a mode (`following`), not something inferred from timing: while it's on, now() is the
// wall clock. Elapsed time comes from performance.now(), which stops while the device sleeps (on
// Android, iOS and macOS), so a live tab timed that way would come back from a sleep minutes in the
// past (issue #181). goLive() and starting without a time turn it on; seeking, changing the rate
// and pausing turn it off; playing at 1× within LIVE_TOLERANCE_MS of the wall clock turns it on
// again, so catching up to the present still counts as live.

/** Playback rates offered by the time controls (negative plays backwards). */
export const RATES = [-300, -60, -10, -1, 1, 10, 60, 300];

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
  /** Live: now() is the wall clock. */
  private following: boolean;

  /** @param t where to start; without it, live. */
  constructor(t?: number) {
    this.following = t === undefined;
    this.anchorT = t ?? Date.now();
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
    const wall = Date.now();
    let t =
      this.following ? wall : (
        this.anchorT + (performance.now() - this.anchorPerf) * this._rate
      );
    const [lo, hi] = this.bounds;
    if (t < lo || t > hi) {
      // Hit the end of the available timetables: stop there.
      this.reanchor(Math.min(hi, Math.max(lo, t)));
      this._playing = false;
      this.following = false;
      this.emit();
      return this.anchorT;
    }
    if (
      !this.following
      && this._rate === 1
      && Math.abs(t - wall) < LIVE_TOLERANCE_MS
    ) {
      // Caught up with the present: live from here.
      this.following = true;
      t = wall;
    }
    return t;
  }

  /** Live: following the wall clock (see above). */
  isLive(): boolean {
    this.now();
    return this.following;
  }

  setBounds(lo: number, hi: number): void {
    this.bounds = [lo, hi];
  }

  seek(t: number): void {
    const [lo, hi] = this.bounds;
    this.reanchor(Math.min(hi, Math.max(lo, t)));
    this.following = false;
    this.emit();
  }

  setRate(rate: number): void {
    if (rate === this._rate) return;
    this.reanchor(this.now());
    this._rate = rate;
    this.following = false;
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
    this.following = false;
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
    this.following = true;
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
