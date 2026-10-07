import { createHash } from "node:crypto";
import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PageSizes,
} from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";

// Upper bound for the original's decoded size. BuchhaltungsButler documents no
// file-size limit for /receipts/upload, so this is our own guard: a receipt
// is rewritten fully in memory and re-sent base64-encoded (+33 %), 15 MB keeps
// the request well below typical gateway limits and the process memory flat.
export const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024;

export type OriginalKind = "pdf" | "png" | "jpeg";

export interface DryChecks {
  page_count_ok: boolean;
  // null = not checkable (original has no text layer, e.g. an image/scan).
  text_contains_original_ok: boolean | null;
  text_contains_entertainment_ok: boolean;
  embedded_files_preserved: boolean;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

// Classifies by magic bytes, not by the file_type field BuchhaltungsButler
// reports - the bytes are what actually get parsed.
export function classifyOriginal(bytes: Uint8Array): OriginalKind {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  const head = Buffer.from(bytes.slice(0, 64)).toString("utf8").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<")) {
    throw new Error(
      "Dateityp XML (E-Rechnung) wird nicht unterstützt - das Original ist eine XML-Datei ohne Seiten, an die " +
        "eine Bewirtungsangaben-Seite angehängt werden kann. Es wurde nichts hochgeladen."
    );
  }
  throw new Error(
    "Dateityp nicht unterstützt - erwartet werden PDF, JPEG oder PNG. Es wurde nichts hochgeladen."
  );
}

function embeddedFileCount(node: PDFDict | undefined): number {
  if (!node) return 0;
  let count = 0;
  const names = node.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (names) count += names.size() / 2;
  const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
  if (kids) {
    for (let i = 0; i < kids.size(); i++) count += embeddedFileCount(kids.lookupMaybe(i, PDFDict));
  }
  return count;
}

export function countEmbeddedFiles(doc: PDFDocument): number {
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  return embeddedFileCount(names?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict));
}

async function loadPdf(bytes: Uint8Array, label: string): Promise<PDFDocument> {
  try {
    // updateMetadata: false - pdf-lib would otherwise overwrite Producer,
    // Creator and ModDate of the original on load.
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error instanceof EncryptedPDFError || (error instanceof Error && /is encrypted/.test(error.message))) {
      throw new Error(
        `${label} ist verschlüsselt oder passwortgeschützt - Schutzmechanismen werden nicht umgangen. ` +
          "Es wurde nichts hochgeladen. Bitte eine unverschlüsselte Fassung verwenden."
      );
    }
    throw new Error(
      `${label} ist defekt und konnte nicht gelesen werden (${error instanceof Error ? error.message : String(error)}). ` +
        "Es wurde nichts hochgeladen."
    );
  }
}

// Original is the base document (not copied into a fresh one) so that
// document-level structures such as embedded files (ZUGFeRD XML, attachments)
// stay in the catalog. For images the original becomes page 1 of a new
// document: JPEG is embedded as-is (DCT stream), PNG is losslessly re-packed
// by pdf-lib (pixel-identical, bytes of the stream differ).
//
// Saving is a full rewrite: pdf-lib has no incremental update. Page content
// is preserved, file bytes are not - compensated by the SHA-256 on the cover
// page and by keeping the original receipt in BuchhaltungsButler.
export async function appendCoverToOriginal(
  originalBytes: Uint8Array,
  kind: OriginalKind,
  coverPdfBytes: Uint8Array
): Promise<{ pdfBytes: Uint8Array; pagesBefore: number; pagesAfter: number }> {
  const cover = await PDFDocument.load(coverPdfBytes);
  let base: PDFDocument;

  if (kind === "pdf") {
    base = await loadPdf(originalBytes, "Das Original-PDF");
  } else {
    base = await PDFDocument.create();
    let image;
    try {
      image = kind === "png" ? await base.embedPng(originalBytes) : await base.embedJpg(originalBytes);
    } catch (error) {
      throw new Error(
        `Das Bild-Original (${kind}) ist defekt und konnte nicht gelesen werden ` +
          `(${error instanceof Error ? error.message : String(error)}). Es wurde nichts hochgeladen.`
      );
    }
    // A4 in the image's orientation, fitted proportionally, never upscaled,
    // never cropped.
    const [a4w, a4h] = PageSizes.A4;
    const landscape = image.width > image.height;
    const [pageWidth, pageHeight] = landscape ? [a4h, a4w] : [a4w, a4h];
    const scale = Math.min(pageWidth / image.width, pageHeight / image.height, 1);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    const page = base.addPage([pageWidth, pageHeight]);
    page.drawImage(image, {
      x: (pageWidth - drawWidth) / 2,
      y: (pageHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }

  const pagesBefore = base.getPageCount();
  const [coverPage] = await base.copyPages(cover, [0]);
  base.addPage(coverPage);
  const pdfBytes = await base.save();
  return { pdfBytes, pagesBefore, pagesAfter: base.getPageCount() };
}

async function pageTexts(bytes: Uint8Array): Promise<string[] | undefined> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: false });
    return text as string[];
  } catch {
    return undefined;
  }
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

// Dry check before anything is uploaded. Compares the merged result against
// the unchanged original; never logs or returns document content.
export async function runDryChecks(
  originalBytes: Uint8Array,
  kind: OriginalKind,
  merged: { pdfBytes: Uint8Array; pagesBefore: number; pagesAfter: number }
): Promise<DryChecks> {
  const mergedTexts = await pageTexts(merged.pdfBytes);
  const mergedDoc = await PDFDocument.load(merged.pdfBytes, { updateMetadata: false });

  let textOriginalOk: boolean | null = null;
  let embeddedOk = true;
  let originalPages = 1;
  if (kind === "pdf") {
    const originalTexts = await pageTexts(originalBytes);
    const hasText = originalTexts?.some((t) => normalize(t).length > 0) ?? false;
    if (hasText && originalTexts) {
      textOriginalOk =
        mergedTexts !== undefined &&
        originalTexts.every((t, i) => normalize(mergedTexts[i] ?? "") === normalize(t));
    }
    const originalDoc = await loadPdf(originalBytes, "Das Original-PDF");
    originalPages = originalDoc.getPageCount();
    embeddedOk = countEmbeddedFiles(mergedDoc) >= countEmbeddedFiles(originalDoc);
  }

  const last = mergedTexts?.[mergedTexts.length - 1] ?? "";
  return {
    page_count_ok:
      merged.pagesAfter === originalPages + 1 && mergedDoc.getPageCount() === originalPages + 1,
    text_contains_original_ok: textOriginalOk,
    text_contains_entertainment_ok: last.includes("Bewirtungsangaben"),
    embedded_files_preserved: embeddedOk,
  };
}
