import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { encodeGrayPng } from "./mixed-receipt-preview.js";

export const RENDER_DPI = 110;

const require = createRequire(import.meta.url);
let modulePromise: Promise<WrappedPdfiumModule> | undefined;

// PDFium as WebAssembly (MIT wrapper, PDFium BSD/Apache): no native code, so it runs wherever Node runs.
function pdfium(): Promise<WrappedPdfiumModule> {
  modulePromise ??= (async () => {
    const file = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
    const wasmBinary = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    const m = await init({ wasmBinary } as Parameters<typeof init>[0]);
    m.PDFiumExt_Init();
    return m;
  })();
  return modulePromise;
}

// Renders every page to an 8-bit grayscale PNG. Memory is read through HEAPU8 after each allocation because the
// WASM heap can grow (and replace its buffer).
export async function renderPdfPagesToPng(pdf: Uint8Array, dpi = RENDER_DPI): Promise<Buffer[]> {
  const m = await pdfium();
  const heap = () => (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
  const dataPtr = m.pdfium.wasmExports.malloc(pdf.length);
  heap().set(pdf, dataPtr);
  const doc = m.FPDF_LoadMemDocument(dataPtr, pdf.length, "");
  if (!doc) {
    m.pdfium.wasmExports.free(dataPtr);
    throw new Error("PDFium konnte die erzeugte PDF nicht öffnen.");
  }
  const pages: Buffer[] = [];
  try {
    const count = m.FPDF_GetPageCount(doc);
    for (let i = 0; i < count; i++) {
      const page = m.FPDF_LoadPage(doc, i);
      try {
        const w = Math.round((m.FPDF_GetPageWidthF(page) * dpi) / 72);
        const h = Math.round((m.FPDF_GetPageHeightF(page) * dpi) / 72);
        const bitmap = m.FPDFBitmap_Create(w, h, 0);
        try {
          m.FPDFBitmap_FillRect(bitmap, 0, 0, w, h, 0xffffffff);
          m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, w, h, 0, 0);
          const stride = m.FPDFBitmap_GetStride(bitmap);
          const start = m.FPDFBitmap_GetBuffer(bitmap);
          const bgrx = heap().subarray(start, start + stride * h);
          const gray = new Uint8Array(w * h);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const o = y * stride + x * 4;
              gray[y * w + x] = Math.round(0.114 * bgrx[o] + 0.587 * bgrx[o + 1] + 0.299 * bgrx[o + 2]);
            }
          }
          pages.push(encodeGrayPng(w, h, gray));
        } finally {
          m.FPDFBitmap_Destroy(bitmap);
        }
      } finally {
        m.FPDF_ClosePage(page);
      }
    }
  } finally {
    m.FPDF_CloseDocument(doc);
    m.pdfium.wasmExports.free(dataPtr);
  }
  return pages;
}
