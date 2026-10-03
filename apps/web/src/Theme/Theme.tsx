import React from "react";
import { resolveTheme, type Theme } from "@transitopia/map-style/basemap.ts";

export type ThemePref = "auto" | Theme;

const STORAGE_KEY = "transitopia:theme";

function loadPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto"; // Storage unavailable (private mode, blocked site data).
  }
}

function savePref(pref: ThemePref): void {
  try {
    if (pref === "auto") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Preferences are optional.
  }
}

const ThemeContext = React.createContext<{
  pref: ThemePref;
  theme: Theme;
  setPref: (pref: ThemePref) => void;
}>({ pref: "auto", theme: "light", setPref: () => {} });

export const useTheme = () => React.useContext(ThemeContext);

/** Light/dark theme for the whole site (chrome and map), following the system unless chosen. */
export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [pref, setPrefState] = React.useState<ThemePref>(loadPref);
  const [theme, setTheme] = React.useState<Theme>(() => resolveTheme(pref));

  React.useEffect(() => {
    setTheme(resolveTheme(pref));
    if (pref !== "auto") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(resolveTheme("auto"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [pref]);

  React.useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    // The browser paints the status bar in theme-color: match the header (src/index.css).
    const color = getComputedStyle(root)
      .getPropertyValue("--header-background")
      .trim();
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", color);
  }, [theme]);

  const setPref = React.useCallback((next: ThemePref) => {
    savePref(next);
    setPrefState(next);
  }, []);

  const value = React.useMemo(
    () => ({ pref, theme, setPref }),
    [pref, theme, setPref],
  );
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};

const NEXT: Record<ThemePref, ThemePref> = {
  auto: "light",
  light: "dark",
  dark: "auto",
};
const LABEL: Record<ThemePref, string> = {
  auto: "Theme: automatic",
  light: "Theme: light",
  dark: "Theme: dark",
};
const GLYPH: Record<ThemePref, string> = { auto: "◐", light: "☀", dark: "☾" };

/** Cycles automatic → light → dark. */
export const ThemeToggle: React.FC<{ className?: string }> = ({
  className,
}) => {
  const { pref, setPref } = useTheme();
  return (
    <button
      type="button"
      className={className}
      title={LABEL[pref]}
      aria-label={LABEL[pref]}
      onClick={() => setPref(NEXT[pref])}>
      {GLYPH[pref]}
    </button>
  );
};
