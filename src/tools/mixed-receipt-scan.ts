import { inflateSync } from "node:zlib";
import { concatTransformationMatrix, drawObject, PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, popGraphicsState, pushGraphicsState, PDFStream } from "pdf-lib";
import { extractTextItems, getDocumentProxy } from "unpdf";

export type UnsupportedReason = "not_pdf" | "page_count" | "image_count" | "text_layer" | "not_bilevel" | "filter" | "unreadable";

const REASON_TEXT: Record<UnsupportedReason, string> = {
  not_pdf: "Das Original ist keine PDF (Foto, Bild oder E-Rechnung)",
  page_count: "Die PDF hat mehr als eine Seite",
  image_count: "Die Seite enthält nicht genau ein Bild",
  text_layer: "Die PDF hat eine Textebene (E-Bon oder Scan mit Texterkennung); geschwärzte Pixel ließen den Text darin stehen",
  not_bilevel: "Das Bild ist kein Schwarz-Weiß-Scan (Graustufe oder Farbe)",
  unreadable: "Die PDF lässt sich nicht vollständig lesen, daher ist nicht prüfbar, ob sie Text enthält",
  filter: "Das Bild ist nicht mit Flate ohne Prädiktor komprimiert (z. B. CCITT oder JPEG)",
};

export class UnsupportedScanError extends Error {
  constructor(readonly reason: UnsupportedReason) {
    super(
      `${REASON_TEXT[reason]}. Version 1 schwärzt nur einseitige Schwarz-Weiß-Scans (PDF mit einem 1-Bit-Bild, ohne Textebene). ` +
        "Es wurde nichts erzeugt oder hochgeladen. Weg ohne Tool: Bon im Scanner in Schwarz-Weiß ohne Texterkennung neu scannen, " +
        "oder von Hand schwärzen (Vorschau-App 'Schwärzen' bzw. Acrobat 'Schwärzen anwenden' mit 'Ausgeblendete Informationen entfernen')."
    );
    this.name = "UnsupportedScanError";
  }
}

export interface BilevelScan {
  doc: PDFDocument;
  imageRef: PDFRef;
  image: PDFRawStream;
  width: number;
  height: number;
  rowBytes: number;
  bits: Uint8Array; // decoded image, at least rowBytes * height bytes
  blackBit: 0 | 1;
}

export interface Band {
  nr: number; // 1-based, top to bottom
  top: number; // first pixel row
  bottom: number; // pixel row after the last one
}

export const INK_MIN_PIXELS = 3; // a pixel row is ink from more than 2 black pixels (scanner noise)
export const MIN_BAND_HEIGHT = 8;
export const MIN_LINES = 5;
export const REDACT_PAD = 4;

function isSingleComponentGray(doc: PDFDocument, cs: unknown): boolean {
  const resolved = cs instanceof PDFRef ? doc.context.lookup(cs) : cs;
  if (resolved === PDFName.of("DeviceGray")) return true;
  if (resolved instanceof PDFArray && resolved.lookup(0) === PDFName.of("ICCBased")) {
    const icc = resolved.lookup(1);
    const n = icc instanceof PDFStream ? icc.dict.lookup(PDFName.of("N")) : undefined;
    return n instanceof PDFNumber && n.asNumber() === 1;
  }
  return false;
}

// Reads the single 1-bit image of a one-page scan. Anything else is rejected with a reason: v1 only redacts pixels,
// so a text layer (E-Bon, OCR) would keep the private text readable in the file.
export async function readBilevelScan(pdfBytes: Uint8Array): Promise<BilevelScan> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  } catch {
    throw new UnsupportedScanError("not_pdf");
  }
  if (doc.getPageCount() !== 1) throw new UnsupportedScanError("page_count");
  const images: Array<[PDFRef, PDFRawStream]> = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) images.push([ref, obj]);
  }
  if (images.length !== 1) throw new UnsupportedScanError("image_count");
  let hasText: boolean;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(pdfBytes));
    const { items } = await extractTextItems(pdf);
    hasText = items.some((pageItems) => pageItems.some((item) => item.str.trim().length > 0));
  } catch {
    throw new UnsupportedScanError("unreadable");
  }
  if (hasText) throw new UnsupportedScanError("text_layer");
  const [imageRef, image] = images[0];
  const dict = image.dict;
  const bpc = dict.lookup(PDFName.of("BitsPerComponent"));
  if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 1 || !isSingleComponentGray(doc, dict.get(PDFName.of("ColorSpace")))) {
    throw new UnsupportedScanError("not_bilevel");
  }
  const filter = dict.lookup(PDFName.of("Filter"));
  const filterName = filter instanceof PDFArray && filter.size() === 1 ? filter.lookup(0) : filter;
  if (filterName !== PDFName.of("FlateDecode") || dict.get(PDFName.of("DecodeParms")) !== undefined) {
    throw new UnsupportedScanError("filter");
  }
  const width = (dict.lookup(PDFName.of("Width")) as PDFNumber).asNumber();
  const height = (dict.lookup(PDFName.of("Height")) as PDFNumber).asNumber();
  const rowBytes = Math.ceil(width / 8);
  let bits: Uint8Array;
  try {
    bits = new Uint8Array(inflateSync(image.contents));
  } catch {
    throw new UnsupportedScanError("filter");
  }
  if (bits.length < rowBytes * height) throw new UnsupportedScanError("filter");
  const decode = dict.lookup(PDFName.of("Decode"));
  const first = decode instanceof PDFArray ? decode.lookup(0) : undefined;
  const blackBit = first instanceof PDFNumber && first.asNumber() === 1 ? 1 : 0;
  return { doc, imageRef, image, width, height, rowBytes, bits, blackBit };
}

