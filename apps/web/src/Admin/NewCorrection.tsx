import React from "react";
import type * as z from "zod";
import type { Disruption } from "@transitopia/transit-core/disruption/types.ts";
import type { ObservationFile } from "@transitopia/transit-core/corrections/types.ts";
import {
  disruption,
  observationFile,
  type observationSetPut,
} from "@transitopia/shared/admin-api.ts";
import { useWrite } from "./api.ts";
import { JsonEditor } from "./JsonEditor.tsx";
import { button, card, errorText } from "./styles.ts";

const DISRUPTION_TEMPLATE: Disruption = {
  id: "2026-10-01-expo-single-track",
  source: "TransLink alert",
  text: "Expo Line single-tracking between Edmonds and Royal Oak",
  active: [
    { from: "2026-10-01T21:30:00-07:00", until: "2026-10-02T02:00:00-07:00" },
  ],
  singleTrack: [
    {
      line: "expo",
      between: ["Edmonds", "Royal Oak"],
      keep: "Edmonds Station @ Platform 2",
      pinEnds: true,
    },
  ],
};

const OBSERVATION_TEMPLATE: ObservationFile = {
  $comment: "Rider report",
  observations: [
    {
      kind: "at_platform",
      date: "2026-10-01",
      source: "rider report",
      stop: "Waterfront Station @ Platform 1",
      time: "2026-10-01T08:15:30-07:00",
      line: "expo",
    },
  ],
};

/** Write a new disruption or observation set (see the formats in regions/metro-vancouver/*\/README.md). */
export function NewCorrection() {
  const [kind, setKind] = React.useState<
    "disruption" | "observations" | undefined
  >();
  const [id, setId] = React.useState("");
  const write = useWrite();
  const close = () => {
    setKind(undefined);
    write.reset();
  };
  if (!kind)
    return (
      <div className="flex gap-2">
        <button
          type="button"
          className={button}
          onClick={() => setKind("disruption")}>
          New disruption
        </button>
        <button
          type="button"
          className={button}
          onClick={() => setKind("observations")}>
          New observations
        </button>
      </div>
    );
  return (
    <div className={`${card} flex flex-col gap-2`}>
      <h3 className="font-medium">
        New {kind === "disruption" ? "disruption" : "observation set"}
      </h3>
      {kind === "observations" ?
        <label className="text-sm">
          Id{" "}
          <input
            className="rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
            placeholder="2026-10-01-rider-expo"
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
        </label>
      : null}
      {write.error ?
        <p className={errorText}>{write.error.message}</p>
      : null}
      {kind === "disruption" ?
        <JsonEditor
          value={DISRUPTION_TEMPLATE}
          schema={disruption}
          busy={write.isPending}
          onSave={(d) =>
            write.mutate(
              {
                path: `admin/api/disruptions/${encodeURIComponent(d.id)}`,
                method: "PUT",
                body: d,
              },
              { onSuccess: close },
            )
          }
        />
      : <JsonEditor
          value={OBSERVATION_TEMPLATE}
          schema={observationFile}
          busy={write.isPending}
          onSave={(file) =>
            write.mutate(
              {
                path: `admin/api/observations/${encodeURIComponent(id)}`,
                method: "PUT",
                body: {
                  title: file.$comment ?? id,
                  file,
                } satisfies z.input<typeof observationSetPut>,
              },
              { onSuccess: close },
            )
          }
        />
      }
      <button type="button" className={`${button} self-start`} onClick={close}>
        Cancel
      </button>
    </div>
  );
}
