import type React from "react";
import { useLocation, useRoute } from "wouter";

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
