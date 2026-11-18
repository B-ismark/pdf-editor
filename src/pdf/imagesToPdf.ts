import {
  PDFDocument,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from "@cantoo/pdf-lib";
import { cleanJpeg, orientMatrix, pageSizeFor, sniffImage, swapsSides } from "./images";

/** One picture, its bytes as read from the file. */
export interface ImageInput {
  name: string;
  bytes: ArrayBuffer;
}

/** A picture this can't make a page of, by name — reported, not thrown. */
export class UnreadableImage extends Error {
  constructor(readonly fileName: string) {
    super(`"${fileName}" isn't a JPEG or PNG picture this can read.`);
  }
}

/**
 * A PDF with one page per picture, in the order given, each page the size of
 * its picture (`pageSizeFor`) and the picture filling it, upright.
 *
 * JPEGs go in as they are (no re-encoding, so no loss) once `cleanJpeg` has
 * taken their metadata out; PNGs are decoded and re-compressed by pdf-lib,
 * which carries over pixels only, never their text chunks. The document gets
 * no Info, no producer, no dates: nothing about where the pictures came from.
 */
export async function imagesToPdf(images: ImageInput[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const img of images) {
    const raw = new Uint8Array(img.bytes);
    const kind = sniffImage(raw);
    let embedded;
    let orientation = 1;
    try {
      if (kind === "jpeg") {
        const clean = cleanJpeg(raw);
        orientation = clean.orientation;
        embedded = await doc.embedJpg(clean.bytes);
      } else if (kind === "png") {
        embedded = await doc.embedPng(raw);
      }
    } catch {
      embedded = undefined;
    }
    if (!embedded) throw new UnreadableImage(img.name);
    const sideways = swapsSides(orientation);
    const { width, height } = pageSizeFor(
      sideways ? embedded.height : embedded.width,
      sideways ? embedded.width : embedded.height,
    );
    const page = doc.addPage([width, height]);
    const name = page.node.newXObject("Image", embedded.ref);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(...orientMatrix(orientation, width, height)),
      drawObject(name),
      popGraphicsState(),
    );
  }
  return doc.save();
}

/**
 * One empty page, `width × height` points — a blank page to insert. Its own
 * tiny document, so it joins a plan like any added file.
 */
export async function blankPage(width: number, height: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([width, height]);
  return doc.save();
}
