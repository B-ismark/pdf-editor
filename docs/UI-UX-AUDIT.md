# UI / UX Audit — PDF Editor

**Scope:** the full client-side PDF Editor (`src/`) — responsive shell, viewer,
tools, dialogs, and the Material 3 Expressive design system.
**Platforms reviewed:** mobile (phone, portrait + landscape), tablet, desktop —
in both **light** and **dark** themes.
**Method:** static review of every component, hook, and stylesheet against
Nielsen's usability heuristics, WCAG 2.2, the Gestalt principles, Material 3
guidance, and the common UX "laws" (Fitts, Hick, Jakob, Miller, Doherty,
Tesler, Aesthetic-Usability, Von Restorff). **Part 2** additionally checks
conformance against the official **Android (Material 3)** and **iOS (Apple
Human Interface Guidelines)** documentation.
**Date:** 2026-07-23

---

## Implementation status (2026-07-23)

All findings from both parts have been addressed on this branch. Notes on the
few that were resolved by mitigation or in phases:

| Finding | Status | Notes |
| --- | --- | --- |
| #1 focus ring | ✅ Fixed | Global `:focus-visible` with inset variants. |
| #2 / P-2 zoom lock | ✅ Fixed | `maximum-scale`/`user-scalable` removed. |
| #3 unsaved-work | ✅ Fixed | `beforeunload` while `changeCount > 0`. |
| #4 keyboard canvas | ◑ Phased | Arrow-nudge + delete + roles shipped; full keyboard *selection* of on-page items remains the larger follow-up. |
| #5 modals | ✅ Fixed | `useModal`: trap, Esc, focus return, roles. |
| #6 touch labels | ◑ Mitigated | Robust `aria-label`s kept; visible labels omitted to avoid crowding the M3 bar. |
| #7 / M-1 targets | ✅ Fixed | icon-btn 48, btn 44, etc. |
| #8 live regions | ✅ Fixed | Polite/assertive SR live regions. |
| #9 / M-2 breakpoints | ✅ Fixed | Expanded ≥840px tier + fit-width cap. |
| #10 bottom clutter | ✅ Fixed | Zoom bar + FAB hidden with sheet open. |
| #11 render feedback | ✅ Fixed | Per-page shimmer skeleton + `aria-busy`. |
| #12 error copy | ✅ Fixed | Plain-language messages. |
| #13 menu keyboard | ✅ Fixed | Arrow/Home/End/Esc roving focus. |
| #14 editable roles | ✅ Fixed | `role="textbox"` + labels. |
| #15 dark-page glare | ✅ Fixed | Optional "Dim pages" preview mode. |
| #16 persistent panel | ✅ Fixed | Panel always mounted on ≥600px. |
| #17 tooltips | ✅ Fixed | Handles use `data-tip`. |
| #18 note contrast | ✅ Fixed | Auto black/white by luminance. |
| #19 tool shortcuts | ✅ Fixed | V/T/D/S/R, shown in tooltips. |
| #20 README | ✅ Fixed | Claims now match; a11y documented. |
| P-1 system gestures | ◑ Mitigated | Data-loss risk removed via #3 + P-3; `touch-action: none` kept for reliable pinch-zoom. |
| P-3 modal Back | ✅ Fixed | History-integrated in `useModal`. |
| P-4 momentum | ✅ Fixed | Inertial glide on one-finger pan. |
| M-3 rail | ✅ Fixed | Rail widened to 80px. |
| i-1 double-tap | ◑ Mitigated | Visible zoom controls are the non-gesture path. |

---

## How to read this report

**Criticality** — user impact if left unaddressed:

| Level | Meaning |
| --- | --- |
| 🔴 **Critical (P0)** | Blocks a whole user group or risks losing the user's work. |
| 🟠 **High (P1)** | Real accessibility failure or significant friction for many users. |
| 🟡 **Medium (P2)** | Noticeable problem on some platforms or in some flows. |
| ⚪ **Low (P3)** | Polish, consistency, or a nice-to-have enhancement. |

**Complexity** — engineering effort to fix:

| Level | Meaning |
| --- | --- |
| **Trivial** | One CSS rule or attribute; well under an hour. |
| **Low** | Localized change in a single component. |
| **Medium** | Touches several components or adds new behavior. |
| **High** | Architectural / substantial engineering. |

---

## What this app already does well

Worth stating up front — the baseline is strong, and several findings below are
refinements rather than rescues:

- **Theme system is exemplary.** A pre-paint inline script (`index.html:19`)
  resolves light/dark/system with no flash, `useTheme` follows the OS live in
  system mode and updates the `theme-color` meta, and every color is a token
  with a full dark palette (`theme.css`). Dark mode is a first-class citizen.
- **`prefers-reduced-motion` is honored** by zeroing the motion-duration tokens
  (`theme.css:155`), so every keyframe animation degrades to instant.
- **Undo/redo with gesture coalescing** (`useHistory`, keyed `doc.set`) is a
  genuinely advanced touch — drags and typing collapse into single steps.
- **Touch-first canvas model** — app-owned pan/pinch/double-tap with zoom
  anchoring (`useViewport`) and enlarged handles on coarse pointers
  (`styles.css:599`).
- **Destructive actions are guarded** with custom confirm dialogs
  (`ConfirmDialog`) rather than `window.confirm`, and preferences persist
  across sessions (`usePrefs`).
- **Aesthetic-Usability Effect** works in the app's favor: the M3 surface
  hierarchy, shape scale, and state layers make it feel trustworthy.

---

## Summary of findings

