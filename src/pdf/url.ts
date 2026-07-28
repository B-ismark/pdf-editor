/**
 * URL safety for link annotations.
 *
 * A PDF `/URI` action is a live capability in the reader that opens the file:
 * several viewers (and every browser-based one) will happily act on
 * `javascript:`, `data:`, and `file:` URIs, which turns "add a link" into
 * "embed active content / probe the local filesystem" in the document the user
 * hands to someone else. So schemes are **allow-listed**, not block-listed, in
 * both places a URI can enter the output:
 *
 *  - what the user types into the Link tool (see `PropertiesPanel`), and
 *  - link annotations copied out of the *source* PDF (see `sanitize.ts`).
 */

/** Schemes we are willing to write into an exported document. */
const SAFE_SCHEMES = ["http:", "https:", "mailto:", "tel:"];

/** Control characters — used to smuggle a scheme past naive checks
 * (`java\0script:`, `java\tscript:`), so any occurrence rejects the input. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Normalise user input into a safe absolute URL, or `null` if it can't be.
 *
 * Bare input like `example.com/x` is treated as `https://example.com/x` — the
 * overwhelmingly common intent, and it keeps a scheme-less entry from silently
 * producing a dead link. Anything that resolves to a scheme outside
 * {@link SAFE_SCHEMES} is rejected rather than sanitised, because there is no
 * safe rewriting of `javascript:alert(1)`.
 */
export function safeLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (CONTROL_CHARS.test(trimmed)) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : // Protocol-relative (`//host/x`) and bare hosts both become https.
      `https://${trimmed.replace(/^\/\//, "")}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!SAFE_SCHEMES.includes(parsed.protocol.toLowerCase())) return null;
  return parsed.href;
}

/** True when `raw` is non-empty but can't be turned into a safe link — lets the
 * UI explain *why* a link won't be exported instead of dropping it silently. */
export function isRejectedUrl(raw: string): boolean {
  return raw.trim().length > 0 && safeLinkUrl(raw) === null;
}

/**
 * Scheme check for a URI that already exists in a source PDF. Unlike
 * {@link safeLinkUrl} this does *not* coerce or rewrite — a value already in the
 * file is either acceptable as-is or dropped. Relative references (no scheme)
 * pass: they resolve against the document, carry no active capability, and
 * rewriting them would break legitimate links.
 */
export function isSafeExistingUri(uri: string): boolean {
  const trimmed = uri.trim();
  if (!trimmed) return false;
  if (CONTROL_CHARS.test(trimmed)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!scheme) return true;
  return SAFE_SCHEMES.includes(`${scheme[1].toLowerCase()}:`);
}
