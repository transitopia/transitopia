// Per-browser conveniences (theme, hidden routes, legend state). Storage can be unavailable
// (private mode, blocked site data), so every access is guarded and defaults always work.

const PREFIX = "transitopia:transit:";

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Ignore: preferences are optional.
  }
}
