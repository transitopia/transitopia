// Facts about how the page was opened, captured before the map writes its position to the URL.

/**
 * Opened from the home screen (or as an installed app): always start live (apps/web/README.md#home-screen).
 * iOS saves the URL the page was on when it was added, ignoring the manifest's start_url, so drop the
 * query (date, time, selection, preview…), keeping the path and map position (the hash).
 */
const standalone =
  (navigator as { standalone?: boolean }).standalone === true
  || matchMedia("(display-mode: standalone)").matches;
if (standalone && location.search)
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.hash}`,
  );

/** The path the site was opened at (before any redirect). */
export const openedPath = location.pathname;

/** Did the URL carry a map position (#map=…)? */
export const openedWithPosition = location.hash.includes("map=");
