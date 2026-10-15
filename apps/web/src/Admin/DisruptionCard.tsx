import React from "react";
import { railRegion } from "../TransitMap/regions.ts";
import type { Disruption } from "@transitopia/transit-core/disruption/types.ts";
import {
  disruption,
  type DisruptionRow,
} from "@transitopia/shared/admin-api.ts";
import { JsonEditor } from "./JsonEditor.tsx";
import {
  EditToggle,
  ReviewActions,
  ReviewResult,
  StateBadge,
  useReview,
} from "./Review.tsx";
import { button, card } from "./styles.ts";

/** A disruption (config/regions/metro-vancouver/disruptions/README.md) to review, or reviewed. */
export function DisruptionCard({ row }: { row: DisruptionRow }) {
  const d = row.body;
  const review = useReview("disruptions", row.id);
  const [editing, setEditing] = React.useState(false);
  return (
    <article className={`${card} flex flex-col gap-2`}>
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge row={row} />
        <h3 className="font-medium">{d.text}</h3>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {row.id} · {d.source}
        {row.alert_id ? ` · alert ${row.alert_id}` : ""} · {periods(d)}
      </p>
      {d.note ?
        <p className="whitespace-pre-wrap text-sm">{d.note.trim()}</p>
      : null}
      {(d.singleTrack ?? []).map((s, i) => (
        <KeepInput
          key={i}
          label={`Single track, ${s.line} ${s.between.join("–")}: open track through`}
          value={s.keep}
          busy={review.busy}
          onSave={(keep) =>
            review.save({
              ...d,
              singleTrack: d.singleTrack!.map((x, j) =>
                j === i ? { ...x, keep } : x,
              ),
            })
          }
        />
      ))}
      {(d.headway ?? []).map((h, i) => (
        <p key={i} className="text-sm">
          Every {h.minS / 60} min: {h.line}
          {h.between ? ` ${h.between.join("–")}` : ""}
        </p>
      ))}
      <ReviewActions state={row.state} review={review} />
      <ReviewResult review={review} from={d.active[0]?.from} />
      <EditToggle editing={editing} setEditing={setEditing} />
      {editing ?
        <JsonEditor
          value={d}
          schema={disruption}
          busy={review.busy}
          onSave={(v) => review.save(v, () => setEditing(false))}
        />
      : null}
    </article>
  );
}

function periods(d: Disruption): string {
  const f = (iso: string) =>
    new Date(iso).toLocaleString("en-CA", {
      timeZone: railRegion().info.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    });
  return d.active.map((p) => `${f(p.from)} → ${f(p.until)}`).join("; ");
}

/** Which track stays open through a single-track section: what confirming needs. */
function KeepInput(props: {
  label: string;
  value: string;
  busy: boolean;
  onSave: (v: string) => void;
}) {
  const [v, setV] = React.useState(props.value);
  React.useEffect(() => setV(props.value), [props.value]);
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      {props.label}
      <input
        className="min-w-64 flex-1 rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
        placeholder='a platform stop, e.g. "Lansdowne Station @ Platform 1"'
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <button
        type="button"
        className={button}
        disabled={props.busy || v === props.value}
        onClick={() => props.onSave(v)}>
        Save
      </button>
    </label>
  );
}
