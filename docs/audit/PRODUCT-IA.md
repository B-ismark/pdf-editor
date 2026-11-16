# PDF Editor: feature inventory, competitive gaps, IA and multi-document proposal

**Scope.** This is a read-only product audit of `/home/user/pdf-editor` at commit `166c581`. Sources: `CLAUDE.md`, `README.md`, `docs/*.md`, `src/App.tsx`, `src/components/*`, `src/pdf/*` and `src/hooks/*`. I changed no files.
**Method.** I read the source statically and did not drive the app in a browser. Each claim marked *(verify)* comes from reading code. It should be pinned with a spec before anyone acts on it.

---

## 0. Executive summary

1. **The feature set is wide and well engineered.** It includes in-place text editing in the document's own face, sampled colours, true raster redaction, OCR, form filling, PAdES signing, compression, page organisation, and multi-select with align and distribute. The weak point is the model the features hang on: each family has a different *commit model*, and the UI gives no sign of which is which:
   - Live, undoable layers: page numbers and watermark.
   - Immediate side downloads that leave the working document alone: Compress, Sign with certificate, Export images, .txt, and Extract.
   - A destructive rebuild that **discards all edits**: Organise → Apply.
2. **The README's "preserving everything you didn't touch" is not true at document level** *(verify)*. `exportPdf` builds a fresh `PDFDocument.create()` and calls `copyPages`, so the following catalog-level structures don't reach the output:
   - bookmarks (`/Outlines`)
   - page labels
   - the tagged-PDF structure tree and `/Lang`
   - named destinations
   - optional-content config
   - `/AcroForm`, whenever no field was filled

   Two practical results: internal links will probably point at orphan page copies, and unfilled forms may stop being fillable. Of everything in this report, this is the most urgent to check, because it affects every download.
