export const THEME_STORAGE_KEY = "agentreview:theme";

export type Theme = "dark" | "light";

export function isTheme(value: string | null | undefined): value is Theme {
  return value === "dark" || value === "light";
}

export function getSystemTheme(): Theme {
  if (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }

  return "light";
}

export function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") {
    return null;
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isTheme(stored) ? stored : null;
}

export function getDomTheme(): Theme | null {
  if (typeof document === "undefined") {
    return null;
  }

  const domTheme = document.documentElement.dataset.theme;
  return isTheme(domTheme) ? domTheme : null;
}

export function resolveTheme(): Theme {
  return getDomTheme() ?? getStoredTheme() ?? getSystemTheme();
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export const THEME_INIT_SCRIPT = `(() => {
  const storageKey = "${THEME_STORAGE_KEY}";
  const stored = window.localStorage.getItem(storageKey);
  const theme =
    stored === "dark" || stored === "light"
      ? stored
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";

  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();`;
