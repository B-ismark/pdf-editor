/**
 * Client-side digital signing (PAdES-style `adbe.pkcs7.detached`).
 *
 * Everything runs in the browser and offline — the private key never leaves the
 * device. Two ways to establish a signing identity:
 *   - upload an existing PKCS#12 (.p12/.pfx) certificate + passphrase, or
 *   - generate a self-signed identity on the spot (tamper-evidence without a
 *     CA-verified identity).
 *
 * The heavy crypto/signing libs (node-forge, @signpdf) are dynamically imported
 * so they stay out of the initial bundle, and `Buffer` is polyfilled locally
 * just before they load.
 */

export interface SignMeta {
  name?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
}

export type SignIdentity =
  | { kind: "p12"; data: Uint8Array; passphrase: string }
  | { kind: "self"; name: string; org?: string };

/** Thrown when a .p12 can't be opened (wrong passphrase / not a PKCS#12). */
export class BadCertificate extends Error {
  constructor(message = "Couldn't open that certificate — check the file and passphrase.") {
    super(message);
    this.name = "BadCertificate";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateSelfSignedP12(forge: any, name: string, org?: string): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 3650 * 864e5);
  const attrs = [
    { name: "commonName", value: name || "Self-signed" },
    { name: "organizationName", value: org || "PDF Editor" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const der = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "", { algorithm: "3des" })).getBytes();
  return Uint8Array.from(der as string, (c: string) => c.charCodeAt(0));
}

/**
 * Sign an already-finished PDF and return the signed bytes. The document must
 * be the final one — any later edit invalidates the signature.
 */
export async function signPdf(pdfBytes: ArrayBuffer, identity: SignIdentity, meta: SignMeta): Promise<Uint8Array> {
  // @signpdf works on Node Buffers; provide one (and `global`) in the browser
  // before loading it. Handle both ESM-interop shapes of the polyfill.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bufferMod: any = await import("buffer");
  const Buffer = bufferMod.Buffer ?? bufferMod.default?.Buffer ?? bufferMod.default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g.Buffer) g.Buffer = Buffer;
  if (!g.global) g.global = globalThis;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const forgeMod: any = await import("node-forge");
  const forge = forgeMod.default ?? forgeMod;
  const { PDFDocument } = await import("pdf-lib");
  const { pdflibAddPlaceholder } = await import("@signpdf/placeholder-pdf-lib");
  const { P12Signer } = await import("@signpdf/signer-p12");
  const { SignPdf } = await import("@signpdf/signpdf");

  let p12Bytes: Uint8Array;
  let passphrase: string;
  const metaOut: SignMeta = { ...meta };
  if (identity.kind === "p12") {
    p12Bytes = identity.data;
    passphrase = identity.passphrase;
    // Fail fast + clearly if the passphrase/file is wrong. Build the binary
    // string in chunks so a large .p12 can't overflow the call stack.
    try {
      let bin = "";
      for (let i = 0; i < p12Bytes.length; i += 8192) {
        bin += String.fromCharCode.apply(null, Array.from(p12Bytes.subarray(i, i + 8192)));
      }
      forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(bin)), passphrase);
    } catch {
      throw new BadCertificate();
    }
  } else {
    p12Bytes = generateSelfSignedP12(forge, identity.name, identity.org);
    passphrase = "";
    if (!metaOut.name) metaOut.name = identity.name;
  }

  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: metaOut.reason || "Signed",
    contactInfo: metaOut.contactInfo || "",
    name: metaOut.name || "",
    location: metaOut.location || "",
  });
  // Object streams OFF so the /Contents placeholder stays literal for @signpdf.
  const withPlaceholder = await doc.save({ useObjectStreams: false });
  const signer = new P12Signer(Buffer.from(p12Bytes), { passphrase });
  const signed = await new SignPdf().sign(Buffer.from(withPlaceholder), signer);
  return new Uint8Array(signed);
}
