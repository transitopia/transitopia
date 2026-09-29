// Zoom-dependent style helpers shared by the overlays.

import type {
  ColorSpecification,
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
} from "@maplibre/maplibre-gl-style-spec";

/** A linear interpolation of values based on the zoom level */
export function interpolateZoom<T>(stops: {
  [zoom: `z${number}`]: T | T[] | ColorSpecification | ExpressionSpecification;
}): DataDrivenPropertyValueSpecification<T> {
  const spec: unknown[] = [];
  Object.entries(stops).forEach(([zoomValue, expr]) => {
    spec.push(Number(zoomValue.substring(1))); // Remove the 'z' prefix from the zoom value
    spec.push(expr);
  });
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    ...spec,
  ] as DataDrivenPropertyValueSpecification<T>;
}

/**
 * An exponential interpolation of the value, based on zoom values
 * Higher values of the exponential 'base' make the output increase
 * more towards the high end of the range.
 * A base of '1' is equivalent to a linear interpolation.
 */
export function interpolateZoomExp<T>({
  base,
  ...stops
}: {
  base: number;
  [zoom: `z${number}`]: T | T[] | ColorSpecification | ExpressionSpecification;
}): DataDrivenPropertyValueSpecification<T> {
  const spec: unknown[] = [];
  Object.entries(stops).forEach(([zoomValue, expr]) => {
    spec.push(Number(zoomValue.substring(1))); // Remove the 'z' prefix from the zoom value
    spec.push(expr);
  });
  return [
    "interpolate",
    ["exponential", base],
    ["zoom"],
    ...spec,
  ] as DataDrivenPropertyValueSpecification<T>;
}

export const defaultLineLayout = {
  "line-cap": "round",
  "line-join": "round",
  visibility: "visible",
} as const;