| # | Finding | Principle / Law | Platforms | Criticality | Complexity |
| --- | --- | --- | --- | --- | --- |
| 1 | No visible keyboard-focus indicator anywhere | WCAG 2.4.7; Nielsen "visibility of status" | All | 🔴 Critical | Trivial |
| 2 | Viewport blocks UI zoom (`user-scalable=no`) | WCAG 1.4.4 / 1.4.10 | Mobile, tablet | 🔴 Critical | Low |
| 3 | No unsaved-work guard on unload | Nielsen "error prevention"; Peak-End | All | 🔴 Critical | Trivial |
| 4 | Canvas elements are pointer-only (no keyboard) | WCAG 2.1.1 | All | 🟠 High | High |
| 5 | Dialogs lack focus trap, Esc, focus return, roles | WCAG 2.4.3; ARIA APG | All | 🟠 High | Medium |
| 6 | Icon-only bar controls unlabeled on touch | Nielsen "recognition"; Jakob | Mobile, tablet | 🟠 High | Low |
| 7 | Touch targets below 44px throughout | Fitts's Law; WCAG 2.5.8 | Mobile, tablet | 🟠 High | Low |
| 8 | Status messages not announced to AT | WCAG 4.1.3 | All | 🟡 Medium | Trivial |
| 9 | One breakpoint: no true tablet/desktop tiers | Responsive design; Fitts | Tablet, desktop | 🟡 Medium | Medium |
| 10 | Bottom-of-screen control congestion | Fitts; Law of Proximity | Mobile | 🟡 Medium | Low |
| 11 | No feedback during page render / zoom re-raster | Doherty Threshold | All | 🟡 Medium | Low |
| 12 | Raw technical error strings shown to users | Nielsen "recognize/recover from errors" | All | 🟡 Medium | Low |
| 13 | Overflow menu not keyboard-navigable | ARIA menu pattern; WCAG 2.1.1 | Desktop | 🟡 Medium | Low |
| 14 | contentEditable elements have no role/label | WCAG 4.1.2 | All | 🟡 Medium | Low |
| 15 | Bright white page glare in dark mode | Dark-mode ergonomics | All (dark) | ⚪ Low | Medium |
| 16 | Side panel appears/disappears (layout shift) | Gestalt stability; CLS | Tablet, desktop | ⚪ Low | Low |
| 17 | Inconsistent tooltip mechanisms (`title` vs custom) | Nielsen "consistency" | Desktop | ⚪ Low | Trivial |
| 18 | Sticky-note text contrast on user-chosen colors | WCAG 1.4.3 | All | ⚪ Low | Low |
| 19 | No keyboard shortcuts for tools | Nielsen "flexibility & efficiency" | Desktop | ⚪ Low | Low |
| 20 | README claims not matched by implementation | Trust / documentation | — | ⚪ Low | Trivial |

---

## Detailed findings

### 🔴 1 — No visible keyboard-focus indicator anywhere
**Principle:** WCAG 2.4.7 Focus Visible (AA); Nielsen "visibility of system status".
**Platforms:** all (keyboard, switch, and screen-reader users).

The stylesheet defines `:hover` and `:active` state layers on `.icon-btn` and
`.btn` (`styles.css:50`, `81`) but there is **no `:focus` or `:focus-visible`
rule in the entire codebase** (verified — zero matches). Tabbing through the
app moves focus invisibly across the app bar, tool nav, panel controls,
dialogs, and `contentEditable` overlays. A keyboard user literally cannot see
where they are.

- **Impact:** keyboard navigation is effectively unusable; a hard AA failure.
- **Fix:** add a global `:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }`
  plus a matched treatment for the state-layer buttons and the on-page
  `contentEditable` items.
- **Complexity:** Trivial.

---

### 🔴 2 — The viewport meta disables user zoom
**Principle:** WCAG 1.4.4 Resize Text (AA), 1.4.10 Reflow (AA).
**Platforms:** mobile, tablet.

```html
<!-- index.html:7 -->
content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"
```

`maximum-scale=1.0, user-scalable=no` prevents the browser's native pinch-zoom.
The app implements its own pinch-zoom for the *document*, but the **UI chrome**
— app bar, tool labels, properties panel, dialogs, snackbars — cannot be
magnified at all. Low-vision users who rely on browser zoom are locked out of
the controls.

- **Why it's here:** to stop the page zooming while the canvas handles its own
  gestures — but `touch-action: none` on `.viewer__scroll` (`styles.css:187`)
  already scopes that to the canvas, so the global lock is overreach.
- **Fix:** drop `maximum-scale` and `user-scalable=no`; verify canvas gestures
  still behave (they should, given the scoped `touch-action`).
- **Complexity:** Low (one line + a manual gesture regression pass).

---

### 🔴 3 — No protection against losing unsaved work
**Principle:** Nielsen "error prevention"; Peak-End Rule.
**Platforms:** all.

Everything lives in memory — "no server, no uploads, no accounts." There is
**no `beforeunload` handler** (verified — zero matches). An accidental
refresh, tab close, or back-gesture silently discards every edit,
annotation, redaction, and placed signature. The in-app "Open another PDF"
flow *is* guarded (`App.tsx:621`), which makes the missing unload guard an
inconsistency as much as a risk.

- **Impact:** catastrophic, unrecoverable data loss from a common gesture —
  and it poisons the "end" of the experience (Peak-End).
- **Fix:** attach a `beforeunload` listener while `changeCount > 0`.
- **Complexity:** Trivial.

---

### 🟠 4 — On-page elements are operable by pointer only
**Principle:** WCAG 2.1.1 Keyboard (A).
**Platforms:** all.

Selecting, moving, resizing, and (for text boxes/notes) editing on-page
elements is driven entirely by pointer events (`PageView.onDown`,
`startPointerDrag` in `useDrag.ts`, and every `*Item` component). Once a
redaction or stamp *is* selected, Delete/Backspace works (`App.tsx:564`), but
there is no keyboard route to select or reposition anything. There is also no
`<main>` landmark and no skip link.

