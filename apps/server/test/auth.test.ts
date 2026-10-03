import { describe, expect, it } from "vitest";
import { Auth } from "../src/auth.ts";
import { readEnv } from "../src/env.ts";

describe("sign-in", () => {
  const env = readEnv({
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    SITE_URL: "https://www.example.org",
  });

  it("returns to the page that started it (/admin by default, or /trackside)", async () => {
    // Without a database every sign-in fails, which is enough to see where it goes back to.
    const auth = new Auth(undefined, env);
    const state = (url: string | undefined) =>
      new URL(url!).searchParams.get("state")!;
    expect(await auth.callback("code", state(auth.loginUrl()))).toBe(
      "https://www.example.org/admin#error=expired",
    );
    expect(await auth.callback("code", state(auth.loginUrl("trackside")))).toBe(
      "https://www.example.org/trackside#error=expired",
    );
    expect(await auth.callback("code", "unknown")).toBe(
      "https://www.example.org/admin#error=expired",
    );
  });
});
