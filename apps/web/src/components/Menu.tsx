import React from "react";

import { Icon, type IconId } from "./Icon.tsx";

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconId | undefined;
  /** Shown instead of the icon, e.g. a route's badge. */
  lead?: React.ReactNode;
  /** A smaller second line ("Stop #50913"). */
  note?: string | undefined;
  onSelect: () => void;
}

/** Where the list sits: under the trigger, or above it when there's no room below. */
type At = { right: number } & ({ top: number } | { bottom: number });

/**
 * A menu button: a trigger that opens a list of actions (ARIA menu pattern). Arrow keys move
 * between items, Escape, a press elsewhere or scrolling closes it, and choosing an item closes it.
 * The list is positioned `fixed` under the trigger (above it when there's no room below), so a
 * scrolling container (a card's body) doesn't clip it. The trigger can be an icon (named by `label`)
 * or a whole row whose content names it (`iconTrigger={false}`; departure rows on station cards).
 */
export const Menu: React.FC<{
  /** The menu's accessible name, e.g. "More actions"; also the trigger's when it's an icon. */
  label: string;
  /** The trigger's content (usually an icon). */
  trigger: React.ReactNode;
  /** False when the trigger's content names it (a row), so `label` names only the menu. */
  iconTrigger?: boolean;
  items: MenuItem[];
  /** Classes for the trigger button; `open` is true while the menu is showing. */
  triggerClassName?: (open: boolean) => string;
  className?: string;
}> = ({
  label,
  trigger,
  iconTrigger = true,
  items,
  triggerClassName,
  className,
}) => {
  const [at, setAt] = React.useState<At>();
  const ref = React.useRef<HTMLDivElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();
  const open = at !== undefined;

  React.useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setAt(undefined);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAt(undefined);
    };
    // A fixed list would drift from its trigger when the card scrolls.
    const onScroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setAt(undefined);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // No room below the trigger (a row near the bottom of the screen): open upwards instead.
  React.useLayoutEffect(() => {
    if (!at || !("top" in at) || !list.current) return;
    const below = list.current.getBoundingClientRect().bottom;
    const trigger = ref.current
      ?.querySelector("button")
      ?.getBoundingClientRect();
    if (trigger && below > window.innerHeight - 8)
      setAt({ bottom: window.innerHeight - trigger.top + 4, right: at.right });
  }, [at]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const els = [
      ...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []),
    ];
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[
      (i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length
    ]?.focus();
  };

  return (
    <div ref={ref} className={className}>
      <button
        type="button"
        aria-label={iconTrigger ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(
            open ? undefined : (
              { top: r.bottom + 4, right: window.innerWidth - r.right }
            ),
          );
        }}
        className={triggerClassName?.(open)}>
        {trigger}
      </button>
      {open ?
        <div
          ref={list}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          style={at}
          className="fixed z-50 w-max max-w-[300px] min-w-[230px] rounded-xl border border-(--card-border) bg-(--card-bg) p-1.5 text-(--card-text) shadow-[0_10px_28px_rgb(17_24_39/0.22)]">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setAt(undefined);
                item.onSelect();
              }}
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-1 text-left text-[15px] font-semibold hover:bg-(--card-hover) focus:bg-(--card-hover) focus:outline-none">
              {item.lead
                ?? (item.icon ? <Icon icon={item.icon} size={20} /> : null)}
              {item.note ?
                <span className="flex min-w-0 flex-col leading-snug">
                  {item.label}
                  <span className="text-[12.5px] font-normal text-(--card-muted)">
                    {item.note}
                  </span>
                </span>
              : item.label}
            </button>
          ))}
        </div>
      : null}
    </div>
  );
};
