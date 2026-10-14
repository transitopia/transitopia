import React from "react";
import type * as z from "zod";
import {
  observationFile,
  type observationSetPut,
  type ObservationRow,
} from "@transitopia/shared/admin-api.ts";
import { JsonEditor } from "./JsonEditor.tsx";
import {
  EditToggle,
  ReviewActions,
  ReviewResult,
  StateBadge,
  useReview,
} from "./Review.tsx";
import { card } from "./styles.ts";

/** An observation set (regions/metro-vancouver/observations/README.md) to review, or reviewed. */
export function ObservationCard({ row }: { row: ObservationRow }) {
  const review = useReview("observations", row.id);
  const [editing, setEditing] = React.useState(false);
  return (
    <article className={`${card} flex flex-col gap-2`}>
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge row={row} />
        <h3 className="font-medium">{row.title}</h3>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {row.id} · {row.body.observations.length} observations ·{" "}
        {row.dates.join(", ")}
        {row.created_by ? ` · from ${row.created_by}` : ""}
      </p>
      <ReviewActions state={row.state} review={review} />
      <ReviewResult review={review} />
      <EditToggle editing={editing} setEditing={setEditing} />
      {editing ?
        <JsonEditor
          value={row.body}
          schema={observationFile}
          busy={review.busy}
          onSave={(file) =>
            review.save(
              { title: row.title, file } satisfies z.input<
                typeof observationSetPut
              >,
              () => setEditing(false),
            )
          }
        />
      : null}
    </article>
  );
}
