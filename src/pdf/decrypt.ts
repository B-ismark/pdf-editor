/**
 * Unlocking an encrypted PDF, once, at open.
 *
 * pdf.js can *show* an encrypted file, but pdf-lib — which writes every
 * download — can't read one: it saves the still-encrypted streams under a
 * trailer that no longer says how to decrypt them. Even a file with only an
 * *owner* password (opens without asking, carries "no printing"-style flags)
 * downloaded as a broken PDF. So the bytes are decrypted here, once, and
 * everything downstream (render, fonts, export, autosave) sees a plain PDF and
 * never needs the password.
 *
 * `@cantoo/pdf-lib` (a maintained pdf-lib fork with RC4/AES support) is
 * imported only from here and only when a file looks encrypted, so it is its
 * own lazy chunk and never touches the render path.
 */

/** The outcome of one unlock attempt. */
export type Unlock =
  | { kind: "plain"; bytes: ArrayBuffer }
  /** Decrypted. `password` says whether it took one to open (a user password),
   * as opposed to an owner-only lock anyone could open. */
  | { kind: "unlocked"; bytes: ArrayBuffer; password: boolean }
  | { kind: "needs-password" }
  /** Encrypted in a way the decrypter couldn't handle; the caller falls back to
   * opening the original bytes and lets pdf.js report what it can. */
  | { kind: "failed" };

export async function unlockPdf(bytes: ArrayBuffer, password: string): Promise<Unlock> {
  const lib = await import("@cantoo/pdf-lib");
  let doc: import("@cantoo/pdf-lib").PDFDocument;
  try {
    doc = await lib.PDFDocument.load(new Uint8Array(bytes.slice(0)), {
      password,
      updateMetadata: false,
    });
  } catch (err) {
    return /password/i.test(String(err)) ? { kind: "needs-password" } : { kind: "failed" };
  }
  // Not `doc.isEncrypted` or the trailer's /Encrypt: the loader drops both
  // once it has decrypted, and leaves this flag instead.
  if (!doc.context.isDecrypted) return { kind: "plain", bytes };

  // The decrypted document still holds the old encryption dictionary, the old
  // object streams and the old xref stream as unreferenced objects; written
  // out, they'd be dead weight carrying the encryption parameters into a file
  // that has none. Keep only what the document can reach.
  //
  // Walked with an explicit stack, not recursion: outline /Next chains and
  // page-to-page links run thousands deep, and a recursive walk overflowed
  // the stack on them. Anything that still throws lands as "failed".
  let out: Uint8Array;
  try {
    const { PDFRef, PDFDict, PDFArray, PDFStream } = lib;
    const ctx = doc.context;
    const seen = new Set<string>();
    const stack: unknown[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info];
    while (stack.length) {
      const o = stack.pop();
      if (o instanceof PDFRef) {
        const key = o.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        stack.push(ctx.lookup(o));
      } else if (o instanceof PDFDict) {
        for (const [, v] of o.entries()) stack.push(v);
      } else if (o instanceof PDFStream) {
        stack.push(o.dict);
      } else if (o instanceof PDFArray) {
        for (const v of o.asArray()) stack.push(v);
      }
    }
    for (const [ref] of ctx.enumerateIndirectObjects()) {
      if (!seen.has(ref.toString())) ctx.delete(ref);
    }
    ctx.trailerInfo.Encrypt = undefined;
    out = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
  } catch {
    return { kind: "failed" };
  }
  return {
    kind: "unlocked",
    bytes: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
    password: password !== "",
  };
}
