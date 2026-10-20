import { describe, expect, it } from "vitest";
import { indexCalendar } from "../src/gtfs/calendar.ts";
import {
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

  it("is at most the window, and undefined when nothing departs in it", () => {
    // The last trip of the day at :10.
    expect(worstWait([10 * M], 0, 60 * M)).toBe(60 * M);
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

  it("averages each daytime hour's worst wait, Monday to Friday", () => {
    const days = regularWeekdays(
      servicesOn,
      serviceDate("20261001"),
      serviceDate("20261031"),
    );
    expect(days).toEqual(week.slice(0, 5));
    // Every 10 minutes 06:00–21:00 on weekdays, with an hour's gap at 12:00, and hourly at the
    // weekend, which doesn't count.
    const wk = Array.from({ length: 91 }, (_, i) => 6 * 3600 + i * 600).filter(
      (s) => s <= 12 * 3600 || s >= 13 * 3600,
    );
    const sa = Array.from({ length: 16 }, (_, i) => (6 + i) * 3600);
    const w = weekdayWait(servicesOn, days, [
      { byService: { wk, sa, su: sa }, offset: 0 },
    ]);
    // 13 hours at 10, 12:00–13:00 at 60, 11:00–12:00 at 10 (12:00 then 13:00 is the next hour's).
    expect(w).toBeCloseTo((14 * 10 + 60) / 15, 5);
    expect(
      weekdayWait(servicesOn, days, [{ byService: {}, offset: 0 }]),
    ).toBeUndefined();
  });
});
