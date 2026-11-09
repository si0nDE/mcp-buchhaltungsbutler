import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeGrayPng, MAX_PART_HEIGHT, NUMBER_MARGIN, previewScale, renderPreview } from "./mixed-receipt-preview.js";
import { findLines, readBilevelScan } from "./mixed-receipt-scan.js";
import { inkLines, makeFakeScanPdf } from "./mixed-receipt-scan.fixture.js";

function decodeGrayPng(png: Buffer): { width: number; height: number; pixels: Uint8Array } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
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
      expect([data[8], data[9]]).toEqual([8, 0]);
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width + 1)]).toBe(0);
    pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, pixels };
}

describe("encodeGrayPng", () => {
  it("round-trips the pixels", () => {
    const pixels = new Uint8Array([0, 128, 255, 10, 20, 30]);
    const decoded = decodeGrayPng(encodeGrayPng(3, 2, pixels));
    expect([decoded.width, decoded.height]).toEqual([3, 2]);
    expect([...decoded.pixels]).toEqual([...pixels]);
  });
});

describe("previewScale", () => {
  it("follows the image width", () => {
    expect(previewScale(1838)).toBe(3);
    expect(previewScale(600)).toBe(1);
    expect(previewScale(400)).toBe(1);
    expect(previewScale(4960)).toBe(8);
  });

  it("renders a wide scan with the scaled width", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ width: 1200, height: 1800, inkRows: inkLines(5) }));
    const [part] = renderPreview(scan, scan.bits, findLines(scan), { numbers: false });
    expect(decodeGrayPng(part.png).width).toBe(1200 / previewScale(1200));
  });
});

describe("renderPreview", () => {
  it("draws line numbers in a left margin at each line's centre", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ inkRows: inkLines(5) }));
    const bands = findLines(scan);
    const [part] = renderPreview(scan, scan.bits, bands, { numbers: true });
    const { width, pixels } = decodeGrayPng(part.png);
    expect(width).toBe(Math.floor(400 / previewScale(400)) + NUMBER_MARGIN);
    for (const b of bands) {
      const cy = Math.round((b.top + b.bottom) / 2 / previewScale(400));
      let dark = 0;
      for (let y = cy - 5; y <= cy + 5; y++) for (let x = 0; x < NUMBER_MARGIN; x++) if (pixels[y * width + x] < 128) dark++;
      expect(dark, `line ${b.nr}`).toBeGreaterThan(0);
    }
    expect([part.fromLine, part.toLine]).toEqual([1, 5]);
  });

  it("has no margin without numbers", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ inkRows: inkLines(5) }));
    const [part] = renderPreview(scan, scan.bits, findLines(scan), { numbers: false });
    expect(decodeGrayPng(part.png).width).toBe(Math.floor(400 / previewScale(400)));
  });

  it("splits tall receipts into parts that cover all lines in order", async () => {
    const scan = await readBilevelScan(await makeFakeScanPdf({ height: 6600, inkRows: inkLines(130) }));
    const bands = findLines(scan);
    const parts = renderPreview(scan, scan.bits, bands, { numbers: true });
    expect(parts.length).toBeGreaterThan(1);
    const heights = parts.map((p) => decodeGrayPng(p.png).height);
    for (const h of heights) expect(h).toBeLessThanOrEqual(MAX_PART_HEIGHT);
    expect(heights.reduce((a, b) => a + b, 0)).toBe(Math.floor(6600 / previewScale(400)));
    const covered = parts.flatMap((p) => (p.fromLine === null || p.toLine === null ? [] : [p.fromLine, p.toLine]));
    expect(covered[0]).toBe(1);
    expect(covered[covered.length - 1]).toBe(bands.length);
    for (let i = 1; i < parts.length; i++) expect(parts[i].fromLine).toBe((parts[i - 1].toLine ?? 0) + 1);
  });
});
