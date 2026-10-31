import React from "react";
import { useLocation, useRoute } from "wouter";

import { Icon, type IconId } from "./Icon.tsx";
import { ModeLink } from "./ModeLink.tsx";
import { LAYERS_PANEL_ID, useLayersPanel } from "./LayersPanel.tsx";

const MODES: {
  href: string;
  label: string;
  icon: IconId;
  /** The active pill's colours, and its pulse ring's (`--pulse`). */
  active: string;
}[] = [
  {
    href: "/transit",
    label: "Transit",
    icon: "bus-front-fill",
    active:
      "bg-transit-blue text-[#06303a] [--pulse:var(--color-transit-blue)]",
  },
  {
    href: "/cycling",
    label: "Cycling",
    icon: "bicycle",
    active:
      "bg-cyclist-green text-[#0b3d23] [--pulse:var(--color-cyclist-green)]",
  },
];

/**
 * The header's mode switch (apps/web/README.md#header-and-layers): the other modes are links; the
 * active mode's pill opens its layers panel. Labels show from tablet width up. Until this browser
 * has opened a panel, the active pill pulses and, from tablet width up, a tip points to it.
 */
export const ModeSwitch: React.FC = () => {
  const { open, setOpen, seen } = useLayersPanel();
  const [location] = useLocation();
  // Closing the tip hides it only until the mode changes or the page reloads.
  const [tipClosed, setTipClosed] = React.useState(false);
  // A different mode has different layers: close the panel when the mode changes.
  React.useEffect(() => {
    setOpen(false);
    setTipClosed(false);
  }, [location, setOpen]);
  return (
    <nav
      aria-label="Mode"
      className="flex items-center gap-0.5 rounded-full bg-gray-100 p-[3px] sm:p-1 dark:bg-gray-800">
      {MODES.map((m) => (
        <ModeItem
          key={m.href}
          mode={m}
          open={open}
          onToggle={() => setOpen(!open)}
          hint={!seen && !tipClosed}
          onCloseTip={() => setTipClosed(true)}
        />
      ))}
    </nav>
  );
};

const ModeItem: React.FC<{
  mode: (typeof MODES)[number];
  open: boolean;
  onToggle: () => void;
  /** Point to the panel: a pulse, and the tip from tablet width up. */
  hint: boolean;
  onCloseTip: () => void;
}> = ({ mode, open, onToggle, hint, onCloseTip }) => {
  const [isActive] = useRoute(mode.href);
  if (isActive)
    return (
      <span className="relative flex">
        <button
          type="button"
          aria-current="page"
          aria-expanded={open}
          aria-controls={LAYERS_PANEL_ID}
          aria-label={`${mode.label} layers`}
          onClick={onToggle}
          className={`relative flex h-10 items-center gap-1 rounded-full pr-2 pl-3 text-sm font-bold sm:gap-1.5 sm:pr-2.5 ${mode.active} ${hint ? "mode-pulse" : ""}`}>
          <span className="text-lg sm:text-base">
            <Icon icon={mode.icon} />
          </span>
          <span className="max-sm:hidden">{mode.label}</span>
          <Icon icon={open ? "chevron-up" : "chevron-down"} size={16} />
        </button>
        {hint && !open ?
          <PanelTip label={mode.label} onClose={onCloseTip} />
        : null}
      </span>
    );
  return (
    <ModeLink
      href={mode.href}
      className="flex h-10 items-center justify-center gap-1.5 rounded-full text-sm font-semibold text-gray-700 hover:bg-gray-200 max-sm:w-11 sm:px-3 dark:text-gray-300 dark:hover:bg-gray-700">
      <span className="text-xl sm:text-base">
        <Icon icon={mode.icon} altText={mode.label} />
      </span>
      <span aria-hidden="true" className="max-sm:hidden">
        {mode.label}
      </span>
    </ModeLink>
  );
};

/** The tip under the active pill, until a panel has been opened (tablet width up; phones only pulse). */
const PanelTip: React.FC<{ label: string; onClose: () => void }> = ({
  label,
  onClose,
}) => (
  <div className="max-sm:hidden">
    {/* The arrow, centred under the pill. */}
    <span
      aria-hidden="true"
      className="absolute top-[calc(100%+0.75rem-6px)] left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 rounded-[2px] bg-main-blue dark:bg-sky-100"
    />
    <div
      role="status"
      className="absolute top-[calc(100%+0.75rem)] right-0 w-64 rounded-xl bg-main-blue py-2.5 pr-9 pl-3 text-[13px] leading-snug text-white shadow-lg dark:bg-sky-100 dark:text-[#06233b]">
      Click{" "}
      <b className="whitespace-nowrap">
        {label} <Icon icon="chevron-down" size={12} />
      </b>{" "}
      to see the legend and choose what’s on the map
      <button
        type="button"
        aria-label="Close tip"
        onClick={onClose}
        className="absolute top-1 right-1 flex h-7 w-7 items-center justify-center rounded-lg opacity-80 hover:bg-white/15 hover:opacity-100 dark:hover:bg-black/10">
        <Icon icon="close" size={14} />
      </button>
    </div>
  </div>
);
