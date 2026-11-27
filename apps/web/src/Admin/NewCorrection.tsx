import React from "react";
import type * as z from "zod";
import type { ObservationFile } from "@transitopia/transit-core/corrections/types.ts";
import {
  observationFile,
  type observationSetPut,
} from "@transitopia/shared/admin-api.ts";
import { useWrite } from "./api.ts";
import { JsonEditor } from "./JsonEditor.tsx";
import { button, card, errorText } from "./styles.ts";

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

/** Write a new observation set (see the format in config/feeds/translink/observations/README.md). */
export function NewCorrection() {
  const [open, setOpen] = React.useState(false);
  const [id, setId] = React.useState("");
  const write = useWrite();
  const close = () => {
    setOpen(false);
    write.reset();
  };
  if (!open)
    return (
      <div className="flex gap-2">
        <button type="button" className={button} onClick={() => setOpen(true)}>
          New observations
        </button>
      </div>
    );
  return (
    <div className={`${card} flex flex-col gap-2`}>
      <h3 className="font-medium">New observation set</h3>
      <label className="text-sm">
        Id{" "}
        <input
          className="rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
          placeholder="2026-10-01-rider-expo"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      {write.error ?
        <p className={errorText}>{write.error.message}</p>
      : null}
      <JsonEditor
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
      <button type="button" className={`${button} self-start`} onClick={close}>
        Cancel
      </button>
    </div>
  );
}
