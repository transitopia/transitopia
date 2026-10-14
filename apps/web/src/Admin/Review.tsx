// The parts of a correction's card that disruptions and observation sets share: its review state,
// the buttons that move it along, and links to previews.

import React from "react";
import region from "@transitopia/region-metro-vancouver/region.json";
import type { Previews, ReviewState } from "@transitopia/shared/admin-api.ts";
import { useWrite } from "./api.ts";
import { button, errorText, primary } from "./styles.ts";

interface Reviewed {
  id: string;
  state: ReviewState;
  reviewed_by: string | null;
  reviewed_at: Date | null;
}

export const isOpen = (s: ReviewState) => s === "draft" || s === "previewing";

const STATE_COLOUR: Record<ReviewState, string> = {
  draft: "bg-gray-200 dark:bg-gray-700",
  previewing: "bg-purple-700 text-white",
  confirmed: "bg-green-700 text-white",
  discarded: "bg-gray-400 text-white dark:bg-gray-600",
};

export function StateBadge({ row }: { row: Reviewed }) {
  return (
    <span
      className={`rounded px-1.5 text-xs ${STATE_COLOUR[row.state]}`}
      title={
        row.reviewed_by ?
          `${row.state} by ${row.reviewed_by}${row.reviewed_at ? ` on ${row.reviewed_at.toLocaleString()}` : ""}`
        : undefined
      }>
      {row.state}
    </span>
  );
}

/**
 * A card's writes and what came of them: `act` previews, confirms, discards or reopens it, `save`
 * stores an edit (dropping previews of the old version).
 */
export function useReview(kind: "disruptions" | "observations", id: string) {
  const write = useWrite();
  const [previews, setPreviews] = React.useState<Previews>();
  const act = (action: "preview" | "confirm" | "discard" | "reopen") =>
    write.mutate(
      { path: `admin/api/${kind}/${id}/${action}` },
      { onSuccess: (r) => "versions" in r && setPreviews(r.versions) },
    );
  const save = (body: unknown, onSaved?: () => void) =>
    write.mutate(
      {
        path: `admin/api/${kind}/${encodeURIComponent(id)}`,
        method: "PUT",
        body,
      },
      {
        onSuccess: () => {
          setPreviews(undefined);
          onSaved?.();
        },
      },
    );
  return {
    act,
    save,
    previews,
    busy: write.isPending,
    error: write.error?.message,
  };
}

export function ReviewActions({
  state,
  review,
}: {
  state: ReviewState;
  review: ReturnType<typeof useReview>;
}) {
  const { act, busy } = review;
  return (
    <div className="flex flex-wrap gap-2">
      {state !== "discarded" ?
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => act("preview")}>
          {busy ? "Dispatching…" : "Preview"}
        </button>
      : null}
      {isOpen(state) ?
        <>
          <button
            type="button"
            className={primary}
            disabled={busy}
            onClick={() => act("confirm")}>
            Confirm
          </button>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => act("discard")}>
            Discard
          </button>
        </>
      : <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => act("reopen")}>
          Reopen
        </button>
      }
    </div>
  );
}

/** Previews (from the card's last Preview) and the error of its last write, if any. */
export function ReviewResult({
  review,
  from,
}: {
  review: ReturnType<typeof useReview>;
  from?: string | undefined;
}) {
  return (
    <>
      {review.previews ?
        <PreviewLinks previews={review.previews} from={from} />
      : null}
      {review.error ?
        <p className={errorText}>{review.error}</p>
      : null}
    </>
  );
}

/** Links to the map for each previewed date, starting at the first period (or 08:00). */
function PreviewLinks({
  previews,
  from,
}: {
  previews: Previews;
  from?: string | undefined;
}) {
  const entries = Object.entries(previews);
  if (!entries.length)
    return (
      <p className="text-sm">
        Nothing to preview: no date within a week of today, or no dispatched
        plan for it.
      </p>
    );
  const startTime =
    from ?
      new Date(from).toLocaleTimeString("en-CA", {
        hour12: false,
        timeZone: region.timezone,
      })
    : "08:00:00";
  return (
    <ul className="text-sm">
      {entries.map(([date, p]) => {
        const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
        return (
          <li key={date}>
            <a
              className="text-blue-700 underline dark:text-blue-400"
              href={`/transit?date=${iso}&t=${startTime}&paused=1&preview=${date}:${p.version}`}
              target="_blank"
              rel="noreferrer">
              Preview {iso}
            </a>{" "}
            <span className="text-gray-600 dark:text-gray-400">
              ({p.summary.inputs.join(", ")})
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** "Edit JSON", opening an editor. */
export function EditToggle(props: {
  editing: boolean;
  setEditing: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="self-start text-xs underline"
      onClick={() => props.setEditing(!props.editing)}>
      {props.editing ? "Close editor" : "Edit JSON"}
    </button>
  );
}
