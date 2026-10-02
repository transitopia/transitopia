import { describe, expect, it } from "vitest";
import {
  addDays,
  checkTimezoneData,
  dayOfWeek,
  formatServiceTime,
  localDate,
  parseGtfsTime,
  serviceDayStart,
  toWallTime,
} from "../src/time.ts";

describe("parseGtfsTime", () => {
  it("handles leading spaces and times past midnight", () => {
    expect(parseGtfsTime(" 5:05:00")).toBe(5 * 3600 + 5 * 60);
    expect(parseGtfsTime("25:30:00")).toBe(25 * 3600 + 30 * 60);
    expect(parseGtfsTime("00:00:01")).toBe(1);
  });
  it("returns NaN for blanks and throws on garbage", () => {
    expect(parseGtfsTime("  ")).toBeNaN();
    expect(() => parseGtfsTime("5:05")).toThrow();
    expect(() => parseGtfsTime("a:b:c")).toThrow();
  });
  it("formats service times beyond 24h", () => {
    expect(formatServiceTime(25 * 3600 + 30 * 60)).toBe("25:30");
    expect(formatServiceTime(3661, true)).toBe("1:01:01");
  });
});

describe("service dates", () => {
  it("does date arithmetic across month and year boundaries", () => {
    expect(addDays("20260930", 1)).toBe("20261001");
    expect(addDays("20270101", -1)).toBe("20261231");
  });
  it("computes day of week with Monday = 0", () => {
    expect(dayOfWeek("20260925")).toBe(4); // Friday
    expect(dayOfWeek("20260927")).toBe(6); // Sunday
    expect(dayOfWeek("20260928")).toBe(0); // Monday
  });
});

describe("serviceDayStart (noon minus 12h)", () => {
  it("equals local midnight on ordinary days", () => {
    const t = serviceDayStart("20260925");
    expect(new Date(t).toISOString()).toBe("2026-09-25T07:00:00.000Z"); // UTC−7
    expect(toWallTime(t)).toMatchObject({ hour: 0, minute: 0 });
  });
  // British Columbia moved to permanent UTC−7 in 2026 (tzdata 2026b; its last clock change was the
  // 2026-03-08 spring-forward). Older runtimes (tzdata ≤ 2026a, e.g. Node 26.7) still fall back on
  // 2026-11-01 and fail here: update Node. TZDB models the change as 2026-11-01 02:00 until CLDR
  // catches up, which gives the same results as the legal date for everything after that.
  it("stays on UTC−7 on 2026-11-01: BC no longer falls back", () => {
    const t = serviceDayStart("20261101");
    expect(new Date(t).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(toWallTime(t)).toMatchObject({ hour: 0, minute: 0 });
    expect(toWallTime(t + 5 * 3600_000)).toMatchObject({ hour: 5, minute: 0 });
  });
  it("has no spring-forward in 2027", () => {
    const t = serviceDayStart("20270314");
    expect(new Date(t).toISOString()).toBe("2027-03-14T07:00:00.000Z");
    expect(toWallTime(t)).toMatchObject({ hour: 0 });
    expect(toWallTime(Date.parse("2027-01-15T20:00:00Z"))).toMatchObject({
      hour: 13,
    });
  });
  // The noon-minus-12h rule still matters wherever clocks change (and for other regions later).
  describe("in a zone that still observes DST (America/Los_Angeles)", () => {
    const LA = "America/Los_Angeles";
    it("is 01:00 PDT on the fall-back day, so 05:00 service time is 05:00 PST", () => {
      // DST ends 2026-11-01 at 02:00 PDT.
      const t = serviceDayStart("20261101", LA);
      expect(new Date(t).toISOString()).toBe("2026-11-01T08:00:00.000Z");
      expect(toWallTime(t + 5 * 3600_000, LA)).toMatchObject({
        hour: 5,
        minute: 0,
      });
    });
    it("is 23:00 PST the previous evening on the spring-forward day", () => {
      // DST starts 2027-03-14 at 02:00 PST.
      const t = serviceDayStart("20270314", LA);
      expect(new Date(t).toISOString()).toBe("2027-03-14T07:00:00.000Z");
      expect(toWallTime(t, LA)).toMatchObject({ hour: 23 });
      expect(toWallTime(t + 12 * 3600_000, LA)).toMatchObject({ hour: 12 });
    });
  });
  it("maps instants back to local dates", () => {
    expect(localDate(Date.parse("2026-09-26T06:59:00Z"))).toBe("20260925");
    expect(localDate(Date.parse("2026-09-26T07:01:00Z"))).toBe("20260926");
  });
});

describe("toWallTime", () => {
  // About every second around transitions and every 37 minutes across two years, compared with ICU itself.
  const zones = [
    "America/Vancouver",
    "America/Los_Angeles",
    "Australia/Lord_Howe", // 30-minute DST shift
    "Asia/Kolkata",
    "America/St_Johns",
  ];
  const formatters = new Map<string, Intl.DateTimeFormat>();
  const icu = (ms: number, tz: string) => {
    let f = formatters.get(tz);
    if (!f)
      formatters.set(
        tz,
        (f = new Intl.DateTimeFormat("en-CA", {
          timeZone: tz,
          hourCycle: "h23",
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
        })),
      );
    const p = Object.fromEntries(
      f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
    );
    return {
      year: +p.year!,
      month: +p.month!,
      day: +p.day!,
      hour: +p.hour!,
      minute: +p.minute!,
      second: +p.second!,
    };
  };
  it("matches the runtime's tzdata through offset changes", () => {
    for (const tz of zones) {
      const from = Date.parse("2025-01-01T00:00:00Z");
      const to = Date.parse("2027-01-01T00:00:00Z");
      for (let t = from; t < to; t += 37 * 60_000 + 1234)
        expect(toWallTime(t, tz)).toEqual(icu(t, tz));
    }
    for (const [at, tz] of [
      ["2026-03-08T10:00:00Z", "America/Vancouver"],
      ["2026-11-01T09:00:00Z", "America/Los_Angeles"],
      ["2026-04-04T15:00:00Z", "Australia/Lord_Howe"],
      ["2026-03-08T05:30:00Z", "America/St_Johns"], // mid-hour in UTC
    ] as const)
      for (
        let t = Date.parse(at) - 2 * 3600_000;
        t < Date.parse(at) + 2 * 3600_000;
        t += 4999
      )
        expect(toWallTime(t, tz)).toEqual(icu(t, tz));
  });
});

describe("checkTimezoneData", () => {
  const checks = [
    {
      at: "2026-11-02T20:00:00Z",
      utcOffsetMinutes: -420,
      reason: "British Columbia's permanent UTC-7",
    },
  ];
  it("passes when the runtime's data agrees", () => {
    expect(checkTimezoneData(checks)).toEqual([]);
  });
  it("explains a disagreement", () => {
    const problems = checkTimezoneData(checks, "America/Los_Angeles");
    expect(problems).toEqual([
      "America/Los_Angeles at 2026-11-02T20:00:00Z is UTC−8, expected UTC−7: British Columbia's permanent UTC-7",
    ]);
  });
});
