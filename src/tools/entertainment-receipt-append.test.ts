import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  appendCoverToOriginal,
  classifyOriginal,
  countEmbeddedFiles,
  MAX_ORIGINAL_BYTES,
  runDryChecks,
  sha256Hex,
} from "./entertainment-receipt-append.js";
import { renderEntertainmentReceiptCover, computeAmounts } from "./entertainment-receipt-pdf.js";

// All fixtures are generated in code - no real receipt lives in the repo.

async function makePdf(options: { pages?: number; text?: string; attach?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Beispiel-Titel");
  doc.setAuthor("Beispiel-Autor");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (options.pages ?? 1); i++) {
    const page = doc.addPage([300, 300]);
    page.drawText(options.text ?? `Seite ${i + 1}`, { x: 20, y: 150, size: 12, font });
  }
  if (options.attach) {
    await doc.attach(Buffer.from('{"beispiel":true}'), "testdata.json", { mimeType: "application/json" });
  }
  return doc.save();
}

// Minimal valid 1x1 RGB PNG, built by hand.
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
function makePng(): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const idat = deflateSync(Buffer.from([0, 200, 30, 30])); // filter byte + one pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

// Widely used minimal 1x1 baseline JPEG.
const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
const makeJpeg = () => new Uint8Array(Buffer.from(JPEG_BASE64, "base64"));

async function makeCover(hash?: string): Promise<Uint8Array> {
  return renderEntertainmentReceiptCover(
    {
      date: "14.03.2026",
      location: "Beispiel-Restaurant, Musterstraße 1, 12345 Musterstadt",
      occasion: "Gespräch mit Netzwerkpartnern zur Planung einer gemeinsamen Veranstaltung",
      participants: [{ name: "Max Mustermann" }],
      hostName: "Max Mustermann",
      foodNet: 30,
      foodVat: 2.1,
      drinksNet: 10,
      drinksVat: 1.9,
      tip: 0,
    },
    computeAmounts({ foodNet: 30, foodVat: 2.1, drinksNet: 10, drinksVat: 1.9, tip: 0, kleinunternehmer: false }),
    { kleinunternehmer: false, attachmentPrecedes: true, originalSha256: hash }
  );
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text as string[];
}

