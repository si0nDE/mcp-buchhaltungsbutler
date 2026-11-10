import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createMixedReceiptTools } from "./mixed-receipt.js";
import { inkLines, makeFakeScanPdf } from "./mixed-receipt-scan.fixture.js";

async function original(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    id_by_customer: "42",
    invoicenumber: "BEISPIEL-0815",
    counterparty: "Beispielmarkt",
    date: "2026-10-01",
    amount: "23.45",
    deleted: "0",
    filename: "scan.pdf",
    file_type: "pdf",
    file_content: Buffer.from(await makeFakeScanPdf({ inkRows: inkLines(8, 30, 20, 20) })).toString("base64"),
    ...overrides,
  };
}

function fakeClient(o: {
  original: Record<string, unknown>;
  receiptsGet?: Array<Record<string, unknown>>;
  upload?: unknown;
  commentFails?: boolean;
  // Row the list shows after the upload; null = the new receipt is not visible (yet).
  uploadedRow?: Record<string, unknown> | null;
  deleteFails?: boolean;
}) {
  let uploaded = false;
  const newRow = { id_by_customer: "777", invoicenumber: "BEISPIEL-0815", deleted: "0", amount: "6.42" };
  const call = vi.fn(async (key: string, _params?: unknown, _options?: unknown) => {
    if (key === "receiptsGetIdByCustomer") return { success: true, data: o.original };
    if (key === "receiptsGet") {
      const extra = uploaded && o.uploadedRow !== null ? [o.uploadedRow ?? newRow] : [];
      return { success: true, data: [...(o.receiptsGet ?? []), ...extra] };
    }
    if (key === "receiptsUpload") {
      uploaded = true;
      return o.upload ?? { success: true, data: { id_by_customer: 777 } };
    }
    if (key === "commentsAdd") {
      if (o.commentFails) throw new Error("HTTP 500");
      return { success: true };
    }
    if (key === "receiptsDeleteIdByCustomer") {
      if (o.deleteFails) throw new Error("Beleg ist festgeschrieben");
      return { success: true };
    }
    throw new Error(`unexpected endpoint ${key}`);
  });
  return { client: { call } as unknown as BBClient, call };
}

const args = {
  source_receipt_id_by_customer: 42,
  redact_lines: ["3-5", 7],
  positions: [
    { description: "Milch 1 l", quantity_text: "2 × 0,99 €", gross: 1.98, vat_rate: 7 },
    { description: "Mineralwasser 0,5 l", quantity_text: "6 × 0,49 €", gross: 2.94, vat_rate: 19 },
    { description: "Pfand", quantity_text: "6 × 0,25 €", gross: 1.5, vat_rate: 19 },
  ],
  receipt_total: 23.45,
  receipt_vat_lines: [
    { vat_rate: 7, net: 15.0, vat: 1.05 },
    { vat_rate: 19, net: 6.22, vat: 1.18 },
  ],
  merchant: { name: "Beispielmarkt", address: "Musterstraße 1, 12345 Musterstadt" },
  receipt_number: "BEISPIEL-0815",
  receipt_datetime: "2026-10-01 10:15",
  payment_method: "Karte",
  paid_by: "Erika Beispiel",
  occasion: "Milch und Wasser für Kundenbesprechungen im Büro",
  company_name: "Beispiel GmbH",
  company_address: "Beispielweg 2, 12345 Musterstadt",
};

type Data = Record<string, unknown>;
const data = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent!.data as Data;

