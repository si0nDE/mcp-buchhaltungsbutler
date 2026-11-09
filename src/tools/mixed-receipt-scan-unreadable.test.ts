import { describe, expect, it, vi } from "vitest";

vi.mock("unpdf", () => ({
  getDocumentProxy: vi.fn().mockRejectedValue(new Error("pdfjs cannot parse")),
  extractTextItems: vi.fn(),
}));

import { makeFakeScanPdf } from "./mixed-receipt-scan.fixture.js";
import { readBilevelScan } from "./mixed-receipt-scan.js";

describe("readBilevelScan with an unreadable text check", () => {
  it("rejects instead of assuming there is no text layer", async () => {
    await expect(readBilevelScan(await makeFakeScanPdf())).rejects.toMatchObject({ reason: "unreadable" });
  });
});
