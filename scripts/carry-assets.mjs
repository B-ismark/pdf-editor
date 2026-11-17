#!/usr/bin/env node
/**
 * Keep earlier deploys' code files online after a new deploy.
 *
 * The app fetches parts of itself on demand (dialogs, the exporter, signing,
 * OCR, the pdf.js worker) under content-hashed names in `assets/`. A Pages
 * deploy replaces the whole site, so a page opened before a deploy asks for
 * files that are gone the moment it next opens one of those parts — which, with
 * no error boundary, blanked the app. The app now copes when that happens
 * (see `src/staleBuild.ts`), but the better outcome is that it doesn't: this
 * copies the last few builds' `assets/` into the new `dist/assets/`. Hashed
 * names never collide, and the new build never references the old files, so
 * they cost only storage (~5 MB a build).
 *
 *   node scripts/carry-assets.mjs --dist dist --history .pages-history \
 *        --keep 5 [--seed-url https://example.github.io/app/]
 *
 * `--history` is a directory kept between deploys (CI caches it): one folder
 * per build holding that build's own assets. `--seed-url` names the live site:
 * whenever the build it's serving isn't in the history (the first deploy with
 * this step, a lost cache, a deploy from elsewhere), its files are fetched and
 * recorded, so pages opened on it keep working. Best-effort throughout, and
 * time-boxed: it logs and carries on, and never fails a deploy.
 */
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const dist = args.dist ?? "dist";
const history = args.history ?? ".pages-history";
const keep = Math.max(1, Number(args.keep ?? 5));
const seedUrl = args["seed-url"];

const assetsDir = join(dist, "assets");
/** A file name Vite emits: `name-<hash>.<ext>`. Nothing else is carried. */
const HASHED = /^[\w.-]+-[\w-]{8}\.(?:m?js|css|wasm|woff2?|ttf|png|svg|json)$/;

async function listBuilds() {
  if (!existsSync(history)) return [];
  const names = await readdir(history);
  // Folder names are zero-padded timestamps, so they sort oldest → newest.
  return names.filter((n) => /^\d+$/.test(n)).sort();
}

/** Fetch the live site's asset files, following references from the entry
 * page through every script and stylesheet it reaches. */
/** The whole crawl gets this long; a slow or hanging live site can't stall a deploy. */
const SEED_BUDGET_MS = 60_000;

async function seedFromLive(url, into, html) {
  const base = url.endsWith("/") ? url : url + "/";
  const deadline = Date.now() + SEED_BUDGET_MS;
  const seen = new Set();
  const queue = [];
  const scan = (text) => {
    for (const m of text.matchAll(/(?:assets\/|\.\/|\/)?([\w.-]+-[\w-]{8}\.(?:m?js|css|wasm))/g)) {
      const name = m[1];
      if (HASHED.test(name) && !seen.has(name)) {
        seen.add(name);
        queue.push(name);
      }
    }
  };
  scan(html);
  await mkdir(into, { recursive: true });
  let saved = 0;
  while (queue.length) {
    if (Date.now() > deadline) {
      console.warn(`carry-assets: seeding stopped at the time limit; ${queue.length} file(s) not fetched.`);
      break;
    }
    const name = queue.shift();
    try {
      const res = await fetch(base + "assets/" + name, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(join(into, name), buf);
      saved++;
      if (/\.(m?js|css)$/.test(name)) scan(buf.toString("utf8"));
    } catch (err) {
      console.warn(`carry-assets: couldn't fetch ${name}: ${err.message}`);
    }
  }
  return saved;
}

async function main() {
  if (!existsSync(assetsDir)) {
    console.warn(`carry-assets: no ${assetsDir}; nothing to do.`);
    return;
  }
  await mkdir(history, { recursive: true });
  let builds = await listBuilds();

  if (seedUrl) {
    const into = join(history, String(Date.now() - 1).padStart(15, "0"));
    try {
      const base = seedUrl.endsWith("/") ? seedUrl : seedUrl + "/";
      const html = await (await fetch(base, { signal: AbortSignal.timeout(15000) })).text();
      const entry = html.match(/assets\/(index-[\w-]{8}\.js)/)?.[1];
      let known = false;
      for (const b of builds) if (entry && existsSync(join(history, b, entry))) known = true;
      if (entry && !known) {
        const n = await seedFromLive(seedUrl, into, html);
        console.log(`carry-assets: recorded the live build (${n} file(s)).`);
      }
    } catch (err) {
      console.warn(`carry-assets: couldn't read the live site (${err.message}); carrying on.`);
      await rm(into, { recursive: true, force: true });
    }
    builds = await listBuilds();
  }

  // Record this build's own files, then drop the oldest beyond `keep`.
  const own = join(history, String(Date.now()).padStart(15, "0"));
  await mkdir(own, { recursive: true });
  for (const f of await readdir(assetsDir)) {
    if (HASHED.test(f)) await cp(join(assetsDir, f), join(own, f));
  }
  builds = await listBuilds();
  for (const old of builds.slice(0, Math.max(0, builds.length - keep))) {
    await rm(join(history, old), { recursive: true, force: true });
  }
  builds = await listBuilds();

  // Copy every earlier build's files the new one doesn't already have.
  let carried = 0;
  for (const b of builds) {
    if (join(history, b) === own) continue;
    for (const f of await readdir(join(history, b))) {
      const to = join(assetsDir, f);
      if (!HASHED.test(f) || existsSync(to)) continue;
      if (!(await stat(join(history, b, f))).isFile()) continue;
      await cp(join(history, b, f), to);
      carried++;
    }
  }
  console.log(`carry-assets: kept ${builds.length} build(s); carried ${carried} earlier file(s) into ${assetsDir}.`);
}

main().catch((err) => {
  // Never fail the deploy over this.
  console.warn(`carry-assets: skipped (${err.stack ?? err})`);
});
