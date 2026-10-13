import React from "react";

// The card for anything tapped on the map (apps/web/README.md#feature-cards): vehicles, stations,
// stops, routes, bike routes and bike parking all use these slots, top to bottom: header (icon tile,
// eyebrow, title, subtitle, ⋯ menu, close), an optional status line, chips, sections of rows, and a
// footer saying where the data comes from. Actions live only in the ⋯ menu, so the body is only
// information. Desktop: a 360 px panel at the top right; phones: a bottom sheet.

export type TileIcon = "station" | "train" | "stop" | "bike" | "ferry";
/** How a time or position is known: the same marks everywhere (live green dot, recorded grey dot, estimated "~"). */
export type Mark = "live" | "recorded" | "estimated";
export type StatusTone = Mark | "warn";
export type ChipTone = "info" | "good" | "warn";

export interface CardAction {
  id: string;
  label: string;
  icon: "follow" | "centre" | "share" | "filter";
  /** May resolve to a short confirmation shown under the header ("Link copied"). */
  onSelect: () => void | Promise<string | void>;
}

export interface CardChip {
  label: string;
  tone?: ChipTone | undefined;
  /** A route chip: the route's own colours. */
  color?: { bg: string; fg: string } | undefined;
}

const TILE_ICONS: Record<TileIcon, React.ReactNode> = {
  station: <circle cx="12" cy="12" r="7" strokeWidth="3" />,
  train: (
    <>
      <rect x="5" y="3" width="14" height="14" rx="3" />
      <path d="M5 10h14M9 21l-1.5-4M15 21l1.5-4" />
      <circle cx="9" cy="13.5" r="0.6" fill="currentColor" />
      <circle cx="15" cy="13.5" r="0.6" fill="currentColor" />
    </>
  ),
  stop: (
    <>
      <path d="M12 22V12" />
      <rect x="5" y="2.5" width="14" height="9.5" rx="2" />
      <path d="M9 7.5h6" />
    </>
  ),
  bike: (
    <>
      <circle cx="6" cy="16" r="4" />
      <circle cx="18" cy="16" r="4" />
      <path d="M6 16l4-8h5l3 8M10 8l2 8M14 5h2" />
    </>
  ),
  ferry: (
    <>
      <path d="M3 15l2 5h14l2-5z" />
      <path d="M6 15V9h12v6M9 9V5h6v4" />
    </>
  ),
};

const ACTION_ICONS: Record<CardAction["icon"], React.ReactNode> = {
  follow: <path d="M12 2.5l7 18-7-4-7 4z" />,
  centre: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  share: (
    <path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  ),
  filter: <path d="M3 5h18l-7 8v6l-4-2v-4z" />,
};

const Svg: React.FC<{ size: number; children: React.ReactNode }> = ({
  size,
  children,
}) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round">
    {children}
  </svg>
);

/** The live/recorded/estimated mark before a time or status. */
export const TimeMark: React.FC<{ mark: Mark; size?: "sm" | "md" }> = ({
  mark,
  size = "md",
}) =>
  mark === "estimated" ?
    <span
      title="Estimated from the schedule"
      className="-mr-0.5 font-bold leading-none text-(--mark-estimated)">
      ~
    </span>
  : <span
      title={mark === "live" ? "Live" : "Recorded"}
      className={`flex-none rounded-full ${size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2"} ${mark === "live" ? "bg-(--mark-live)" : "bg-(--mark-recorded)"}`}
    />;

const STATUS_STYLE: Record<StatusTone, string> = {
  live: "bg-(--mark-live-bg) text-(--mark-live-fg)",
  recorded: "bg-(--mark-neutral-bg) text-(--mark-neutral-fg)",
  estimated: "bg-(--mark-neutral-bg) text-(--mark-neutral-fg)",
  warn: "bg-(--card-warn-bg) text-(--card-warn-fg)",
};

const CHIP_STYLE: Record<ChipTone, string> = {
  info: "bg-(--card-chip-bg) text-(--card-chip-fg)",
  good: "bg-(--card-good-bg) text-(--card-good-fg)",
  warn: "bg-(--card-warn-bg) text-(--card-warn-fg)",
};

