import React from "react";

import { Icon, type IconId } from "./Icon.tsx";

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconId | undefined;
  onSelect: () => void;
}

/**
 * A menu button: a trigger that opens a list of actions (ARIA menu pattern). Arrow keys move
 * between items, Escape or a press elsewhere closes it, and choosing an item closes it. The list is
 * positioned `fixed` under the trigger, so a scrolling container (a card's body) doesn't clip it.
 */
export const Menu: React.FC<{
  /** The trigger's accessible name, e.g. "More actions". */
  label: string;
  /** The trigger's content (usually an icon). */
  trigger: React.ReactNode;
  items: MenuItem[];
  /** Classes for the trigger button; `open` is true while the menu is showing. */
  triggerClassName?: (open: boolean) => string;
  className?: string;
}> = ({ label, trigger, items, triggerClassName, className }) => {
  const [at, setAt] = React.useState<{ top: number; right: number }>();
  const ref = React.useRef<HTMLDivElement>(null);
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
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
        aria-label={label}
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
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          style={at}
          className="fixed z-50 w-[230px] rounded-xl border border-(--card-border) bg-(--card-bg) p-1.5 text-(--card-text) shadow-[0_10px_28px_rgb(17_24_39/0.22)]">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setAt(undefined);
                item.onSelect();
              }}
              className="flex h-11 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[15px] font-semibold hover:bg-(--card-hover) focus:bg-(--card-hover) focus:outline-none">
              {item.icon ?
                <Icon icon={item.icon} size={20} />
              : null}
              {item.label}
            </button>
          ))}
        </div>
      : null}
    </div>
  );
};
