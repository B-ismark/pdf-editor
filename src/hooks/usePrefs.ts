import { useCallback, useEffect, useState } from "react";

/** Read a JSON-serialised preference, shallow-merged over a fallback so a
 * partial/older stored shape can't drop required fields. */
export function loadPref<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...fallback, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return fallback;
}

function loadRaw(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * State that persists to localStorage. Objects are shallow-merged over the
 * fallback on load; primitives (pass a string) are stored verbatim. Lets the
 * app remember the user's last font/size/colour, draw tool, etc. instead of
 * snapping back to defaults each session.
 */
export function usePersistentState<T extends object>(
  key: string,
  fallback: T,
): [T, React.Dispatch<React.SetStateAction<T>>];
export function usePersistentState(
  key: string,
  fallback: string,
): [string, React.Dispatch<React.SetStateAction<string>>];
export function usePersistentState(key: string, fallback: unknown): unknown {
  const isObj = typeof fallback === "object" && fallback !== null;
  const [value, setValue] = useState(() =>
    isObj
      ? loadPref(key, fallback as object)
      : loadRaw(key, fallback as string),
  );
  useEffect(() => {
    try {
      localStorage.setItem(key, isObj ? JSON.stringify(value) : String(value));
    } catch {
      /* ignore */
    }
  }, [key, value, isObj]);
  return [value, setValue];
}

/** A boolean preference persisted as "1"/"0". */
export function usePersistentFlag(
  key: string,
  fallback: boolean,
): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : raw === "1";
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue];
}

/**
 * A yes/no the person may or may not have answered: `null` until they do, so
 * the default can follow something else (Dim pages follows the theme) and
 * nothing is written until it's a real choice. `legacy` is an older key whose
 * "1" still counts as a choice; its "0" doesn't — the old flag stored its
 * default on first run, so a "0" there says nothing about the person.
 */
export function usePersistentChoice(
  key: string,
  legacy?: string,
): [boolean | null, (v: boolean) => void] {
  const [value, setValue] = useState<boolean | null>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === "on") return true;
      if (raw === "off") return false;
      if (legacy && localStorage.getItem(legacy) === "1") return true;
    } catch {
      /* localStorage blocked */
    }
    return null;
  });
  const set = useCallback(
    (v: boolean) => {
      setValue(v);
      try {
        localStorage.setItem(key, v ? "on" : "off");
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [value, set];
}
