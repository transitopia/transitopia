// Screenshot the running app with the locally installed Chrome, for visual checks.
//
//   tsx pipelines/screenshot.ts <out.png> [path-and-query] [--mobile] [--dark] [--wait ms] [--click x,y]
//
// Example: tsx pipelines/screenshot.ts /tmp/a.png "/transit?date=2026-09-28&t=08:00:00&paused=1#map=13/49.28/-123.11"
// Requires `npm run dev` (http://localhost:5173). Browser console errors are printed.

import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter(
  (a, i) =>
    !a.startsWith("--")
    && !["--wait", "--click", "--base", "--pick"].includes(args[i - 1] ?? ""),
);
const [out = "screenshot.png", path = "/"] = positional;
const base = opt("--base") ?? "http://localhost:5173";

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=metal", "--enable-gpu"],
});
const context = await browser.newContext({
  viewport:
    flag("--mobile") ?
      { width: 390, height: 844 }
    : { width: 1440, height: 900 },
  deviceScaleFactor: flag("--mobile") ? 3 : 1,
  isMobile: flag("--mobile"),
  hasTouch: flag("--mobile"),
  colorScheme: flag("--dark") ? "dark" : "light",
});
const page = await context.newPage();
const seen = new Map<string, number>();
const report = (msg: string) => {
  const n = (seen.get(msg) ?? 0) + 1;
  seen.set(msg, n);
  if (n === 1) console.log(msg);
};
page.on("console", async (m) => {
  if (m.type() !== "error" && m.type() !== "warning") return;
  // Error objects stringify to just "Error"; include their stacks.
  const details = await Promise.all(
    m
      .args()
      .map((a) =>
        a
          .evaluate((x: unknown) =>
            x instanceof Error ? (x.stack ?? x.message) : "",
          )
          .catch(() => ""),
      ),
  );
  report(
    `[browser ${m.type()}] ${m.text()}${details
      .filter(Boolean)
      .map((d) => `\n  ${d}`)
      .join("")}`,
  );
});
page.on("pageerror", (e) =>
  report(`[page error] ${e.message}\n${e.stack ?? ""}`),
);
await page.goto(base + path, { waitUntil: "load" });
await page.waitForTimeout(Number(opt("--wait") ?? 2500));
const pick = opt("--pick");
if (pick) {
  // Centre the map on the first moving vehicle of a route (via the app's debug handle), then click it.
  // Use with paused=1 so the vehicle stays put.
  const found = await page.evaluate((route) => {
    const w = window as unknown as {
      transit: {
        map: { jumpTo(o: { center: [number, number]; zoom: number }): void };
        vehicles(): {
          routeKey: string;
          lon: number;
          lat: number;
          status: string;
        }[];
      };
    };
    const v = w.transit
      .vehicles()
      .find((x) => x.routeKey === route && x.status === "moving");
    if (v) w.transit.map.jumpTo({ center: [v.lon, v.lat], zoom: 16 });
    return Boolean(v);
  }, pick);
  if (!found) console.log(`No moving ${pick} vehicle found`);
  await page.waitForTimeout(1500);
  const vp = page.viewportSize()!;
  await page.mouse.click(vp.width / 2, vp.height / 2);
  await page.waitForTimeout(500);
}
const click = opt("--click");
if (click) {
  const [x, y] = click.split(",").map(Number) as [number, number];
  await page.mouse.click(x, y);
  await page.waitForTimeout(500);
}
await page.screenshot({ path: out });
for (const [msg, n] of seen)
  if (n > 1) console.log(`(repeated ${n}×) ${msg.split("\n")[0]}`);
console.log(`Saved ${out}`);
await browser.close();
