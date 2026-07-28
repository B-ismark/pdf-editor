/** A decoded image ready to be placed on a page as a stamp. */
export interface PreparedStamp {
  /** PNG or JPEG data URL — the two formats `pdf-lib` can embed. */
  dataUrl: string;
  w: number;
  h: number;
}

/**
 * Longest edge, in pixels, that we keep for a placed image.
 *
 * A phone camera photo is routinely 4000+ px wide. Embedded at full resolution
 * it lands in the PDF as tens of megabytes for something displayed a couple of
 * inches across, and it has to be held in memory as a data URL for the whole
 * session on top of that. 2000px still exceeds 300 dpi at any size a stamp is
 * actually placed at, so downscaling past it costs nothing visible.
 */
const MAX_EDGE = 2000;

/** Refuse absurd inputs before decoding rather than after — a 100 MP image
 * would be allocated in full first, which is exactly the failure to avoid. */
const MAX_BYTES = 40 * 1024 * 1024;

/**
 * Read a user-chosen image file into an embeddable stamp.
 *
 * Handles the three things the previous inline version didn't: it verifies the
 * file really is a decodable image, it converts formats `pdf-lib` can't embed
 * (WebP, AVIF, anything else the browser can decode) into PNG, and it caps the
 * resolution so a camera photo doesn't dominate the exported file.
 *
 * Rejects with a user-facing message.
 */
export async function prepareImageStamp(file: File): Promise<PreparedStamp> {
  if (file.size > MAX_BYTES) {
    throw new Error(
      `That image is ${Math.round(file.size / 1e6)} MB — too large to place. Try one under ${MAX_BYTES / 1e6} MB.`,
    );
  }

  const objectUrl = URL.createObjectURL(file);
  let img: HTMLImageElement;
  try {
    img = await loadImage(objectUrl);
  } catch {
    throw new Error(
      `"${file.name}" isn't an image this browser can read. Try a PNG or JPEG.`,
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const { naturalWidth: w0, naturalHeight: h0 } = img;
  if (!w0 || !h0) throw new Error("That image appears to be empty.");

  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const isEmbeddable = file.type === "image/png" || file.type === "image/jpeg";

  // Already small enough and in an embeddable format — keep the original bytes
  // rather than re-encoding (which would only lose quality and grow PNGs).
  if (scale === 1 && isEmbeddable) {
    return { dataUrl: await readAsDataUrl(file), w: w0, h: h0 };
  }

  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't process that image.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);

  // JPEG for photos (much smaller), PNG when transparency could matter.
  const asJpeg = file.type === "image/jpeg";
  const dataUrl = asJpeg
    ? canvas.toDataURL("image/jpeg", 0.9)
    : canvas.toDataURL("image/png");
  return { dataUrl, w, h };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode failed"));
    img.src = src;
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
