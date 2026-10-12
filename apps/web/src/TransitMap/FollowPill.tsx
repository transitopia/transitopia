import type React from "react";
import type {
  TransitEngine,
  TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";

/** "Expo Line train to Waterfront", "99 bus to UBC". */
export function vehicleName(snap: TransitSnapshot): string {
  const v = snap.selected?.vehicle;
  const r = snap.selected?.route;
  if (!v || !r) return "vehicle";
  const to = v.headsign.replace(/^.*?\bTo\s+/i, "to ");
  return (
    r.mode === "bus" ? `${r.key} bus ${to}`
    : r.mode === "ferry" ? `${r.label} ${to}`
    : `${r.label} train ${to}`
  );
}

/**
 * Shown while the camera follows the selected vehicle (apps/web/README.md#follow), with Stop. Top
 * centre on desktop; on phones under the time pill.
 */
export const FollowPill: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
}> = ({ engine, snap }) =>
  snap.following && snap.selected ?
    <div
      role="status"
      data-map-overlay
      className="absolute z-[55] flex h-12 max-w-[calc(100%-1.25rem)] items-center gap-2.5 rounded-full border-2 border-[#0d98a6] bg-(--card-bg) pr-1.5 pl-3.5 whitespace-nowrap text-(--card-text) shadow-[0_4px_16px_rgb(17_24_39/0.14)] max-sm:top-[4.25rem] max-sm:left-2.5 sm:top-5 sm:left-1/2 sm:-translate-x-1/2 dark:border-transit-blue">
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        className="flex-none text-[#0d98a6] dark:text-transit-blue">
        <path d="M12 2.5l7 18-7-4-7 4z" />
      </svg>
      <span className="text-[14.5px] font-extrabold">Following</span>
      <span className="min-w-0 truncate text-sm text-(--card-muted) max-sm:hidden">
        {vehicleName(snap)}
      </span>
      <button
        type="button"
        onClick={() => engine.setFollowing(false)}
        className="h-9 flex-none rounded-full bg-(--card-chip-bg) px-3 text-[13.5px] font-bold hover:bg-(--card-hover)">
        Stop
      </button>
    </div>
  : null;