export const InfoCard: React.FC<{
  /** The tile: an icon, or short text (a route number), in the route's or the mode's colours. */
  tile: {
    icon?: TileIcon | undefined;
    text?: string | undefined;
    bg: string;
    fg: string;
  };
  /** The eyebrow is the line above the title (opposite of subtitle) */
  eyebrow: string;
  title: string;
  subtitle?: string | undefined;
  status?: { tone: StatusTone; text: string } | undefined;
  chips?: CardChip[] | undefined;
  actions?: CardAction[] | undefined;
  /**
   * Time-dependent cards when the map isn't live: an amber banner with the time shown and Go live
   * (apps/web/README.md#time-and-not-live). Bike cards ignore the map's time and never get one.
   */
  notLive?: { future: boolean; when: string; onGoLive: () => void } | undefined;
  footer?: React.ReactNode;
  onClose: () => void;
  children?: React.ReactNode;
}> = ({
  tile,
  eyebrow,
  title,
  subtitle,
  status,
  chips,
  actions,
  notLive,
  footer,
  onClose,
  children,
}) => {
  const [notice, setNotice] = React.useState<string>();
  React.useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  return (
    <article
      aria-label={title}
      aria-live="polite"
      data-map-overlay
      className={`info-card absolute z-50 flex flex-col overflow-hidden bg-(--card-bg) text-(--card-text) shadow-[0_8px_28px_rgb(17_24_39/0.16)] max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[60dvh] max-sm:rounded-t-[20px] max-sm:border-t sm:top-5 sm:right-[3.25rem] sm:max-h-[calc(100%-11rem)] sm:w-[360px] sm:rounded-2xl sm:border dark:shadow-[0_10px_32px_rgb(0_0_0/0.5)] ${notLive ? "border-(--notlive-border) max-sm:border-t-2 sm:border-2" : "border-(--card-border)"}`}>
      <div className="overflow-y-auto pb-[env(safe-area-inset-bottom)] sm:pb-0">
        <div aria-hidden="true" className="flex justify-center pt-2 sm:hidden">
          <span className="h-[5px] w-10 rounded-full bg-(--card-handle)" />
        </div>
        {notLive ?
          <div
            role="status"
            className="flex items-center gap-2.5 border-b border-(--notlive-border) bg-(--notlive-bg) py-2.5 pr-2.5 pl-3.5 text-(--notlive-fg) max-sm:mt-2">
            <svg
              aria-hidden="true"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="text-[13px] font-extrabold tracking-wider uppercase">
                {notLive.future ? "Not live · projected" : "Not live"}
              </span>
              <span className="text-sm font-semibold">
                {notLive.future ? "Projected for " : "Showing "}
                {notLive.when}
              </span>
            </div>
            <button
              type="button"
              onClick={notLive.onGoLive}
              className="h-9 flex-none rounded-[9px] border-[1.5px] border-current px-3 text-[13.5px] font-extrabold">
              Go live
            </button>
          </div>
        : null}
        {/*
          A grid, so the subtitle can run under the ⋯ and close buttons: they share the title's
          height, never the subtitle's.
        */}
        <header className="relative grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-start gap-x-3 pt-3.5 pr-2 pb-2.5 pl-4">
          <div
            aria-hidden="true"
            className="flex h-11 w-11 flex-none items-center justify-center rounded-[11px] text-base font-extrabold tracking-tight"
            style={{ background: tile.bg, color: tile.fg }}>
            {tile.icon ?
              <Svg size={tile.icon === "bike" ? 26 : 24}>
                {TILE_ICONS[tile.icon]}
              </Svg>
            : tile.text}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-px pt-px">
            <span className="text-xs font-bold uppercase tracking-wider text-(--card-muted)">
              {eyebrow}
            </span>
            <h2 className="text-[19px] leading-tight font-extrabold">
              {title}
            </h2>
          </div>
          <div className="flex items-start">
            {actions?.length ?
              <ActionMenu actions={actions} onNotice={setNotice} />
            : null}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="-mt-1 flex h-11 w-11 flex-none items-center justify-center rounded-full hover:bg-(--card-hover)">
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          {subtitle ?
            <span className="col-span-2 col-start-2 pr-2 text-sm text-(--card-muted)">
              {subtitle}
            </span>
          : null}
        </header>
        {notice ?
          <p
            role="status"
            className="px-4 pb-2 text-sm font-semibold text-(--card-good-fg)">
            {notice}
          </p>
        : null}
        {status ?
          <div className="px-4 pb-2.5">
            <span
              className={`inline-flex items-center gap-[7px] rounded-full px-2.5 py-[5px] text-[13px] font-semibold ${STATUS_STYLE[status.tone]}`}>
              {status.tone === "warn" ?
                <Svg size={14}>
                  <path d="M12 3L2 21h20z" />
                  <path d="M12 10v5M12 18v.5" />
                </Svg>
              : <TimeMark mark={status.tone} />}
              {status.text}
            </span>
          </div>
        : null}
        {chips?.length ?
          <div className="flex flex-wrap gap-1.5 px-4 pb-3">
            {chips.map((c) => (
              <span
                key={c.label}
                className={`inline-flex h-[26px] items-center rounded-md px-[9px] text-[13px] font-bold ${c.color ? "" : CHIP_STYLE[c.tone ?? "info"]}`}
                style={
                  c.color ?
                    { background: c.color.bg, color: c.color.fg }
                  : undefined
                }>
                {c.label}
              </span>
            ))}
          </div>
        : null}
        {children}
        {footer ?
          <footer className="border-t border-(--card-divider) bg-(--card-footer-bg) px-4 pt-2.5 pb-3.5 text-[12.5px] leading-snug text-(--card-muted)">
            {footer}
          </footer>
        : null}
      </div>
    </article>
  );
};