- **Impact:** the core editing surface is unreachable without a pointer.
- **Fix:** make items focusable with roving `tabindex`, add arrow-key nudging
  and Enter/Space to select; add a `<main>` landmark. Full parity is a large
  effort inherent to canvas editors — a phased approach (focus + delete +
  nudge) delivers most of the value.
- **Complexity:** High. *(Reasonable to document as a known limitation while
  the higher-ROI a11y fixes above land first.)*

---

### 🟠 5 — Dialogs are not fully accessible modals
**Principle:** WCAG 2.4.3 Focus Order; ARIA Authoring Practices (dialog).
**Platforms:** all.

`SignatureDialog`, `FinishDialog`, `Organize`, and the `ColorField` popover:

- **No focus trap** — Tab escapes to the page behind the scrim.
- **No Escape-to-close** (verified — no Escape handling anywhere). Users must
  hit the ✕ or tap the scrim.
- **Focus isn't moved in on open, nor returned to the trigger on close.**
- **Inconsistent semantics:** only `ConfirmDialog` has `role="alertdialog"`
  + `aria-modal` (`ConfirmDialog.tsx:23`); `SignatureDialog`/`FinishDialog`
  are plain divs; `ColorField` has `role="dialog"` but no label or
  `aria-modal` (`ColorField.tsx:61`).

- **Fix:** a small shared `useModal` (or `<dialog>`) that traps focus, closes
  on Escape, restores focus, and standardizes `role`/`aria-modal`/labelling.
- **Complexity:** Medium (one primitive, applied in ~4 places).

---

### 🟠 6 — Icon-only bar controls are unlabeled on touch
**Principle:** Nielsen "recognition rather than recall"; Jakob's Law.
**Platforms:** mobile, tablet.

The app-bar Undo, Redo, More (⋮), and Theme buttons are icon-only. They carry
`aria-label`/`data-tip`, but `TooltipHost` deliberately suppresses tips on
coarse pointers (`TooltipHost.tsx:48`), and on phones the text Download label
and app name are hidden too (`styles.css:1015`). A touch user is left to
*recall* what each glyph does, with no on-demand label. (The bottom tool nav is
fine — it has permanent text labels.)

- **Fix:** on touch, surface labels on long-press, or move overflow-menu-style
  labeled rows for these actions; at minimum keep the accessible names (present)
  and add a visible label affordance.
- **Complexity:** Low.

---

### 🟠 7 — Touch targets fall below the recommended minimum
**Principle:** Fitts's Law; WCAG 2.5.8 Target Size (Minimum, AA = 24px; Material recommends 48px).
**Platforms:** mobile, tablet.

- `.icon-btn` is **40×40px** (`styles.css:29`) — the most-used control in the
  app (app bar, zoom bar, draw bar, organize). Below the 44/48px comfort target
  and below the README's claimed "48px touch targets."
- `.btn` is **38px tall** (`styles.css:63`) — all dialog Cancel/Apply/Add
  buttons.
- `.sigsaved__del` is **22×22px** at a -6px offset (`styles.css:806`) — below
  even the 24px WCAG floor, and easy to miss or fat-finger.
- `.posgrid__cell` is 30px tall (`styles.css:416`); the `.tb-move` handle is
  24×16 (32×20 coarse).

- **Fix:** raise `.icon-btn`/`.btn` to 44–48px (or keep visual size but expand
  the hit area with padding/`::before`), and enlarge the tiny delete affordance.
- **Complexity:** Low.

---

### 🟡 8 — Status messages aren't announced to assistive tech
**Principle:** WCAG 4.1.3 Status Messages (AA).
**Platforms:** all.

The snackbar renders as a plain `<div>` (`App.tsx:904`) with no `aria-live` or
`role`. "Downloaded edited PDF," "Tap the page to place your signature," and
error text are invisible to screen-reader users. The same applies to the
"placing" instructional messages that are the *only* cue for the place-stamp
flow.

- **Fix:** `role="status"` + `aria-live="polite"` for normal messages,
  `role="alert"` for `snackbar--err`.
- **Complexity:** Trivial.

---

### 🟡 9 — A single 600px breakpoint collapses tablet and desktop
**Principle:** responsive design; Fitts's Law.
**Platforms:** tablet, desktop.

Everything above `min-width: 600px` (`styles.css:975`) is treated identically,
which creates three separate problems:

- **Cramped at ~600px:** a 66px rail + 288px side panel leaves ~246px for the
  document on a 600px-wide tablet in portrait, and the panel can't be collapsed.
- **Over-scaled on wide desktops:** fit-to-width scales the widest page to the
  viewport (`useViewport.ts:40`) with no max-width or two-page spread, so on a
  1920px monitor a single page balloons to an awkward size.
- **No landscape-phone handling:** in landscape the top bar + bottom nav + FAB
  crush the viewer vertically, and the 72%-height bottom sheet (`styles.css:270`)
  covers most of what's left.

- **Fix:** add a desktop tier (e.g. ≥1024px) with a content max-width / optional
  two-up view, make the tablet side panel collapsible, and add a short-viewport
  media query.
- **Complexity:** Medium.

---

### 🟡 10 — Bottom-of-screen controls compete for the same space
**Principle:** Fitts's Law; Gestalt Law of Proximity.
**Platforms:** mobile.

On phones the bottom edge simultaneously hosts the full-width tool nav, the FAB
(`bottom: 88px`, `styles.css:364`), and the zoom bar (`bottom: 76px`,
`styles.css:232`) — and opening the properties sheet (up to 72% height) lands on
top of all of it. Three stacked, differently-elevated targets in the thumb zone
invite mis-taps, and proximity makes them read as one cluttered region.

