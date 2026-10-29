import React from "react";
import { useLocation, useRoute } from "wouter";
import {
  modeOfKey,
  parseKey,
  type MapMode,
} from "@transitopia/shared/features.ts";
import { formatQuery } from "@transitopia/shared/url.ts";

/**
 * A mode's URL with a feature selected, at the same map position: where a key of the other mode
 * goes (apps/web/README.md#modes-and-url-state).
 */
export function modeUrl(mode: MapMode, key: string): string {
  return `/${mode}?${formatQuery(new URLSearchParams({ select: key }))}${location.hash}`;
}

/**
 * On opening a mode with another mode's key in ?select= (a station on /cycling, bike parking's ID
 * on /transit), go to that mode instead. OSM refs, which either mode's features may have, are left
 * to the feature resolver.
 */
export function useOtherModeRedirect(mode: MapMode): void {
  const [, navigate] = useLocation();
  React.useEffect(() => {
    const key = new URLSearchParams(location.search).get("select");
    const k = key && parseKey(key);
    const other = k && modeOfKey(k);
    if (key && other && other !== mode)
      navigate(modeUrl(other, key), { replace: true });
  }, [mode, navigate]);
}

/**
 * Link to a mode (/transit, /cycling). The map position (#map=…) is shared by every mode, so it's
 * kept; the query string holds the current mode's own state, so it isn't (apps/web/README.md#modes-and-url-state).
 */
export function ModeLink({
  href,
  className,
  classNameActive,
  children,
}: {
  href: string;
  className?: string;
  classNameActive?: string;
  children: React.ReactNode;
}) {
  const [isActive] = useRoute(href);
  const [, navigate] = useLocation();
  return (
    <a
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={`${className ?? ""} ${isActive ? (classNameActive ?? "") : ""}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(`${href}${location.hash}`);
      }}>
      {children}
    </a>
  );
}
