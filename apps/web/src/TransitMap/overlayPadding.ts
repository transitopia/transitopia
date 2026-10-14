import React from "react";
import type { TransitEngine } from "@transitopia/transit-map/engine.ts";

type Padding = { top: number; right: number; bottom: number; left: number };

type Rect = Pick<
  DOMRect,
  "top" | "right" | "bottom" | "left" | "width" | "height"
>;

/**
 * The map edges covered by chrome marked `data-map-overlay` (header, cards, time bar), so follow and
 * "Centre on map" keep the vehicle where it can be seen (apps/web/README.md#follow).
 */
export function measureOverlays(map: HTMLElement): Padding {
  return overlayPadding(
    map.getBoundingClientRect(),
    [...document.querySelectorAll<HTMLElement>("[data-map-overlay]")].map(
      (el) => el.getBoundingClientRect(),
    ),
  );
}

/**
 * Each overlay counts against whichever edge of the map `box` gives up the smallest share of the
 * map: the header is a top band, the desktop card a right one, a phone's bottom sheet a bottom one.
 * Hidden overlays (no size) don't count.
 */
export function overlayPadding(box: Rect, overlays: Rect[]): Padding {
  const pad: Padding = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const r of overlays) {
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
