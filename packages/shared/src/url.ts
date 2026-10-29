// Query strings for shareable links (apps/web/README.md#modes-and-url-state).

/**
 * A query string that keeps ":" and "/" as they are: both are allowed in a query (RFC 3986), and
 * feature keys and times are full of colons (`select=run:25:3:2200325`, `t=08:15:00`), which
 * `URLSearchParams.toString()` would write as `%3A`. Everything else is escaped as usual, and
 * `URLSearchParams` reads the result back unchanged.
 */
export function formatQuery(q: URLSearchParams): string {
  const enc = (s: string) =>
    encodeURIComponent(s).replace(/%3A/gi, ":").replace(/%2F/gi, "/");
  return [...q].map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
}
