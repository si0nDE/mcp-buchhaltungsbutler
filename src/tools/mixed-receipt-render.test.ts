import { inflateSync } from "node:zlib";
import { PDFDocument, PageSizes, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { RENDER_DPI, renderPdfPagesToPng } from "./mixed-receipt-render.js";

function decode(png: Buffer): { width: number; height: number; at: (x: number, y: number) => number } {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("latin1");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, at: (x, y) => raw[y * (width + 1) + 1 + x] };
}

async function pdfWithRect(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage(PageSizes.A4);
    page.drawRectangle({ x: 100, y: 500, width: 200, height: 100, color: rgb(0, 0, 0) });
  }
  return doc.save();
}

describe("renderPdfPagesToPng", () => {
  it("renders an A4 page at 110 dpi with the drawn content", async () => {
    expect(RENDER_DPI).toBe(110);
    const [png] = await renderPdfPagesToPng(await pdfWithRect());
    const img = decode(png);
    expect([img.width, img.height]).toEqual([909, 1286]);
    // rectangle centre: x = 200 pt, y = 550 pt from the bottom -> 842 - 550 = 292 pt from the top
    expect(img.at(Math.round((200 * 110) / 72), Math.round((292 * 110) / 72))).toBeLessThan(64);
    expect(img.at(20, 20)).toBeGreaterThan(230);
  });

  it("renders every page and reuses the initialised module", async () => {
    const first = await renderPdfPagesToPng(await pdfWithRect(2));
    const second = await renderPdfPagesToPng(await pdfWithRect(2));
    expect(first).toHaveLength(2);
    expect(Buffer.compare(first[0], second[0])).toBe(0);
  });
});
