import { describe, expect, it } from "vitest";
import { isLocalUrl, readEnv } from "../src/env.ts";

describe("readEnv", () => {
  it("accepts ADMIN_DEV_TOKEN on a local server", () => {
    expect(readEnv({ ADMIN_DEV_TOKEN: "t" }).adminDevToken).toBe("t");
    expect(
      readEnv({ ADMIN_DEV_TOKEN: "t", PUBLIC_URL: "http://127.0.0.1:8787" })
        .adminDevToken,
    ).toBe("t");
  });

  it("refuses ADMIN_DEV_TOKEN when the public URL isn't local", () => {
    expect(() =>
      readEnv({
        ADMIN_DEV_TOKEN: "t",
        PUBLIC_URL: "https://api.transitopia.org",
      }),
    ).toThrow(/local development only/);
  });
});

describe("isLocalUrl", () => {
  it("knows loopback hosts", () => {
    expect(isLocalUrl("http://localhost:8787")).toBe(true);
    expect(isLocalUrl("http://api.localhost")).toBe(true);
    expect(isLocalUrl("http://[::1]:8787")).toBe(true);
    expect(isLocalUrl("https://api.transitopia.org")).toBe(false);
    expect(isLocalUrl("https://localhost.example.com")).toBe(false);
    expect(isLocalUrl("not a url")).toBe(false);
  });
});
