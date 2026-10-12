import React from "react";
import type { TransitEngine } from "@transitopia/transit-map/engine.ts";

type Padding = { top: number; right: number; bottom: number; left: number };

/**
 * The map edges covered by chrome marked `data-map-overlay` (header, cards, time bar), so follow and
 * "Centre on map" keep the vehicle where it can be seen (apps/web/README.md#follow). Each overlay
 * counts against whichever edge gives up the smallest share of the map: the header is a top band,
 * the desktop card a right one, a phone's bottom sheet a bottom one.
 */
export function measureOverlays(map: HTMLElement): Padding {
  const box = map.getBoundingClientRect();
  const pad: Padding = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const el of document.querySelectorAll<HTMLElement>(
    "[data-map-overlay]",
  )) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const sides: [keyof Padding, number, number][] = [
      ["top", r.bottom - box.top, box.height],
      ["bottom", box.bottom - r.top, box.height],
      ["left", r.right - box.left, box.width],
      ["right", box.right - r.left, box.width],
    ];
    const [side, px] = sides.reduce((a, b) =>
      b[1] / b[2] < a[1] / a[2] ? b : a,
    );
    pad[side] = Math.max(pad[side], Math.max(0, px));
  }
  return pad;
}

/** Re-measure after every render (cheap: a handful of rects) and on resize. */
export function useOverlayPadding(engine: TransitEngine): void {
  const last = React.useRef("");
  const update = React.useCallback(() => {
    const map = document.getElementById("map");
    if (!map) return;
    const pad = measureOverlays(map);
    const key = JSON.stringify(pad);
    if (key === last.current) return;
    last.current = key;
    engine.setViewPadding(pad);
  }, [engine]);
  React.useEffect(update);
  React.useEffect(() => {
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [update]);
}
