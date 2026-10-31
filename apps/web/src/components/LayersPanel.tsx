import React from "react";
import { createPortal } from "react-dom";

// The active mode's layers panel (apps/web/README.md#header-and-layers): the header's mode switch
// opens it, and the mode's own component fills it, because only the mode knows its layers. It drops
// down from the header: a popover on desktop, a full-width panel on phones.

const LayersPanelContext = React.createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Whether this browser has ever opened a layers panel (the mode switch's tip waits for it). */
  seen: boolean;
  /** The element inside the header that the panel is rendered into. */
  host: HTMLElement | null;
  setHost: (el: HTMLElement | null) => void;
}>({
  open: false,
  setOpen: () => {},
  seen: true,
  host: null,
  setHost: () => {},
});

export const useLayersPanel = () => React.useContext(LayersPanelContext);

const SEEN_KEY = "transitopia:layers-panel-seen";

function loadSeen(): boolean {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "false") === true;
  } catch {
    return false; // Storage unavailable: the tip shows each visit.
  }
}

export const LayersPanelProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [open, setOpenState] = React.useState(false);
  const [seen, setSeen] = React.useState(loadSeen);
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  const setOpen = React.useCallback((next: boolean) => {
    setOpenState(next);
    if (!next) return;
    setSeen(true);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(true));
    } catch {
      // Preferences are optional.
    }
  }, []);
  const value = React.useMemo(
    () => ({ open, setOpen, seen, host, setHost }),
    [open, setOpen, seen, host],
  );
  return (
    <LayersPanelContext.Provider value={value}>
      {children}
    </LayersPanelContext.Provider>
  );
};

/** Where the header puts the panel. */
export const LayersPanelHost: React.FC = () => {
  const { setHost } = useLayersPanel();
  return <div ref={setHost} className="contents" />;
};

export const LAYERS_PANEL_ID = "layers-panel";

/** The panel, filled by the active mode. Renders nothing while closed. */
export const LayersPanel: React.FC<{
  /** "Transit layers": the panel's name, and its heading on phones. */
  label: string;
  /** The rows come in sections with their own headings (`PanelHeading`), so the panel's "Show" is left out. */
  sectioned?: boolean | undefined;
  children: React.ReactNode;
}> = ({ label, sectioned, children }) => {
  const { open, setOpen, host } = useLayersPanel();
  const ref = React.useRef<HTMLElement>(null);

  // Close on Escape, or a press outside the panel and the header (desktop: it's a popover). Escape
  // is caught first and marked handled, so an open card stays open (InfoCard closes on Escape).
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      const header = ref.current?.closest("header");
      if (header && !header.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, setOpen]);

  if (!open || !host) return null;
  return createPortal(
    <>
      {/* Phones: dim the map below the panel. */}
      <div
        aria-hidden="true"
        className="layers-scrim sm:hidden"
        onClick={() => setOpen(false)}
      />
      <section
        ref={ref}
        id={LAYERS_PANEL_ID}
        aria-label={label}
        className="layers-panel bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100">
        <div className="flex items-center py-1.5 pr-2 pl-4 sm:hidden">
          <h2 className="flex-1 text-lg font-extrabold">{label}</h2>
          <button
            type="button"
            className="h-11 px-3.5 font-bold text-main-blue dark:text-sky-300"
            onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
        {sectioned ? null : (
          <h2 className={`${HEADING} max-sm:hidden`}>Show</h2>
        )}
        {children}
      </section>
    </>,
    host,
  );
};

/** A switch as the panel draws it (decorative: the whole row is the button). */
const SwitchKnob: React.FC<{ on: boolean }> = ({ on }) => (
  <span
    aria-hidden="true"
    className={`flex h-7 w-12 flex-none rounded-full p-0.5 sm:h-6 sm:w-10 ${on ? "justify-end bg-main-blue dark:bg-sky-600" : "justify-start bg-gray-300 dark:bg-gray-600"}`}>
    <span className="h-6 w-6 rounded-full bg-white shadow sm:h-5 sm:w-5" />
  </span>
);

/**
 * A layer that can be shown or hidden: swatch, name, optional description, switch. Disabled (greyed
 * out, drawn off) when there's nothing of it here, with `disabledReason` as its tooltip.
 */
export const SwitchRow: React.FC<{
  on: boolean;
  onChange: (on: boolean) => void;
  title: string;
  description?: string | undefined;
  swatch?: React.ReactNode;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}> = ({
  on,
  onChange,
  title,
  description,
  swatch,
  disabled,
  disabledReason,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={on && !disabled}
    disabled={disabled}
    title={disabled ? disabledReason : undefined}
    onClick={() => onChange(!on)}
    className={`flex w-full items-center gap-3 px-4 py-2 text-left ${disabled ? "cursor-default opacity-45" : "hover:bg-gray-50 dark:hover:bg-gray-800"} ${description ? "min-h-14" : "min-h-12"}`}>
    {swatch !== undefined ?
      <span aria-hidden="true" className="flex w-7 flex-none justify-center">
        {swatch}
      </span>
    : null}
    <span className="flex flex-1 flex-col gap-0.5">
      <span className="text-[15px] font-bold max-sm:text-base">{title}</span>
      {description ?
        <span className="text-[12.5px] text-gray-600 max-sm:text-[13px] dark:text-gray-400">
          {description}
        </span>
      : null}
    </span>
    <SwitchKnob on={on && !disabled} />
  </button>
);

const HEADING =
  "px-4 pt-2 pb-1 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400";

/** A section's heading, in a `sectioned` panel. */
export const PanelHeading: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => <h3 className={HEADING}>{children}</h3>;

export const PanelDivider: React.FC = () => (
  <div className="mx-4 my-1.5 h-px bg-gray-200 dark:bg-gray-700" />
);
