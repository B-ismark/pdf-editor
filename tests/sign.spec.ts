import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import forge from "node-forge";
import { fixtures } from "./fixtures";
import { open, pageTexts, watch } from "./helpers";

/**
 * "Sign with certificate" produces a signature a validator accepts.
 *
 * Nothing checked this end to end, which mattered the day the PDF engine was
 * swapped for its maintained fork: the signing library imports the engine
 * itself, and objects from two copies of it can't be mixed in one document.
 * So this verifies the bytes the user gets, the way a reader would: the
 * /ByteRange covers the whole file except the signature, the PKCS#7 digest
 * matches those bytes, and the signature over it checks out against the
 * certificate it carries.
 */
test("a certificate signature verifies against the downloaded bytes", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);

  await page.locator('[aria-label="Export options"]').click();
  await page.locator(".menu__item", { hasText: "Sign with certificate" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign document" });
  await dialog.getByPlaceholder("e.g. Ada Lovelace").fill("Test Signer");
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    dialog.getByRole("button", { name: "Sign & download" }).click(),
  ]);
  const bytes = readFileSync((await dl.path())!);
  const text = bytes.toString("latin1");

  // The byte range: everything but the /Contents hex string, to the last byte.
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  expect(m).not.toBeNull();
  const [a, b, c, d] = m!.slice(1).map(Number);
  expect(a).toBe(0);
  expect(c + d).toBe(bytes.length);
  const gap = text.slice(b, c);
  expect(gap).toMatch(/^<[0-9a-fA-F]+>$/);
  const signed = Buffer.concat([bytes.subarray(a, a + b), bytes.subarray(c, c + d)]);

  // The PKCS#7 signature (the slot is zero-padded past it): its digest is of exactly those bytes, and the
  // signature over the signed attributes verifies with the embedded cert.
  const der = Buffer.from(gap.slice(1, -1), "hex").toString("binary");
  const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der, { parseAllBytes: false })) as forge.pkcs7.PkcsSignedData & {
    rawCapture: { authenticatedAttributes: forge.asn1.Asn1[]; signature: string; digestAlgorithm: string };
  };
  const cert = p7.certificates[0];
  expect(cert.subject.getField("CN").value).toBe("Test Signer");
  const attrs = p7.rawCapture.authenticatedAttributes;
  const digestAttr = attrs.find(
    (attr) => forge.asn1.derToOid((attr.value as forge.asn1.Asn1[])[0].value as string) === forge.pki.oids.messageDigest,
  )!;
  const claimed = ((digestAttr.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as string;
  const actual = forge.md.sha256.create().update(signed.toString("binary")).digest().getBytes();
  expect(Buffer.from(claimed, "binary").toString("hex")).toBe(Buffer.from(actual, "binary").toString("hex"));

  const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
  const attrDigest = forge.md.sha256.create().update(forge.asn1.toDer(set).getBytes()).digest().getBytes();
  const ok = (cert.publicKey as forge.pki.rsa.PublicKey).verify(attrDigest, p7.rawCapture.signature);
  expect(ok).toBe(true);

  // And it's still the document.
  const [p1] = await pageTexts(bytes, [1]);
  expect(p1.length).toBeGreaterThan(0);
  expect(w.errors).toEqual([]);
});
