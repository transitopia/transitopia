import { describe, expect, it } from "vitest";
import { removeStopSpurs, type LonLat } from "../src/geo.ts";

describe("removeStopSpurs", () => {
  const limits = { curbM: 10, spurM: 20 };
  // BC Transit route 15, shape 50481 at Esquimalt Rd and Maitland St: vertex 118 is the stop.
  const road: LonLat[] = [
    [-123.38716, 48.43044],
    [-123.38854, 48.43055],
    [-123.39026, 48.43085],
    [-123.39028, 48.43078],
    [-123.39209, 48.43105],
  ];
  const stop: LonLat = [-123.39026, 48.43085];

  it("drops a vertex on a stop just off the road", () => {
    expect(removeStopSpurs(road, [stop], limits)).toEqual([
      road[0],
      road[1],
      road[3],
      road[4],
    ]);
  });

  it("keeps vertices that aren't on a stop", () => {
    expect(removeStopSpurs(road, [[-123.3903, 48.4309]], limits)).toEqual(road);
  });

  it("keeps a stop on a corner", () => {
    const corner: LonLat[] = [
      [-123.39, 48.43],
      [-123.388, 48.43],
      [-123.388, 48.4315],
    ];
    expect(removeStopSpurs(corner, [corner[1]!], limits)).toEqual(corner);
  });

  it("keeps a stop on a curve, with no short jog to the road", () => {
    // BC Transit shape 50550 near Swartz Bay: 17 m off the chord, neighbours 70 m and 153 m away.
    const curve: LonLat[] = [
      [-123.41269, 48.68409],
      [-123.41343, 48.6837],
      [-123.4145, 48.68252],
    ];
    expect(removeStopSpurs(curve, [curve[1]!], limits)).toEqual(curve);
  });

  it("drops a bump to the curb on a straight road", () => {
    // BC Transit Kelowna shape 51528: 9 m off the chord, neighbours 164 m and 281 m away.
    const bump: LonLat[] = [
      [-119.47642, 49.8836],
      [-119.4787, 49.88373],
      [-119.48262, 49.88373],
    ];
    expect(removeStopSpurs(bump, [bump[1]!], limits)).toEqual([
      bump[0],
      bump[2],
    ]);
  });

  it("keeps the ends", () => {
    expect(removeStopSpurs(road, [road[0]!, road[4]!], limits)).toEqual(road);
  });
});
