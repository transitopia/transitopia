/**
 * Helper function to remove keys with undefined values from an object
 * `{foo: undefined, bar: 15}` becomes `{bar: 15}`
 */
export function removeUndefinedKeys<Shape extends Record<string, unknown>>(
  obj: Shape,
): {
  [K in keyof Shape as undefined extends Shape[K] ?
    Shape[K] extends undefined ?
      never
    : K
  : K]: Exclude<Shape[K], undefined>;
} {
  return Object.fromEntries(
    Object.entries(obj).filter(([_k, v]) => v !== undefined),
  ) as any;
}
