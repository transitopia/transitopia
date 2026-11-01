import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clockMinutes,
  clockTime,
  fromIsoDate,
  isoDate,
  rateLabel,
  shortDate,
  timeState,
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
