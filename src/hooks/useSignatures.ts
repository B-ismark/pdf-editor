import { useState } from "react";

export interface SavedSig {
  dataUrl: string;
  w: number;
  h: number;
}

const KEY = "signatures";
const MAX = 8;

function load(): SavedSig[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((s) => s && typeof s.dataUrl === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A small localStorage-backed gallery of signatures the user chose to keep
 * ("Remember this signature on this device" — off by default), so a
 * signature can be reused across sessions instead of re-drawn every time.
 */
export function useSignatures() {
  const [sigs, setSigs] = useState<SavedSig[]>(load);

  const persist = (next: SavedSig[]) => {
    setSigs(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / disabled storage */
    }
  };

  const save = (sig: SavedSig) => {
    // De-dupe identical images; newest first; cap the gallery.
    persist([sig, ...sigs.filter((s) => s.dataUrl !== sig.dataUrl)].slice(0, MAX));
  };

  const remove = (dataUrl: string) => persist(sigs.filter((s) => s.dataUrl !== dataUrl));

  return { sigs, save, remove };
}
