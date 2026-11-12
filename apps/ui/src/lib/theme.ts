import { useEffect, useSyncExternalStore } from "react";

export const themes = ["light", "dark", "system"] as const;
export type Theme = (typeof themes)[number];

const storageKey = "fred.theme";
const query = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

function read(): Theme {
  const stored = localStorage.getItem(storageKey);
  return stored === "light" || stored === "dark" ? stored : "system";
}

// Sets the `dark` class on <html> for the preference. index.html runs the same rule before first paint.
function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && matchMedia(query).matches);
  document.documentElement.classList.toggle("dark", dark);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The theme preference, stored per browser under fred.theme. System mode follows the OS and tracks its changes while mounted.
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, read, () => "system" as const);
  useEffect(() => {
    if (theme !== "system") return;
    const media = matchMedia(query);
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);
  return {
    theme,
    setTheme(next: Theme) {
      if (next === "system") localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, next);
      apply(next);
      for (const listener of listeners) listener();
    },
  };
}