describe("sha256Hex", () => {
  it("hashes the exact bytes", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("classifyOriginal", () => {
  it("recognises pdf, png and jpeg by magic bytes", async () => {
    expect(classifyOriginal(await makePdf())).toBe("pdf");
    expect(classifyOriginal(makePng())).toBe("png");
    expect(classifyOriginal(makeJpeg())).toBe("jpeg");
  });

  it("rejects unsupported types with a type hint", () => {
    expect(() => classifyOriginal(Buffer.from("nur Text"))).toThrow(/nicht unterstützt/);
    expect(() => classifyOriginal(Buffer.from("<?xml version='1.0'?><Invoice/>"))).toThrow(/XML/);
  });

  it("exposes a 15 MB limit", () => {
    expect(MAX_ORIGINAL_BYTES).toBe(15 * 1024 * 1024);
  });
});

describe("appendCoverToOriginal", () => {
  it("appends the cover as last page and keeps the embedded file (single-page pdf)", async () => {
    const original = await makePdf({ text: "Beispiel-Restaurant, Rechnung 000001, Gesamt 44,00", attach: true });
    const result = await appendCoverToOriginal(original, "pdf", await makeCover());
    expect(result.pagesBefore).toBe(1);
    expect(result.pagesAfter).toBe(2);
    const texts = await pageTexts(result.pdfBytes);
    expect(texts[0]).toContain("Rechnung 000001");
    expect(texts[1]).toContain("Bewirtungsangaben");
    expect(countEmbeddedFiles(await PDFDocument.load(result.pdfBytes))).toBe(1);
  });

  it("puts the cover after all pages of a multi-page original", async () => {
    const result = await appendCoverToOriginal(await makePdf({ pages: 3 }), "pdf", await makeCover());
    expect(result.pagesAfter).toBe(4);
    const texts = await pageTexts(result.pdfBytes);
    expect(texts[2]).toContain("Seite 3");
    expect(texts[3]).toContain("Bewirtungsangaben");
  });

  it("does not touch title and author of the original", async () => {
    const result = await appendCoverToOriginal(await makePdf(), "pdf", await makeCover());
    const doc = await PDFDocument.load(result.pdfBytes, { updateMetadata: false });
    expect(doc.getTitle()).toBe("Beispiel-Titel");
    expect(doc.getAuthor()).toBe("Beispiel-Autor");
  });

  it("embeds a jpeg original byte-for-byte as page 1", async () => {
    const jpeg = makeJpeg();
    const result = await appendCoverToOriginal(jpeg, "jpeg", await makeCover());
    expect(result.pagesBefore).toBe(1);
    expect(result.pagesAfter).toBe(2);
    const doc = await PDFDocument.load(result.pdfBytes);
    const streams = [...doc.context.enumerateIndirectObjects()]
      .map(([, obj]) => obj)
      .filter((obj): obj is PDFRawStream => obj instanceof PDFRawStream)
      .filter((s) => s.dict.get(PDFName.of("Subtype"))?.toString() === "/Image");
    expect(streams.some((s) => Buffer.from(s.contents).equals(Buffer.from(jpeg)))).toBe(true);
  });

  it("wraps a png original into page 1 and appends the cover", async () => {
    const result = await appendCoverToOriginal(makePng(), "png", await makeCover());
    expect(result.pagesAfter).toBe(2);
  });

  it("rejects an encrypted pdf", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: "Standard" }));
    const encrypted = await doc.save();
    await expect(appendCoverToOriginal(encrypted, "pdf", await makeCover())).rejects.toThrow(/verschlüsselt/);
  });

  it("rejects a truncated pdf", async () => {
    const original = await makePdf();
    await expect(
      appendCoverToOriginal(original.slice(0, Math.floor(original.length / 3)), "pdf", await makeCover())
    ).rejects.toThrow(/defekt|nicht gelesen/);
  });
});

describe("runDryChecks", () => {
  it("passes for a correct merge and reports text/attachment checks", async () => {
    const original = await makePdf({ attach: true });
    const merged = await appendCoverToOriginal(original, "pdf", await makeCover());
    const checks = await runDryChecks(original, "pdf", merged);
    expect(checks).toEqual({
      page_count_ok: true,
      text_contains_original_ok: true,
      text_contains_entertainment_ok: true,
      embedded_files_preserved: true,
    });
  });

  it("fails when the page count is off", async () => {
    const original = await makePdf({ pages: 2 });
    const merged = await appendCoverToOriginal(await makePdf({ pages: 1 }), "pdf", await makeCover());
    const checks = await runDryChecks(original, "pdf", merged);
    expect(checks.page_count_ok).toBe(false);
  });

  it("flags lost embedded files", async () => {
    const original = await makePdf({ attach: true });
    const merged = await appendCoverToOriginal(await makePdf({ attach: false }), "pdf", await makeCover());
    const checks = await runDryChecks(original, "pdf", merged);
    expect(checks.embedded_files_preserved).toBe(false);
  });

  it("reports null for the original-text check when the original is an image", async () => {
    const jpeg = makeJpeg();
    const merged = await appendCoverToOriginal(jpeg, "jpeg", await makeCover());
    const checks = await runDryChecks(jpeg, "jpeg", merged);
    expect(checks.text_contains_original_ok).toBeNull();
    expect(checks.page_count_ok).toBe(true);
  });
});

describe("hash footer", () => {
  it("prints the sha256 of the original bytes on the cover page", async () => {
    const original = await makePdf();
    const hash = sha256Hex(original);
    const merged = await appendCoverToOriginal(original, "pdf", await makeCover(hash));
    const texts = await pageTexts(merged.pdfBytes);
    expect(texts[1]).toContain(hash);
  });
});