3. **"Redact all matches" sizes its boxes by character count** (`find.ts`: `perChar = frag.width / len`, `height = size` with no padding). CLAUDE.md lists exactly this as a rule ("cover rectangles must be *measured*… never estimated from character counts"), because it once leaked text. Search also can't match a phrase that spans two text runs, which pdf.js produces often. For a privacy-first product, these are the two most important search gaps.
4. **The IA problem is not where the duplication sits. It is that three kinds of thing share one list.** Canvas tools, document *settings and layers*, and *outputs* are all filed into the same "Organise / Text / Finish" groups. I propose:
   - a left sidebar for **Pages / Outline / Search / Comments**, where page operations become live and undoable;
   - a right Inspector that only shows **properties** (the document's own properties when nothing is selected);
   - an **Export** split-button that owns every "produce a file" action;
   - a complete command palette.
5. **For multi-document support I recommend document tabs, with the Pages sidebar doubling as a cross-document shelf.** On phones, tabs collapse into a title switcher sheet. Each document gets its own undo, viewport and autosave slot. Pages are copied between documents by default. One structural prerequisite comes first: a **page-plan model** in `DocState`, because fragment ids are positional (`${pageIndex}:${itemIndex}`) and that is why Organise has to discard edits today.

---

## 1. Feature inventory

Surface key:
- **Bar**: the app bar
- **Dock**: the floating tool dock
- **Drawbar**: the draw sub-toolbar
- **Insp-D / Insp-P**: the Inspector's Document / Properties tabs (≥600px only)
- **⋯**: the overflow menu
- **Pal**: the command palette (Ctrl/⌘+K)
- **SelBar**: the contextual selection bar (phone, or desktop with the Inspector collapsed)
- **Multibar**: the bar shown for a multi-selection
- **Rail**: the page thumbnail rail
- **Org**: the Organise modal

### 1.1 Open, session and file

| Feature | Where | Shortcut | Notes / limitations |
|---|---|---|---|
| Open PDF (picker, drag-drop) | Start screen | none | Content-sniffed (`looksLikePdf`). Drag-drop takes **only `files[0]`**, and drop works only on the start screen, not over an open document. |
| Open another PDF | ⋯ File, Pal | none | **Discards** the current doc and its edits (after a confirm). Single-document app. |
| Close / home | Brand button, ⋯ File, Pal | none | Confirms if there are changes. |
| Password-protected PDFs | none | none | **Refused** with an error (`pdfOpenError`). pdf.js can decrypt with a password; pdf-lib can't re-save. |
| Autosave and restore | Start-screen banner; ⋯ View "Save session on this device" | none | IndexedDB with **one slot** (`current`, `current-bytes`). Undo history isn't persisted. **The OCR layer isn't persisted** *(verify)*: OCR fragments live in `pdf.pages`, not in `DocState`, so after a restore any edit to an `ocr:` fragment is orphaned and the scan is no longer searchable. The ⋯ toggle is missing from Pal. |
| Unsaved-work guard | beforeunload | none | Present. |
| Download edited PDF | Bar (primary), Pal | none | Warns when a whiteout cover sits over live text. Filename is `-edited.pdf`. There is **no Ctrl+S** binding, so the browser's "Save page" dialog fires instead. |
| Print | none | none | Missing. |
| Share (Web Share) | none | none | Missing. This is the natural "send" path on phones. |

### 1.2 Canvas tools (Dock, single-key shortcuts, Pal)

| Tool | Key | Notes / limitations |
|---|---|---|
| Select | V | Click text to edit in place. Marquee multi-select is mouse-only by design. Multibar offers align ×6, distribute ×2 (needs 3+ items), front/back, duplicate, delete. Ctrl+C/V/D copy, paste and duplicate overlay objects. Arrow keys nudge (Shift = ×10). `[`/`]` restack annotations. |
| Edit existing text | (Select) | Keeps the source typeface and weight, and samples background and ink colour. **The original is covered, not removed.** No reflow. Rotated text isn't repositioned. Find matches **within a single fragment only**. |
| Add text | T | Text box. Inherits the last text style (persisted). Font choice is Sans / Serif / Mono plus bold, italic, size and colour. Standard fonts are WinAnsi only. |
| Draw | D | Disclosure toolbar with eight sub-tools: highlight, pen, rect, line, arrow, tick, cross, note. Has colour and width. **Everything is flattened into page content on export**: there are no real PDF annotations, so a reviewer in Acrobat sees no comments and a sticky note is a drawn rectangle. |
| Sign | S | Dialog with draw / type / upload modes and a saved gallery (localStorage). Tap to place. Stamps are edited on the canvas only. No initials or date presets. |
| Redact | R | True removal: the page is rasterised (JPEG or PNG, whichever is smaller; ⋯ "Lossless redacted pages" forces PNG). The page loses its text layer. The fill colour can be changed in Properties. |
| Whiteout | W | Cosmetic cover, stays vector. Download warns when it covers live text. |
| Link | L | Rectangle with a URL (allow-list: http(s)/mailto/tel). **No link-to-page target.** |
| Add image | *not in Dock*: Insp-D "Organise", ⋯, Pal | Same stamp mechanism as Sign, but filed under "Organise" (see §2). |

### 1.3 Document actions (`docActions`: shared by Insp-D, ⋯ and Pal)

| Group | Action | Commit model | Notes |
|---|---|---|---|
| Organise | Organise pages | **Rebuild, discards edits** | Full-screen modal. Reorder uses ‹ › buttons only (**no drag**). Also rotate, delete, "Add PDF" (appends at the end only), Extract selected (downloads). There is **no insert-blank, insert-at-position, split or duplicate page**. The selected-page badge uses the `add` (+) glyph. |
| Organise | Add image | Live stamp | Opens a picker. Marked `opens: "dialog"`, but it opens an OS picker. |
| Text | Recognise text (OCR) | Mutates `pdf.pages` (not undoable, not autosaved) | tesseract.js, self-hosted, English only. Cancellable. |
| Text | Copy all text | Clipboard | none |
| Text | Export text (.txt) | Side download | none |
| Finish | Page numbers | Live, undoable layer | Six positions, start number, colour. Size is fixed at 11. **No "Page X of Y", prefix, header/footer text or Bates numbering.** |
| Finish | Watermark | Live, undoable layer | Text only: diagonal, opacity, angle, size. No image watermark, no page range. |
| Finish | Export as images | Side download (PNG at 2×, zipped) | No JPEG option, no DPI choice, no page range. |
| Finish | Compress PDF | Side download | Keep text (image downsampling), High / Balanced / Smallest, Custom. Preview shows the resulting size. |
| Finish | Sign with certificate | Side download | adbe.pkcs7.detached, self-signed or .p12. Must be the last step. |

### 1.4 View and preferences

| Feature | Where | Notes |
|---|---|---|
| Zoom −/+, % (resets to fit width) | Zoom pill (top-right) | Pinch, ⌘-wheel, double-tap. **No Fit page, no go-to-page field, no two-up or spread view, no zoom in Pal.** |
| Page rail | Bar toggle, Pal ("Show page thumbnails", label drift vs. "Show pages") | Navigation only. No page ops, no drag, no context menu. |
| Find | Bar, Ctrl+F, Pal | Case-insensitive substring. No whole-word, regex or patterns. Has "Redact all", sized by char-count estimate. **No replace.** |
| Theme | ⋯ View, Pal | none |
| Dim pages | ⋯ View, Pal | none |
| Lossless redacted pages | ⋯ View only | Missing from Pal. It's an export setting filed under "View". |
| Undo / redo | Bar, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Pal | 200 steps, in-memory. |
| Command palette | **Ctrl+K only** | Not shown anywhere in the UI. No visible hint, no "?" cheat-sheet. |

### 1.5 Properties (Insp-P on desktop, bottom sheet on phone)

- **Text** (fragment or box): family, bold, italic, size, colour, reset style.
- **Redaction**: fill colour.
- **Link**: URL.
- **Annotation**: colour, width, front/back.
- **Stamp**: a name, plus a note that it's edited on the canvas.

There is no X/Y/W/H numeric entry, opacity, rotation field, or lock.

### 1.6 Forms

`FormFieldLayer` fills **text fields and checkboxes only**. Radio buttons, dropdowns, list boxes and signature fields are ignored. Field names are used as `aria-label`s, and these are often machine names such as `topmostSubform[0].Page1[0].f1_01[0]`. On export the form is **always flattened** once any value was set, with no "keep fillable" option. There is **no form-field creation**.

### 1.7 Hard-to-discover features

- **The command palette (Ctrl+K)**: no button, hint or menu entry anywhere.
- **Copy, paste and duplicate (Ctrl+C/V/D)**: there's no Duplicate in SelBar or Insp-P for a single object. Only Pal and Multibar show it.
- **Restack `[` / `]`**: shown in Insp-P and Multibar tooltips only.
- **Marquee multi-select and group drag**: mouse-only, and nothing tells you it exists.
- **Search-and-redact**: lives inside the Find bar. Someone looking for "redact" in the Redact tool won't find it.
- **Tick and cross marks**: two items deep, under Draw.
- **Form filling**: invisible until a field is clicked with Select. Fields don't respond while another tool is active, and nothing explains why.
- **Lossless redaction**: filed under "View".
- **Single-key tool shortcuts**: the tooltips show them, and the README lists only V/T/D/S/R (W and L are missing).

### 1.8 Inconsistencies between surfaces

1. **Pal is not a superset.** It's missing: Save session toggle, Lossless toggle, zoom (in, out, fit), Show/Hide panel, Bring to front / Send to back, align and distribute, Delete selection, Escape/deselect, and next/previous match.
2. **Label drift.** The app bar says "Show pages / Hide pages" while Pal says "Show page thumbnails". Both the Inspector heading and the brand tooltip say "Close document".
3. **The `opens: "dialog"` mark on "Add image"** promises an in-app dialog, but an OS picker opens. This is a small instance of the "a mark that promises a dialog that never arrives" rule in CLAUDE.md.
4. **Two signing entry points sit far apart.** "Sign" is in the Dock (a visual signature). "Sign with certificate" is in Finish (a cryptographic signature). Neither mentions the other, and users conflate the two.
5. **Outputs are spread over four places.** Download is in the bar; .txt in "Text"; images, compress and certificate signing in "Finish"; Extract inside Organise.
6. **Commit models are invisible** (§1.3). Page numbers and watermark are live and undoable. Organise looks the same in the list but wipes your edits.
7. **The documentation is stale.**
   - README: "Page numbers / watermark / organize rebuild the document". They are live layers now; only Organise rebuilds.
   - README: the tool table and shortcut list omit Whiteout, Link, Compress, certificate signing, form fill, Pal, multi-select, copy and paste, and tick/cross.
   - README: the overflow-menu description is outdated.
   - CLAUDE.md: "Finishing ops … bake in (and reset) current edits". Organise *discards* edits rather than baking them in (`mainBytes = pdf.bytes`, confirm text: "discards your current text edits, annotations, and redactions"); the others bake without resetting.
8. **Phone gets a different command set.** Insp-D doesn't exist under 600px, so the ⋯ menu is the only route to document actions, and Pal needs a keyboard. That's acceptable, but it means the ⋯ menu can't be slimmed down without a phone replacement.

### 1.9 Integrity and correctness items found in passing (outside the brief, high priority)

| # | Item | Evidence | Suggested spec |
|---|---|---|---|
| I-1 | Catalog-level structure dropped on export: outline, page labels, StructTreeRoot/Lang, Dests, OCProperties, AcroForm when unfilled, ViewerPreferences | `exporter.ts:445` `PDFDocument.create()` plus `copyPages` per page. Nothing copies catalog entries. *(verify)* | Export a fixture with outline, page labels, a tagged structure, an internal GoTo link and an unfilled form. Assert each survives, and that the link `/Dest` targets an output page. |
| I-2 | Search-and-redact boxes are estimated, not measured. A leak is possible for wide glyphs, accents and descenders. | `find.ts` `perChar`, `y = base − 0.2·size`, `height = size`, no padding. `redactAllMatches` copies the box as-is. | Same as `export.spec`'s redacted-page check, against a "WWW" and "Åçg" fixture. |
| I-3 | The OCR text layer isn't autosaved, so edits on OCR words are orphaned after a restore. | `runOcr` → `setPdf`; `saveSession(fileName, pdf.bytes, doc.state)`. *(verify)* | Run OCR, edit a word, reload, restore, and assert. |
| I-4 | pdf.js proxies in `getCachedDoc` are never `destroy()`ed, so each Organise Apply or re-open leaves a worker-side document behind. | `loader.ts:168` WeakMap with no destroy. *(verify)* | This blocks multi-document support (§4.7). |
| I-5 | The form is flattened whenever any field has a value, with no choice. Radio buttons and choice fields can't be filled. | `fillAndFlattenForm` | Add a feature: a "Keep form fillable" option. |

---

## 2. Competitive comparison

**Baseline.** These are features that Acrobat (Pro/Reader), PDF Expert, Smallpdf, iLovePDF, PDF24, Stirling-PDF and Xodo all offer, or that a majority of them treat as standard.

**Status key.** ✅ present · ◐ partial · ✗ missing.

**Fit key** (how well it fits a no-server, no-CDN product):
- **Native**: plain pdf-lib or pdf.js work.
- **WASM**: needs a self-hosted engine.
- **No**: needs a server or a large proprietary engine.

| Capability | Status | Fit | Effort | Value | Notes |
|---|---|---|---|---|---|
| Preserve outline / tags / links on save | ✗ (I-1) | Native | M | ★★★★★ | This is integrity rather than a feature. Do it first. |
| Bookmarks / outline: view and navigate | ✗ | Native (`pdf.getOutline()`) | S | ★★★★ | An Outline tab in the left sidebar. |
| Bookmarks: edit and create | ✗ | Native (low-level dicts) | M | ★★★ | |
| Links to a page / internal destinations | ✗ | Native (`/GoTo` + `/Dest`) | S | ★★★ | Add a target type to `LinkAnnot`. |
| Insert blank page / page from image / PDF at position | ✗ (append-only merge) | Native | S | ★★★★★ | Universal in every competitor. |
| Duplicate page; drag-reorder in sidebar | ✗ | Native | S–M | ★★★★ | Needs the page-plan model (§3.3). |
| Split by ranges / every N / by bookmark → zip | ◐ (extract a selection) | Native + `zip.ts` | S | ★★★★ | A top-3 task on iLovePDF, Smallpdf and PDF24. |
| Crop / set page boxes, resize page, N-up | ✗ | Native (`setCropBox`, `embedPage`) | S–M | ★★★ | Crop is the common one. |
| Images → PDF ("Create from JPGs") | ✗ | Native | S | ★★★★ | A top task on every web tool. Belongs on the start screen. |
| Header / footer text; "Page X of Y"; date and filename tokens | ◐ (numbers only) | Native | S | ★★★★ | Extend the existing live layer. |
| Bates numbering | ✗ | Native | S (after the above) | ★★★ (legal) | Worth most across *multiple* documents (§4). |
| Real PDF annotations (highlight, note, ink as `/Annot`) + flatten option | ✗ (always flattened) | Native | M | ★★★★ | Review workflows, and Acrobat's comment pane. |
| Comments list panel | ✗ | Native | S (after the above) | ★★★ | |
| Form filling: radio, dropdown, list, keep-fillable option | ◐ | Native (pdf-lib forms) | S–M | ★★★★ | |
| Form field creation (text, checkbox, radio, dropdown, signature, date) | ✗ | Native (pdf-lib `createTextField` etc.) | M | ★★★★ | Acrobat "Prepare form", PDF Expert, Xodo. |
| Find: phrase across runs, whole word, regex | ◐ | Native | S–M | ★★★★ | |
| Pattern redaction (emails, phones, IBAN/card, SSN, dates, custom regex) + review list | ✗ | Native | M | ★★★★★ | Fits the product's privacy positioning closely. Acrobat Pro, Stirling auto-redact. |
| "Remove hidden information" report (what the scrub found and removed) | ◐ (silent scrub) | Native | S | ★★★★ | Makes the existing sanitiser visible to users and auditable. |
| True text removal on edit (no cover) / non-raster redaction | ✗ | Native but hard (content-stream rewrite) | L | ★★★★ | Removes the "covered, not deleted" caveat in the README. |
| Paragraph-level editing / reflow | ✗ | Hard | L | ★★★ | Acrobat and PDF Expert only. Defer. Line-joining is a cheaper partial step. |
| Edit or replace existing images | ✗ | Native-ish (XObject swap) | M | ★★ | Swapping an image is feasible. Free editing is not. |
| Open password-protected PDFs | ✗ | Native (pdf.js `onPassword`) for viewing; WASM (qpdf) to re-save | S / M | ★★★★ | A common failure today. |
| Password-protect (encrypt) / remove password | ✗ | WASM: qpdf-wasm (Apache-2.0), or the `@cantoo/pdf-lib` fork that adds encryption | M | ★★★★ | README says "out of scope". It isn't: qpdf compiled to WASM runs on-device and can be lazy-loaded like tesseract. |
| PDF/A conversion | ✗ | WASM-heavy (needs output intent, XMP, all fonts embedded) | L | ★★ | Conflicts with metadata stripping. Defer; mention as a known gap. |
| Compare two PDFs (text diff + visual overlay) | ✗ | Native (pdf.js text + canvas diff) | M | ★★★ | Needs multi-document support. |
| Print | ✗ | Native (iframe or blob) | S | ★★★★ | |
| Save in place (File System Access) + Ctrl+S | ✗ | Native (Chromium); download fallback elsewhere | S–M | ★★★★ | |
| Installable PWA, offline, "Open with" file handler | ✗ (deliberately no app shell) | Native | M | ★★★ | See §2.2 on the trade-off with the "no app shell" stance. |
| Web Share (phone) | ✗ | Native | S | ★★★★ | |
| Multi-document tabs, merge-by-drag, batch ops | ✗ | Native | L | ★★★★★ | §4. |
| Office ↔ PDF conversion | ✗ | No (needs LibreOffice or server; LibreOffice-WASM is ~50 MB+) | none | none | State it as out of scope. |
| OCR languages beyond English | ◐ | WASM (more `@tesseract.js-data/*` packages) | S | ★★★ | Lazy-load per language. |
| Accessibility: tag and check | ✗ | Hard | L | ★★ | First stop *destroying* tags (I-1). |

### 2.1 Top 12 by value per effort, within the constraint

1. **Preserve document structure on export** (I-1), and fix measured search-redaction (I-2). Correctness before features.
2. **Non-destructive page operations in the sidebar**: drag reorder, insert blank / image / PDF *at a position*, duplicate, rotate, delete, all undoable. Organise stops discarding edits. This is also the foundation for multi-document support.
3. **Split** (ranges / every N / by bookmark → zip), **Images → PDF**, **Crop**.
4. **Pattern redaction plus a "Remove hidden information" report.** These are the features most closely tied to the product's privacy positioning.
5. **Outline sidebar** (view, then edit), and **link to page**.
6. **Open encrypted PDFs** (pdf.js password prompt) and **encrypt / decrypt on export** (qpdf-wasm, lazy and self-hosted).
7. **Forms**: complete filling (radio, choice), a "Keep fillable / Flatten" choice, then field creation.
8. **Header / footer text with tokens**, which then extends to **Bates numbering**.
9. **Real annotations** (an option: "Keep as comments" vs. "Flatten into page"), plus a Comments panel.
10. **Print, Share, and Save-in-place (Ctrl+S)**.
11. **Multi-document workspace** (§4), including Combine, Download all, batch Compress / Watermark / Bates.
12. **Compare documents** (requires item 11).

### 2.2 PWA and offline: proceed carefully

CLAUDE.md deliberately rules out an app-shell service worker, to avoid the classic stale-shell failure. An installable PWA (manifest + `file_handlers` + `launchQueue`) does *not* need offline caching. Install and "Open with…" for PDFs work with a manifest plus a minimal SW, or even without an SW on current Chromium. If offline support is wanted, use a **content-hashed precache of the Vite output only**: filenames are already hashed, and the cache name comes from the build hash, which avoids stale-shell bugs. Make it opt-in through the same "keep things on this device" switch that already governs the engine cache. Offline support is valuable for this product ("works on a plane / air-gapped"). Treat it as a deliberate policy change backed by a `privacy.spec` assertion, not an accident.

---

## 3. Information architecture critique and proposal

### 3.1 What's wrong with the current split

Current surfaces:
- **App bar**: home, rail toggle, undo/redo, find, change count, Download, ⋯.
- **Tool dock**: seven canvas modes.
- **Drawbar**.
- **Inspector**: tabs Document | Properties.
- **⋯ menu**: the same ten document actions, plus View prefs and File.
- **Palette**: a partial index.
- **SelBar / Multibar**.
- **Rail**: navigation only.
- **Organise**: a modal page editor.

Problems:

1. **Categories follow implementation, not task.** "Organise / Text / Finish" mixes four different kinds of thing:
   - **insertion** (Add image: a canvas act, like Sign);
   - **transformation** (OCR);
   - **live document layers** (Page numbers, Watermark);
   - **outputs** (Compress, Export images, .txt, Sign with certificate).

   Users can't predict whether an item changes the document, downloads a separate file, or wipes their edits.
2. **The Inspector's "Document" tab is a command list sitting where properties belong.** The two-tab design (S-4) fixed a real bug: actions disappearing on selection. But it keeps a modal split in the Inspector, and the high-frequency job (properties) shares space with rarely-used commands that also appear in ⋯. On desktop, ten commands are always shown twice.
3. **Pages appear in two places with different powers.** The rail sits next to the document and can only navigate. The real page editor is a full-screen modal that rebuilds the document and discards your edits. Every mainstream editor (Acrobat, PDF Expert, Preview, Xodo) does page work in the thumbnail sidebar, live.
4. **Outputs have no home.** The primary button is "Download". Five other outputs are filed as "actions", and "Extract" sits inside Organise.
5. **The palette isn't a complete index** (§1.8 lists the gaps), so it can't serve as the "find any command" surface it's meant to be.
6. **Tool dock weight.** Link and Whiteout get permanent first-level slots, while Add image, a far more common action, is buried in "Organise".

### 3.2 Proposed model: one rule per surface

The rule:
- **Change the document** → canvas tools or page sidebar, always undoable.
- **Describe the selection, or the document when nothing is selected** → Inspector.
- **Produce a file** → Export.
- **Change the app** → ⋯.
- **Find anything** → palette.

| Surface | Holds | Changes from today |
|---|---|---|
| **App bar** | Home / documents (tabs on desktop, title switcher on phone) · Undo · Redo · Find · change count · **Export ▾** (split button) · ⋯ | Download becomes a split button. Its main action stays "Download PDF"; the caret opens the Export sheet. No new controls on phones (width budget, `shell.spec`). |
| **Left sidebar** (replaces the rail; tabs) | **Pages**: thumbnails with drag reorder, multi-select, context menu (rotate, delete, duplicate, insert blank / image / PDF before/after, extract, split here), and a drop target for files. **Outline**: bookmarks, view then edit. **Search**: a results list with context, pattern presets, "Redact selected results". **Comments**: list of annotations and notes. | Organise stops being a separate destination. The full-screen grid becomes a "grid view" toggle of the Pages tab (handy on phones). All page operations become undoable edits. |
| **Tool dock** (canvas modes only) | Select · Text · Draw ▸ · **Insert ▸** (signature, initials, date, image, stamp) · Redact ▸ (area, whiteout, search/patterns) · Link ▸ (URL / page) · later **Form ▸** | "Add image" joins Sign as *Insert*. Whiteout becomes a Redact sub-mode, which also puts the safety distinction next to the choice. Link gains a page target. Shortcuts stay. |
| **Inspector** (right; one job) | Properties of the selection. **With nothing selected: Document properties.** That means the live layers (Header/footer and page numbers, Watermark, Bates), the form setting (Keep fillable / Flatten), annotation export mode (Comments / Flatten), the redaction raster (Lossless), OCR status with a "Recognise text" button, and page size / count. | The doc-action list goes away. The empty state becomes useful document *settings*, which is also what Figma shows with nothing selected, without a mode switch. The "Document / Properties" tabs can go. |
| **Export sheet** (from the Download caret; a bottom sheet on phones) | Download PDF · Save (in place, Ctrl+S, where supported) · Save as… · Share (phones) · Print · Compress… · Protect with password… · Sign with certificate… · Export pages as images… · Export text · Split… · *(multi-doc)* Download all (zip) / Combine | Every "produce a file" action lives here and is labelled as such. None of them changes the working document. |
| **⋯ menu** | Theme · Dim pages · Save session on this device · Keyboard shortcuts (?) · Command palette (Ctrl+K) · About / privacy · Close document | Preferences and help only. On phones the Export sheet and the Pages sidebar take over the document actions the menu carries today. |
| **Command palette** | Generated from **one command registry**: tools, sub-tools, page ops, export actions, document settings, view, selection ops, navigation (go to page N). Each entry carries shortcut, icon and `opens` marker. | Extend the `docActions` / `TOOLS` single-source idea to *everything*, and add a spec asserting that every registry entry appears in the palette. Add a visible "Search commands · Ctrl+K" entry point (⋯ and empty states). |
| **SelBar / Multibar** | Unchanged in role. Add Duplicate and Arrange to SelBar for parity with Multibar. | none |

### 3.3 Architectural enabler: the page plan in `DocState`

Organise discards edits because overlay and edit identity is positional. Fragment ids are `${pageIndex}:${itemIndex}`, and overlays carry `pageIndex`. Proposed change:

- Add `pages: PageRef[]` to `DocState`, where `PageRef = { key, sourceId, sourceIndex, rotation, kind: "source" | "blank" | "image" }`.
- Key overlays and edits by the page's stable `key`, not its output index. Fragment ids become `${sourceId}/${sourceIndex}:${itemIndex}`.
- The exporter walks `pages` in order. The vector path copies the source page; blank pages are created; image pages are embedded.

What this buys:
- Reorder, rotate, delete, insert and merge all become ordinary `doc.set` calls, so they're undoable and cheap with no rebuild.
- Page operations can preview live in the main view.
- It's the same structure multi-document support needs (pages from document B inside document A).
- Restored sessions keep working, because sources are stored by content hash.

This is the largest single refactor in the report, and most of the high-value items depend on it.

---

## 4. Multi-document support

### 4.1 Options considered

| Model | Strengths | Weaknesses |
|---|---|---|
| **Tabs** (Acrobat, PDF Expert, browsers) | Most familiar. Dirty state per tab is visible. One active document keeps the existing single-canvas architecture and render window intact. | Doesn't fit a 360–430px app bar. A tab strip alone gives no way to move pages between documents. |
| **Switcher** (title dropdown) | Compact and fits phones. | Hides how many documents are open and which are dirty. Merging or dragging between documents is impossible. |
| **Workspace with a file shelf** (Stirling-PDF's newer file manager, iLovePDF's file list) | Natural for batch work and merging. Each file is a card. | Weak for focused editing, which is this app's core job. Competes with the left sidebar for space. Turns the editor into a file-processing tool. |

### 4.2 Recommendation: tabs, with the Pages sidebar as a cross-document shelf

- **Desktop (≥600px): a document tab strip** under the app bar. It shows the title, a dirty dot, and close (×). A "+" opens files. Middle-click closes a tab. Ctrl+Tab, or Ctrl+PageUp/PageDown, switches. Only the active tab renders.
- **The Pages sidebar gains a scope toggle: "This document / All open documents".** In "All" mode, each open document is a collapsible group of thumbnails, which makes the sidebar the shelf. Pages can be dragged within a group (reorder) or across groups (copy into that document at the drop point).
  - **Copy by default.** This matches Acrobat's thumbnail drag between documents and is safe.
  - **Alt/Option + drag**, or the context menu's "Move to…", moves instead.
- **Phones: no tab strip.** The width budget in `shell.spec` is non-negotiable. The brand / home button becomes the **document title with a count chip** ("Contract.pdf · 3"). Tapping it opens a **Documents sheet**: a list with thumbnail, name, dirty state and close, plus "Open file", "Combine…" and "Download all". Cross-document page moves go through multi-select in the Pages grid, then "Copy to… / Move to… [document]". No cross-document drag on touch.

Why this model:
- Editing stays one document at a time, which is what the render window, viewport, find and selection all assume.
- Tabs are understood without explanation.
- The cross-document move lives where pages already live, instead of adding a fourth surface.
- On phones the switcher's weakness (it hides state) matters less, because the sheet lists every document with its dirty state.

### 4.3 Opening, combining and merging

- Dropping **several files** on the start screen opens each as a tab. Today only `files[0]` is used.
- Dropping files **onto the workspace** opens new tabs.
- Dropping a file **onto a gap in the Pages sidebar** inserts its pages there. This *is* merge, with no dialog.
- "Open another PDF" becomes **Open…**, which adds a tab. It no longer discards anything, so the "Discard & open" confirm goes away.
- **Combine** (Export sheet, or the Documents sheet): pick documents and order them, and the result opens as a new untitled tab built from page refs. The originals are untouched. Edits and overlays come along, because they're keyed by page key (§3.3).
- Form-field name collisions on combine: rename with a suffix (pdf-lib merges by name otherwise), and say so in the status message.

### 4.4 Undo

- **One history per document.** Undo acts on the active tab, so each tab gets its own `useHistory` and its own revision counter.
- A **cross-document copy** is a single insert step in the *target* only.
- A **move** is two steps: an insert in the target and a delete in the source, linked by a transaction id. Undoing one of them shows a snackbar action, "Also undo in *Source.pdf*". No silent cross-tab undo.
- **Combine** creates a new document, whose first history entry is "Combined from 3 documents".

### 4.5 Autosave and restore

- **Schema v2.** `sessions/{docId} → { fileName, sourceHashes[], doc: DocState, ocrLayers, savedAt, order }` plus `sources/{sha256} → bytes`. Source bytes are deduplicated by content hash, so combined documents and two tabs of one file don't store the bytes twice. Migrate the v1 `current` slot to one v2 session.
- **Persist the OCR layer** (fixes I-3).
- **The restore banner** lists every saved document with checkboxes, plus "Restore all", "Not now" and "Delete all". The ⋯ toggle erases everything, as today.
- **Quota.** Check `navigator.storage.estimate()` before writing. Above about 80% of quota, stop saving the *largest inactive* documents and say so ("Not saving *Big-scan.pdf* on this device: low storage"). Don't call `storage.persist()` implicitly: it raises a prompt in some browsers, and it changes the privacy footprint.
- **Closing a tab** deletes its session (after a confirm if dirty). An unsaved document never outlives its tab silently.

### 4.6 Download all, and batch operations

- **Download all (zip)** reuses `zip.ts`, a stored zip, which suits already-compressed PDFs. Each entry is `name-edited.pdf`. On phones, **Share all** passes the files to `navigator.share({ files })` where supported.
- **Batch in the Export sheet.** Compress, Watermark, Header/footer and **Bates numbering** each get "Apply to: this document / all open documents". Bates *continuing across documents* is a strong reason for legal users to want multi-document support. Batch results go into one zip.
- **Compare**: pick two tabs, then show a side-by-side or overlay diff.

### 4.7 Memory limits

Current costs per document:
- `ArrayBuffer` bytes.
- A pdf.js proxy in the worker, holding parsed objects and fonts.
- Font and colour stores (`WeakMap` by bytes, so freed with the bytes).
- Canvases for the windowed pages.
- The history (up to 200 snapshots, but structurally shared).

Policy:
1. **Only the active tab mounts `PageView`s.** Inactive tabs keep `DocState` and their bytes only.
2. **On deactivation**, call `pdfDocument.cleanup()`, which frees page and font caches. After a tab has been inactive for a while, or when there are more than N inactive tabs, call `destroy()` and re-parse on activation (roughly 100 ms to 1 s; show the skeleton). This needs I-4 fixed first: `getCachedDoc` has to become an owned, destroyable handle per document.
3. **Soft caps, warn but don't refuse.**
   - Desktop: about 12 open documents or about 600 MB of source bytes.
   - Phone: about 4 documents or about 150 MB. iOS Safari kills tabs around 1–1.5 GB, and rasterising redacted pages at export is the peak.
   - Scale the caps by `navigator.deviceMemory` where it's available.
   - Past the cap, show: "Lots of documents open: close some to keep things fast."
4. **Batch export runs serially**, one document at a time, with `yieldToUI` between pages. Never export several documents in parallel. Release each output's bytes once it's added to the zip.
5. **New specs:**
   - `rendering.spec`: switching tabs doesn't grow canvas memory, and inactive tabs hold zero canvases.
   - `privacy.spec`: multi-slot autosave is erased by the toggle.
   - A spec that a cross-document page copy carries its edits into the export.

### 4.8 Suggested build order

1. Fix I-4. Extract a `DocumentSession` from `App.tsx`: pdf, fileName, history, selection, viewport, find, tool-transient state. Add a `useWorkspace` hook (sessions plus `activeId`). The UI is unchanged at this point; it's the same app with one session.
2. Add the page-plan model to `DocState` (§3.3), and make Organise non-destructive with it.
3. Autosave v2 (multi-slot, content-hashed sources, OCR persisted).
4. Tabs on desktop and the Documents sheet on phones. Multi-file open.
5. Pages sidebar "All documents" scope: drag-copy and Move to….
6. Export sheet: Download all, Combine, batch Compress / Watermark / Bates. Then Compare.

---

## 5. Overall sequencing

| Phase | Items |
|---|---|
| **Now (correctness)** | I-1 structure preservation (outline, labels, tags, dests, AcroForm), I-2 measured search-redaction, I-3 OCR persistence, I-4 proxy destroy. Refresh the README and CLAUDE.md claims (§1.8 item 7). |
| **Quick wins (S)** | Complete the palette from one registry, with a visible Ctrl+K entry. Print, Share, Ctrl+S → download (save-in-place on Chromium). Pass a password to pdf.js for viewing. Link to page. Outline view. Header/footer tokens. Images → PDF on the start screen. Multi-file drop. |
| **IA (M)** | Left sidebar with Pages / Outline / Search / Comments. Export split-button and sheet. Inspector becomes properties-only with document settings when nothing is selected. Dock: Insert ▸ and Redact ▸ sub-modes. |
| **Foundations (M–L)** | Page plan in `DocState`, giving live page ops: insert, duplicate, split, crop. |
| **Differentiators (M)** | Pattern redaction plus a hidden-information report. Encrypt / decrypt through qpdf-wasm. Forms: complete filling, keep-fillable, then creation. Real annotations with a flatten option. |
| **Multi-document (L)** | §4.8. Then batch operations, Bates across documents, Compare. |
| **Later / hard** | True glyph removal (no cover, and non-raster redaction), paragraph reflow, PDF/A, more OCR languages, opt-in offline PWA. |
