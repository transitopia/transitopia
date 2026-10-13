import React from "react";

import { siteUrl } from "../config.ts";

/**
 * A route's search metadata (apps/web/README.md#search-metadata): its description, replacing the
 * site-wide one in index.html, and a canonical link without the query string, so the mode state in
 * it (?date=…, ?preview=…) doesn't make each variant a separate page for search engines.
 */
export function PageMeta({
  path,
  description,
}: {
  path: string;
  description: string;
}) {
  React.useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    const siteDescription = meta?.content;
    if (meta) meta.content = description;
    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = `${siteUrl}${path}`;
    document.head.append(canonical);
    return () => {
      if (meta && siteDescription !== undefined) meta.content = siteDescription;
      canonical.remove();
    };
  }, [path, description]);
  return null;
}
