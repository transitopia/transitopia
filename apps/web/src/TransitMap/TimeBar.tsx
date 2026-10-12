import React from "react";
import {
  RATES,
  type TransitEngine,
  type TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import { localDate } from "@transitopia/transit-core/time.ts";

import { TimeMark, type Mark } from "../components/InfoCard.tsx";
import {
  clockTime,
  fromIsoDate,
  isoDate,
  rateLabel,
  shortDate,
  timeState,
} from "./format.ts";

/** The slider spans 03:00 → 27:00 of the service day; tick labels every few hours. */
const TICKS_DESKTOP = Array.from({ length: 9 }, (_, i) => 3 + i * 3);
const TICKS_PHONE = Array.from({ length: 7 }, (_, i) => 3 + i * 4);

const RT_MARK: Record<TransitSnapshot["rt"]["mode"], Mark> = {
  live: "live",
  recorded: "recorded",
  loading: "recorded",
  estimated: "estimated",
  unavailable: "estimated",
};

type Props = { engine: TransitEngine; snap: TransitSnapshot };

/**
 * Time controls (apps/web/README.md#time-and-not-live): play/pause, time, date, speed, Live, and a
 * slider across the service day, shaded where real bus positions were recorded. Amber means "not
 * live" and nothing else. On phones the bar is compact (pause, time, Live) only while live; any
 * other state shows it expanded, and Go live collapses it. With a card open on a phone, the time
 * shrinks to a pill at the top.
 */
export const TimeBar: React.FC<Props & { cardOpen: boolean }> = ({
  engine,
  snap,
  cardOpen,
}) => {
  useTimeKeys(engine);
  const phone = usePhone();
  const [pillOpen, setPillOpen] = React.useState(false);
  // The pill's controls close with the card.
  React.useEffect(() => {
    if (!cardOpen) setPillOpen(false);
  }, [cardOpen]);

  if (!phone) return <FullBar engine={engine} snap={snap} />;
  if (cardOpen && !pillOpen)
    return (
      <TimePill engine={engine} snap={snap} onOpen={() => setPillOpen(true)} />
    );
  return (
    <PhoneBar
      engine={engine}
      snap={snap}
      atTop={cardOpen}
      onCollapse={cardOpen ? () => setPillOpen(false) : undefined}
    />
  );
};

function usePhone(): boolean {
  const query = "(max-width: 639px)";
  const [phone, setPhone] = React.useState(
    () => window.matchMedia(query).matches,
  );
  React.useEffect(() => {
    const m = window.matchMedia(query);
    const onChange = () => setPhone(m.matches);
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, []);
  return phone;
}

/** Keyboard: space play/pause, ←/→ one minute (shift: ten), L live, [ ] slower/faster. */
function useTimeKeys(engine: TransitEngine): void {
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
      else if (e.key === "]" || e.key === "[") stepRate(engine, e.key === "]");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);
}

function stepRate(engine: TransitEngine, faster: boolean): void {
  const i = RATES.indexOf(engine.clock.rate);
  const next = Math.min(
    RATES.length - 1,
    Math.max(0, (i < 0 ? RATES.indexOf(1) : i) + (faster ? 1 : -1)),
  );
  engine.setRate(RATES[next]!);
}

/** "Live · Wed 7 Oct · Weekday", or (amber) "Paused · Tue 6 Oct", "Replaying at 10× · …", "Projected at 60× · …". */
function subLine(snap: TransitSnapshot, withService: boolean): string {
  const date = shortDate(localDate(snap.t));
  if (snap.live)
    return `Live · ${date}${withService ? ` · ${snap.serviceLabel}` : ""}`;
  const state =
    !snap.playing ? "Paused" : (
      `${timeState(snap).future ? "Projected" : "Replaying"} at ${rateLabel(snap.rate)}`
    );
  return `${state} · ${date}`;
}

const FullBar: React.FC<Props> = ({ engine, snap }) => (
  <section
    aria-label="Time controls"
    data-map-overlay
    className={`absolute bottom-8 left-1/2 z-40 flex w-[min(860px,calc(100%-2.5rem))] -translate-x-1/2 flex-col gap-1 rounded-2xl bg-(--card-bg) px-4 pt-3 pb-2.5 text-(--card-text) shadow-[0_6px_24px_rgb(17_24_39/0.14)] ${snap.live ? "border border-(--card-border)" : "border-2 border-(--notlive-border)"}`}>
    <div className="flex items-center gap-3">
      <PlayButton engine={engine} snap={snap} />
      <TimeText snap={snap} sub={subLine(snap, true)} />
      <div className="flex-1" />
      <Badges snap={snap} />
      {snap.live ? null : <NotLiveBadge />}
      <DateButton engine={engine} snap={snap} />
      <SpeedStepper engine={engine} snap={snap} />
      <LiveOrGoLive engine={engine} snap={snap} />
    </div>
    <Slider engine={engine} snap={snap} ticks={TICKS_DESKTOP} />
  </section>
);

const PhoneBar: React.FC<
  Props & { atTop: boolean; onCollapse: (() => void) | undefined }
> = ({ engine, snap, atTop, onCollapse }) => {
  const expanded = !snap.live || atTop;
  return (
    <section
      aria-label="Time controls"
      data-map-overlay
      className={`absolute inset-x-2.5 z-40 flex flex-col gap-3 rounded-[18px] bg-(--card-bg) px-3 py-2.5 text-(--card-text) shadow-[0_6px_20px_rgb(17_24_39/0.16)] ${atTop ? "top-2.5 z-[55]" : "bottom-[26px]"} ${snap.live ? "border border-(--card-border)" : "border-2 border-(--notlive-border)"}`}>
      <div className="flex items-center gap-3">
        <PlayButton engine={engine} snap={snap} />
        <TimeText snap={snap} sub={subLine(snap, false)} />
        <LiveOrGoLive engine={engine} snap={snap} />
        {onCollapse ?
          <button
            type="button"
            aria-label="Hide time controls"
            onClick={onCollapse}
            className="-mr-1 flex h-11 w-11 flex-none items-center justify-center rounded-full hover:bg-(--card-hover)">
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round">
              <path d="M6 15l6-6 6 6" />
            </svg>
          </button>
        : null}
      </div>
      {expanded ?
        <>
          <Slider engine={engine} snap={snap} ticks={TICKS_PHONE} />
          <div className="flex items-center gap-2">
            <DateButton engine={engine} snap={snap} wide />
            <SpeedStepper engine={engine} snap={snap} />
          </div>
          <Badges snap={snap} />
        </>
      : null}
    </section>
  );
};

/** Phones with a card open: the time as a pill at the top (amber when not live). */
const TimePill: React.FC<Props & { onOpen: () => void }> = ({
  engine,
  snap,
  onOpen,
}) => {
  const { when } = timeState(snap);
  return (
    <div
      data-map-overlay
      className={`absolute top-2.5 left-2.5 z-[55] flex h-11 items-center gap-2 rounded-full pr-3.5 pl-1.5 shadow-[0_4px_14px_rgb(17_24_39/0.25)] ${snap.live ? "border border-(--card-border) bg-(--card-bg) text-(--card-text)" : "bg-(--notlive-border) text-[#3b2300]"}`}>
      <button
        type="button"
        aria-label={snap.playing ? "Pause" : "Play"}
        onClick={() => engine.toggle()}
        className={`flex h-8 w-8 flex-none items-center justify-center rounded-full ${snap.live ? "bg-transit-blue text-[#06303a]" : "bg-[#3b2300] text-(--notlive-border)"}`}>
        <PlayIcon playing={snap.playing} size={12} />
      </button>
      <button
        type="button"
        onClick={onOpen}
        aria-label={
          snap.live ?
            `Time: ${clockTime(snap.t).slice(0, 5)}, live. Open time controls`
          : `Not live: showing ${when}${snap.playing ? "" : ", paused"}. Open time controls`
        }
        className="flex h-full items-center gap-2">
        {snap.live ?
          <>
            <span className="text-[17px] font-extrabold tabular-nums">
              {clockTime(snap.t).slice(0, 5)}
            </span>
            <span className="flex items-center gap-1.5 text-[13px] font-bold text-(--mark-live-fg)">
              <TimeMark mark="live" />
              Live
            </span>
          </>
        : <>
            <span className="text-sm font-semibold">Showing</span>
            <span className="text-[15px] font-bold whitespace-nowrap tabular-nums">
              {when.replace(", ", " · ")}
            </span>
          </>
        }
      </button>
    </div>
  );
};

const PlayIcon: React.FC<{ playing: boolean; size: number }> = ({
  playing,
  size,
}) =>
  playing ?
    <svg aria-hidden="true" width={size} height={size + 2} viewBox="0 0 14 16">
      <rect x="1" y="1" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="9" y="1" width="4" height="14" rx="1" fill="currentColor" />
    </svg>
  : <svg
      aria-hidden="true"
      width={size + 2}
      height={size + 4}
      viewBox="0 0 16 18">
      <path d="M3 1.5 L15 9 L3 16.5 Z" fill="currentColor" />
    </svg>;

const PlayButton: React.FC<Props> = ({ engine, snap }) => (
  <button
    type="button"
    aria-label={snap.playing ? "Pause" : "Play"}
    onClick={() => engine.toggle()}
    className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-main-blue text-white hover:bg-[#0a4a80] dark:bg-sky-300 dark:text-gray-900">
    <PlayIcon playing={snap.playing} size={14} />
  </button>
);

const TimeText: React.FC<{ snap: TransitSnapshot; sub: string }> = ({
  snap,
  sub,
}) => {
  const time = clockTime(snap.t);
  return (
    <div className="flex min-w-0 flex-1 flex-col sm:flex-none">
      <span className="text-[22px] leading-none font-extrabold tracking-tight tabular-nums sm:text-[26px]">
        {time.slice(0, 5)}
        <span className="text-[15px] font-bold text-(--card-muted) sm:text-base">
          {time.slice(5)}
        </span>
      </span>
      <span
        className={`mt-[3px] truncate text-[12.5px] sm:text-[13px] ${snap.live ? "text-(--card-muted)" : "font-bold text-(--notlive-text)"}`}>
        {sub}
      </span>
    </div>
  );
};

/** Where bus positions come from at the shown time, service changes, and preview mode. */
const Badges: React.FC<{ snap: TransitSnapshot }> = ({ snap }) => (
  <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
    <span
      title={snap.rt.title}
      className="flex items-center gap-1.5 rounded-full bg-(--mark-neutral-bg) px-2.5 py-1.5 text-[12.5px] whitespace-nowrap text-(--mark-neutral-fg)">
      <TimeMark mark={RT_MARK[snap.rt.mode]} />
      {snap.rt.label.replace("Buses: ", "Buses ")}
    </span>
    {snap.notices.length ?
      <span
        className="rounded-full bg-(--card-warn-bg) px-2.5 py-1.5 text-[12.5px] font-semibold whitespace-nowrap text-(--card-warn-fg)"
        title={snap.notices.join("\n")}>
        Service change
      </span>
    : null}
    {snap.preview.length ?
      <span
        className="rounded-full bg-purple-700 px-2.5 py-1.5 text-[12.5px] font-semibold whitespace-nowrap text-white"
        title={`Showing unconfirmed corrections for ${snap.preview.map(isoDate).join(", ")}: not what visitors see`}>
        Preview
      </span>
    : null}
  </div>
);

const NotLiveBadge: React.FC = () => (
  <span className="flex items-center gap-1.5 rounded-full bg-(--notlive-bg) px-3 py-1.5 text-[13px] font-extrabold tracking-wider whitespace-nowrap text-(--notlive-fg) uppercase">
    <ClockIcon />
    Not live
  </span>
);

const ClockIcon: React.FC = () => (
  <svg
    aria-hidden="true"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

/** Green "Live" only when live; otherwise the way back to it. */
const LiveOrGoLive: React.FC<Props> = ({ engine, snap }) =>
  snap.live ?
    <span className="flex h-10 flex-none items-center gap-1.5 rounded-[10px] bg-(--mark-live-bg) px-3 text-sm font-bold text-(--mark-live-fg)">
      <TimeMark mark="live" />
      Live
    </span>
  : <GoLiveButton onClick={() => engine.goLive()} />;

export const GoLiveButton: React.FC<{
  onClick: () => void;
  className?: string;
}> = ({ onClick, className }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex h-10 flex-none items-center gap-1.5 rounded-[10px] border-[1.5px] border-(--golive-border) bg-(--card-bg) px-3 text-sm font-bold whitespace-nowrap text-(--golive-fg) hover:bg-(--card-hover) ${className ?? ""}`}>
    <span
      aria-hidden="true"
      className="h-[9px] w-[9px] rounded-full border-2 border-current"
    />
    Go live
  </button>
);

/** The date as "Wed 7 Oct", opening the browser's date picker (bounded to the published timetables). */
const DateButton: React.FC<Props & { wide?: boolean }> = ({
  engine,
  snap,
  wide,
}) => {
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <div className={`relative ${wide ? "flex-1" : ""}`}>
      <button
        type="button"
        aria-label={`Date: ${shortDate(snap.serviceDate)}. Change date`}
        onClick={() => {
          const el = input.current;
          if (!el) return;
          try {
            el.showPicker();
          } catch {
            el.focus();
          }
        }}
        className="flex h-10 w-full items-center justify-center gap-2 rounded-[10px] border border-(--card-border) bg-(--card-bg) px-3 text-sm font-semibold whitespace-nowrap hover:bg-(--card-hover) max-sm:h-11 max-sm:text-[14.5px]">
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
        {shortDate(snap.serviceDate)}
      </button>
      <input
        ref={input}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-0"
        value={isoDate(snap.serviceDate)}
        min={snap.dateRange ? isoDate(snap.dateRange[0]) : undefined}
        max={snap.dateRange ? isoDate(snap.dateRange[1]) : undefined}
        onChange={(e) => {
          const d = fromIsoDate(e.target.value);
          if (d) engine.seekDate(d);
        }}
      />
    </div>
  );
};

const SpeedStepper: React.FC<Props> = ({ engine, snap }) => {
  const i = RATES.indexOf(snap.rate);
  const arrow = (d: string) => (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
  const step =
    "flex h-10 w-10 items-center justify-center hover:bg-(--card-hover) disabled:opacity-40 max-sm:h-11 max-sm:w-11";
  return (
    <div
      role="group"
      aria-label="Playback speed"
      className="flex flex-none items-center overflow-hidden rounded-[10px] border border-(--card-border)">
      <button
        type="button"
        aria-label="Slower"
        disabled={i === 0}
        onClick={() => stepRate(engine, false)}
        className={step}>
        {arrow("M11 7l-5 5 5 5M18 7l-5 5 5 5")}
      </button>
      <span
        aria-live="polite"
        className="min-w-[52px] text-center text-[15px] font-bold tabular-nums">
        {rateLabel(snap.rate)}
      </span>
      <button
        type="button"
        aria-label="Faster"
        disabled={i === RATES.length - 1}
        onClick={() => stepRate(engine, true)}
        className={step}>
        {arrow("M6 7l5 5-5 5M13 7l5 5-5 5")}
      </button>
    </div>
  );
};

const Slider: React.FC<Props & { ticks: number[] }> = ({
  engine,
  snap,
  ticks,
}) => {
  const [scrub, setScrub] = React.useState<number>();
  const [lo, hi] = snap.sliderRange;
  const value = scrub ?? Math.round(snap.t / 1000);
  const pct = (x: number) => ((x - lo) / (hi - lo)) * 100;
  const coverage = snap.coverage
    .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as const)
    .filter(([a, b]) => b > a);
  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-[7px] h-1.5 overflow-hidden rounded-full bg-(--slider-track)"
        title="Shaded: real bus positions recorded">
        {coverage.map(([a, b]) => (
          <span
            key={a}
            className="absolute inset-y-0 bg-(--slider-recorded)"
            style={{
              left: `${pct(a)}%`,
              width: `max(2px, ${pct(b) - pct(a)}%)`,
            }}
          />
        ))}
        <span
          className="absolute inset-y-0 left-0 bg-(--slider-fill)"
          style={{ width: `${Math.max(0, Math.min(100, pct(value * 1000)))}%` }}
        />
      </div>
      <input
        type="range"
        aria-label="Time of day"
        className="time-slider relative block h-5 w-full cursor-pointer"
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
        aria-hidden="true"
        className="relative mt-0.5 h-4 text-[11px] text-(--card-faint) tabular-nums">
        {ticks.map((h) => (
          <span
            key={h}
            className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
            style={{ left: `${((h - 3) / 24) * 100}%` }}>
            {String(h % 24).padStart(2, "0")}
          </span>
        ))}
      </div>
    </div>
  );
};
