import { describe, expect, it } from "vitest";
import { formatInstant, parseInstant } from "../src/url.ts";

describe("URL instants (?date=)", () => {
  const t = Date.parse("2026-11-04T23:05:00Z");

  it("writes local time with the shortest offset", () => {
    expect(formatInstant(t, "America/Edmonton")).toBe("2026-11-04T17:05:00-06");
    expect(formatInstant(t, "America/Vancouver")).toBe(
      "2026-11-04T16:05:00-07",
    );
    expect(formatInstant(t, "UTC")).toBe("2026-11-04T23:05:00Z");
    expect(formatInstant(t, "Asia/Kolkata")).toBe("2026-11-05T04:35:00+05:30");
  });

  it("reads back the same instant, whatever the zone it was written in", () => {
    for (const tz of [
      "America/Edmonton",
      "America/Vancouver",
      "UTC",
      "Asia/Kolkata",
    ])
      expect(parseInstant(formatInstant(t, tz))).toBe(t);
  });

  it("reads offsets in their other ISO 8601 forms", () => {
    expect(parseInstant("2026-11-04T17:05-06:00")).toBe(t);
    expect(parseInstant("2026-11-04T17:05:00-0600")).toBe(t);
    expect(parseInstant("2026-11-04T23:05:00Z")).toBe(t);
  });

  it("refuses a time without an offset, or a malformed one", () => {
    expect(parseInstant("2026-11-04T17:05:00")).toBeUndefined();
    expect(parseInstant("2026-11-04")).toBeUndefined();
    expect(parseInstant("2026-13-04T17:05:00Z")).toBeUndefined();
    expect(parseInstant("2026-11-04T25:30:00-07")).toBeUndefined();
  });
});
