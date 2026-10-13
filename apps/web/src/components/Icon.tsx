import React from "react";

/**
 * An icon's drawing. Bootstrap icons (https://icons.getbootstrap.com/) are filled on a 16-unit grid;
 * line icons, drawn for the site's UI concepts canvas, are stroked on a 24-unit grid.
 */
type IconDef =
  | { kind: "fill"; body: React.ReactElement }
  | {
      kind: "line";
      body: React.ReactElement;
      /** Stroke width in grid units (default 2). */
      weight?: number;
    };

const fill = (body: React.ReactElement): IconDef => ({ kind: "fill", body });
const line = (body: React.ReactElement, weight?: number): IconDef =>
  weight === undefined ?
    { kind: "line", body }
  : { kind: "line", body, weight };

/** Available SVG icons. To keep the build size small, this only contains icons we use. */
const icons = {
  blank: fill(<></>),
  // Icons from https://icons.getbootstrap.com/ :
  bicycle: fill(
    <path d="M4 4.5a.5.5 0 0 1 .5-.5H6a.5.5 0 0 1 0 1v.5h4.14l.386-1.158A.5.5 0 0 1 11 4h1a.5.5 0 0 1 0 1h-.64l-.311.935.807 1.29a3 3 0 1 1-.848.53l-.508-.812-2.076 3.322A.5.5 0 0 1 8 10.5H5.959a3 3 0 1 1-1.815-3.274L5 5.856V5h-.5a.5.5 0 0 1-.5-.5m1.5 2.443-.508.814c.5.444.85 1.054.967 1.743h1.139zM8 9.057 9.598 6.5H6.402zM4.937 9.5a1.997 1.997 0 0 0-.487-.877l-.548.877zM3.603 8.092A2 2 0 1 0 4.937 10.5H3a.5.5 0 0 1-.424-.765l1.027-1.643zm7.947.53a2 2 0 1 0 .848-.53l1.026 1.643a.5.5 0 1 1-.848.53L11.55 8.623z" />,
  ),
  "bus-front-fill": fill(
    <path d="M16 7a1 1 0 0 1-1 1v3.5c0 .818-.393 1.544-1 2v2a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5V14H5v1.5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-2a2.496 2.496 0 0 1-1-2V8a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1V2.64C1 1.452 1.845.408 3.064.268A43.608 43.608 0 0 1 8 0c2.1 0 3.792.136 4.936.268C14.155.408 15 1.452 15 2.64V4a1 1 0 0 1 1 1zM3.552 3.22A43.306 43.306 0 0 1 8 3c1.837 0 3.353.107 4.448.22a.5.5 0 0 0 .104-.994A44.304 44.304 0 0 0 8 2c-1.876 0-3.426.109-4.552.226a.5.5 0 1 0 .104.994ZM8 4c-1.876 0-3.426.109-4.552.226A.5.5 0 0 0 3 4.723v3.554a.5.5 0 0 0 .448.497C4.574 8.891 6.124 9 8 9c1.876 0 3.426-.109 4.552-.226A.5.5 0 0 0 13 8.277V4.723a.5.5 0 0 0-.448-.497A44.304 44.304 0 0 0 8 4m-3 7a1 1 0 1 0-2 0 1 1 0 0 0 2 0m8 0a1 1 0 1 0-2 0 1 1 0 0 0 2 0m-7 0a1 1 0 0 0 1 1h2a1 1 0 1 0 0-2H7a1 1 0 0 0-1 1" />,
  ),
  // Line icons from the UI concepts canvas:
  "chevron-down": line(<path d="M6 9l6 6 6-6" />, 2.5),
  "chevron-up": line(<path d="M6 15l6-6 6 6" />, 2.5),
  /** Slower / faster (the speed stepper). */
  "chevrons-left": line(<path d="M11 7l-5 5 5 5M18 7l-5 5 5 5" />, 2.25),
  "chevrons-right": line(<path d="M6 7l5 5-5 5M13 7l5 5-5 5" />, 2.25),
  close: line(<path d="M6 6l12 12M18 6L6 18" />, 2.25),
  "three-dots": fill(
    <>
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </>,
  ),
  play: fill(<path d="M4 2.2 L13.5 8 L4 13.8 Z" />),
  pause: fill(
    <>
      <rect x="3.5" y="2" width="3.4" height="12" rx="0.8" />
      <rect x="9.1" y="2" width="3.4" height="12" rx="0.8" />
    </>,
  ),
  clock: line(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>,
    2.25,
  ),
  calendar: line(
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>,
  ),
  warning: line(
    <>
      <path d="M12 3L2 21h20z" />
      <path d="M12 10v5M12 18v.5" />
    </>,
    2.5,
  ),
  /** Follow on map. */
  navigation: line(<path d="M12 2.5l7 18-7-4-7 4z" />),
  "navigation-fill": fill(<path d="M8 1.7l4.7 12-4.7-2.7-4.7 2.7z" />),
  /** Centre on map. */
  crosshair: line(
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>,
  ),
  share: line(
    <path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />,
  ),
  filter: line(<path d="M3 5h18l-7 8v6l-4-2v-4z" />),
  /** Card tiles. */
  station: line(<circle cx="12" cy="12" r="7" />, 3),
  train: line(
    <>
      <rect x="5" y="3" width="14" height="14" rx="3" />
      <path d="M5 10h14M9 21l-1.5-4M15 21l1.5-4" />
      <circle cx="9" cy="13.5" r="0.6" fill="currentColor" />
      <circle cx="15" cy="13.5" r="0.6" fill="currentColor" />
    </>,
  ),
  "bus-stop": line(
    <>
      <path d="M12 22V12" />
      <rect x="5" y="2.5" width="14" height="9.5" rx="2" />
      <path d="M9 7.5h6" />
    </>,
  ),
  ferry: line(
    <>
      <path d="M3 15l2 5h14l2-5z" />
      <path d="M6 15V9h12v6M9 9V5h6v4" />
    </>,
  ),
} satisfies { [iconId: string]: IconDef };

export type IconId = keyof typeof icons;

interface Props {
  icon?: IconId;
  /** For an icon that means something on its own; without it the icon is hidden from screen readers. */
  altText?: string;
  /** Size in px; by default the icon matches the font size (1em). */
  size?: number;
  className?: string;
}

/**
 * An icon in the current text colour. By default it matches the font size and sits on the text's
 * baseline, like a character.
 */
export const Icon: React.FunctionComponent<Props> = (props: Props) => {
  const def: IconDef = icons[props.icon ?? "blank"];
  const sizing =
    props.size ?
      { width: props.size, height: props.size }
    : { width: 16, height: 16 };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      {...sizing}
      viewBox={def.kind === "fill" ? "0 0 16 16" : "0 0 24 24"}
      className={`${props.size ? "" : "w-[1em] h-[1em] align-[-.125em]"} inline-block flex-none ${props.className ?? ""}`}
      {...(def.kind === "fill" ?
        { fill: "currentColor" }
      : {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: def.weight ?? 2,
          strokeLinecap: "round" as const,
          strokeLinejoin: "round" as const,
        })}
      {...(props.altText ?
        { role: "img", "aria-label": props.altText }
      : { "aria-hidden": true })}>
      {def.body}
    </svg>
  );
};
