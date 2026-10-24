// Stop spacing as the site shows it (apps/web/README.md#stop-spacing): the categories are
// @transitopia/shared/stop-spacing.ts, shared with the plan's figures and the layers panel.

import type { StopSpacingTier } from "@transitopia/shared/stop-spacing.ts";
import type { IconId } from "../components/Icon.tsx";

/** "240 m", "1.1 km", "12 km": to 10 m below a kilometre, then to 100 m, whole kilometres from 10. */
export function spacingText(metres: number): string {
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(metres >= 10_000 ? 0 : 1)} km`;
}

/** A tier's icon, in the text colour: never the frequency bands' colours, which mean good or bad. */
export function spacingIcon(tier: StopSpacingTier): IconId {
  return `stops-${tier.id}`;
}
