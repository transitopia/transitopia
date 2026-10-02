import { describe, expect, it } from "vitest";
import {
  distanceAt,
  solveLeg,
  speedAt,
  type Kinematics,
} from "../src/movement/kinematics.ts";

const train: Kinematics = {
  accel: 1,
  decel: 1,
  maxSpeed: 80,
  minCruiseFraction: 0.6,
  dwell: 25,
  length: 68,
  width: 3,
  profile: "trapezoid",
};

function checkProfile(distance: number, duration: number, k = train) {
  const p = solveLeg(distance, duration, k);
  let prev = 0;
  for (let t = 0; t <= duration; t += duration / 200) {
    const d = distanceAt(p, t);
    expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
    expect(d).toBeLessThanOrEqual(distance + 1e-9);
    prev = d;
  }
  expect(distanceAt(p, duration)).toBeCloseTo(distance, 6);
  // Distance at the end of the motion phase must reach the destination (no jump on arrival).
  expect(distanceAt(p, duration - 1e-6)).toBeCloseTo(distance, 2);
  return p;
}

describe("solveLeg", () => {
  it("fits a typical 1 km station hop in 70 s", () => {
    const p = checkProfile(1000, 70);
    expect(p.v * 3.6).toBeLessThanOrEqual(80);
    expect(p.hold).toBe(0);
  });
  it("holds slack at the origin rather than crawling", () => {
    const p = checkProfile(800, 240);
    expect(p.hold).toBeGreaterThan(100);
    expect(p.v).toBeCloseTo((80 / 3.6) * 0.6, 6);
    expect(speedAt(p, 10)).toBe(0);
  });
  it("lets the schedule win when it is tighter than the model", () => {
    checkProfile(2000, 70);
  });
  it("falls back to linear when even a triangle profile is infeasible", () => {
    const p = checkProfile(2000, 30);
    expect(p.linear).toBe(true);
  });
  it("is linear for buses", () => {
    const p = checkProfile(500, 60, { ...train, profile: "linear" });
    expect(distanceAt(p, 30)).toBeCloseTo(250, 6);
  });
});