- **Fix:** hide the zoom bar while the sheet is open, or dock zoom into the nav;
  reduce simultaneous floating layers.
- **Complexity:** Low.

---

### 🟡 11 — No feedback during page render or zoom re-rasterization
**Principle:** Doherty Threshold (<400ms).
**Platforms:** all.

`PageView` debounces 90ms then rasterizes each page (`PageView.tsx:87`). During
initial open of a large document, and on **every zoom change** (which re-renders
at the new scale), pages show a blank white canvas with no spinner or skeleton.
On big/complex PDFs this can visibly exceed the 400ms comfort threshold with no
indication that work is happening.

- **Fix:** per-page loading skeleton/shimmer until the canvas paints; consider a
  low-res immediate paint upscaled while the sharp render runs.
- **Complexity:** Low (skeleton) to Medium (progressive raster).

---

### 🟡 12 — Errors are shown as raw technical strings
**Principle:** Nielsen "help users recognize, diagnose, and recover from errors."
**Platforms:** all.

Failures surface `String(err)` directly — e.g. `Could not open PDF: ${String(err)}`
(`App.tsx:138`), and similar in the finishing/export paths. Users see stack-ish
text like "Error: Invalid PDF structure" with no guidance on what to do.

- **Fix:** map common failures (corrupt/encrypted/non-PDF) to plain-language
  messages with a next step; keep the raw detail behind a "details" affordance.
- **Complexity:** Low.

---

### 🟡 13 — The overflow menu isn't keyboard-navigable
**Principle:** ARIA menu pattern; WCAG 2.1.1.
**Platforms:** desktop.

The ⋮ menu uses `role="menu"`/`role="menuitem"` (`App.tsx:670`) but has no
arrow-key roving focus, no Home/End, and no Escape-to-close/focus-return.
Declaring the menu role without the keyboard behavior is worse than a plain
list because AT announces interactions the widget doesn't support.

- **Fix:** implement roving `tabindex` + arrow/Escape handling, or drop the menu
  roles in favor of a labeled button group.
- **Complexity:** Low.

---

### 🟡 14 — On-page editable text has no accessible role or name
**Principle:** WCAG 4.1.2 Name, Role, Value.
**Platforms:** all.

`EditableFragment`, `TextBoxItem`, and `NoteItem` are `contentEditable` `<div>`s
with no `role="textbox"`, no `aria-label`, and (for text boxes/notes) no
programmatic name. The fragment at least sets `title={fragment.original}`
(`EditableFragment.tsx:92`); the others expose nothing to AT.

- **Fix:** add `role="textbox"`, `aria-multiline="false"`, and a meaningful
  `aria-label` ("Editable text: …" / "Sticky note").
- **Complexity:** Low.

---

### ⚪ 15 — Full-white page is harsh in dark mode
**Principle:** dark-mode ergonomics.
**Platforms:** all (dark theme).

