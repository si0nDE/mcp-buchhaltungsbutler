import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createEntertainmentReceiptTools } from "./entertainment-receipt.js";

const [generateReceipt] = createEntertainmentReceiptTools();

const baseArgs = {
  date: "24.09.2026",
  location: "Restaurant Zur Alten Post, München",
  occasion: "Vertragsverhandlung Rahmenvertrag IT-Sicherheitsaudits 2026/2027 mit Kunde GmbH",
  participants: "Nena Tempel (mainsec UG), Max Mustermann (Kunde GmbH)",
  host_name: "Nena Tempel",
  food_net: 32.5,
  food_vat: 2.28,
  drinks_net: 38.0,
  drinks_vat: 7.22,
  tip: 4.5,
};

describe("generate_entertainment_receipt", () => {
  it("is registered with the expected name and annotations", () => {
    expect(generateReceipt.name).toBe("generate_entertainment_receipt");
    expect(generateReceipt.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it("returns a single-page base64 PDF when no bill_file is given (Fall B)", async () => {
    const result = await generateReceipt.handler(baseArgs as never);
    const data = result.structuredContent!.data as { pdf_base64: string };
    const doc = await PDFDocument.load(Buffer.from(data.pdf_base64, "base64"));
    expect(doc.getPageCount()).toBe(1);
  });

  it("returns a merged multi-page PDF when bill_file is given (Fall A)", async () => {
    const billDoc = await PDFDocument.create();
    billDoc.addPage([200, 200]);
    const billBase64 = Buffer.from(await billDoc.save()).toString("base64");

    const result = await generateReceipt.handler({
      ...baseArgs,
      bill_file: billBase64,
      bill_file_type: "pdf",
    } as never);
    const data = result.structuredContent!.data as { pdf_base64: string };
    const doc = await PDFDocument.load(Buffer.from(data.pdf_base64, "base64"));
    expect(doc.getPageCount()).toBe(2);
  });

  it("rejects a denylisted occasion", async () => {
    await expect(generateReceipt.handler({ ...baseArgs, occasion: "Geschäftsessen" } as never)).rejects.toThrow(
      /zu unkonkret/
    );
  });

  it("rejects bill_file without bill_file_type", async () => {
    const billDoc = await PDFDocument.create();
    billDoc.addPage([200, 200]);
    const billBase64 = Buffer.from(await billDoc.save()).toString("base64");

    await expect(
      generateReceipt.handler({ ...baseArgs, bill_file: billBase64 } as never)
    ).rejects.toThrow(/bill_file and bill_file_type/);
  });

  it("rejects bill_file_type without bill_file", async () => {
    await expect(
      generateReceipt.handler({ ...baseArgs, bill_file_type: "pdf" } as never)
    ).rejects.toThrow(/bill_file and bill_file_type/);
  });

  it("defaults kleinunternehmer to false when omitted (Regelbesteuerung split)", async () => {
    const result = await generateReceipt.handler(baseArgs as never);
    const data = result.structuredContent!.data as { deductible: number };
    // Net base 75.00 -> 70% = 52.50 (would be 59.15 on the gross base if
    // kleinunternehmer had wrongly defaulted to true).
    expect(data.deductible).toBeCloseTo(52.5, 2);
  });
});
