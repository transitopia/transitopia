import React from "react";

/** An icon's drawing on a 16-unit grid: filled, or stroked (line icons). */
type IconDef =
  | { kind: "fill"; body: React.ReactElement }
  | {
      kind: "line";
      body: React.ReactElement;
      /** Stroke width in grid units (default 4/3). */
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
  // Our own icons:
  "chevron-down": line(<path d="M4 6l4 4 4-4" />, 1.667),
  "chevron-up": line(<path d="M4 10l4-4 4 4" />, 1.667),
  "chevron-left": line(<path d="M10 4l-4 4 4 4" />, 1.667),
  /** Slower / faster (the speed stepper). */
  "chevrons-left": line(
    <path d="M7.333 4.667l-3.333 3.333 3.333 3.333M12 4.667l-3.333 3.333 3.333 3.333" />,
    1.5,
  ),
  "chevrons-right": line(
    <path d="M4 4.667l3.333 3.333-3.333 3.333M8.667 4.667l3.333 3.333-3.333 3.333" />,
    1.5,
  ),
  close: line(<path d="M4 4l8 8M12 4L4 12" />, 1.5),
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
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.667v3.333l2 1.333" />
    </>,
    1.5,
  ),
  calendar: line(
    <>
      <rect x="2" y="3.333" width="12" height="10.667" rx="1.333" />
      <path d="M2 6.667h12M5.333 2v2.667M10.667 2v2.667" />
    </>,
  ),
  warning: line(
    <>
      <path d="M8 2L1.333 14h13.333z" />
      <path d="M8 6.667v3.333M8 12v0.333" />
    </>,
    1.667,
  ),
  /** Follow on map. */
  navigation: line(<path d="M8 1.667l4.667 12-4.667-2.667-4.667 2.667z" />),
  "navigation-fill": fill(<path d="M8 1.7l4.7 12-4.7-2.7-4.7 2.7z" />),
  /** Centre on map. */
  crosshair: line(
    <>
      <circle cx="8" cy="8" r="4.667" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <path d="M8 1.333v2M8 12.667v2M1.333 8h2M12.667 8h2" />
    </>,
  ),
  share: line(
    <path d="M8 2v8M4.667 5.333l3.333-3.333 3.333 3.333M3.333 8.667v4a1.333 1.333 0 0 0 1.333 1.333h6.667a1.333 1.333 0 0 0 1.333-1.333v-4" />,
  ),
  filter: line(<path d="M2 3.333h12l-4.667 5.333v4l-2.667-1.333v-2.667z" />),
  /** A combined route: a stretch of line. */
  segment: line(<path d="M2.667 8h10.667" />, 2.5),
  /** Card tiles. */
  // A station on its line: an open ring over a thick route line, which stops inside the ring's stroke.
  station: line(
    <>
      <circle cx="8" cy="8" r="4" />
      <path
        d="M0.667 6.333H4v3.333H0.667zM12 6.333h3.333v3.333H12z"
        fill="currentColor"
        stroke="none"
      />
    </>,
    2,
  ),
  train: line(
    <>
      <rect x="3.333" y="2" width="9.333" height="9.333" rx="2" />
      <path d="M3.333 6.667h9.333M6 14l-1-2.667M10 14l1-2.667" />
      <circle cx="6" cy="9" r="0.4" fill="currentColor" />
      <circle cx="10" cy="9" r="0.4" fill="currentColor" />
    </>,
  ),
  "bus-stop": line(
    <>
      <path d="M8 14.667V8" />
      <rect x="3.333" y="1.667" width="9.333" height="6.333" rx="1.333" />
      <path d="M6 5h4" />
    </>,
  ),
  ferry: line(
    <>
      <path d="M2 10l1.333 3.333h9.333l1.333-3.333z" />
      <path d="M4 10V6h8v4M6 6V3.333h4v2.667" />
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
      viewBox="0 0 16 16"
      className={`${props.size ? "" : "w-[1em] h-[1em] align-[-.125em]"} inline-block flex-none ${props.className ?? ""}`}
      {...(def.kind === "fill" ?
        { fill: "currentColor" }
      : {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: def.weight ?? 4 / 3,
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