`.page` and thumbnails are hardcoded `#fff` (`styles.css:209`, `954`) — correct
for representing paper, but on the `--surface-dim` (#141218) dark background a
full-page white rectangle is a bright slab that causes glare in low light.
Mature PDF readers offer a page-dim / invert / sepia mode for exactly this.

- **Fix:** offer an optional "dark page" / dimmed-canvas view (CSS filter on the
  canvas, preview-only) toggle; keep export untouched.
- **Complexity:** Medium.

---

### ⚪ 16 — Side panel appears and disappears, shifting layout
**Principle:** Gestalt stability; Cumulative Layout Shift.
**Platforms:** tablet, desktop.

The side panel only renders when something is selected (`App.tsx:869`), so on
desktop the viewer widens and narrows as selection changes. `useViewport`
intentionally avoids rescaling to prevent a zoom-jump (`useViewport.ts:44`),
which is a thoughtful mitigation, but the panel itself still pops in/out — and
the README's "persistent side panel" describes a stability the build doesn't
deliver.

- **Fix:** on desktop, keep a persistent panel that shows the empty-state copy
  (`props__empty` already exists) instead of unmounting.
- **Complexity:** Low.

---

### ⚪ 17 — Two different tooltip mechanisms
**Principle:** Nielsen "consistency and standards."
**Platforms:** desktop.

Most controls use the custom `data-tip`/`TooltipHost` system (fast, styled),
but the move/resize handles use the native `title` attribute
(`TextBoxItem.tsx:113`, `118`) — which is slow, unstyled, and invisible on
touch. Two tooltip systems for one app.

- **Fix:** standardize on `data-tip`.
- **Complexity:** Trivial.

---

### ⚪ 18 — Sticky-note text contrast depends on user color choice
**Principle:** WCAG 1.4.3 Contrast.
**Platforms:** all.

Sticky notes paint text at a fixed `#1a1a1a` on a user-chosen background
(`styles.css:611`, `NoteItem` `style.background = color`). The default yellow is
fine, but a user who picks a dark note color gets near-black text on a dark
fill.

- **Fix:** auto-pick black/white note text from the background luminance.
- **Complexity:** Low.

---

### ⚪ 19 — No keyboard shortcuts for tool switching
**Principle:** Nielsen "flexibility and efficiency of use."
**Platforms:** desktop.

Undo/redo/delete have shortcuts (`App.tsx:550`), but there are no accelerators
for the primary tools (Select/Text/Draw/Sign/Redact) the way every comparable
editor offers (V, T, etc.). Power users on desktop pay a mouse round-trip for
every tool switch.

- **Fix:** add single-key tool shortcuts with a discoverable hint in tooltips.
- **Complexity:** Low.

---

### ⚪ 20 — README claims not matched by the implementation
**Principle:** trust / documentation accuracy.

Two specifics: the README advertises **"48px touch targets"** (actual
`.icon-btn` is 40px — see #7) and a **"persistent side panel"** on
tablet/desktop (actually conditional — see #16). Small gaps, but they erode
trust when a reviewer checks.

- **Fix:** align the code to the claims (preferred) or soften the claims.
- **Complexity:** Trivial.

---

## Cross-cutting themes

1. **Keyboard & screen-reader accessibility is the biggest gap.** Findings 1,
   4, 5, 8, 13, 14 all point the same way: the app is beautifully built for
   pointer + sighted use, and largely unbuilt for keyboard and AT. Fixing
   focus-visible (#1), the unload guard (#3), the viewport lock (#2), live
   regions (#8), and dialog behavior (#5) is high-value and mostly low-cost.
2. **"Responsive" today means "phone vs. not-phone."** The single 600px
   breakpoint (#9) leaves real tablet, wide-desktop, and landscape cases
   unoptimized.
3. **Dark mode is structurally excellent** — the one ergonomic gap is page
   glare (#15); everything else in dark theme is handled correctly.
4. **Feedback is good globally but thin locally** — strong document-level status,
   but per-page render (#11) and error legibility (#12) need attention.

## Suggested sequencing

- **Quick wins (Trivial/Low, high impact):** #1 focus-visible, #3 unload guard,
  #8 live regions, #2 viewport, #7 touch targets, #6 touch labels, #12 error
  copy, #17 tooltip consistency, #20 README.
- **Next (Low/Medium):** #5 modal primitive, #13 menu keyboard, #14 editable
  roles, #10 bottom-bar congestion, #11 render feedback, #16 persistent panel,
  #9 breakpoint tiers.
- **Larger, plan separately:** #4 full keyboard editing, #15 dark-page view.

---
---

# Part 2 — Platform conformance: Android (Material 3) & iOS (Apple HIG)

This section compares the app against the **official** Android and Apple design
documentation and adds findings specific to running as an installable/mobile
web app on those platforms. Because the app ships as a browser PWA rather than a
native binary, "conformance" means honoring platform *conventions and
constraints* (gesture zones, safe areas, target sizes, size-class layouts, dark
appearance) — the things users' muscle memory and assistive tech expect.

### Official guidance used as the yardstick

**Material 3 (Android):**

- Touch targets must be **≥ 48×48 dp**; Material components enforce this
  internally. ([accessibility](https://developer.android.com/design/ui/mobile/guides/foundations/accessibility))
- Contrast: **4.5:1** normal text, **3:1** large text, and **3:1** for non-text
  UI (component container vs. background; surface vs. non-text element).
  ([color-contrast](https://m3.material.io/foundations/designing/color-contrast))
- **Window size classes / breakpoints:** **Compact < 600 dp** → navigation bar
  (bottom); **Medium 600–839 dp** → navigation **rail** (~80 dp wide);
  **Expanded ≥ 840 dp** → navigation **drawer** / two-pane canonical layouts.
  Height breakpoints exist for short viewports.
  ([breakpoints](https://m3.material.io/foundations/layout/breakpoints/overview),
  [window size classes](https://m3.material.io/foundations/layout/applying-layout/window-size-classes))
- **Navigation bar** carries **3–5 top-level destinations**; the **FAB sits
  above** the navigation bar.
  ([navigation bar](https://m3.material.io/components/navigation-bar/guidelines),
  [FAB](https://m3.material.io/components/floating-action-button/guidelines))

**Apple Human Interface Guidelines (iOS):**

- Controls need a hit region of **≥ 44×44 pt**.
  ([layout](https://developer.apple.com/design/human-interface-guidelines/layout))
- **Safe areas** must inset content from the notch/Dynamic Island, rounded
  corners, and home indicator.
- **Dynamic Type:** support user text scaling; use text styles, avoid fixed
  sizes. ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility))
- **Gestures** should *supplement, not replace* visible controls, and must not
  fight **system gestures** (edge-swipe back, the home-indicator swipe, which
  the OS always wins). ([gestures](https://developer.apple.com/design/human-interface-guidelines/inputs/touchscreen-gestures/))
- **Dark Mode** is systemwide; elevated surfaces get **lighter** (shadows read
  poorly on dark). ([dark mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode))

---

## Where the app already conforms (both platforms)

- **Safe-area insets are handled thoroughly.** `env(safe-area-inset-*)` is
  applied to the app bar, tool nav, viewer padding, zoom bar, FAB, dialog scrim,
  and the organizer (`styles.css:100, 144, 188, 232, 364`; `758`; `895, 918`).
  This is exactly what iOS HIG and Android edge-to-edge require, and many apps
  get it wrong.
- **Dark-mode elevation via surface tint, not just shadows.** The M3
  `surface-container-*` ramp lightens with elevation and is used for menus,
  dialogs, and sheets (`theme.css:123`) — matching both M3 and Apple's
  "elevated = lighter in dark" rule.
- **Breakpoint at 600 dp switches bottom bar → rail**, which aligns with the M3
  Compact→Medium transition (`styles.css:975`).
- **Navigation bar holds 5 items + FAB above it** — within the M3 "3–5
  destinations, FAB above the bar" rule (`App.tsx:45`, `styles.css:364`).
- **UI type scale is `rem`-based** (`theme.css:143`), so it responds to the
  browser/OS base font size — the web equivalent of honoring Dynamic Type
  (undercut only by the zoom lock, finding P-2).

---

## Platform findings summary

| # | Finding | Standard | Platform | Criticality | Complexity |
| --- | --- | --- | --- | --- | --- |
| P-1 | Owning all touch gestures fights system gestures (edge-back, home swipe) | HIG Gestures; Android back | iOS + Android | 🟠 High | Medium |
| P-2 | Zoom lock blocks Dynamic Type / system zoom | HIG Dynamic Type; M3 a11y | iOS + Android | 🟠 High | Low |
| P-3 | Modals ignore the platform Back affordance | HIG; Android predictive back | iOS + Android | 🟠 High | Medium |
| M-1 | Targets below 48 dp (Material) / 44 pt (Apple) | M3 48dp / HIG 44pt | iOS + Android | 🟠 High | Low |
| P-4 | One-finger pan has no native momentum/rubber-band | HIG/Material "feel"; Jakob | iOS + Android | 🟡 Medium | Medium |
| M-2 | No Expanded (≥840 dp) layout; rail never becomes a drawer | M3 size classes | Android tablet/desktop | 🟡 Medium | Medium |
| M-3 | Rail is ~66px (< 80 dp) and semantically a toolbar, not nav | M3 nav rail | Android medium | ⚪ Low | Low |
| i-1 | Double-tap-to-zoom collides with VoiceOver/Safari gestures | HIG accessibility | iOS | ⚪ Low | Low |

---

## Details

### 🟠 P-1 — App-owned gestures collide with OS system gestures
**Standard:** HIG "gestures supplement, not replace"; system gestures win.
**Platforms:** iOS + Android.

`.viewer__scroll` sets `touch-action: none` and the app implements its own
one-finger pan, pinch, and double-tap (`styles.css:187`, `useViewport.ts:133`).
On phones this overlaps the OS gesture zones:

- **iOS left-edge swipe = Safari back.** A pan begun near the left edge either
  triggers a browser back — which, with no unload guard (Part 1, #3), *destroys
  all edits* — or is swallowed, confusing the user.
- **Home-indicator / control-center swipe** shares the bottom edge where the nav
  bar, FAB, and zoom bar live. Safe-area padding helps, but the app still places
  its most-used controls in the OS's reserved bottom band.

- **Fix:** don't blanket `touch-action: none` — use `touch-action: pan-x pan-y`
  and only suppress the browser default during an *active* multi-touch/draw
  gesture; keep a visible scroll affordance; ensure left-edge drags aren't
  captured as pans. Pair with the P-3 history guard so an accidental back is
  recoverable.
- **Complexity:** Medium.

---

### 🟠 P-2 — Zoom lock defeats Dynamic Type and system zoom
**Standard:** HIG Dynamic Type; M3 accessibility.
**Platforms:** iOS + Android.

This is finding **#2** from Part 1 seen through the platform lens.
`user-scalable=no, maximum-scale=1.0` (`index.html:7`) contradicts both
platforms' core accessibility promise: iOS users who raise their text size or
pinch-zoom Safari, and Android users who enable font scaling / magnification,
are all denied. The `rem`-based type scale that *would* have honored their
settings is neutralized by the lock.

- **Fix:** remove the scale lock (see #2); the scoped `touch-action` from P-1
  keeps canvas gestures working without it.
- **Complexity:** Low.

---

### 🟠 P-3 — Modal surfaces don't integrate with the platform Back gesture
**Standard:** Android predictive back; iOS dismissal conventions.
**Platforms:** iOS + Android.

Dialogs, the organizer, the overflow menu, and the mobile properties sheet are
pure React state with **no browser history entry**. So the Android **back
gesture/button** and iOS back don't *dismiss* them — they navigate the whole
tab away (again risking total data loss). Users on both platforms expect Back to
close the top-most transient surface first.

- **Fix:** `history.pushState` when a modal/sheet/organizer opens and close it on
  `popstate`; only let Back leave the app when nothing is open. This also gives
  Escape-key parity (Part 1, #5) a natural home.
- **Complexity:** Medium.

---

### 🟠 M-1 — Touch targets miss both platforms' minimums
**Standard:** Material **48×48 dp**; Apple **44×44 pt**.
**Platforms:** iOS + Android.

Part 1, #7 flagged this against WCAG; against the platform specs it is a
definite fail on **both**: `.icon-btn` 40px < 44pt < 48dp (`styles.css:29`),
`.btn` 38px tall (`styles.css:63`), and the 22px saved-signature delete
(`styles.css:806`). Material's own components would never ship at 40dp, so the
app reads as sub-spec on Android in particular.

- **Fix:** 48px hit areas on Android-class targets (visual size can stay smaller
  via transparent padding); never below 44px anywhere. See #7.
- **Complexity:** Low.

---

### 🟡 P-4 — One-finger panning has no native momentum or rubber-band
**Standard:** platform "feel"; Jakob's Law (match native behavior).
**Platforms:** iOS + Android.

Because `touch-action: none` disables native scrolling and pan is applied by
directly mutating `scrollLeft/scrollTop` each move (`useViewport.ts:143`), a
flick just stops dead on release — no inertial glide, no edge bounce. Both
platforms' users are deeply accustomed to momentum scrolling; its absence makes
the single most-used gesture feel subtly broken and "webby."

- **Fix:** prefer native scrolling (P-1's scoped `touch-action`) so the platform
  supplies momentum; if custom pan is retained, add a velocity-based inertial
  animation on release.
- **Complexity:** Medium.

---

### 🟡 M-2 — No Expanded (≥ 840 dp) layout; the rail never becomes a drawer
**Standard:** M3 window size classes.
**Platforms:** Android tablet, ChromeOS, desktop.

The one `min-width: 600px` rule (`styles.css:975`) serves Medium and Expanded
identically. M3 defines a distinct **Expanded ≥ 840 dp** class that should adopt
a navigation drawer and/or two-pane canonical layouts and cap content width.
This is Part 1, #9 stated against the official threshold: today a 1280 dp
tablet/desktop gets the same 66px rail as a 600 dp phone-in-landscape.

- **Fix:** add an `@media (min-width: 840px)` (≈Expanded) tier — wider labeled
  navigation, a persistent properties pane, and a page-column max-width / two-up
  spread. See #9, #16.
- **Complexity:** Medium.

---

### ⚪ M-3 — The rail is under-width and semantically a toolbar
**Standard:** M3 navigation rail (~80 dp) and navigation semantics.
**Platforms:** Android medium.

The rail is 66px (`styles.css:983`) versus M3's ~80 dp, and it hosts *tools*
(Select/Text/Draw/Sign/Redact) styled as an M3 **navigation** bar/rail —
components meant for **top-level destinations**, not mode switches. It reads
convincingly, but strict M3 would model tool selection as a toolbar / segmented
control and reserve nav components for navigation.

- **Fix:** widen to 80 dp, or re-label the pattern as a tool rail and drop the
  nav-indicator semantics; low urgency since the adaptation is intuitive.
- **Complexity:** Low.

---

### ⚪ i-1 — Double-tap-to-zoom overlaps iOS assistive gestures
**Standard:** HIG accessibility / gestures.
**Platforms:** iOS.

The canvas double-tap toggles fit⇄2× (`useViewport.ts:173`). On iOS, double-tap
is also VoiceOver's "activate" gesture and (absent the zoom lock) Safari's
smart-zoom. For VoiceOver users interacting with the page, the app's meaning can
compete with the assistive one.

- **Fix:** gate the custom double-tap when an assistive service is likely active,
  and always provide the same action via the visible zoom controls (already
  present) so the gesture is a supplement, not the only path.
- **Complexity:** Low.

---

# Part 3 — Shell review (2026-08-18)

**Scope:** the chrome around the document — app bar, page rail, Inspector,
overflow menu, tooltips, icon set. **Method:** the app driven in a real browser
at 360 / 390 / 1280 / 1440px in both themes, with the *rendered geometry*
measured rather than the source read. Every finding below passed type-checking,
passed the existing 40-spec suite, and is plainly visible in a screenshot — which
is the point: these are placement, identity and naming faults, and none of them
looks like a bug in the code that causes it.

## S-1 — The primary action was the only thing the app bar could sacrifice

**Severity:** High. **Standard:** WCAG 2.5.8, Apple 44pt, Material 48dp.

Eight controls at 44–48px cannot fit a 390px app bar. Every `.icon-btn` carried
`flex: none`; the filled **Download** button did not — so *all* of the overflow
came out of the one control that mattered most. Measured at 390px: a 15×37px
sliver of a pill, still clickable, no longer readable as a button, and well under
every touch minimum in the guidelines this project already follows.

**Fixed** by sizing the row to its contents rather than letting it eat itself: the
theme control moved into the overflow menu (below), and `.appbar__download` got
`flex: none` so it can never be the thing that gives. `tests/shell.spec.ts`
measures `scrollWidth`, the last control's right edge, and the Download button's
box at 360/390/430px — adding a ninth control fails the 360px case.

## S-2 — The theme toggle sat in the app bar, after the overflow menu

**Severity:** Low (but it paid for S-1). **Standard:** Material top-app-bar
guidance; overflow is conventionally last.

A once-in-a-while preference held permanent space in the most valuable strip of
the UI, at the same visual weight as the document actions, and *to the right of*
the ⋯ button — so the control that is by convention last no longer was. **Fixed:**
it's a row in the overflow menu beside the other preferences, showing its current
value ("Theme · Dark"). It stays in the bar on the start screen, which has no menu.

## S-3 — The overflow menu clipped its last group with no way to scroll

**Severity:** High — two actions were unreachable. The menu is taller than an
820–900px window and had no `max-height`, so **Open another PDF** and **Close
document** were painted past the bottom edge. **Fixed:** `max-height` plus
`overflow-y: auto`. Half its labels also wrapped to two lines at `min-width:
200px`, turning a scannable list into uneven blocks; widened to 268px with
`nowrap`. The spec asserts the menu ends inside the window, the last item can be
reached, and every row is one line tall.

## S-4 — The Inspector changed identity without saying so

**Severity:** High. **Standard:** Nielsen #1 (visibility of system status), #6
(recognition over recall).

One panel did two unrelated jobs — a list of document/finishing commands, and the
properties of the selection — and swapped between them on selection with nothing
anywhere to indicate it had. Clicking the page made **Compress PDF**,
**Watermark** and **OCR** vanish, and there was no way back to them without
deselecting first. The collapsed edge tab hinted at the state with a word set
sideways in `writing-mode: vertical-rl`.

**Fixed:** two labelled tabs, **Document** and **Properties**, with the standard
ARIA tabs pattern and roving arrow-key focus. Selecting something still moves to
Properties — that is what the click asked for — but the switch is now visible and
reversible. Deselecting deliberately does *not* switch back, so the panel can't
flip on a stray click into empty space. The collapsed tab is icon-only.

Two things fell out of this: `PropertiesPanel`'s "nothing selected" copy had been
**unreachable since it was written** (with nothing selected the panel showed the
document list instead, so the text explaining how to get properties only appeared
once you no longer needed it), and the collapse control stopped floating
`position: absolute` over the panel's own heading.

## S-5 — One glyph, several meanings; one name, no glyph

**Severity:** Medium. **Standard:** Nielsen #4 (consistency and standards).

The icon map reused pictures across unrelated — sometimes opposite — actions:

| Glyph | Stood for |
| --- | --- |
| `RotateCw` | rotate a page · restore a session · save a session · reset a text style |
| `Shrink` | compress the file · **and** the switch that turns compression off |
| `Download` | the exported PDF · a .txt sidecar |
| `Image` | import one image · export every page as images |
| `Signature` | the draw-a-signature tool · sign with an X.509 certificate |
| `Minus` | the line tool · zoom out / decrease |

Metaphors were loose in the same places: a hashtag for **Page numbers** (mapped
under the key `tag`), a water droplet for **Watermark**, stacked layers for
**Organize pages**. `SelectionBar` used a `Type` glyph for *Edit* and a pencil for
*Style* — the two exactly the wrong way round.

And `name="sliders"` was never a key in the map, so the Inspector's collapsed tab
rendered `Icon`'s silent `Square` fallback: a blank box where its settings glyph
belonged. The `filled` prop had the same shape of fault — declared in `Props`,
passed by the tool dock as `filled={tool === t.key}`, and never destructured, so
it did nothing at all.

**Fixed:** every meaning has its own key and its own glyph; keys are named for
what they mean rather than which picture they are; the dead `filled` prop is gone
(the active tool is already stated by the dock's background and `aria-pressed`).
`tests/icons.spec.ts` fails if any `name=` in `src/` isn't mapped, and if any
mapped name is never used. The command palette's hand-written second copy of the
tool list — which had drifted to icon names the dock no longer used — now derives
from `TOOLS`.

## S-6 — The page rail spent its width on everything except the page

**Severity:** Medium. **Standard:** Gestalt proximity.

Of 156px, ~34 went to a stacked page number and a hairline frame, leaving a
thumbnail barely over 100px. The number sat *below* the thumbnail it belonged to
— nearer the next page than its own — and the document's page count appeared
nowhere in the UI, so "how long is this?" meant scrolling the rail to its end.
The rail's heading shouted `PAGES` in tracked-out uppercase micro-type while the
panel opposite said "Document" in title case: two headings of equal rank, styled
as if they were different things.

**Fixed:** 176px of which nearly all is preview, the number as a chip on the
thumbnail (one visual object, not two stacked), the count in the header, sentence
case at the same type level as the Inspector's tabs, and an active-page *ring*
rather than a border, so the list doesn't reflow as the active page changes. The
accessible name carries what the chip shows: "Page 3 of 12 (current)".

## S-7 — Tooltips were never clamped to the viewport

**Severity:** Medium. The bubble is centred on its anchor with
`translate(-50%)` and had no bound, so any control near an edge got a tooltip
drawn half outside the window — the collapsed Inspector tab sits *at* the right
edge, and on a phone so does the ⋯ button. `white-space: nowrap` with no
`max-width` also meant the sentence-long tips (the lossless-raster explanation)
ran off the side as one line. **Fixed:** measured in a layout effect and clamped
before paint, with a `max-width` so long tips wrap instead.

Separately, the page-rail toggle was named **"Toggle page thumbnails"** — which
leaves the current state to be guessed — and tipped **"Pages"**, the same word as
the heading of the rail it opens, which it then covered. Both now state the
outcome: *Show pages* / *Hide pages*.

## S-8 — Dead code the stylesheet still described

`.toolnav` (40 lines, plus a `@media` override) and `.fab` (20 lines) styled two
components that no longer exist — a bottom navigation bar and a mobile FAB, both
replaced by the tool dock. Removed. Also removed: `1 page(s) · 300 text
fragments`, which is a placeholder for copy rather than copy, wherever it
appeared.

## Not changed, and why

- **The document actions appear in both the Document tab and the ⋯ menu.** With
  the two now sharing one taxonomy — same groups, same order, same names, same
  icons — this is an ordinary primary/secondary pair rather than a contradiction.
  Removing them from the menu would leave phones, where the panel is a
  selection-driven sheet and the command palette needs a keyboard, with no way to
  reach them at all.
- **The tool dock and zoom pill still float over the page.** Documented
  trade-offs with their reasoning at the CSS; the alternative placements were
  tried and collide with each other (see `tests/phone.spec.ts`).
- **Pages stay white in dark mode** unless *Dim pages* is on. Fidelity to the
  file is the default on purpose; finding #15 in Part 1 is the standing item.

---

## Updated sequencing (Part 1 + Part 2)

- **Quick wins:** P-2/#2 (zoom lock), M-1/#7 (targets), plus the Part 1 trivials
  (#1 focus, #3 unload guard, #8 live regions).
- **Platform-integration batch:** P-1 (scoped `touch-action`), P-3 (history-based
  back/Escape for modals), P-4 (native/inertial scrolling) — these three are
  interrelated and best done together.
- **Adaptive-layout batch:** M-2/#9 Expanded tier, #16 persistent pane, M-3 rail.
- **Larger:** #4 full keyboard editing, #15 dark-page view, i-1 assistive-gesture
  gating.

## Sources

- Material 3 — [Breakpoints](https://m3.material.io/foundations/layout/breakpoints/overview),
  [Window size classes](https://m3.material.io/foundations/layout/applying-layout/window-size-classes),
  [Color & contrast](https://m3.material.io/foundations/designing/color-contrast),
  [Navigation bar](https://m3.material.io/components/navigation-bar/guidelines),
  [Navigation rail](https://m3.material.io/components/navigation-rail/guidelines),
  [FAB](https://m3.material.io/components/floating-action-button/guidelines)
- Android — [Accessibility (touch targets)](https://developer.android.com/design/ui/mobile/guides/foundations/accessibility),
  [Use window size classes](https://developer.android.com/develop/adaptive-apps/guides/use-window-size-classes)
- Apple HIG — [Layout](https://developer.apple.com/design/human-interface-guidelines/layout),
  [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility),
  [Gestures](https://developer.apple.com/design/human-interface-guidelines/inputs/touchscreen-gestures/),
  [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)
