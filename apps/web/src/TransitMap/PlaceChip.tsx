import React from "react";
import type { Place } from "@transitopia/transit-map/url.ts";

import { CardChips } from "../components/InfoCard.tsx";

/**
 * A stop, exchange or station a card names, as a chip opening its card, with a back strip returning
 * to the card it was opened from (apps/web/README.md#cross-references).
 */
export const PlaceChip: React.FC<{
  place: Place;
  label: string;
  onOpen: (p: Place) => void;
  className?: string | undefined;
}> = ({ place, label, onOpen, className = "justify-end" }) => (
  <CardChips
    className={className}
    chips={[
      {
        label,
        icon: place.kind === "station" ? "station" : "bus-stop",
        onSelect: () => onOpen(place),
        action: `View ${place.kind}: ${label}`,
      },
    ]}
  />
);
