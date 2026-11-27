import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cardClock,
  cardMinutes,
  clockMinutes,
  clockTime,
  fromIsoDate,
  isoDate,
  offsetFromDevice,
  offsetLabel,
  rateLabel,
  shortDate,
  timeState,
  zoneLabel,
} from "../src/TransitMap/format.ts";

// 08:04:05 in Vancouver (PDT, UTC−7).
const T = Date.parse("2026-10-06T15:04:05Z");

describe("dates", () => {
  it("converts service dates to and from the date input's format", () => {
    expect(isoDate("20260929")).toBe("2026-09-29");
    expect(fromIsoDate("2026-09-29")).toBe("20260929");
    expect(fromIsoDate("2026-9-29")).toBeUndefined();
    expect(fromIsoDate("")).toBeUndefined();
  });

  it("names the day", () => {
    expect(shortDate("20261006")).toBe("Tue 6 Oct");
  });
});

const TZ = "America/Vancouver";

describe("times", () => {
  it("shows wall-clock time in the given time zone", () => {
    expect(clockTime(T, TZ)).toBe("08:04:05");
    expect(clockMinutes(T, TZ)).toBe("08:04");
    expect(clockTime(Date.parse("2026-10-07T06:59:59.900Z"), TZ)).toBe(
      "23:59:59",
    );
  });

  it("labels playback rates with a real minus sign", () => {
    expect(rateLabel(60)).toBe("60×");
    expect(rateLabel(-4)).toBe("−4×");
  });
});

describe("timeState", () => {
  afterEach(() => vi.useRealTimers());

  it("is future only when not live and ahead of now", () => {
    vi.useFakeTimers({ now: T });
    expect(timeState({ t: T + 60_000, live: false, timezone: TZ })).toEqual({
      live: false,
      future: true,
      when: "Tue 6 Oct, 08:05",
    });
    expect(timeState({ t: T - 60_000, live: false, timezone: TZ }).future).toBe(
      false,
    );
    expect(timeState({ t: T + 60_000, live: true, timezone: TZ }).future).toBe(
      false,
    );
  });

  it("shows the calendar date after midnight", () => {
    const halfPastMidnight = Date.parse("2026-10-07T07:30:00Z");
    expect(
      timeState({ t: halfPastMidnight, live: true, timezone: TZ }).when,
    ).toBe("Wed 7 Oct, 00:30");
  });
});

describe("time zones", () => {
  it("labels offsets", () => {
    expect(offsetLabel(-420)).toBe("UTC−7");
    expect(offsetLabel(330)).toBe("UTC+5:30");
    expect(offsetLabel(0)).toBe("UTC");
  });

  it("names a zone by a short abbreviation, else its offset", () => {
    expect(zoneLabel(T, "America/Edmonton")).toMatch(/^[A-Z]{2,4}$/);
    // CLDR's generic name here is "India Time": too long for the time bar.
    expect(zoneLabel(T, "Asia/Kolkata")).toBe("UTC+5:30");
  });

  it("says how far the time bar is from the device", () => {
    vi.stubEnv("TZ", "America/Vancouver"); // the device's zone
    try {
      expect(offsetFromDevice(T, "America/Edmonton")).toBe("+1 h");
      expect(offsetFromDevice(T, "America/Dawson_Creek")).toBeUndefined();
      expect(offsetFromDevice(T, "Asia/Kolkata")).toBe("+12 h 30 min");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("marks a card's clock times only when its offset isn't the time bar's", () => {
    // America/Dawson_Creek and America/Vancouver are both UTC−7 in October 2026: same offset, no mark.
    const same = cardClock(T, "America/Dawson_Creek", "America/Vancouver");
    expect(cardMinutes(T, same)).toBe("08:04");
    const other = cardClock(T, "America/Edmonton", "America/Vancouver");
    expect(cardMinutes(T, other)).toMatch(/^09:04 \S+$/);
  });
});
