import React from "react";

import {
  LayersPanel,
  PanelDivider,
  SwitchRow,
} from "../components/LayersPanel.tsx";
import { DEFAULT_SHOW, type CyclingShow } from "./cycling-map-layers.ts";

const STORAGE_KEY = "transitopia:cycling:layers";

/** The panel's choices, remembered per browser (storage can be unavailable: defaults always work). */
export function useCyclingShow(): [CyclingShow, (show: CyclingShow) => void] {
  const [show, setShow] = React.useState<CyclingShow>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw)
        return {
          ...DEFAULT_SHOW,
          ...(JSON.parse(raw) as Partial<CyclingShow>),
        };
    } catch {
      // Storage unavailable or unreadable.
    }
    return DEFAULT_SHOW;
  });
  const update = React.useCallback((next: CyclingShow) => {
    setShow(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Preferences are optional.
    }
  }, []);
  return [show, update];
}

/** A line sample in the cycling layer's style (cycling-map-layers.ts). */
const Line: React.FC<{ className: string }> = ({ className }) => (
  <span className={`block w-7 ${className}`} />
);

/** The cycling layers panel (apps/web/README.md#header-and-layers). */
export const CyclingLayers: React.FC<{
  show: CyclingShow;
  onChange: (show: CyclingShow) => void;
}> = ({ show, onChange }) => {
  const set = (k: keyof CyclingShow) => (on: boolean) =>
    onChange({ ...show, [k]: on });
  return (
    <LayersPanel label="Cycling layers">
      <SwitchRow
        title="Protected lanes & paths"
        description="Separated from traffic"
        swatch={
          <Line className="h-[5px] rounded-full bg-[#1a6d23] dark:bg-[#4cc26a]" />
        }
        on={show.protected}
        onChange={set("protected")}
      />
      <SwitchRow
        title="Local street bikeways"
        description="Shared, traffic-calmed streets"
        swatch={
          <Line className="h-1 rounded-full bg-[#1a6d23] dark:bg-[#4cc26a]" />
        }
        on={show.local}
        onChange={set("local")}
      />
      <SwitchRow
        title="Painted bike lanes"
        description="On the roadway, and shared lanes on busy streets"
        swatch={
          <Line className="h-[3px] bg-[repeating-linear-gradient(90deg,#1a6d23_0_4px,transparent_4px_9px)] dark:bg-[repeating-linear-gradient(90deg,#4cc26a_0_4px,transparent_4px_9px)]" />
        }
        on={show.painted && !show.aaaOnly}
        onChange={(on) =>
          // Showing painted lanes again also lifts "all ages & abilities only".
          onChange({ ...show, painted: on, aaaOnly: on ? false : show.aaaOnly })
        }
      />
      <SwitchRow
        title="Bike parking"
        swatch={
          <span className="h-[7px] w-[7px] rounded-full border-[1.5px] border-[#1a6d23]/80 bg-[#e7e783]/70 dark:border-[#4cc26a]/80 dark:bg-[#465028]" />
        }
        on={show.parking}
        onChange={set("parking")}
      />
      <SwitchRow
        title="Under construction"
        swatch={
          <Line className="h-[3.5px] bg-[repeating-linear-gradient(90deg,#e26d23_0_4px,transparent_4px_9px)] dark:bg-[repeating-linear-gradient(90deg,#f08a3c_0_4px,transparent_4px_9px)]" />
        }
        on={show.construction}
        onChange={set("construction")}
      />
      <PanelDivider />
      <SwitchRow
        title="All ages & abilities only"
        description="Hide painted lanes and busy shared roads"
        on={show.aaaOnly}
        onChange={set("aaaOnly")}
      />
    </LayersPanel>
  );
};
