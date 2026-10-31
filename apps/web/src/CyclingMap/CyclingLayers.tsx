import React from "react";

import { COMFORT, type Comfort } from "@transitopia/cycling-core/classify.ts";

import {
  LayersPanel,
  PanelDivider,
  PanelHeading,
  SwitchRow,
} from "../components/LayersPanel.tsx";
import { COMFORT_NAMES } from "./comfort.ts";
import {
  comfortKey,
  DEFAULT_SHOW,
  type CyclingShow,
} from "./cycling-map-layers.ts";

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
const Line: React.FC<{ className: string; children?: React.ReactNode }> = ({
  className,
  children,
}) => <span className={`block w-7 ${className}`}>{children}</span>;

/** Each comfort level's line, as the map draws it (cycling-map-layers.ts). */
const COMFORT_SWATCHES: Record<Comfort, React.ReactNode> = {
  [COMFORT.most]: (
    <Line className="h-[5px] rounded-full bg-[#1a6d23] dark:bg-[#4cc26a]" />
  ),
  // With the white centre dashes the map adds from z13.
  [COMFORT.high]: (
    <Line className="flex h-[5px] items-center rounded-full bg-[#1a6d23] px-0.5 dark:bg-[#4cc26a]">
      <span className="h-px flex-1 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.8)_0_2px,transparent_2px_5px)] dark:bg-[repeating-linear-gradient(90deg,rgba(21,24,28,0.8)_0_2px,transparent_2px_5px)]" />
    </Line>
  ),
  [COMFORT.low]: (
    <Line className="h-[3px] bg-[repeating-linear-gradient(90deg,#1a6d23_0_4px,transparent_4px_9px)] dark:bg-[repeating-linear-gradient(90deg,#4cc26a_0_4px,transparent_4px_9px)]" />
  ),
  // Round dots, as the map draws comfort 1 (round caps on a short dash).
  [COMFORT.least]: (
    <Line className="h-[3px] bg-[radial-gradient(circle,#1a3223_1.2px,transparent_1.6px)] bg-[length:6px_3px] dark:bg-[radial-gradient(circle,#a7c9ae_1.2px,transparent_1.6px)]" />
  ),
};

/** The cycling layers panel (apps/web/README.md#header-and-layers), by comfort level. */
export const CyclingLayers: React.FC<{
  show: CyclingShow;
  onChange: (show: CyclingShow) => void;
}> = ({ show, onChange }) => {
  const set = (k: keyof CyclingShow) => (on: boolean) =>
    onChange({ ...show, [k]: on });
  const comfortRow = (c: Comfort) => (
    <SwitchRow
      key={c}
      title={COMFORT_NAMES[c].title}
      description={COMFORT_NAMES[c].description}
      swatch={COMFORT_SWATCHES[c]}
      on={show[comfortKey(c)]}
      onChange={set(comfortKey(c))}
    />
  );
  return (
    <LayersPanel label="Cycling layers" sectioned>
      <PanelHeading>Most comfortable</PanelHeading>
      {comfortRow(COMFORT.most)}
      {comfortRow(COMFORT.high)}
      <PanelDivider />
      <PanelHeading>Less comfortable</PanelHeading>
      {comfortRow(COMFORT.low)}
      {comfortRow(COMFORT.least)}
      <PanelDivider />
      <PanelHeading>More</PanelHeading>
      <SwitchRow
        title="Bike parking"
        swatch={
          <span className="h-[7px] w-[7px] rounded-full border-[1.5px] border-[#1a6d23]/80 bg-[#e7e783]/70 dark:border-[#4cc26a]/80 dark:bg-[#465028]" />
        }
        on={show.parking}
        onChange={set("parking")}
      />
      <SwitchRow
        title="Ferries"
        description="Crossings that take bikes"
        swatch={
          <Line className="h-[2px] bg-[repeating-linear-gradient(90deg,#4a7db2_0_8px,transparent_8px_14px)] dark:bg-[repeating-linear-gradient(90deg,#7fa9d4_0_8px,transparent_8px_14px)]" />
        }
        on={show.ferries}
        onChange={set("ferries")}
      />
      <SwitchRow
        title="Under construction"
        swatch={
          <Line className="h-[3.5px] bg-[repeating-linear-gradient(90deg,#e26d23_0_4px,transparent_4px_9px)] dark:bg-[repeating-linear-gradient(90deg,#f08a3c_0_4px,transparent_4px_9px)]" />
        }
        on={show.construction}
        onChange={set("construction")}
      />
    </LayersPanel>
  );
};
