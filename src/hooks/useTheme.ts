import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";

const KEY = "theme";
const MODES: ThemeMode[] = ["system", "light", "dark"];

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* localStorage blocked */
  }
  return "system";
}

/** Resolve a mode to the concrete "light" | "dark" applied to <html>. */
function resolve(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

/**
 * Manual light/dark/system theme control. Writes the resolved theme to the
 * <html data-theme> attribute (the same one index.html sets before paint) and
 * persists the user's choice. In "system" mode it follows the OS live.
 */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readMode);

  const apply = useCallback((m: ThemeMode) => {
    const resolved = resolve(m);
    document.documentElement.setAttribute("data-theme", resolved);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "dark" ? "#141218" : "#fef7ff");
  }, []);

  // Apply on mount / whenever the mode changes, and persist the choice.
  useEffect(() => {
    apply(mode);
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode, apply]);

  // Follow the OS theme live while in "system" mode.
  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode, apply]);

  const cycle = useCallback(() => {
    setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]);
  }, []);

  return { mode, setMode, cycle };
}
