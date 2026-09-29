// Facts about how the page was opened, captured before the map writes its position to the URL.

/** Did the URL carry a map position (#map=…, or the pre-V2 ?z=&lat=&lng=)? */
export const openedWithPosition =
  location.hash.includes("map=")
  || new URLSearchParams(location.search).has("lat");
