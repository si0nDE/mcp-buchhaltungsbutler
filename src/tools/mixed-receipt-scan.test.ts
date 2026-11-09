import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  assertUsableBands,
  findLines,
  isBlack,
  parseLineSpec,
  readBilevelScan,
  redactLines,
  UnsupportedScanError,
  writeScan,
  type Band,
} from "./mixed-receipt-scan.js";
import { inkLines, makeFakeScanPdf } from "./mixed-receipt-scan.fixture.js";

async function reason(bytes: Uint8Array): Promise<string> {
  try {
    await readBilevelScan(bytes);
    return "accepted";
  } catch (error) {
    return error instanceof UnsupportedScanError ? error.reason : `other: ${String(error)}`;
  }
}

describe("readBilevelScan", () => {
  it("reads a one-page 1-bit DeviceGray scan", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ width: 400, height: 600 }));
    expect([scan.width, scan.height, scan.rowBytes, scan.blackBit]).toEqual([400, 600, 50, 0]);
    expect(scan.bits.length).toBeGreaterThanOrEqual(50 * 600);
  });

  it("accepts a single-component ICCBased color space", async () => {
    expect(await reason(await makeFakeScanPdf({ colorSpace: "ICCBased" }))).toBe("accepted");
  });

  it("rejects everything v1 cannot redact, naming the reason", async () => {
    expect(await reason(new TextEncoder().encode('<?xml version="1.0"?><Invoice/>'))).toBe("not_pdf");
    expect(await reason(await makeFakeScanPdf({ pages: 2 }))).toBe("page_count");
    expect(await reason(await makeFakeScanPdf({ images: 2 }))).toBe("image_count");
    expect(await reason(await makeFakeScanPdf({ textLayer: true }))).toBe("text_layer");
    expect(await reason(await makeFakeScanPdf({ bitsPerComponent: 8 }))).toBe("not_bilevel");
    expect(await reason(await makeFakeScanPdf({ bitsPerComponent: 8, colorSpace: "DeviceRGB" }))).toBe("not_bilevel");
    expect(await reason(await makeFakeScanPdf({ predictor: true }))).toBe("filter");
  });

  it("explains the manual way in the error message", async () => {
    await expect(readBilevelScan(await makeFakeScanPdf({ textLayer: true }))).rejects.toThrow(/Es wurde nichts erzeugt oder hochgeladen/);
  });
});

describe("findLines", () => {
  it("finds ink bands and drops bands thinner than 8 px", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ inkRows: [[20, 40], [60, 62], [80, 100]] }));
    expect(findLines(scan)).toEqual([
      { nr: 1, top: 20, bottom: 40 },
      { nr: 2, top: 80, bottom: 100 },
    ]);
  });

  it("ignores rows with only 2 black pixels (scanner noise)", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ inkRows: [[20, 40]], inkWidth: 2 }));
    expect(findLines(scan)).toEqual([]);
  });

  it("finds the same bands when /Decode [1 0] makes bit 1 black", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ inkRows: [[20, 40], [80, 100]], decodeInverted: true }));
    expect(scan.blackBit).toBe(1);
    expect(findLines(scan).map((b) => [b.top, b.bottom])).toEqual([[20, 40], [80, 100]]);
  });
});

describe("assertUsableBands", () => {
  const band = (nr: number, top: number, height = 30): Band => ({ nr, top, bottom: top + height });

  it("needs at least 5 lines", () => {
    expect(() => assertUsableBands([band(1, 0), band(2, 50), band(3, 100), band(4, 150)])).toThrow(/Nur 4 Textzeilen/);
  });

  it("rejects a band more than three times the median height and names it", () => {
    const bands = [band(1, 0), band(2, 50), band(3, 100, 100), band(4, 250), band(5, 300)];
    expect(() => assertUsableBands(bands)).toThrow(/Zeile\(n\) 3/);
  });

  it("accepts normal receipts", () => {
    expect(() => assertUsableBands([band(1, 0), band(2, 50), band(3, 100), band(4, 150), band(5, 200)])).not.toThrow();
  });
});

