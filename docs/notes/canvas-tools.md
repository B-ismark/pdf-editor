# Canvas tools: drawing, annotations, selection and marks

_Read before touching the Draw tool, `AnnotationLayer`, stacking order, multi-select, tick/cross marks (`pdf/marks.ts`), or touch gestures (`useDrag.ts`)._

Moved verbatim from `CLAUDE.md`; the index there links here.

## Gotchas

- **The draw sub-toolbar is a disclosure, and the annotation layer is two halves.**
  Two things about the Draw tool that aren't in the types. First: 60px of chrome
  across the bottom of the page had nothing left to say once you'd picked what to
  draw with, and no way to dismiss it without leaving the tool — so picking a
  sub-tool collapses it to a handle naming that sub-tool, the dock's Draw button
  toggles it, and `aria-expanded` tracks *the disclosure* rather than the tool.
  `aria-controls` is only set while `#drawbar` is mounted, the same rule the page
  rail follows. Second: `AnnotationLayer` renders twice per page, `variant="shapes"`
  under the text overlay and `variant="hits"` above it. The invisible text overlay
  took every click, so a pen line across a paragraph could not be selected,
  recoloured, moved or restacked — and a stroke over text is the only kind anyone
  draws. Only *stroke*-shaped hit targets move above: they're the width of the ink
  the user drew, so a click on one means that ink, whereas a box target is mostly
  empty space and a highlight over a paragraph would blanket the text and make the
  document uneditable underneath. Both halves read the same array in the same
  order, so nothing about stacking changes. If you add a kind, put its *visible*
  parts in `shapes` and give it a hit target in exactly one half.

- **Stacking order is the annotations array, in both directions.**
  `AnnotationLayer` maps the array to SVG in order and `exporter.ts` walks it with
  `for (const a of annots)`, so one array decides the preview *and* the file and
  they can't disagree — which is what makes `reorderAnnotations` (`overlays.ts`)
  the whole of bring-to-front. Deliberately annotations only: the exporter's layers
  are fixed (edits → text boxes → annotations → stamps → whiteout covers), so
  there is no order in which a stroke sits above a signature, and offering the
  control per-kind would promise one. Surfaced in the Inspector, the
  multi-select bar, and `]` / `[` — but not for a *sticky note*: a note is an
  HTML element rendered after the SVG, so it is above every shape whatever the
  array says, and both export paths now order through `annotationPaintOrder`
  (notes last) so the file agrees. Before that, a shape drawn after a note
  covered it in the export and not on screen.

- **A multi-selection is dragged by its own highlights.** `.multisel` used to be
  inert decoration, so a group could be aligned and distributed but not *moved* —
  dragging a member selected it instead and dropped the selection. The highlights
  render above the objects they outline, which makes them the natural drag surface
  for the whole group: one `startPointerDrag`, incremental deltas through
  `applyOverlayDeltas` under one coalescing key (one undo step for the gesture).
  Because they cover their objects they must also hand a *click* back through as
  "select just this one", or a group becomes a trap. Note the marquee is
  mouse-only by design (a touch drag pans the page), so this is a pointer-only
  path today.

