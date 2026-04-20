"use client";

import { useTheme } from "./ThemeProvider";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="theme-toggle"
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        {theme === "dark" ? "☾" : "☀"}
      </span>
      <span className="theme-toggle-copy">
        <span className="theme-toggle-label">Theme</span>
        <span className="theme-toggle-value">
          {theme === "dark" ? "Dark" : "Light"}
        </span>
      </span>
    </button>
  );
}