describe("prepare_mixed_receipt", () => {
  it("shows the numbered receipt and the questions to ask first", async () => {
    const { client, call } = fakeClient({ original: await original() });
    const [prepare] = createMixedReceiptTools(client);
    expect(prepare.name).toBe("prepare_mixed_receipt");
    expect(prepare.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    const result = await prepare.handler({ source_receipt_id_by_customer: 42 } as never);
    const d = data(result);
    expect(d.line_count).toBe(8);
    expect((d.questions as string[]).length).toBe(6);
    expect((d.original as Data).display_ref).toBe("Rg. BEISPIEL-0815 · Beispielmarkt · 01.10.2026 · 23,45 €");
    expect(d.original_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((result.images as string[]).length).toBeGreaterThan(0);
    expect(call.mock.calls.map((c) => c[0])).toEqual(["receiptsGetIdByCustomer"]);
  });

  it("accepts a tall band (logo, QR code), names it and warns", async () => {
    const rows: Array<[number, number]> = [[20, 50], [70, 220], [240, 270], [290, 320], [340, 370], [390, 420], [440, 470]];
    const pdf = await makeFakeScanPdf({ inkRows: rows });
    const { client } = fakeClient({ original: await original({ file_content: Buffer.from(pdf).toString("base64") }) });
    const result = await createMixedReceiptTools(client)[0].handler({ source_receipt_id_by_customer: 42 } as never);
    const d = data(result);
    expect(d.tall_lines).toEqual([2]);
    expect((d.warnings as string[]).join(" ")).toMatch(/Zeile\(n\) 2 sind ungewöhnlich hoch/);
  });

  it("reports no tall lines for a normal receipt", async () => {
    const { client } = fakeClient({ original: await original() });
    const d = data(await createMixedReceiptTools(client)[0].handler({ source_receipt_id_by_customer: 42 } as never));
    expect(d.tall_lines).toEqual([]);
    expect(d.warnings).toBeUndefined();
  });

  it("still aborts with fewer than 5 lines", async () => {
    const pdf = await makeFakeScanPdf({ inkRows: inkLines(4) });
    const { client } = fakeClient({ original: await original({ file_content: Buffer.from(pdf).toString("base64") }) });
    await expect(createMixedReceiptTools(client)[0].handler({ source_receipt_id_by_customer: 42 } as never)).rejects.toThrow(/Nur 4 Textzeilen/);
  });

  it("refuses a rotated original with the geometry reason", async () => {
    const pdf = await makeFakeScanPdf({ inkRows: inkLines(8), rotate: 90 });
    const { client } = fakeClient({ original: await original({ file_content: Buffer.from(pdf).toString("base64") }) });
    await expect(createMixedReceiptTools(client)[0].handler({ source_receipt_id_by_customer: 42 } as never)).rejects.toThrow(/gedreht/);
  });

  it("refuses a deleted original and a non-PDF original", async () => {
    const deleted = fakeClient({ original: await original({ deleted: "1" }) });
    await expect(createMixedReceiptTools(deleted.client)[0].handler({ source_receipt_id_by_customer: 42 } as never)).rejects.toThrow(/gelöscht/);
    const xml = fakeClient({ original: await original({ file_content: Buffer.from("<?xml version='1.0'?><x/>").toString("base64") }) });
    await expect(createMixedReceiptTools(xml.client)[0].handler({ source_receipt_id_by_customer: 42 } as never)).rejects.toThrow(/keine PDF/);
  });
});

describe("generate_mixed_receipt", () => {
  it("previews page and receipt without uploading", async () => {
    const { client, call } = fakeClient({ original: await original() });
    const [, generate] = createMixedReceiptTools(client);
    expect(generate.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    const result = await generate.handler(args as never);
    const d = data(result);
    expect(d.status).toBe("preview");
    expect(d.redacted_blocks).toEqual(["3-5", "7"]);
    expect((d.amounts as Data).reimbursement).toBe(6.42);
    expect((d.amounts as Data).input_vat_total).toBe(0.84);
    expect((d.warnings as string[]).join(" ")).toMatch(/Bestätigung ausstehend/);
    const images = d.images as Array<Data>;
    expect(images[0]).toEqual({ kind: "page", page: 1 });
    expect(images.some((i) => i.kind === "bon")).toBe(true);
    expect((result.images as string[]).length).toBe(images.length);
    expect(call.mock.calls.map((c) => c[0])).not.toContain("receiptsUpload");
  });

  it("adds the tall-line warning and the Inhaber hint to the preview", async () => {
    const rows: Array<[number, number]> = [[20, 50], [70, 220], [240, 270], [290, 320], [340, 370], [390, 420], [440, 470], [490, 520]];
    const pdf = await makeFakeScanPdf({ inkRows: rows });
    const { client } = fakeClient({ original: await original({ file_content: Buffer.from(pdf).toString("base64") }) });
    const d = data(await createMixedReceiptTools(client)[1].handler(args as never));
    expect((d.warnings as string[]).join(" ")).toMatch(/Zeile\(n\) 2 sind ungewöhnlich hoch/);
    expect((d.booking_hint as Data).inhaber).toMatch(/Privateinlage/);
  });

  it("joins line breaks in free text with a comma", async () => {
    const { client, call } = fakeClient({ original: await original() });
    await createMixedReceiptTools(client)[2].handler({
      ...args,
      merchant: { name: "Beispielmarkt", address: "Musterstraße 1\r\n12345 Musterstadt" },
      confirm: true,
    } as never);
    const params = call.mock.calls.find((c) => c[0] === "receiptsUpload")![1] as Data;
    const pdfText = (await extractText(await getDocumentProxy(new Uint8Array(Buffer.from(params.file as string, "base64"))), { mergePages: true })).text;
    expect(pdfText).toContain("Musterstraße 1, 12345 Musterstadt");
    expect(params.counterparty).toBe("Beispielmarkt");
  });

  it("names the field and character when a free text is not encodable, before loading anything", async () => {
    const { client, call } = fakeClient({ original: await original() });
    const upload = createMixedReceiptTools(client)[2];
    await expect(upload.handler({ ...args, paid_by: "Łukasz Beispiel", confirm: true } as never)).rejects.toThrow(/paid_by enthält das Zeichen "Ł".*Es wurde nichts erzeugt/);
    expect(call).not.toHaveBeenCalled();
    await expect(createMixedReceiptTools(client)[1].handler({ ...args, positions: [{ ...args.positions[0], description: "Kaffee ☕" }] } as never)).rejects.toThrow(/positions\[0\]\.description enthält das Zeichen "☕"/);
    expect(call).not.toHaveBeenCalled();
  });

  it("warns when the receipt number differs from BuchhaltungsButler", async () => {
    const { client } = fakeClient({ original: await original({ invoicenumber: "4711" }) });
    const result = await createMixedReceiptTools(client)[1].handler(args as never);
    expect((data(result).warnings as string[]).join(" ")).toMatch(/weicht von der Rechnungsnummer des Originals in BHB ab \('4711'\)/);
  });

  it("rejects a vague occasion and a line outside the receipt", async () => {
    const { client } = fakeClient({ original: await original() });
    const [, generate] = createMixedReceiptTools(client);
    await expect(generate.handler({ ...args, occasion: "Büro" } as never)).rejects.toThrow(/Anlass/);
    await expect(generate.handler({ ...args, redact_lines: [9] } as never)).rejects.toThrow(/außerhalb der Zeilen 1-8/);
  });
});

describe("generate_and_upload_mixed_receipt", () => {
  it("does nothing without confirm: true", async () => {
    const { client, call } = fakeClient({ original: await original() });
    const upload = createMixedReceiptTools(client)[2];
    expect(upload.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    await expect(upload.handler({ ...args, confirm: false } as never)).rejects.toThrow(/confirm/);
    expect(call).not.toHaveBeenCalled();
  });

  it("uploads with explicit fields, comments on the original and soft-deletes it once the new receipt is verified", async () => {
    const { client, call } = fakeClient({
      original: await original(),
      receiptsGet: [
        { id_by_customer: "42", invoicenumber: "BEISPIEL-0815", deleted: "0" },
        { id_by_customer: "50", invoicenumber: "BEISPIEL-0815", deleted: "1" },
      ],
    });
    const result = await createMixedReceiptTools(client)[2].handler({ ...args, confirm: true } as never);
    const uploadCall = call.mock.calls.find((c) => c[0] === "receiptsUpload")!;
    const params = uploadCall[1] as Data;
    expect(params).toMatchObject({
      type: "invoice inbound",
      counterparty: "Beispielmarkt",
      invoice_number: "BEISPIEL-0815",
      date: "2026-10-01",
      amount: 6.42,
      currency: "EUR",
      file_name: "Auslagenbeleg_2026-10-01_Beispielmarkt.pdf",
    });
    expect(params.vat_rate).toBeUndefined();
    const pdfText = (await extractText(await getDocumentProxy(new Uint8Array(Buffer.from(params.file as string, "base64"))), { mergePages: true })).text;
    expect(pdfText).toContain("Auslagenbeleg");
    const comment = call.mock.calls.find((c) => c[0] === "commentsAdd")![1] as Data;
    expect(comment.receipt_id_by_customer).toBe(42);
    expect(comment.comment_text).toMatch(/Original zur geschwärzten Fassung/);
    const keys = call.mock.calls.map((c) => c[0]);
    const deleteCall = call.mock.calls.find((c) => c[0] === "receiptsDeleteIdByCustomer")!;
    expect(deleteCall[2]).toEqual({ idSuffix: 42 });
    // order: upload, comment on the original, check that the new receipt is there, only then delete
    expect(keys.indexOf("commentsAdd")).toBeGreaterThan(keys.indexOf("receiptsUpload"));
    expect(keys.lastIndexOf("receiptsGet")).toBeGreaterThan(keys.indexOf("receiptsUpload"));
    expect(keys.indexOf("receiptsDeleteIdByCustomer")).toBeGreaterThan(keys.lastIndexOf("receiptsGet"));
    expect(keys.filter((k) => k === "receiptsDeleteIdByCustomer")).toHaveLength(1);
    const d = data(result);
    expect(d).toMatchObject({
      status: "uploaded",
      new_receipt_id_by_customer: 777,
      new_receipt_verified: true,
      original_receipt_id_by_customer: 42,
      original_deleted: true,
      comment_added: true,
    });
    expect((d.next_steps as string[]).join(" ")).toMatch(/soft-gelöscht/);
  });

  it("does not delete the original when the new receipt cannot be found", async () => {
    const { client, call } = fakeClient({ original: await original(), uploadedRow: null });
    const d = data(await createMixedReceiptTools(client)[2].handler({ ...args, confirm: true } as never));
    expect(call.mock.calls.map((c) => c[0])).not.toContain("receiptsDeleteIdByCustomer");
    expect(d).toMatchObject({ status: "uploaded", new_receipt_verified: false, original_deleted: false });
    expect((d.next_steps as string[]).join(" ")).toMatch(/list_receipts/);
  });

  it("does not delete the original when the receipt found has a different amount", async () => {
    const { client, call } = fakeClient({
      original: await original(),
      uploadedRow: { id_by_customer: "777", invoicenumber: "BEISPIEL-0815", deleted: "0", amount: "99.00" },
    });
    const d = data(await createMixedReceiptTools(client)[2].handler({ ...args, confirm: true } as never));
    expect(call.mock.calls.map((c) => c[0])).not.toContain("receiptsDeleteIdByCustomer");
    expect(d.new_receipt_verified).toBe(false);
  });

  it("reports a failed deletion without failing the upload and says what to do", async () => {
    const { client } = fakeClient({ original: await original(), deleteFails: true });
    const d = data(await createMixedReceiptTools(client)[2].handler({ ...args, confirm: true } as never));
    expect(d).toMatchObject({ status: "uploaded", new_receipt_verified: true, original_deleted: false });
    expect(d.original_delete_error).toMatch(/festgeschrieben/);
    expect((d.next_steps as string[]).join(" ")).toMatch(/set_receipt_deleted/);
  });

  it("never deletes anything in the preview tools", async () => {
    const { client, call } = fakeClient({ original: await original() });
    const [prepare, generate] = createMixedReceiptTools(client);
    await prepare.handler({ source_receipt_id_by_customer: 42 } as never);
    await generate.handler(args as never);
    expect(call.mock.calls.map((c) => c[0])).not.toContain("receiptsDeleteIdByCustomer");
  });

  it("sets vat_rate when only one rate is involved", async () => {
    const { client, call } = fakeClient({ original: await original() });
    await createMixedReceiptTools(client)[2].handler({ ...args, positions: [args.positions[0]], confirm: true } as never);
    expect((call.mock.calls.find((c) => c[0] === "receiptsUpload")![1] as Data).vat_rate).toBe(7);
  });

  it("stops on another active receipt with the same number", async () => {
    const { client, call } = fakeClient({ original: await original(), receiptsGet: [{ id_by_customer: "99", invoicenumber: "BEISPIEL-0815", deleted: "0", counterparty: "Beispielmarkt", date: "2026-10-01", amount: "6.42" }] });
    await expect(createMixedReceiptTools(client)[2].handler({ ...args, confirm: true } as never)).rejects.toThrow(/schon einen aktiven Beleg/);
    expect(call.mock.calls.map((c) => c[0])).not.toContain("receiptsUpload");
  });

  it("reports the upload even without an id and when the comment fails", async () => {
    const { client } = fakeClient({ original: await original(), upload: { success: true }, commentFails: true });
    const d = data(await createMixedReceiptTools(client)[2].handler({ ...args, confirm: true } as never));
    expect(d.new_receipt_id_by_customer).toBeNull();
    expect(d.new_receipt_verified).toBe(true);
    expect(d.comment_added).toBe(false);
    expect((d.next_steps as string[]).join(" ")).toMatch(/add_comment/);
  });
});
