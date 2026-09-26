// Motion profiles for a single stop-to-stop leg. Given the leg's distance and scheduled duration,
// produce distance-covered as a function of elapsed time. See PLAN.md §4.4.

export interface Kinematics {
  accel: number; // m/s²
  decel: number; // m/s²
  maxSpeed: number; // km/h
  minCruiseFraction: number;
  dwell: number; // s
  length: number; // m
  width: number; // m
  profile: 'trapezoid' | 'linear';
}

export interface KinematicsConfig {
  modes: Record<string, Kinematics>;
  routes: Record<string, Partial<Kinematics>>;
  sizing: { minPixelLength: number; minPixelWidth: number };
}

export function kinematicsFor(cfg: KinematicsConfig, mode: string, routeKey: string): Kinematics {
  const base = cfg.modes[mode] ?? cfg.modes.bus;
  if (!base) throw new Error(`No kinematics for mode ${mode}`);
  const over = Object.fromEntries(Object.entries(cfg.routes[routeKey] ?? {}).filter(([k]) => !k.startsWith('$')));
  return { ...base, ...over };
}

/** A solved leg: hold at the origin, then accelerate / cruise / decelerate. */
export interface LegProfile {
  distance: number;
  duration: number;
  hold: number;
  v: number; // cruise speed m/s
  a: number;
  b: number;
  linear: boolean;
}

export function solveLeg(distance: number, duration: number, k: Kinematics): LegProfile {
  const base = { distance, duration, hold: 0, v: 0, a: k.accel, b: k.decel, linear: false };
  if (k.profile === 'linear' || distance <= 0 || duration <= 0) {
    return { ...base, v: duration > 0 ? distance / duration : 0, linear: true };
  }
  const a = k.accel;
  const b = k.decel;
  const vmax = k.maxSpeed / 3.6;
  // Time for distance D at cruise speed v with trapezoidal accel/decel: T = c·v + D/v, c = 1/2a + 1/2b.
  const c = 1 / (2 * a) + 1 / (2 * b);
  const timeAt = (v: number) => c * v + distance / v;
  // Top speed reachable within the distance (triangle profile).
  const vPeak = Math.sqrt(distance / c);
  const vTop = Math.min(vmax, vPeak);
  const tMin = timeAt(vTop);
  if (duration <= tMin) {
    // Schedule is tighter than the model allows: the schedule wins, stretching the profile.
    const disc = duration * duration - 4 * c * distance;
    if (disc < 0) return { ...base, v: distance / duration, linear: true };
    return { ...base, v: (duration - Math.sqrt(disc)) / (2 * c) };
  }
  // Slack: run slower, but not below minCruise; hold any remainder at the origin.
  const disc = duration * duration - 4 * c * distance;
  let v = (duration - Math.sqrt(Math.max(0, disc))) / (2 * c);
  const vMin = Math.min(vTop, vmax * k.minCruiseFraction);
  if (v < vMin) v = vMin;
  const hold = Math.max(0, duration - timeAt(v));
  return { ...base, v, hold };
}

/** Distance covered after `t` seconds into the leg (0 ≤ result ≤ distance). */
export function distanceAt(p: LegProfile, t: number): number {
  if (t <= 0) return 0;
  if (t >= p.duration) return p.distance;
  if (p.linear) return p.v * t;
  const tt = t - p.hold;
  if (tt <= 0) return 0;
  const { v, a, b, distance } = p;
  const ta = v / a;
  const tb = v / b;
  const da = (v * ta) / 2;
  const db = (v * tb) / 2;
  const tc = Math.max(0, (distance - da - db) / v);
  if (tt < ta) return 0.5 * a * tt * tt;
  if (tt < ta + tc) return da + v * (tt - ta);
  const td = tt - ta - tc;
  if (td < tb) return Math.min(distance, da + v * tc + v * td - 0.5 * b * td * td);
  return distance;
}

/** Instantaneous speed (m/s) at time t, for display. */
export function speedAt(p: LegProfile, t: number): number {
  if (t <= 0 || t >= p.duration) return 0;
  if (p.linear) return p.v;
  const tt = t - p.hold;
  if (tt <= 0) return 0;
  const ta = p.v / p.a;
  const tb = p.v / p.b;
  const tc = Math.max(0, (p.distance - (p.v * ta) / 2 - (p.v * tb) / 2) / p.v);
  if (tt < ta) return p.a * tt;
  if (tt < ta + tc) return p.v;
  return Math.max(0, p.v - p.b * (tt - ta - tc));
}
