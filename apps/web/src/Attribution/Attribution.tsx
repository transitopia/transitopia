import React from "react";
import { creditsFor, legendsFor } from "@transitopia/shared/datasets.ts";

// Credits for exactly the data on screen (docs/DESIGN.md#attribution): each mode (and the transit engine)
// declares what it draws with useDatasets(); the basemap is always there.

const BASEMAP_DATASETS = ["osm", "protomaps"];

type Registry = {
  add: (ids: readonly string[]) => () => void;
  ids: readonly string[];
};

const AttributionContext = React.createContext<Registry>({
  add: () => () => {},
  ids: BASEMAP_DATASETS,
});

export const AttributionProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [counts, setCounts] = React.useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const add = React.useCallback((ids: readonly string[]) => {
    const bump = (d: 1 | -1) =>
      setCounts((prev) => {
        const next = new Map(prev);
        for (const id of ids) {
          const n = (next.get(id) ?? 0) + d;
          if (n > 0) next.set(id, n);
          else next.delete(id);
        }
        return next;
      });
    bump(1);
    return () => bump(-1);
  }, []);
  const value = React.useMemo(
    () => ({ add, ids: [...BASEMAP_DATASETS, ...counts.keys()] }),
    [add, counts],
  );
  return (
    <AttributionContext.Provider value={value}>
      {children}
    </AttributionContext.Provider>
  );
};

/** Credit these datasets while the calling component is mounted (and the list is unchanged). */
export function useDatasets(ids: readonly string[]): void {
  const { add } = React.useContext(AttributionContext);
  const key = ids.join(",");
  React.useEffect(() => (key ? add(key.split(",")) : undefined), [add, key]);
}

export const AttributionControl: React.FC = () => {
  const { ids } = React.useContext(AttributionContext);
  const [open, setOpen] = React.useState(false);
  const datasets = creditsFor(ids);
  const legends = legendsFor(datasets);
  return (
    <div className="absolute bottom-0 right-0 z-40 max-w-full flex flex-col items-end pointer-events-none text-xs">
      {open ?
        <div
          id="attribution-details"
          className="pointer-events-auto m-2 mb-0 max-w-md max-h-[60dvh] overflow-y-auto rounded-md border border-gray-300 bg-white p-3 shadow-md dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
          <h2 className="mb-1 font-semibold">Data on this map</h2>
          <ul className="space-y-1">
            {datasets.map((d) => (
              <li key={d.id}>
                <a
                  href={d.url}
                  className="underline"
                  target="_blank"
                  rel="noreferrer">
                  {d.credit}
                </a>
                <span className="text-gray-500 dark:text-gray-400">
                  {" · "}
                  {d.license.url ?
                    <a
                      href={d.license.url}
                      className="underline"
                      target="_blank"
                      rel="noreferrer">
                      {d.license.name}
                    </a>
                  : d.license.name}
                </span>
              </li>
            ))}
          </ul>
          {legends.map((text) => (
            <p key={text} className="mt-2">
              {text}
            </p>
          ))}
          <p className="mt-2">
            <a
              href="https://github.com/transitopia/transitopia/blob/main/DATA-LICENSES.md"
              className="underline"
              target="_blank"
              rel="noreferrer">
              About the data
            </a>
            {" · "}
            <a
              href="https://maplibre.org/"
              className="underline"
              target="_blank"
              rel="noreferrer">
              MapLibre
            </a>
          </p>
        </div>
      : null}
      <div className="pointer-events-auto flex max-w-full items-center gap-1 rounded-tl-md bg-white/80 pl-[max(0.5rem,var(--screen-corner-inset))] pr-(--screen-corner-inset) dark:bg-gray-900/80 dark:text-gray-200">
        <span className="truncate">
          {datasets.map((d) => d.credit).join(" · ")}
        </span>
        <button
          type="button"
          className="h-7 w-7 shrink-0 rounded-full text-base leading-none hover:bg-gray-200 dark:hover:bg-gray-700"
          aria-expanded={open}
          aria-controls="attribution-details"
          aria-label={open ? "Hide data credits" : "Show data credits"}
          onClick={() => setOpen(!open)}>
          ⓘ
        </button>
      </div>
    </div>
  );
};
