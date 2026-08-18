import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ICON_NAMES } from "../src/components/Icon";

/**
 * The icon map's two failure modes, neither of which the type-checker can see.
 *
 * `Icon` takes a `name: string` and falls back to a bare `Square` when the name
 * isn't mapped — so a typo, or a name invented at a call site, renders an empty
 * box with no error anywhere. That is exactly how the properties panel's collapsed
 * tab shipped showing a square where its settings glyph belonged: `name="sliders"`
 * was never a key in the map.
 *
 * The second mode is subtler and was the whole of the icon problem here: one glyph
 * standing for several unrelated actions. That can't be asserted mechanically (some
 * sharing is correct — `rectangle` and `redact_tool` are both squares, one filled),
 * so it's checked at the map instead, by giving every meaning its own key. What
 * *can* be asserted is that no key is dead weight, since an unused key is how the
 * map drifts out of step with the UI it describes.
 */

/** Every `.ts`/`.tsx` file under `src/`. */
function sources(dir = "src"): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** Every literal icon name in the source: `<Icon name="x">` and `icon: "x"`. */
function usedNames(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of sources()) {
    if (file.endsWith("components/Icon.tsx")) continue;
    const text = readFileSync(file, "utf8");
    for (const re of [/<Icon\s+name="([a-z_0-9]+)"/g, /\bicon:\s*"([a-z_0-9]+)"/g]) {
      for (const m of text.matchAll(re)) {
        used.set(m[1], [...(used.get(m[1]) ?? []), file]);
      }
    }
  }
  return used;
}

/** Names built at runtime rather than written as literals, so the scan misses them. */
const DYNAMIC = ["light_mode", "dark_mode", "system_mode", "panel_open", "panel_close", "palette", "link_tool"];

test("every icon name in the source is mapped", () => {
  const used = usedNames();
  expect(used.size, "the scan found no icon usages at all — the regexes are stale").toBeGreaterThan(30);

  const unmapped = [...used.entries()]
    .filter(([name]) => !ICON_NAMES.includes(name))
    .map(([name, files]) => `${name} (${[...new Set(files)].join(", ")})`);

  expect(unmapped, "these names fall back to a blank square").toEqual([]);
});

test("every mapped icon is actually used", () => {
  const used = new Set([...usedNames().keys(), ...DYNAMIC]);
  const dead = ICON_NAMES.filter((name) => !used.has(name));
  expect(dead, "mapped but never rendered — drop it or use it").toEqual([]);
});
