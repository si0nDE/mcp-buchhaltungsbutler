import { concatTransformationMatrix, degrees, drawObject, PDFDocument, PDFName, popGraphicsState, pushGraphicsState, StandardFonts } from "pdf-lib";

export interface FakeScanOptions {
  width?: number; // pixels, default 400
  height?: number; // pixels, default 600
  inkRows?: Array<[number, number]>; // [top, bottom) pixel rows with ink
  inkWidth?: number; // ink pixels per row starting at x = 10, default 200
  colorSpace?: "DeviceGray" | "ICCBased" | "DeviceRGB";
  bitsPerComponent?: 1 | 8;
  decodeInverted?: boolean; // /Decode [1 0]: bit 1 = black
  predictor?: boolean; // adds /DecodeParms << /Predictor 15 >>
  textLayer?: boolean;
  images?: number; // image XObjects per page, default 1
  pages?: number; // default 1
  extraBytes?: number; // appends this many bytes to the decoded stream (over-long stream)
  rotate?: number; // page rotation in degrees
  pageScale?: { w: number; h: number }; // page size factor, so the image no longer matches the page aspect
}

// Synthetic receipt scan like a document scanner writes it at 600 dpi: one page, one 1-bit Flate image.
// Fictitious content only.
export async function makeFakeScanPdf(o: FakeScanOptions = {}): Promise<Uint8Array> {
  const width = o.width ?? 400;
  const height = o.height ?? 600;
  const bpc = o.bitsPerComponent ?? 1;
  const components = o.colorSpace === "DeviceRGB" ? 3 : 1;
  const rowBytes = bpc === 1 ? Math.ceil(width / 8) : width * components;
  const bits = new Uint8Array(rowBytes * height + (o.extraBytes ?? 0)).fill(o.decodeInverted ? 0x00 : 0xff);
  const inkEnd = Math.min(width, 10 + (o.inkWidth ?? 200));
  for (const [top, bottom] of o.inkRows ?? []) {
    for (let y = top; y < bottom; y++) {
      for (let x = 10; x < inkEnd; x++) {
        if (bpc === 8) bits.fill(0, y * rowBytes + x * components, y * rowBytes + (x + 1) * components);
        else if (o.decodeInverted) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
        else bits[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
      }
    }
  }
  const pageW = ((width * 72) / 600) * (o.pageScale?.w ?? 1);
  const pageH = ((height * 72) / 600) * (o.pageScale?.h ?? 1);
  const doc = await PDFDocument.create();
  for (let p = 0; p < (o.pages ?? 1); p++) {
    const page = doc.addPage([pageW, pageH]);
    if (o.rotate) page.setRotation(degrees(o.rotate));
    if (o.textLayer) {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("Beispielartikel 1,00", { x: 2, y: 2, size: 4, font });
    }
    let colorSpace: unknown = PDFName.of(o.colorSpace === "DeviceRGB" ? "DeviceRGB" : "DeviceGray");
    if (o.colorSpace === "ICCBased") {
      const icc = doc.context.register(doc.context.flateStream(new Uint8Array(0), { N: 1 }));
      colorSpace = doc.context.obj([PDFName.of("ICCBased"), icc]);
    }
    for (let i = 0; i < (o.images ?? 1); i++) {
      const dict: Record<string, unknown> = {
        Type: "XObject",
        Subtype: "Image",
        Width: width,
        Height: height,
        ColorSpace: colorSpace,
        BitsPerComponent: bpc,
      };
      if (o.decodeInverted) dict.Decode = [1, 0];
      if (o.predictor) dict.DecodeParms = { Predictor: 15, Columns: width };
      const ref = doc.context.register(doc.context.flateStream(bits, dict as never));
      const name = page.node.newXObject(`Im${i}`, ref);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(pageW, 0, 0, pageH, 0, 0), drawObject(name), popGraphicsState());
    }
  }
  return doc.save({ useObjectStreams: false });
}

// Evenly spaced ink rows: count lines of `lineHeight` px with `gap` px between them, starting at `start`.
export function inkLines(count: number, lineHeight = 30, gap = 20, start = 20): Array<[number, number]> {
  return Array.from({ length: count }, (_, i) => {
    const top = start + i * (lineHeight + gap);
    return [top, top + lineHeight] as [number, number];
  });
}
