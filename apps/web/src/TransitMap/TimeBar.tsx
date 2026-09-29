import React from "react";
import {
  RATES,
  type TransitEngine,
  type TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import { clockTime, fromIsoDate, isoDate, rateLabel } from "./format.ts";

/** Hour ticks under the slider, which spans 03:00 → 27:00 of the service day. */
const TICKS = Array.from({ length: 12 }, (_, i) => 4 + i * 2);

/**
 * Time controls (V2-PLAN.md §5.2): play/pause, time, date, speed, Live, and a slider across the
 * service day, shaded where real bus positions were recorded.
 */
export const TimeBar: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
}> = ({ engine, snap }) => {
  const [scrub, setScrub] = React.useState<number>();
  const [lo, hi] = snap.sliderRange;

  // Keyboard: space play/pause, ←/→ one minute (shift: ten), L live, [ ] slower/faster.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("input, select, textarea, button")
        || e.metaKey
        || e.ctrlKey
        || e.altKey
      )
        return;
      const step = (e.shiftKey ? 10 : 1) * 60_000;
      const { clock } = engine;
      if (e.key === " ") {
        engine.toggle();
        e.preventDefault();
      } else if (e.key === "ArrowRight") engine.seek(clock.now() + step);
      else if (e.key === "ArrowLeft") engine.seek(clock.now() - step);
      else if (e.key === "l" || e.key === "L") engine.goLive();
      else if (e.key === "]" || e.key === "[") {
        const i = RATES.indexOf(clock.rate);
        const next = Math.min(
          RATES.length - 1,
          Math.max(
            0,
            (i < 0 ? RATES.indexOf(1) : i) + (e.key === "]" ? 1 : -1),
          ),
        );
        engine.setRate(RATES[next]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

  const value = scrub ?? Math.round(snap.t / 1000);
  const coverage = snap.coverage
    .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as const)
    .filter(([a, b]) => b > a);
  const pct = (x: number) => ((x - lo) / (hi - lo)) * 100;

  const button =
    "h-11 rounded-full px-3 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-2";
  return (
    <section
      aria-label="Time controls"
      className="absolute bottom-7 left-2 right-2 z-40 mx-auto max-w-3xl rounded-lg border border-gray-300 bg-white/95 px-3 pb-2 pt-1 shadow-md sm:left-5 sm:right-5 dark:border-gray-600 dark:bg-gray-900/95 dark:text-gray-100">
      <div className="flex flex-wrap items-center gap-x-2">
        <button
          type="button"
          className="h-11 w-11 shrink-0 rounded-full bg-blue-700 text-lg text-white hover:bg-blue-800"
          aria-label={snap.playing ? "Pause" : "Play"}
          onClick={() => engine.toggle()}>
          {snap.playing ? "❚❚" : "▶"}
        </button>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-xl font-semibold tabular-nums">
            {clockTime(snap.t)}
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-gray-600 dark:text-gray-300">
            <span>{snap.serviceLabel}</span>
            <span
              className={`whitespace-nowrap rounded px-1 ${
                snap.rt.mode === "live" ? "bg-red-600 text-white"
                : snap.rt.mode === "recorded" ?
                  "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100"
                : "bg-gray-100 dark:bg-gray-800"
              }`}
              title={snap.rt.title}>
              {snap.rt.label}
            </span>
            {snap.notices.length ?
              <span
                className="whitespace-nowrap rounded bg-amber-100 px-1 text-amber-900 dark:bg-amber-900 dark:text-amber-100"
                title={snap.notices.join("\n")}>
                Service change
              </span>
            : null}
            {snap.preview.length ?
              <span
                className="whitespace-nowrap rounded bg-purple-700 px-1 text-white"
                title={`Showing unconfirmed corrections for ${snap.preview.map(isoDate).join(", ")}: not what visitors see`}>
                Preview
              </span>
            : null}
          </div>
        </div>
        <div className="order-last flex w-full gap-2 pt-1 sm:order-none sm:w-auto sm:pt-0">
          <input
            type="date"
            aria-label="Date"
            className="h-9 flex-1 rounded border border-gray-300 bg-transparent px-1 text-sm sm:flex-none dark:border-gray-600"
            value={isoDate(snap.serviceDate)}
            min={snap.dateRange ? isoDate(snap.dateRange[0]) : undefined}
            max={snap.dateRange ? isoDate(snap.dateRange[1]) : undefined}
            onChange={(e) => {
              const d = fromIsoDate(e.target.value);
              if (d) engine.seekDate(d);
            }}
          />
          <select
            aria-label="Playback speed"
            className="h-9 rounded border border-gray-300 bg-transparent px-1 text-sm dark:border-gray-600 dark:bg-gray-900"
            value={snap.rate}
            onChange={(e) => engine.setRate(Number(e.target.value))}>
            {RATES.map((r) => (
              <option key={r} value={r}>
                {rateLabel(r)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          aria-pressed={snap.live}
          className={`${button} text-sm font-medium ${snap.live ? "text-red-600" : ""}`}
          onClick={() => engine.goLive()}>
          <span aria-hidden="true">{snap.live ? "● " : "○ "}</span>Live
        </button>
      </div>
      <div className="relative mt-1">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-1"
          title="Shaded: real bus positions recorded">
          {coverage.map(([a, b]) => (
            <span
              key={a}
              className="absolute top-0 h-1 bg-red-500/70"
              style={{
                left: `${pct(a)}%`,
                width: `max(2px, ${pct(b) - pct(a)}%)`,
              }}
            />
          ))}
        </div>
        <input
          type="range"
          aria-label="Time of day"
          className="block h-7 w-full cursor-pointer accent-blue-700"
          min={Math.round(lo / 1000)}
          max={Math.round(hi / 1000)}
          step={1}
          value={value}
          onPointerDown={() => setScrub(value)}
          onPointerUp={() => setScrub(undefined)}
          onBlur={() => setScrub(undefined)}
          onChange={(e) => {
            const s = Number(e.target.value);
            if (scrub !== undefined) setScrub(s);
            engine.seek(s * 1000);
          }}
        />
        <div
          className="relative h-3 text-[10px] text-gray-500 dark:text-gray-400"
          aria-hidden="true">
          {TICKS.map((h) => (
            <span
              key={h}
              className="absolute -translate-x-1/2"
              style={{ left: `${((h - 3) / 24) * 100}%` }}>
              {String(h % 24).padStart(2, "0")}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
};
