import { deflateSync } from "node:zlib";
import { isBlack, type Band, type BilevelScan } from "./mixed-receipt-scan.js";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// 8-bit grayscale PNG without dependencies (filter 0 on every row).
export function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// 3x5 pixel digits, '#' = ink.
const DIGITS: Record<string, string[]> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
};

export const PREVIEW_SCALE = 3; // scan pixels per preview pixel
export const NUMBER_MARGIN = 28; // preview pixels left of the receipt (three digits)
export const DIGIT_PX = 2; // preview pixels per digit pixel
export const MAX_PART_HEIGHT = 1000; // preview pixels per image

export interface PreviewPart {
  png: Buffer;
  fromLine: number | null;
  toLine: number | null;
}

function drawNumber(px: Uint8Array, width: number, height: number, text: string, centerY: number): void {
  const top = centerY - Math.floor((5 * DIGIT_PX) / 2);
  [...text].forEach((ch, i) => {
    const left = 2 + i * 4 * DIGIT_PX;
    DIGITS[ch].forEach((row, gy) =>
      [...row].forEach((c, gx) => {
        if (c !== "#") return;
        for (let dy = 0; dy < DIGIT_PX; dy++) {
          for (let dx = 0; dx < DIGIT_PX; dx++) {
            const y = top + gy * DIGIT_PX + dy;
            const x = left + gx * DIGIT_PX + dx;
            if (y >= 0 && y < height && x < width) px[y * width + x] = 0;
          }
        }
      })
    );
  });
}

// Downscaled receipt (box filter) with optional line numbers, split into parts at gaps between lines.
export function renderPreview(
  scan: Pick<BilevelScan, "width" | "height" | "rowBytes" | "blackBit">,
  bits: Uint8Array,
  bands: Band[],
  options: { numbers: boolean }
): PreviewPart[] {
  const view = { bits, rowBytes: scan.rowBytes, blackBit: scan.blackBit };
  const w = Math.floor(scan.width / PREVIEW_SCALE);
  const h = Math.floor(scan.height / PREVIEW_SCALE);
  const margin = options.numbers ? NUMBER_MARGIN : 0;
  const width = w + margin;
  const px = new Uint8Array(width * h).fill(255);
  const area = PREVIEW_SCALE * PREVIEW_SCALE;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let white = 0;
      for (let dy = 0; dy < PREVIEW_SCALE; dy++) {
        for (let dx = 0; dx < PREVIEW_SCALE; dx++) if (!isBlack(view, x * PREVIEW_SCALE + dx, y * PREVIEW_SCALE + dy)) white++;
      }
      px[y * width + margin + x] = Math.round((255 * white) / area);
    }
  }
  const center = (b: Band) => (b.top + b.bottom) / 2 / PREVIEW_SCALE;
  if (options.numbers) for (const b of bands) drawNumber(px, width, h, String(b.nr), Math.round(center(b)));

  const parts: PreviewPart[] = [];
  let start = 0;
  while (start < h) {
    let end = Math.min(h, start + MAX_PART_HEIGHT);
    if (end < h) {
      // cut just above a line that starts in the lower half of this part
      const cut = bands.map((b) => Math.floor(b.top / PREVIEW_SCALE)).filter((t) => t > start + MAX_PART_HEIGHT / 2 && t <= end).pop();
      if (cut !== undefined) end = cut;
    }
    const inPart = bands.filter((b) => center(b) >= start && center(b) < end);
    parts.push({
      png: encodeGrayPng(width, end - start, px.subarray(start * width, end * width)),
      fromLine: inPart[0]?.nr ?? null,
      toLine: inPart[inPart.length - 1]?.nr ?? null,
    });
    start = end;
  }
  return parts;
}
