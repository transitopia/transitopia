import React from "react";

import { CardTrail } from "@transitopia/shared/card-trail.ts";

/**
 * The cards a card was opened through, for its back strip (`back` on InfoCard,
 * apps/web/README.md#cross-references): a CardTrail, as the transit engine keeps, that re-renders
 * when the strip's label changes.
 */
export function useCardTrail<T>(): {
  /** The showing card (`here`, titled `label`) opens another. */
  push: (here: T, label: string) => void;
  pop: () => T | undefined;
  clear: () => void;
  backLabel: string | undefined;
} {
  const [trail] = React.useState(() => new CardTrail<T>());
  const [backLabel, setBackLabel] = React.useState<string>();
  return React.useMemo(
    () => ({
      push: (here, label) => {
        trail.push(here, label);
        setBackLabel(trail.backLabel);
      },
      pop: () => {
        const t = trail.pop();
        setBackLabel(trail.backLabel);
        return t;
      },
      clear: () => {
        trail.clear();
        setBackLabel(undefined);
      },
      backLabel,
    }),
    [trail, backLabel],
  );
}
