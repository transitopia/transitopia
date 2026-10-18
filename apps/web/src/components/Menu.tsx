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

/** What a list opens from (viewport px): a trigger's rectangle, or a point. */
export interface MenuAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Where the list sits: under the anchor, or above it when there's no room below. */
type At = ({ right: number } | { left: number })
  & ({ top: number } | { bottom: number }) & { maxHeight?: number };
/** The list keeps this far from the screen's edges (px). */
const EDGE_PX = 8;

/**
 * A menu's list of actions (ARIA menu), positioned `fixed` by its anchor, so a scrolling container
 * (a card's body) doesn't clip it: under it (above when there's no room below), its right edge on
 * the anchor's (`align="right"`, a trigger at a card's edge) or its left edge (`align="left"`, a
 * point on the map; moved in when it would run off the screen). Arrow keys move between items;
 * Escape, a press outside it (and outside `inside`, its trigger) or scrolling closes it, and so does
 * choosing an item. Escape is caught first and marked handled, so it closes only the menu, not the
 * card it's on.
 */
export const MenuList: React.FC<{
  id?: string;
  /** The menu's accessible name. */
  label: string;
  items: MenuItem[];
  anchor: MenuAnchor;
  align: "left" | "right";
  onClose: () => void;
  /** Presses in here don't close it (its trigger, which toggles it itself). */
  inside?: React.RefObject<HTMLElement | null>;
  /** Where it must fit (viewport px), within EDGE_PX; the screen by default. */
  bounds?: MenuAnchor | undefined;
}> = ({ id, label, items, anchor, align, onClose, inside, bounds }) => {
  const list = React.useRef<HTMLDivElement>(null);
  const [at, setAt] = React.useState<At>(() =>
    align === "right" ?
      { top: anchor.bottom + 4, right: window.innerWidth - anchor.right }
    : { top: anchor.bottom + 4, left: anchor.left },
  );
  // Every item gets the same leading slot when any has an icon or badge, so the labels line up.
  const leading = items.some((i) => i.lead !== undefined || i.icon);
  const close = React.useRef(onClose);
  close.current = onClose;

  React.useEffect(() => {
    list.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const within = (t: EventTarget | null) =>
      list.current?.contains(t as Node) || inside?.current?.contains(t as Node);
    const onDown = (e: PointerEvent) => {
      if (!within(e.target)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close.current();
    };
    // A fixed list would drift from its anchor when the card scrolls.
    const onScroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) close.current();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [inside]);

  // No room below the anchor (a row near the bottom of the screen): open upwards instead, when
  // there's more room there, scrolling within what room there is; and keep a list opened at a point
  // on the screen.
  React.useLayoutEffect(() => {
    if (!list.current || at.maxHeight !== undefined) return;
    const r = list.current.getBoundingClientRect();
    const fit = bounds ?? {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
    const below = fit.bottom - anchor.bottom - 4 - EDGE_PX;
    const above = anchor.top - fit.top - 4 - EDGE_PX;
    const side =
      r.height <= below || below >= above ?
        { top: anchor.bottom + 4, maxHeight: below }
      : { bottom: window.innerHeight - anchor.top + 4, maxHeight: above };
    const x =
      "right" in at ?
        { right: at.right }
      : {
          left: Math.max(
            fit.left + EDGE_PX,
            Math.min(at.left, fit.right - EDGE_PX - r.width),
          ),
        };
    setAt({ ...x, ...side });
  }, [at, anchor, bounds]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const els = [
      ...(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []),
    ];
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[
      (i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length
    ]?.focus();
  };

  return (
    <div
      ref={list}
      id={id}
      role="menu"
      aria-label={label}
      onKeyDown={onMenuKey}
      style={at}
      className="fixed z-50 w-max max-w-[300px] min-w-[230px] overflow-y-auto rounded-xl border border-(--card-border) bg-(--card-bg) p-1.5 text-(--card-text) shadow-[0_10px_28px_rgb(17_24_39/0.22)]">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          // Like a native menu, the item under the pointer is the active one, so the arrow keys
          // go on from it and there's one highlight. The opening focus on the first item (for
          // keyboard and screen reader users) shows only when it came from the keyboard, and a
          // hovered item only while it's the active one (not once the arrow keys move on).
          onPointerMove={(e) => {
            if (document.activeElement !== e.currentTarget)
              e.currentTarget.focus();
          }}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-1 text-left text-[15px] font-semibold focus:outline-none focus-visible:bg-(--card-hover) hover:focus:bg-(--card-hover)">
          {leading ?
            <span className="flex w-8 flex-none items-center justify-center">
              {item.lead
                ?? (item.icon ? <Icon icon={item.icon} size={20} /> : null)}
            </span>
          : null}
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
  );
};

/**
 * A menu button: a trigger that opens a MenuList under it (ARIA menu button pattern). The trigger
 * can be an icon (named by `label`) or a whole row whose content names it (`iconTrigger={false}`;
 * departure rows on station cards).
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
  const [anchor, setAnchor] = React.useState<MenuAnchor>();
  const ref = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();
  const open = anchor !== undefined;

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
          setAnchor(
            open ? undefined : (
              { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
            ),
          );
        }}
        className={triggerClassName?.(open)}>
        {trigger}
      </button>
      {anchor ?
        <MenuList
          id={menuId}
          label={label}
          items={items}
          anchor={anchor}
          align="right"
          onClose={() => setAnchor(undefined)}
          inside={ref}
        />
      : null}
    </div>
  );
};
