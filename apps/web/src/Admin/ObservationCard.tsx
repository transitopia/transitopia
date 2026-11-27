import React from "react";
import type * as z from "zod";
import {
  observationFile,
  type observationSetPut,
  type ObservationRow,
} from "@transitopia/shared/admin-api.ts";
import { useWrite } from "./api.ts";
import { JsonEditor } from "./JsonEditor.tsx";
import { button, card, errorText } from "./styles.ts";

/**
 * An observation set (config/feeds/translink/observations/README.md). It applies as soon as it's
 * saved, and an edit or a delete at the dispatcher's next check.
 */
export function ObservationCard({ row }: { row: ObservationRow }) {
  const write = useWrite();
  const [editing, setEditing] = React.useState(false);
  const path = `admin/api/observations/${encodeURIComponent(row.id)}`;
  return (
    <article className={`${card} flex flex-col gap-2`}>
      <h3 className="font-medium">{row.title}</h3>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {row.id} · {row.body.observations.length} observations ·{" "}
        {row.dates.join(", ")}
        {row.created_by ? ` · from ${row.created_by}` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          onClick={() => setEditing(!editing)}>
          {editing ? "Close editor" : "Edit JSON"}
        </button>
        <button
          type="button"
          className={button}
          disabled={write.isPending}
          onClick={() => {
            if (confirm(`Delete ${row.id}? Its observations stop applying.`))
              write.mutate({ path, method: "DELETE" });
          }}>
          Delete
        </button>
      </div>
      {write.error ?
        <p className={errorText}>{write.error.message}</p>
      : null}
      {editing ?
        <JsonEditor
          value={row.body}
          schema={observationFile}
          busy={write.isPending}
          onSave={(file) =>
            write.mutate(
              {
                path,
                method: "PUT",
                body: { title: row.title, file } satisfies z.input<
                  typeof observationSetPut
                >,
              },
              { onSuccess: () => setEditing(false) },
            )
          }
        />
      : null}
    </article>
  );
}
