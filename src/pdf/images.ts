/**
 * Photos and scans as PDF pages: what's needed to tell an image from a PDF
 * (cheap, no pdf-lib — the start screen and the file picker use it) and the
 * JPEG metadata pass. The pdf-lib half is `imagesToPdf.ts`, loaded on demand.
 */

export type ImageKind = "jpeg" | "png";

/** What an image file is, from its first bytes — never from its name or MIME
 * type, which a renamed file gets wrong. */
export function sniffImage(head: ArrayBuffer | Uint8Array): ImageKind | null {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((v, i) => b[i] === v)) return "png";
  return null;
}

/** The file types the open and add pickers accept besides PDF. */
export const IMAGE_ACCEPT = "image/jpeg,image/png,.jpg,.jpeg,.png";

export interface CleanJpeg {
  /** The same picture with every metadata segment taken out. */
  bytes: Uint8Array;
  /** EXIF orientation, 1–8 (1 when there's none): how the camera meant the
   * stored pixels to be turned or mirrored to stand upright. */
  orientation: number;
}

/**
 * Take the metadata out of a JPEG without touching the picture. A phone photo
 * carries where it was taken (GPS), the camera and its serial number, the time,
 * often a thumbnail of the uncropped shot — in EXIF (APP1), XMP (APP1), IPTC /
 * Photoshop (APP13), maker notes and comments. pdf-lib embeds a JPEG's bytes
 * as they are, so all of that would ride along inside the PDF.
 *
 * Kept: APP0 (JFIF: pixel density, no personal data) and APP14 (Adobe: says
 * how to read the colour channels — without it a CMYK scan comes out
 * inverted). Everything else before the image data goes; the scan data after
 * SOS is copied byte for byte, so nothing is re-encoded.
 *
 * The EXIF orientation is read on the way through, since stripping it is
 * what makes the picture lie on its side: the page draws it upright instead.
 */
export function cleanJpeg(input: Uint8Array): CleanJpeg {
  const b = input;
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("Not a JPEG");
  const keep: Uint8Array[] = [b.subarray(0, 2)];
  let orientation = 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error("Damaged JPEG");
    const marker = b[i + 1];
    // Fill bytes between segments.
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Markers without a length (TEM, RSTn) don't belong here, but cost nothing.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      keep.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === 0xd9) break; // EOI before any image data
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) throw new Error("Damaged JPEG");
    const end = i + 2 + len;
    if (marker === 0xda) {
      // Start of scan: from here on it's the picture (and any later scans and
      // markers inside it), copied as is.
      keep.push(b.subarray(i));
      return { bytes: concat(keep), orientation };
    }
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(b.subarray(i + 4, end));
    const drop = (isApp && marker !== 0xe0 && marker !== 0xee) || marker === 0xfe;
    if (!drop) keep.push(b.subarray(i, end));
    i = end;
  }
  throw new Error("Damaged JPEG");
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The orientation tag (0x0112) from an APP1 payload, or 1. */
function exifOrientation(app1: Uint8Array): number {
  // "Exif\0\0", then a TIFF header.
  if (app1.length < 14 || String.fromCharCode(...app1.subarray(0, 4)) !== "Exif" || app1[4] !== 0 || app1[5] !== 0) return 1;
  const t = app1.subarray(6);
  const little = t[0] === 0x49 && t[1] === 0x49;
  if (!little && !(t[0] === 0x4d && t[1] === 0x4d)) return 1;
  const u16 = (o: number) => (o + 2 > t.length ? -1 : little ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const u32 = (o: number) =>
    o + 4 > t.length ? -1 : little ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0 : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0;
  const ifd = u32(4);
  const count = u16(ifd);
  if (ifd < 0 || count < 0) return 1;
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/**
 * Where the image's unit square goes on a `pw × ph` page so the picture
 * stands upright for each EXIF orientation: the `cm` matrix [a b c d e f].
 * Image space has (0,0) at the bottom-left of the *stored* picture, (0,1) at
 * its first row.
 */
export function orientMatrix(orientation: number, pw: number, ph: number): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2: return [-pw, 0, 0, ph, pw, 0]; // mirrored left–right
    case 3: return [-pw, 0, 0, -ph, pw, ph]; // upside down
    case 4: return [pw, 0, 0, -ph, 0, ph]; // mirrored top–bottom
    case 5: return [0, -ph, -pw, 0, pw, ph]; // transposed
    case 6: return [0, -ph, pw, 0, 0, ph]; // needs a quarter turn clockwise
    case 7: return [0, ph, pw, 0, 0, 0]; // transversed
    case 8: return [0, ph, -pw, 0, pw, 0]; // needs a quarter turn anticlockwise
    default: return [pw, 0, 0, ph, 0, 0];
  }
}

/** Orientations 5–8 stand the picture on its side: width and height swap. */
export function swapsSides(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

/**
 * Page size for a picture `w × h` pixels: the size it shows at on screen
 * (96 per inch), but never longer than an A4 page's long side — a 12-megapixel
 * phone photo would otherwise make a page over a metre wide.
 */
export function pageSizeFor(w: number, h: number): { width: number; height: number } {
  const A4_LONG = 842;
  const s = Math.min(0.75, A4_LONG / Math.max(w, h));
  return { width: Math.max(1, w * s), height: Math.max(1, h * s) };
}