describe("parseLineSpec", () => {
  it("expands ranges, dedupes and sorts", () => {
    expect(parseLineSpec(["5-7", 9, "9"], 10)).toEqual([5, 6, 7, 9]);
  });

  it("rejects out-of-range, reversed, unreadable and empty specs", () => {
    expect(() => parseLineSpec([11], 10)).toThrow(/außerhalb der Zeilen 1-10/);
    expect(() => parseLineSpec(["7-5"], 10)).toThrow(/rückwärts/);
    expect(() => parseLineSpec(["fünf"], 10)).toThrow(/keine Zeilennummer/);
    expect(() => parseLineSpec([], 10)).toThrow(/leer/);
  });
});

describe("redactLines and writeScan", () => {
  it("merges adjacent lines into one block and blackens the full width", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ inkRows: inkLines(5) }));
    const bands = findLines(scan);
    const { bits, blocks } = redactLines(scan, bands, [2, 3]);
    expect(blocks).toEqual([{ from: 2, to: 3, top: bands[1].top, bottom: bands[2].bottom }]);
    const view = { ...scan, bits };
    for (const y of [bands[1].top, bands[2].bottom - 1]) {
      for (const x of [0, 5, 150, 399]) expect(isBlack(view, x, y)).toBe(true);
    }
  });

  it("keeps lines that are not redacted bit for bit, even with only a 2 px gap", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ inkRows: [[20, 40], [42, 60], [80, 100], [120, 140], [160, 180]] }));
    const bands = findLines(scan);
    const { bits } = redactLines(scan, bands, [2]);
    const view = { ...scan, bits };
    for (let y = 20; y < 40; y++) {
      for (let x = 0; x < scan.width; x++) expect(isBlack(view, x, y)).toBe(isBlack(scan, x, y));
    }
    for (let y = 80; y < 100; y++) expect(isBlack(view, 300, y)).toBe(false);
  });

  it("blackens to the black bit when /Decode [1 0] is set", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ inkRows: inkLines(5), decodeInverted: true }));
    const bands = findLines(scan);
    const { bits } = redactLines(scan, bands, [1]);
    expect(isBlack({ ...scan, bits }, 300, bands[0].top)).toBe(true);
  });

  it("writes a PDF whose image holds the redacted bits and no stream with the old bits", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ inkRows: inkLines(5) }));
    const original = Buffer.from(scan.bits.subarray(0, scan.rowBytes * scan.height));
    const bands = findLines(scan);
    const { bits } = redactLines(scan, bands, [4, 5]);
    const out = await writeScan(scan, bits);

    const reread = await readBilevelScan(out);
    expect(Buffer.from(reread.bits.subarray(0, reread.rowBytes * reread.height)).equals(Buffer.from(bits.subarray(0, scan.rowBytes * scan.height)))).toBe(true);

    const doc = await PDFDocument.load(out);
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      let inflated: Buffer;
      try {
        inflated = inflateSync(obj.contents);
      } catch {
        continue;
      }
      expect(inflated.subarray(0, original.length).equals(original)).toBe(false);
    }
  });

  it("copies nothing but the image: no annotations, no Info metadata, no private strings", async () => {
    const src = await PDFDocument.load(await makeFakeScanPdf({ inkRows: inkLines(5) }));
    src.setTitle("Privat Rotwein Beispiel");
    const annot = src.context.register(
      src.context.obj({ Type: "Annot", Subtype: "FreeText", Rect: [0, 0, 10, 10], Contents: "Rotwein privat" })
    );
    src.getPage(0).node.set(PDFName.of("Annots"), src.context.obj([annot]));
    const scan = await readBilevelScan(await src.save({ useObjectStreams: false }));
    const { bits } = redactLines(scan, findLines(scan), [1]);
    const out = await writeScan(scan, bits);

    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"));
    expect(annots === undefined || (annots instanceof PDFArray && annots.size() === 0)).toBe(true);
    expect(doc.getTitle()).toBeUndefined();
    expect(Buffer.from(out).includes("Rotwein")).toBe(false);
  });

  it("keeps /Decode [1 0] semantics in the rebuilt image", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ inkRows: inkLines(5), decodeInverted: true }));
    const { bits } = redactLines(scan, findLines(scan), [1]);
    const reread = await readBilevelScan(await writeScan(scan, bits));
    expect(reread.blackBit).toBe(1);
    expect(Buffer.from(reread.bits.subarray(0, reread.rowBytes * reread.height)).equals(Buffer.from(bits.subarray(0, scan.rowBytes * scan.height)))).toBe(true);
  });
});
