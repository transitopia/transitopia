import React from "react";

import { Icon, type IconId } from "./Icon.tsx";
import { Menu } from "./Menu.tsx";

// The card for anything tapped on the map (apps/web/README.md#feature-cards): vehicles, stations,
// stops, routes, bike routes and bike parking all use these slots, top to bottom: header (icon tile,
// eyebrow, title, subtitle, ⋯ menu, close), an optional status line, chips, sections of rows, and a
// footer saying where the data comes from. Actions live only in the ⋯ menu, so the body is
// information (departure rows excepted: they open what they name). A card opened from another card (a departure row's menu) gets a back strip on top
// naming that card. Desktop: a 360 px panel at the top right; phones: a bottom sheet.

/** How a time or position is known: the same marks everywhere (live green dot, recorded grey dot, estimated "~"). */
export type Mark = "live" | "recorded" | "estimated";
export type StatusTone = Mark | "warn";
export type ChipTone = "info" | "good" | "warn";

export interface CardAction {
  id: string;
  label: string;
  icon: IconId;
  /** May resolve to a short confirmation shown under the header ("Link copied"). */
  onSelect: () => void | Promise<string | void>;
}

export interface CardChip {
  label: string;
  tone?: ChipTone | undefined;
  /** A route chip: the route's own colours. */
  color?: { bg: string; fg: string } | undefined;
}

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
    icon?: IconId | undefined;
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
  /** The card this one was opened from (apps/web/README.md#cross-references): its title, and how to return. */
  back?: { label: string; onBack: () => void } | undefined;
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
  back,
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
        {back ?
          <button
            type="button"
            onClick={back.onBack}
            aria-label={`Back to ${back.label}`}
            className="flex h-10 w-full items-center gap-1.5 border-b border-(--card-divider) bg-(--card-back-bg) pr-4 pl-2.5 text-left text-[13.5px] font-bold text-(--card-link) hover:bg-(--card-hover)">
            <Icon icon="chevron-left" size={18} />
            <span className="truncate">{back.label}</span>
          </button>
        : null}
        {notLive ?
          <div
            role="status"
            className="flex items-center gap-2.5 border-b border-(--notlive-border) bg-(--notlive-bg) py-2.5 pr-2.5 pl-3.5 text-(--notlive-fg)">
            <Icon icon="clock" size={22} />
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
              <Icon icon={tile.icon} size={24} />
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
              <Menu
                label="More actions"
                trigger={<Icon icon="three-dots" size={20} />}
                className="-mt-1 -mr-1.5"
                triggerClassName={(open) =>
                  `flex h-11 w-11 items-center justify-center rounded-full hover:bg-(--card-hover) ${open ? "bg-(--card-chip-bg)" : ""}`
                }
                items={actions.map((a) => ({
                  ...a,
                  // An action may confirm what it did ("Link copied") under the header.
                  onSelect: () =>
                    void Promise.resolve(a.onSelect()).then((text) => {
                      if (text) setNotice(text);
                    }),
                }))}
              />
            : null}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="-mt-1 flex h-11 w-11 flex-none items-center justify-center rounded-full hover:bg-(--card-hover)">
              <Icon icon="close" size={18} />
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
                <Icon icon="warning" size={14} />
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