export function isBlack(scan: Pick<BilevelScan, "bits" | "rowBytes" | "blackBit">, x: number, y: number): boolean {
  return ((scan.bits[y * scan.rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1) === scan.blackBit;
}

// Projection profile: a band is a run of pixel rows with ink, separated by fully white rows.
export function findLines(scan: BilevelScan): Band[] {
  const bands: Band[] = [];
  let start = -1;
  for (let y = 0; y <= scan.height; y++) {
    let ink = false;
    if (y < scan.height) {
      let n = 0;
      for (let x = 0; x < scan.width && n < INK_MIN_PIXELS; x++) if (isBlack(scan, x, y)) n++;
      ink = n >= INK_MIN_PIXELS;
    }
    if (ink && start < 0) start = y;
    if (!ink && start >= 0) {
      if (y - start >= MIN_BAND_HEIGHT) bands.push({ nr: bands.length + 1, top: start, bottom: y });
      start = -1;
    }
  }
  return bands;
}

export function assertUsableBands(bands: Band[]): void {
  if (bands.length < MIN_LINES) {
    throw new Error(`Nur ${bands.length} Textzeilen erkannt (mindestens ${MIN_LINES}). Ist das wirklich ein Kassenbon? Es wurde nichts erzeugt.`);
  }
  const heights = bands.map((b) => b.bottom - b.top).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  const tall = bands.filter((b) => b.bottom - b.top > 3 * median);
  if (tall.length > 0) {
    throw new Error(
      `Zeile(n) ${tall.map((b) => b.nr).join(", ")} sind mehr als dreimal so hoch wie eine normale Zeile (Median ${median} px): ` +
        "Zeilen gehen ineinander über, etwa bei einem schief eingezogenen Bon. Bon gerade neu scannen. Es wurde nichts erzeugt."
    );
  }
}

export function parseLineSpec(spec: Array<number | string>, lineCount: number): number[] {
  const out = new Set<number>();
  for (const item of spec) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(item));
    if (!m) throw new Error(`redact_lines: "${item}" ist keine Zeilennummer und kein Bereich wie "5-16".`);
    const from = Number(m[1]);
    const to = Number(m[2] ?? m[1]);
    if (from > to) throw new Error(`redact_lines: Bereich "${item}" ist rückwärts.`);
    if (from < 1 || to > lineCount) throw new Error(`redact_lines: "${item}" liegt außerhalb der Zeilen 1-${lineCount}. Es wurde nichts erzeugt.`);
    for (let n = from; n <= to; n++) out.add(n);
  }
  if (out.size === 0) throw new Error("redact_lines ist leer: Ohne geschwärzte Zeile ist es kein gemischter Einkauf.");
  return [...out].sort((a, b) => a - b);
}

export interface RedactionBlock {
  from: number;
  to: number;
  top: number;
  bottom: number;
}

// Consecutive line numbers become one block; each block is filled black over the full width with REDACT_PAD px,
// but never into the neighbouring lines (those are not redacted, otherwise they would belong to the block).
export function redactLines(scan: BilevelScan, bands: Band[], lineNumbers: number[]): { bits: Uint8Array; blocks: RedactionBlock[] } {
  const bits = new Uint8Array(scan.bits);
  const fill = scan.blackBit === 0 ? 0x00 : 0xff;
  const blocks: RedactionBlock[] = [];
  for (const n of [...lineNumbers].sort((a, b) => a - b)) {
    const last = blocks[blocks.length - 1];
    if (last && n === last.to + 1) {
      last.to = n;
      last.bottom = bands[n - 1].bottom;
    } else {
      blocks.push({ from: n, to: n, top: bands[n - 1].top, bottom: bands[n - 1].bottom });
    }
  }
  for (const b of blocks) {
    const prevBottom = b.from > 1 ? bands[b.from - 2].bottom : 0;
    const nextTop = b.to < bands.length ? bands[b.to].top : scan.height;
    const top = Math.max(b.top - REDACT_PAD, prevBottom);
    const bottom = Math.min(b.bottom + REDACT_PAD, nextTop);
    bits.fill(fill, top * scan.rowBytes, bottom * scan.rowBytes);
  }
  return { bits, blocks };
}

// Builds a fresh single-page PDF from the redacted pixels only. Nothing of the original file is copied (no
// annotations, Info/XMP metadata, earlier objects), so no private content can survive next to the image.
export async function writeScan(scan: BilevelScan, bits: Uint8Array): Promise<Uint8Array> {
  const { width: pageW, height: pageH } = scan.doc.getPage(0).getSize();
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([pageW, pageH]);
  const dict: Record<string, unknown> = {
    Type: "XObject",
    Subtype: "Image",
    Width: scan.width,
    Height: scan.height,
    ColorSpace: PDFName.of("DeviceGray"),
    BitsPerComponent: 1,
  };
  if (scan.blackBit === 1) dict.Decode = [1, 0];
  const ref = doc.context.register(doc.context.flateStream(bits.subarray(0, scan.rowBytes * scan.height), dict as never));
  const name = page.node.newXObject("Im0", ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(pageW, 0, 0, pageH, 0, 0), drawObject(name), popGraphicsState());
  return doc.save({ useObjectStreams: false });
}
