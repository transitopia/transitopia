import { describe, expect, it } from "vitest";
import { indexCalendar } from "../src/gtfs/calendar.ts";
import {
  averageWait,
  departuresAround,
  frequencyOf,
  regularWeek,
  regularWeekdays,
  weekdayWait,
  worstWait,
} from "../src/schedule/frequency.ts";
import { serviceDate } from "../src/time.ts";

const M = 60;

describe("worstWait", () => {
  it("counts the gaps a rider arriving in the window could fall into", () => {
    // Four buses bunched in 20 minutes, then 40 minutes to the next: every 15 on average, but up to 40.
    const times = [0, 5, 10, 20, 60].map((m) => m * M);
    expect(worstWait(times, 0, 60 * M)).toBe(40 * M);
    expect(frequencyOf(times, 0, 60 * M)).toEqual({
      minutes: 15,
      wait: 40,
      // Most riders arrive in the 40-minute gap: about 15, not half of every 15.
      averageWait: expect.closeTo(875 / 60, 5),
      departures: 4,
    });
  });

  it("counts from the window's start, and to the next departure after it", () => {
    // Every 30 minutes, whatever the phase.
    expect(
      worstWait(
        [25, 55, 85].map((m) => m * M),
        0,
        60 * M,
      ),
    ).toBe(30 * M);
    expect(
      worstWait(
        [5, 35, 65].map((m) => m * M),
        0,
        60 * M,
      ),
    ).toBe(30 * M);
  });

  it("leaves out the gap after the last departure where service ends", () => {
    // The last trains to Braid, every 12 min until :36: up to 12, not the rest of the hour.
    expect(
      worstWait(
        [0, 12, 24, 36].map((m) => m * M),
        0,
        60 * M,
      ),
    ).toBe(12 * M);
    // …and on average 6, over the time trains still run.
    expect(
      averageWait(
        [0, 12, 24, 36].map((m) => m * M),
        0,
        60 * M,
      ),
    ).toBe(6 * M);
    // The evening's last at :50, then tomorrow's first.
    expect(
      worstWait(
        [20, 50, 60 * 8].map((m) => m * M),
        0,
        60 * M,
      ),
    ).toBe(30 * M);
    // One last trip and nothing after: as an hour without service, not the few minutes to it.
    expect(worstWait([3 * M], 0, 60 * M)).toBe(60 * M);
    expect(averageWait([3 * M], 0, 60 * M)).toBe(30 * M);
    // An hour's gap to the next still counts, up to the window.
    expect(
      worstWait(
        [50, 110].map((m) => m * M),
        0,
        60 * M,
      ),
    ).toBe(60 * M);
  });

  it("is undefined when nothing departs in the window", () => {
    expect(worstWait([70 * M], 0, 60 * M)).toBeUndefined();
  });
});

describe("departuresAround", () => {
  const calendar = {
    calendar: [
      {
        serviceId: "wk",
        days: [true, true, true, true, true, false, false],
        start: serviceDate("20261001"),
        end: serviceDate("20261231"),
      },
    ],
    exceptions: [],
  };
  const servicesOn = indexCalendar(calendar);
  // Trips at 23:30 and 24:30 (after midnight, the same service day), and 06:00.
  const sources = [
    { byService: { wk: [6 * 3600, 23.5 * 3600, 24.5 * 3600] }, offset: 0 },
  ];
  const wed = serviceDate("20261021");

  it("finds the next service day's trips by when they run, and the first after the window", () => {
    // From Wednesday's 24:00: its 24:30, then Thursday's 06:00 (30:00 on Wednesday).
    expect(
      departuresAround(servicesOn, sources, wed, 24 * 3600, 25 * 3600),
    ).toEqual([24.5 * 3600, 30 * 3600]);
    // From Thursday's 00:00: Wednesday's 24:30 runs then.
    expect(
      departuresAround(servicesOn, sources, serviceDate("20261022"), 0, 3600),
    ).toEqual([0.5 * 3600, 6 * 3600]);
  });

  it("shifts departures by the source's offset", () => {
    expect(
      departuresAround(
        servicesOn,
        [{ ...sources[0]!, offset: 600 }],
        wed,
        6 * 3600,
        7 * 3600,
      ),
    ).toEqual([6 * 3600 + 600, 23.5 * 3600 + 600]);
  });
});

describe("regular weekdays", () => {
  // Weekdays, Saturdays and Sundays, with Monday 12 October a holiday on Sunday service.
  const calendar = {
    calendar: [
      ["wk", [true, true, true, true, true, false, false]],
      ["sa", [false, false, false, false, false, true, false]],
      ["su", [false, false, false, false, false, false, true]],
    ].map(([serviceId, days]) => ({
      serviceId: serviceId as string,
      days: days as boolean[],
      start: serviceDate("20261001"),
      end: serviceDate("20261031"),
    })),
    exceptions: [
      { serviceId: "wk", date: serviceDate("20261012"), type: 2 as const },
      { serviceId: "su", date: serviceDate("20261012"), type: 1 as const },
    ],
  };
  const servicesOn = indexCalendar(calendar);
  const week = regularWeek(
    servicesOn,
    serviceDate("20261001"),
    serviceDate("20261031"),
  );

  it("takes each weekday's usual services, leaving out holidays", () => {
    expect(week).toEqual(
      [
        "20261005",
        "20261006",
        "20261007",
        "20261001",
        "20261002",
        "20261003",
        "20261004",
      ].map(serviceDate),
    );
  });

  it("takes the median over weekday hours of the better direction's worst wait", () => {
    const days = regularWeekdays(
      servicesOn,
      serviceDate("20261001"),
      serviceDate("20261031"),
    );
    expect(days).toEqual(week.slice(0, 5));
    // Every 10 minutes one way until 13:00 and the other way from 14:00, every 30 otherwise.
    const every = (fromH: number, toH: number, m: number) =>
      Array.from(
        { length: ((toH - fromH) * 60) / m },
        (_, i) => fromH * 3600 + i * m * 60,
      );
    const out = [...every(6, 13, 10), ...every(13, 21.5, 30)];
    const back = [...every(6, 14, 30), ...every(14, 21.5, 10)];
    const dir = (wk: number[]) => [{ byService: { wk }, offset: 0 }];
    // Each alone: up to 10 for 7 hours, 30 for 8; the median is 30.
    expect(weekdayWait(servicesOn, days, [dir(out)])).toBe(30);
    expect(weekdayWait(servicesOn, days, [dir(back)])).toBe(30);
    // The better one each hour: 10, except 13:00–14:00.
    expect(weekdayWait(servicesOn, days, [dir(out), dir(back)])).toBe(10);
    expect(weekdayWait(servicesOn, days, [dir([])])).toBeUndefined();
  });
});