- **Tick and cross are placed by a tap, and their geometry lives in one place.**
  Every other draw sub-tool needs a drag, but a form checkbox is smaller than
  `MIN_DRAG`, so requiring a drag would make a thirty-field form thirty drags: a
  click drops a `DEFAULT_MARK_SIZE` mark, a drag sizes it. The glyphs are drawn
  three times over — the SVG overlay, the pdf-lib vector export, and the canvas
  that rasterises a redacted page — so they are defined once as unit polylines
  in `pdf/marks.ts` and each path maps the same numbers into its own space. A
  second copy is a preview that lies about the file. Both kinds are
  box-shaped, which is what earns them the existing selection frame, marquee
  hit-testing and rotation for free; the set of box kinds is `isBoxAnnotation`
  in `pdf/types.ts`, and a new box kind that isn't added there renders fine and
  silently loses its resize handles.
  **Rotation is applied in the pdf-lib path and *not* in the raster path.**
  `rect` and `highlight` hand their angle to a pdf-lib primitive; a polyline has
  none, so `markPolylines` takes the rotation and turns the points itself. The
  redaction canvas, by contrast, is already translated and rotated about the box
  centre before the branch runs — the same setup every box kind shares — so
  passing the angle there too rotates it twice. Shipping without the pdf-lib
  half was invisible in every existing test: the overlay tilted the tick and the
  file carried a level one.
  **What a mark can't show you, the UI has to say.** The gesture hint is the only
  thing that distinguishes a tapped tool from seven dragged ones, and it shipped
  *covered by the status snackbar* — which sat at `bottom: 88px` against a toolbar
  at `bottom: 76px`, so the explanation was hidden at exactly the moment a new
  document opened. The snackbar clears the whole bottom cluster now (dock 16+56,
  drawbar 76+60), the hint travels onto the collapsed handle (where it finally
  fits on a phone), and a ghost mark of `DEFAULT_MARK_SIZE` follows the cursor so
  the size a tap commits to is visible before it is committed. The ghost is drawn
  from `MARK_PATHS` like every other path — and its `<svg>` is deliberately *not*
  `.annot-svg`, because that class means "the annotation layer" and the specs
  count its shapes.
- **Touch = select-first.** `hooks/useDrag.ts` exports `tapSelect` and
  `startElementGesture`: on touch, an *unselected* element only selects on a
  clean tap and lets the page pan under a drag; once selected it drags. Reuse
  these for any new draggable/selectable overlay. Stamps have no properties
  sheet — they're edited directly on the canvas (drag/resize handle/delete
  badge).
- **Placing an image or signature** goes through `.placelayer`, a layer
  `PageView` mounts above every overlay while `placing` is set. It has to sit
  on top: a signature line is almost always next to text, and a click that
  reached the fragment selected it instead of placing (the bug this replaced).
  The ghost and the drop both come from `pdf/placement.ts` (`placedSize`,
  `placeAt`), centred on the pointer and clamped to the page, so the preview
  can't promise a spot the click then misses. A pointer places on a primary
  press (right/middle clicks don't place); a finger places on lift, only if it
  didn't travel and no second finger joined. The layer must **not** stop touch
  events: the viewer pans and pinches in JS on `.viewer__scroll`
  (`touch-action: none`), so swallowing them pins you to the page that was on
  screen when you armed the stamp. Esc cancels.
- **The page edge is the file's edge.** The exported page cuts off anything
  past its MediaBox, so the overlay matches it:
  - stamps can't be dragged off (`keepStampOnPage` in `DocumentEditor`: a move stops at
    the edge; a resize or rotation that would *grow* it off is refused, one
    that shrinks it always goes through). The bulk paths don't go through
    `onChangeStamp`, so they have their own guards: paste/duplicate and
    align/distribute pull each stamp back (`keepStampsOnPage`), and a group
    move is shortened so the whole group stops when its first stamp reaches
    the edge (`limitGroupMove`) instead of shearing apart. Known limit: the
    clamp uses the page *as displayed* (`viewBox`), which is right for
    unrotated pages; a non-square `/Rotate`d page may still clip a stamp;
  - text boxes stop at the edge when dragged (`TextBoxItem`);
  - typed text that runs past (an edit or a text box) can't be stopped, so
    it's marked with a wavy rule (`.is-spill`, set by `PageView`'s spill
    effect, re-run when the document's real fonts arrive) and the snackbar
    says it once.
  `.page__overlay` clips at 16px past the edge (`overflow-clip-margin`), so
  handles on an object at the edge stay grabbable but spilled text can't widen
  the scroll surface. Anything new that draws outside the page inside the
  overlay will be clipped there — the phone's "done" tick moves above the
  text's end when it wouldn't fit, for that reason.
- **The page is one Tab stop.** Each page's fragments use a roving tabindex
  (the stop is the fragment you last left, else the first). Up/Down move
  between fragments, across pages; Left/Right do too once the caret is at the
  start/end, or always when the fragment isn't editable (a phone outside edit
  mode), so they never fall through to the editor's nudge. If the fragment you leave
  is selected, the selection moves with you. A "Skip to tools" button is the
  first Tab stop and lands on the active tool. Don't give a new
  per-fragment control its own tab stop.
