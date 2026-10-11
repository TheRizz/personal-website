import { Moon, Sun } from "lucide-react";
import { iconButtonClass } from "./IconButton";

export const THEME_COLORS = { dark: "#090a0c", light: "#faf8f5" } as const;

/** Runs before first paint (inlined in <head>) so the page never flashes the wrong theme. */
export const themeScript = `(function () {
  var theme;
  try { theme = localStorage.getItem("theme"); } catch (e) {}
  if (theme !== "light" && theme !== "dark") {
    theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.dataset.theme = theme;
  var meta = document.querySelector("meta[name=theme-color]");
  if (meta) meta.content = theme === "light" ? "${THEME_COLORS.light}" : "${THEME_COLORS.dark}";
})();`;

function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === "light" ? "dark" : "light";
  root.dataset.theme = next;
  document.querySelector("meta[name=theme-color]")?.setAttribute("content", THEME_COLORS[next]);
  try {
    localStorage.setItem("theme", next);
  } catch {
    // Storage can be unavailable (private mode); the toggle still works for this page view.
  }
}

export function ThemeToggle() {
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Toggle light and dark theme"
      title="Toggle theme"
      className={iconButtonClass}
    >
      {/* Both icons render and CSS shows the right one, so server and client markup match. */}
      <Sun className="light:hidden" />
      <Moon className="hidden light:block" />
    </button>
  );
}
