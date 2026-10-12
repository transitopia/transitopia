import React from "react";
import { useLocation, useRoute } from "wouter";

import { Icon, type IconId } from "./Icon.tsx";
import { ModeLink } from "./ModeLink.tsx";
import { LAYERS_PANEL_ID, useLayersPanel } from "./LayersPanel.tsx";

const MODES: {
  href: string;
  label: string;
  icon: IconId;
  /** The active pill's colours. */
  active: string;
}[] = [
  {
    href: "/transit",
    label: "Transit",
    icon: "bus-front-fill",
    active: "bg-transit-blue text-[#06303a]",
  },
  {
    href: "/cycling",
    label: "Cycling",
    icon: "bicycle",
    active: "bg-cyclist-green text-[#0b3d23]",
  },
];

/**
 * The header's mode switch (apps/web/README.md#header-and-layers): the other modes are links; the
 * active mode's pill opens its layers panel. Labels show from tablet width up.
 */
export const ModeSwitch: React.FC = () => {
  const { open, setOpen } = useLayersPanel();
  const [location] = useLocation();
  // A different mode has different layers: close the panel when the mode changes.
  React.useEffect(() => setOpen(false), [location, setOpen]);
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
        />
      ))}
    </nav>
  );
};

const ModeItem: React.FC<{
  mode: (typeof MODES)[number];
  open: boolean;
  onToggle: () => void;
}> = ({ mode, open, onToggle }) => {
  const [isActive] = useRoute(mode.href);
  if (isActive)
    return (
      <button
        type="button"
        aria-current="page"
        aria-expanded={open}
        aria-controls={LAYERS_PANEL_ID}
        aria-label={`${mode.label} layers`}
        onClick={onToggle}
        className={`flex h-10 items-center gap-1 rounded-full pr-2 pl-3 text-sm font-bold sm:gap-1.5 sm:pr-2.5 ${mode.active}`}>
        <span className="text-lg sm:text-base">
          <Icon icon={mode.icon} />
        </span>
        <span className="max-sm:hidden">{mode.label}</span>
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={open ? "rotate-180" : ""}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
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
