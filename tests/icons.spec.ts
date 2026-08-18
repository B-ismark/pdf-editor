import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ICON_MAP, ICON_NAMES, SHARED_GLYPHS } from "../src/components/Icon";

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
 * standing for several unrelated actions. It *can* be asserted — by requiring that
 * two names resolving to the same Lucide component are declared in `SHARED_GLYPHS`
 * with a reason. That check is here because de-duplicating the map introduced a
 * fresh duplicate: `edit` and `draw_tool` both came out as `Pencil`, and both are
 * on screen at once (the selection bar floats over the canvas with the dock still
 * showing). Reasoning about names caught the old duplicates; only comparing the
 * resolved glyphs caught the new one.
 *
 * The blind spot that remains: Lucide's `Pen`, `Pencil` and `PenLine` are the *same*
 * body path, differing by a single 4px stroke, so they are distinct components and
 * one picture. Nothing mechanical catches that — it took rendering all 60-odd
 * glyphs onto one sheet and looking at them. Do that when adding to this map.
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

test("no two names resolve to the same glyph unless declared", () => {
  const byGlyph = new Map<unknown, string[]>();
  for (const [name, component] of Object.entries(ICON_MAP)) {
    byGlyph.set(component, [...(byGlyph.get(component) ?? []), name]);
  }

  // A group of three is undeclared by construction: `SHARED_GLYPHS` pairs one name
  // with one other, and three names on one picture is never the right answer. Only
  // an exactly-two group can be excused, and only if the pair is declared — the
  // first draft of this check destructured `[a, b]` out of the group and so read
  // past a third name entirely.
  const undeclared = [...byGlyph.values()]
    .filter((names) => names.length > 1)
    .filter((names) => {
      if (names.length > 2) return true;
      const [a, b] = names;
      return SHARED_GLYPHS[a] !== b && SHARED_GLYPHS[b] !== a;
    })
    .map((names) => names.join(" + "));

  expect(
    undeclared,
    "these names are one picture wearing two meanings — give one its own glyph, " +
      "or declare the pair in SHARED_GLYPHS with a reason",
  ).toEqual([]);

  // A stale entry in SHARED_GLYPHS would silently license a real duplicate later.
  for (const [a, b] of Object.entries(SHARED_GLYPHS)) {
    expect(ICON_MAP[a], `SHARED_GLYPHS names ${a}, which isn't in the map`).toBeTruthy();
    expect(ICON_MAP[b], `SHARED_GLYPHS names ${b}, which isn't in the map`).toBeTruthy();
    expect(ICON_MAP[a], `${a} and ${b} no longer share a glyph — drop the entry`).toBe(ICON_MAP[b]);
  }
});

test("every mapped icon is actually used", () => {
  const used = new Set([...usedNames().keys(), ...DYNAMIC]);
  const dead = ICON_NAMES.filter((name) => !used.has(name));
  expect(dead, "mapped but never rendered — drop it or use it").toEqual([]);
});
