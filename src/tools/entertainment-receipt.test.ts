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

  it("returns the invoice net total and reclass amount as booking_hint when the invoice is present", async () => {
    const result = await generateReceipt.handler(baseArgs as never);
    const text = JSON.stringify(result);
    expect(text).toContain('"invoice_net_total":"75.00"');
    expect(text).toContain('"reclass_amount":"22.50"');
  });

  it("returns no booking_hint for a Kleinunternehmer (split on gross, no net reclass)", async () => {
    const result = await generateReceipt.handler({ ...baseArgs, kleinunternehmer: true } as never);
    const data = result.structuredContent!.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("booking_hint");
  });

  it("warns (no error) when entertainment_type is missing with an invoice present", async () => {
    const result = await generateReceipt.handler(baseArgs as never);
    const data = result.structuredContent!.data as { warnings?: string[] };
    expect(data.warnings?.join(" ")).toContain("entertainment_type fehlt");
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

describe("Modus Rechnung fehlt (ohne Quell-Beleg)", () => {
  const baseArgs = {
    date: "2026-07-29",
    location: "Beispiel-Gaststätte, Musterstadt",
    occasion: "Nachbesprechung der Vertriebsplanung 2026 mit Abstimmung der nächsten Schritte",
    participants: [{ name: "Max Mustermann", company: "Beispiel GmbH", relation: "external" }],
    host_name: "Max Mustermann",
    original_invoice_status: "missing_requested",
    entertainment_type: "business",
    missing_invoice_treatment: "practice_70_30_no_vat",
    gross_amount: 37.5,
    payment_evidence: { transaction_id_by_customer: 1001 },
    invoice_requests: [{ date: "2026-07-31", channel: "E-Mail" }],
    counterparty: "Beispiel-Gaststätte",
    kleinunternehmer: false,
  };

  function missingClient(txAmount = "-37.50", txDate = "2026-07-31", chartRows: unknown[] = []) {
    return {
      call: vi.fn(async (key: string) => {
        if (key === "transactionsGetIdByCustomer") return { data: { id_by_customer: "1001", amount: txAmount, booking_date: `${txDate} 00:00:00` } };
        if (key === "receiptsUpload") return { id_by_customer: 7001 };
        if (key === "transactionsAssignBatchReceipt") return { success: true };
        if (key === "settingsGetPostingaccounts") return { success: true, data: chartRows };
        return { success: true, data: [] };
      }) as BBClient["call"],
    };
  }

  it("uploads ONE receipt with amount = gross_amount and an empty vat_rate, then assigns it to the transaction", async () => {
    const c = missingClient();
    const [, upload] = createEntertainmentReceiptTools(c);
    const result = await upload.handler(baseArgs as never);
    const uploadCall = vi.mocked(c.call).mock.calls.find((x) => x[0] === "receiptsUpload")!;
    expect(uploadCall[1]).toMatchObject({ amount: 37.5, vat_rate: "", date: "2026-07-29", counterparty: "Beispiel-Gaststätte", currency: "EUR" });
    expect((uploadCall[1] as Record<string, unknown>).link_to_receipt_id_by_customer).toBeUndefined();
    expect(vi.mocked(c.call).mock.calls.filter((x) => x[0] === "receiptsUpload")).toHaveLength(1);
    expect(vi.mocked(c.call)).toHaveBeenCalledWith("transactionsAssignBatchReceipt", {
      transactions_to_receipts: [{ transaction_id_by_customer: 1001, receipt_id_by_customer: 7001 }],
    });
    const data = result.structuredContent!.data as Record<string, unknown>;
    expect(data.assigned_to_transaction).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain("booking_hint");
    expect(text).toContain("X R 57/09");
  });

  it("the uploaded PDF has the page plus the notes page", async () => {
    const c = missingClient();
    const [, upload] = createEntertainmentReceiptTools(c);
    await upload.handler(baseArgs as never);
    const uploadCall = vi.mocked(c.call).mock.calls.find((x) => x[0] === "receiptsUpload")!;
    const doc = await PDFDocument.load(Buffer.from((uploadCall[1] as { file: string }).file, "base64"));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it("gives SKR03 accounts 4650/4654 with amounts and 0_none when the chart is SKR03", async () => {
    const c = missingClient("-37.50", "2026-07-31", [{ postingaccount_number: "8400", name: "Erlöse 19 % USt" }]);
    const [, upload] = createEntertainmentReceiptTools(c);
    const result = await upload.handler(baseArgs as never);
    const data = result.structuredContent!.data as { booking_hint: Record<string, unknown> };
    expect(data.booking_hint).toMatchObject({
      chart: "SKR03",
      vat: "0_none",
      splits: [
        { kind: "deductible", postingaccount: 4650, amount: "26.25" },
        { kind: "non_deductible", postingaccount: 4654, amount: "11.25" },
      ],
    });
  });

  it("gives no account numbers when the chart cannot be determined", async () => {
    const c = missingClient();
    vi.mocked(c.call).mockImplementation((async (key: string) => {
      if (key === "transactionsGetIdByCustomer") return { data: { amount: "-37.50", booking_date: "2026-07-31 00:00:00" } };
      if (key === "receiptsUpload") return { id_by_customer: 7001 };
      if (key === "transactionsAssignBatchReceipt") return { success: true };
      throw new Error("HTTP 500");
    }) as BBClient["call"]);
    const [, upload] = createEntertainmentReceiptTools(c);
    const result = await upload.handler(baseArgs as never);
    const data = result.structuredContent!.data as { booking_hint: { chart: string; splits: Array<Record<string, unknown>> } };
    expect(data.booking_hint.chart).toBe("unknown");
    expect(data.booking_hint.splits.every((s) => !("postingaccount" in s))).toBe(true);
  });

  it("lists all missing fields in one error and uploads nothing", async () => {
    const c = missingClient();
    const [, upload] = createEntertainmentReceiptTools(c);
    await expect(
      upload.handler({
        ...baseArgs,
        gross_amount: undefined,
        counterparty: undefined,
        missing_invoice_treatment: undefined,
        payment_evidence: undefined,
        invoice_requests: undefined,
      } as never)
    ).rejects.toThrow(/gross_amount[\s\S]*counterparty|counterparty[\s\S]*gross_amount/);
    expect(vi.mocked(c.call).mock.calls.some((x) => x[0] === "receiptsUpload")).toBe(false);
  });

  it("does not ask for link_to_receipt_id_by_customer and rejects it in this mode", async () => {
    const c = missingClient();
    const [, upload] = createEntertainmentReceiptTools(c);
    await expect(upload.handler({ ...baseArgs, link_to_receipt_id_by_customer: 5 } as never)).rejects.toThrow(/source_receipt_id_by_customer/);
    expect(vi.mocked(c.call)).not.toHaveBeenCalled();
  });

  it("aborts before the upload when the transaction amount differs", async () => {
    const c = missingClient("-40.00");
    const [, upload] = createEntertainmentReceiptTools(c);
    await expect(upload.handler(baseArgs as never)).rejects.toThrow(/Betrag/);
    expect(vi.mocked(c.call).mock.calls.some((x) => x[0] === "receiptsUpload")).toBe(false);
  });

  it("accepts a difference of exactly 0,01 € to the transaction", async () => {
    const c = missingClient("-37.51");
    const [, upload] = createEntertainmentReceiptTools(c);
    await upload.handler(baseArgs as never);
    expect(vi.mocked(c.call).mock.calls.some((x) => x[0] === "receiptsUpload")).toBe(true);
  });

  it("aborts before the upload when the transaction cannot be loaded", async () => {
    const c = missingClient();
    vi.mocked(c.call).mockImplementation((async (key: string) => {
      if (key === "transactionsGetIdByCustomer") throw new Error("HTTP 404");
      return { id_by_customer: 7001 };
    }) as BBClient["call"]);
    const [, upload] = createEntertainmentReceiptTools(c);
    await expect(upload.handler(baseArgs as never)).rejects.toThrow(/Transaktion 1001/);
    expect(vi.mocked(c.call).mock.calls.some((x) => x[0] === "receiptsUpload")).toBe(false);
  });

  it("warns (no abort) when the transaction date is more than 3 days after the Bewirtung", async () => {
    const c = missingClient("-37.50", "2026-08-05");
    const [, upload] = createEntertainmentReceiptTools(c);
    const result = await upload.handler(baseArgs as never);
    expect(JSON.stringify(result)).toContain("Kalendertage");
  });

  it("does not warn about the date within 3 days", async () => {
    const c = missingClient("-37.50", "2026-08-01");
    const [, upload] = createEntertainmentReceiptTools(c);
    const result = await upload.handler(baseArgs as never);
    expect(JSON.stringify(result)).not.toContain("Kalendertage");
  });

  it("turns a failed assignment into a warning and keeps the upload", async () => {
    const c = missingClient();
    vi.mocked(c.call).mockImplementation((async (key: string) => {
      if (key === "transactionsGetIdByCustomer") return { data: { amount: "-37.50", booking_date: "2026-07-31 00:00:00" } };
      if (key === "receiptsUpload") return { id_by_customer: 7001 };
      if (key === "transactionsAssignBatchReceipt") throw new Error("boom");
      return { data: [] };
    }) as BBClient["call"]);
    const [, upload] = createEntertainmentReceiptTools(c);
    const result = await upload.handler(baseArgs as never);
    const data = result.structuredContent!.data as Record<string, unknown>;
    expect(data.id_by_customer).toBe(7001);
    expect(data.assigned_to_transaction).toBe(false);
    expect(JSON.stringify(result)).toContain("Zuordnung");
    expect(vi.mocked(c.call).mock.calls.filter((x) => x[0] === "receiptsUpload")).toHaveLength(1);
  });

  it("works with a payment description only (no transaction, no assignment)", async () => {
    const c = missingClient();
    const [, upload] = createEntertainmentReceiptTools(c);
    const result = await upload.handler({ ...baseArgs, payment_evidence: { description: "Barzahlung, Kassenbuch Nr. 12" } } as never);
    const keys = vi.mocked(c.call).mock.calls.map((x) => x[0]);
    expect(keys).not.toContain("transactionsGetIdByCustomer");
    expect(keys).not.toContain("transactionsAssignBatchReceipt");
    expect(result.structuredContent!.data).not.toHaveProperty("assigned_to_transaction");
  });

  it("rejects sole_proprietor_self in both tools", async () => {
    const c = missingClient();
    const [generate, upload] = createEntertainmentReceiptTools(c);
    await expect(generate.handler({ ...baseArgs, entertainment_type: "sole_proprietor_self", date: "29.07.2026" } as never)).rejects.toThrow(/Verpflegungs/);
    await expect(upload.handler({ ...baseArgs, entertainment_type: "sole_proprietor_self" } as never)).rejects.toThrow(/Verpflegungs/);
    expect(vi.mocked(c.call)).not.toHaveBeenCalled();
  });

  it("rejects sole_proprietor_self also with an invoice present", async () => {
    await expect(
      generateReceipt.handler({ ...(baseArgs as Record<string, unknown>), date: "24.09.2026", entertainment_type: "sole_proprietor_self", original_invoice_status: "present", gross_amount: undefined, food_net: 10, food_vat: 0.7 } as never)
    ).rejects.toThrow(/Verpflegungs/);
  });

  it("the pure generator returns pdf, warnings and a booking_hint without account numbers", async () => {
    const c = missingClient();
    const [generate] = createEntertainmentReceiptTools(c);
    const result = await generate.handler({ ...baseArgs, date: "29.07.2026" } as never);
    const text = JSON.stringify(result);
    expect(text).toContain("pdf_base64");
    expect(text).toContain("booking_hint");
    expect(text).toContain("warnings");
    expect(text).not.toContain('"postingaccount"');
    expect(vi.mocked(c.call)).not.toHaveBeenCalled();
  });
});

describe("item 4: present mode with a non-business entertainment_type", () => {
  type Data = { warnings?: string[]; booking_hint?: Record<string, unknown> };

  it("internal_employees: warns with 4140 and gives no 70/30 reclass hint", async () => {
    const result = await generateReceipt.handler({ ...baseArgs, entertainment_type: "internal_employees" } as never);
    const data = result.structuredContent!.data as Data;
    expect(data.warnings?.join(" ")).toContain("4140");
    expect(data.booking_hint).toBeDefined();
    expect(data.booking_hint).not.toHaveProperty("reclass_amount");
    expect(data.booking_hint).not.toHaveProperty("invoice_net_total");
    expect(String(data.booking_hint?.note)).toContain("kein 70/30");
  });

  it("business: keeps the reclass hint", async () => {
    const result = await generateReceipt.handler({ ...baseArgs, entertainment_type: "business" } as never);
    const data = result.structuredContent!.data as Data;
    expect(data.booking_hint).toMatchObject({ invoice_net_total: "75.00", reclass_amount: "22.50" });
  });

  it("internal_shareholder_managers without shareholder_manager_treatment: asks for it, no error", async () => {
    const result = await generateReceipt.handler({ ...baseArgs, entertainment_type: "internal_shareholder_managers" } as never);
    const data = result.structuredContent!.data as Data;
    expect(data.warnings?.join(" ")).toContain("shareholder_manager_treatment");
  });

  it("the upload tool gives the same non-business hint", async () => {
    const c = mockClient({ success: true, id_by_customer: 777 });
    const [, upload] = createEntertainmentReceiptTools(c);
    const result = await upload.handler({
      ...baseArgs,
      date: "2026-09-24",
      entertainment_type: "internal_employees",
      counterparty: "Beispiel-Gaststätte",
      link_to_receipt_id_by_customer: 530,
    } as never);
    const data = result.structuredContent!.data as Data;
    expect(data.warnings?.join(" ")).toContain("4140");
    expect(data.booking_hint).not.toHaveProperty("reclass_amount");
  });
});
