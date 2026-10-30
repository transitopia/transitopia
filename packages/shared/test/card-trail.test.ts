import { describe, expect, it } from "vitest";
import { CardTrail } from "../src/card-trail.ts";

describe("CardTrail", () => {
  it("goes back through the cards it was opened from, newest first", () => {
    const t = new CardTrail<string>();
    expect(t.backLabel).toBeUndefined();
    t.push("station", "Waterfront");
    t.push("route", "Expo Line");
    expect(t.backLabel).toBe("Expo Line");
    expect(t.pop()).toBe("route");
    expect(t.backLabel).toBe("Waterfront");
    expect(t.pop()).toBe("station");
    expect(t.pop()).toBeUndefined();
  });

  it("forgets every card when cleared", () => {
    const t = new CardTrail<string>();
    t.push("a", "A");
    t.clear();
    expect(t.backLabel).toBeUndefined();
    expect(t.pop()).toBeUndefined();
  });
});
