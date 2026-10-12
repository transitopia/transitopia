/**
 * The horizontal Transitopia logo. The dark theme uses a version with a light wordmark; the badge,
 * including its navy ring, is the same in both, as on the app icon.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <>
      <img
        src="/transitopia-logo-h.svg"
        alt="Transitopia"
        className={`block dark:hidden ${className ?? ""}`}
      />
      <img
        src="/transitopia-logo-h-dark.svg"
        alt="Transitopia"
        className={`hidden dark:block ${className ?? ""}`}
      />
    </>
  );
}
