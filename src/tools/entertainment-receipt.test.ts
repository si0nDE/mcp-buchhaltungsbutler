import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createEntertainmentReceiptTools, deriveVatRate, formatGermanDate } from "./entertainment-receipt.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

const [generateReceipt, generateAndUploadReceipt] = createEntertainmentReceiptTools(mockClient({}));

const baseArgs = {
  date: "24.09.2026",
  location: "Restaurant Zur Alten Post, München",
  occasion: "Vertragsverhandlung Rahmenvertrag IT-Sicherheitsaudits 2026/2027 mit Kunde GmbH",
  participants: [
    { name: "Anna Beispiel", company: "Beispielfirma UG" },
    { name: "Max Mustermann", company: "Kunde GmbH" },
  ],
  host_name: "Anna Beispiel",
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

  // Two real bookings both listed all 5 people who sat at the table as
  // "participants", even though the linked invoice's amount only covered 2 of
  // them (the other 3 paid separately) - because the old description told
  // the calling model to do exactly that ("alle, die am Tisch saßen"). The
  // description is the only way this tool can ask a clarifying question (it
  // has no interactive human-in-the-loop channel), so it must instruct the
  // calling model to actively ask, the same way host_name already does,
  // rather than assume "everyone at the table" is the right answer.
  it("instructs the calling model to actively ask who this specific amount covers, not assume everyone at the table", () => {
    // ZodRawShape's value type is zod v4's generic core $ZodType, which
    // doesn't statically declare .description even though every concrete
    // schema (ZodArray here) carries it at runtime - narrow just enough to
    // read it without losing the rest of inputSchema's real typing.
    const description = (generateReceipt.inputSchema.participants as { description?: string }).description;
    expect(description).toContain("MUSS aktiv beim Nutzer erfragt werden");
    expect(description).not.toContain("alle, die am Tisch saßen");
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

describe("formatGermanDate", () => {
  it("converts an ISO date to German DD.MM.YYYY", () => {
    expect(formatGermanDate("2026-09-17")).toBe("17.09.2026");
  });
});

describe("deriveVatRate", () => {
  it("computes the rate from the actual food net/vat ratio (post-2026 dine-in: 7%)", () => {
    expect(deriveVatRate({ foodNet: 32.5, foodVat: 2.28, drinksNet: 0, drinksVat: 0 })).toBe(7);
  });

  it("computes the rate from the actual drinks net/vat ratio (19%)", () => {
    expect(deriveVatRate({ foodNet: 0, foodVat: 0, drinksNet: 12, drinksVat: 2.28 })).toBe(19);
  });

  // Food's statutory rate depends on when the receipt is dated: 7% dine-in
  // only since 1.1.2026 (§ 12 Abs. 2 Nr. 15 UStG); before that, dine-in food
  // was 19% (only takeaway was 7%). Rather than hardcode either rate or a
  // cutoff date to pick between them, this derives the rate from the actual
  // net/vat amounts the caller already supplied (exactly as printed on the
  // real invoice) - correct for any receipt regardless of date, and immune
  // to the rate itself changing again in the future.
  it("computes 19% for a pre-2026-style dine-in food line, not a hardcoded 7%", () => {
    expect(deriveVatRate({ foodNet: 10, foodVat: 1.9, drinksNet: 0, drinksVat: 0 })).toBe(19);
  });

  it("returns an empty string (BuchhaltungsButler's 'multiple rates' signal) when both are present", () => {
    expect(deriveVatRate({ foodNet: 32.5, foodVat: 2.28, drinksNet: 12, drinksVat: 2.28 })).toBe("");
  });

  it("returns undefined when no amounts are present at all", () => {
    expect(deriveVatRate({ foodNet: 0, foodVat: 0, drinksNet: 0, drinksVat: 0 })).toBeUndefined();
  });

  it("returns undefined rather than dividing by zero when vat is given but net is 0", () => {
    expect(deriveVatRate({ foodNet: 0, foodVat: 2.28, drinksNet: 0, drinksVat: 0 })).toBeUndefined();
  });

  it("snaps a ratio close to a valid German rate despite cent-rounding noise on the printed amounts", () => {
    // 0.50 / 7.15 = 6.993% - not exactly 7% due to cent rounding on the real
    // invoice, but close enough that 7% is clearly what's meant.
    expect(deriveVatRate({ foodNet: 7.15, foodVat: 0.5, drinksNet: 0, drinksVat: 0 })).toBe(7);
  });

  // Food and drinks are never combined into one ratio (see the "empty
  // string when both present" case above) - but the single-category ratio
  // itself also needs a floor: without snapping to a known valid German
  // rate (0/7/19) within a small tolerance, a data-entry slip (e.g. a wrong
  // net or vat figure) could produce a percentage that isn't a real VAT
  // rate at all (e.g. ~13%, roughly what a food+drinks blend would look
  // like if the two were ever wrongly combined) and get sent to
  // BuchhaltungsButler as if it were valid - worse than sending nothing.
  it("returns undefined instead of an invalid rate when the ratio is far from any valid German VAT rate", () => {
    expect(deriveVatRate({ foodNet: 10, foodVat: 1.3, drinksNet: 0, drinksVat: 0 })).toBeUndefined();
  });
});

describe("generate_and_upload_entertainment_receipt", () => {
  it("is registered with the expected name and annotations", () => {
    expect(generateAndUploadReceipt.name).toBe("generate_and_upload_entertainment_receipt");
    expect(generateAndUploadReceipt.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
  });

  const uploadArgs = {
    date: "2026-09-17",
    location: "Restaurant Zur Alten Post, München",
    occasion: "Vertragsverhandlung Rahmenvertrag IT-Sicherheitsaudits 2026/2027 mit Kunde GmbH",
    participants: [
      { name: "Anna Beispiel", company: "Beispielfirma UG" },
      { name: "Max Mustermann", company: "Kunde GmbH" },
    ],
    host_name: "Anna Beispiel",
    counterparty: "Restaurant Zur Alten Post",
    food_net: 32.5,
    food_vat: 2.28,
    drinks_net: 0,
    drinks_vat: 0,
    tip: 0,
    bill_reference: "92119",
    link_to_receipt_id_by_customer: 493,
  };

  it("uploads the generated PDF via receiptsUpload and returns only the new id_by_customer, no pdf_base64 (Fall B)", async () => {
    const client = mockClient({ success: true, message: "", data: { id_by_customer: "999" } });
    const [, generateAndUpload] = createEntertainmentReceiptTools(client);

    const result = await generateAndUpload.handler(uploadArgs as never);

    expect(client.call).toHaveBeenCalledWith(
      "receiptsUpload",
      expect.objectContaining({
        type: "invoice inbound",
        counterparty: "Restaurant Zur Alten Post",
        invoice_number: "92119",
        date: "2026-09-17",
        amount: 34.78,
        currency: "EUR",
        vat_rate: 7,
        link_to_receipt_id_by_customer: 493,
      })
    );
    const data = result.structuredContent!.data as Record<string, unknown>;
    expect(data.id_by_customer).toBe("999");
    expect(data).not.toHaveProperty("pdf_base64");
  });

  it("passes a base64-encoded PDF file to receiptsUpload", async () => {
    const client = mockClient({ success: true, message: "", data: { id_by_customer: "999" } });
    const [, generateAndUpload] = createEntertainmentReceiptTools(client);

    await generateAndUpload.handler(uploadArgs as never);

    const [, params] = (client.call as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(typeof params.file).toBe("string");
    const doc = await PDFDocument.load(Buffer.from(params.file, "base64"));
    expect(doc.getPageCount()).toBe(1);
  });

  it("requires link_to_receipt_id_by_customer when no bill_file is given (Fall B)", async () => {
    const client = mockClient({ success: true, message: "", data: {} });
    const [, generateAndUpload] = createEntertainmentReceiptTools(client);

    const { link_to_receipt_id_by_customer, ...withoutLink } = uploadArgs;
    await expect(generateAndUpload.handler(withoutLink as never)).rejects.toThrow(
      /link_to_receipt_id_by_customer/
    );
    expect(client.call).not.toHaveBeenCalled();
  });

  it("uploads a merged multi-page PDF without requiring link_to_receipt_id_by_customer (Fall A)", async () => {
    const client = mockClient({ success: true, message: "", data: { id_by_customer: "999" } });
    const [, generateAndUpload] = createEntertainmentReceiptTools(client);
    const billDoc = await PDFDocument.create();
    billDoc.addPage([200, 200]);
    const billBase64 = Buffer.from(await billDoc.save()).toString("base64");

    const { link_to_receipt_id_by_customer, ...withoutLink } = uploadArgs;
    await generateAndUpload.handler({
      ...withoutLink,
      bill_file: billBase64,
      bill_file_type: "pdf",
    } as never);

    const [, params] = (client.call as ReturnType<typeof vi.fn>).mock.calls[0];
    const doc = await PDFDocument.load(Buffer.from(params.file, "base64"));
    expect(doc.getPageCount()).toBe(2);
  });

  it("rejects a denylisted occasion before ever calling the client", async () => {
    const client = mockClient({ success: true, message: "", data: {} });
    const [, generateAndUpload] = createEntertainmentReceiptTools(client);

    await expect(
      generateAndUpload.handler({ ...uploadArgs, occasion: "Geschäftsessen" } as never)
    ).rejects.toThrow(/zu unkonkret/);
    expect(client.call).not.toHaveBeenCalled();
  });
});
