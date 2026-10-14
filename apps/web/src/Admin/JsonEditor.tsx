import React from "react";
import type * as z from "zod";
import { errorText, primary } from "./styles.ts";

/** A JSON textarea whose Save hands over the parsed value, once it's JSON that `schema` accepts. */
export function JsonEditor<T>(props: {
  value: T;
  schema: z.ZodType<T>;
  onSave: (v: T) => void;
  busy?: boolean;
}) {
  const [text, setText] = React.useState(() =>
    JSON.stringify(props.value, null, 2),
  );
  const [error, setError] = React.useState<string>();
  const save = () => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const r = props.schema.safeParse(json);
    if (!r.success) {
      setError(r.error.issues.map((i) => i.message).join("; "));
      return;
    }
    setError(undefined);
    props.onSave(r.data);
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        className="h-80 w-full rounded border border-gray-300 bg-transparent p-2 font-mono text-xs dark:border-gray-600"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error ?
        <p className={errorText}>{error}</p>
      : null}
      <button
        type="button"
        className={`${primary} self-start`}
        disabled={props.busy}
        onClick={save}>
        Save
      </button>
    </div>
  );
}
