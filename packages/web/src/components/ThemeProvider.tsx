"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  getStoredTheme,
  isTheme,
  resolveTheme,
  type Theme,
} from "@/lib/theme";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => resolveTheme());
  const [hasStoredPreference, setHasStoredPreference] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return isTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  });

  useEffect(() => {
    applyTheme(theme);

    if (hasStoredPreference) {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
      return;
    }

    window.localStorage.removeItem(THEME_STORAGE_KEY);
  }, [hasStoredPreference, theme]);

  useEffect(() => {
    if (hasStoredPreference) {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (!getStoredTheme()) {
        setThemeState(mediaQuery.matches ? "dark" : "light");
      }
    };

    handleChange();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [hasStoredPreference]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: (nextTheme) => {
        setHasStoredPreference(true);
        setThemeState(nextTheme);
      },
      toggleTheme: () => {
        setHasStoredPreference(true);
        setThemeState((currentTheme) =>
          currentTheme === "dark" ? "light" : "dark"
        );
      },
    }),
    [theme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return context;
}
