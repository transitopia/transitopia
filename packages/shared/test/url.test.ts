import { describe, expect, it } from "vitest";
import { formatQuery } from "../src/url.ts";

describe("formatQuery", () => {
  it("keeps colons and slashes readable, and reads back unchanged", () => {
    const q = new URLSearchParams();
    q.set("date", "2026-10-17");
    q.set("t", "08:15:00");
    q.set("select", "run:25:3:2200325");
    q.set("x", "a b&c=d?e#f%g+h");
    const s = formatQuery(q);
    expect(s).toBe(
      "date=2026-10-17&t=08:15:00&select=run:25:3:2200325&x=a%20b%26c%3Dd%3Fe%23f%25g%2Bh",
    );
    expect([...new URLSearchParams(s)]).toEqual([...q]);
  });
});