/** A heading over rows, separated from what's above by a 1 px divider. */
export const CardSection: React.FC<{
  title: string;
  children: React.ReactNode;
}> = ({ title, children }) => (
  <section className="border-t border-(--card-divider) px-4 pt-2.5 pb-2">
    <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-(--card-muted)">
      {title}
    </h3>
    <div className="divide-y divide-(--card-divider)">{children}</div>
  </section>
);

/** Label (with an optional note under it) and value; the value may carry a time mark. */
export const CardRow: React.FC<{
  label: React.ReactNode;
  note?: React.ReactNode;
  value?: React.ReactNode;
  mark?: Mark | undefined;
  /** "Unknown" and the like. */
  muted?: boolean | undefined;
}> = ({ label, note, value, mark, muted }) => (
  <div className="flex min-h-10 items-center gap-2.5 py-2">
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="text-[14.5px] leading-snug">{label}</span>
      {note ?
        <span className="text-[12.5px] leading-snug text-(--card-muted)">
          {note}
        </span>
      : null}
    </div>
    {value !== undefined ?
      <span
        className={`flex max-w-[65%] items-center justify-end gap-1.5 text-right text-[14.5px] font-bold tabular-nums ${muted ? "font-semibold text-(--card-faint)" : ""}`}>
        {mark ?
          <TimeMark mark={mark} />
        : null}
        {value}
      </span>
    : null}
  </div>
);

/** The ⋯ menu beside Close: every action the card offers. */
const ActionMenu: React.FC<{
  actions: CardAction[];
  onNotice: (text: string) => void;
}> = ({ actions, onNotice }) => {
  // Where the menu goes: fixed, under the button, so the card's scrolling body doesn't clip it.
  const [open, setOpen] = React.useState<{ top: number; right: number }>();
  const ref = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();
  React.useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(undefined);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(undefined);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // Arrow keys move between items.
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [
      ...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []),
    ];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <div ref={ref} className="-mt-1 -mr-1.5">
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={menuId}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(
            open ? undefined : (
              { top: r.bottom + 4, right: window.innerWidth - r.right }
            ),
          );
        }}
        className={`flex h-11 w-11 items-center justify-center rounded-full hover:bg-(--card-hover) ${open ? "bg-(--card-chip-bg)" : ""}`}>
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="currentColor">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open ?
        <div
          id={menuId}
          role="menu"
          aria-label="Actions"
          onKeyDown={onMenuKey}
          style={open}
          className="fixed z-50 w-[230px] rounded-xl border border-(--card-border) bg-(--card-bg) p-1.5 shadow-[0_10px_28px_rgb(17_24_39/0.22)]">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(undefined);
                void Promise.resolve(a.onSelect()).then((text) => {
                  if (text) onNotice(text);
                });
              }}
              className="flex h-11 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[15px] font-semibold hover:bg-(--card-hover) focus:bg-(--card-hover) focus:outline-none">
              <Svg size={20}>{ACTION_ICONS[a.icon]}</Svg>
              {a.label}
            </button>
          ))}
        </div>
      : null}
    </div>
  );
};

/** Share a link with the system sheet where there is one (phones), else copy it. */
export async function shareLink(
  url: string,
  title: string,
): Promise<string | void> {
  if (navigator.share) {
    try {
      await navigator.share({ url, title });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "Link copied";
  } catch {
    return "Couldn't copy the link";
  }
}
