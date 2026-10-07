import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createEntertainmentReceiptTools } from "./entertainment-receipt.js";
import { sha256Hex } from "./entertainment-receipt-append.js";

// All data below is invented.
async function makeOriginal(attach = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText("Beispiel-Restaurant, Rechnung 000001, Gesamt 44,00", { x: 10, y: 150, size: 9, font });
  if (attach) await doc.attach(Buffer.from("{}"), "testdata.json", { mimeType: "application/json" });
  return doc.save();
}

const baseArgs = {
  date: "2026-03-14",
  location: "Beispiel-Restaurant, Musterstraße 1, 12345 Musterstadt",
  occasion: "Gespräch mit Netzwerkpartnern zur Planung einer gemeinsamen Veranstaltung",
  host_name: "Max Mustermann",
  host_role: "Geschäftsführer",
  participants: [{ name: "Max Mustermann" }, { name: "Erika Beispiel" }, { name: "Hans Testmann" }],
  counterparty: "Beispiel-Restaurant GmbH",
  company_name: "Beispiel Consulting GmbH",
  company_address: "Beispielweg 2, 12345 Musterstadt",
  bill_reference: "000001",
  receipt_number: "R-0001",
  food_net: 30,
  food_vat: 2.1,
  drinks_net: 10,
  drinks_vat: 1.9,
  tip: 0,
  kleinunternehmer: false,
  source_receipt_id_by_customer: 1001,
};

interface Setup {
  original?: Uint8Array;
  data?: Record<string, unknown>;
  list?: unknown[] | Error;
  getError?: Error;
  uploadError?: Error;
  uploadResponse?: Record<string, unknown>;
}

function setup(opts: Setup = {}) {
  const calls: Array<{ key: string; params: Record<string, unknown> }> = [];
  const call = vi.fn(async (key: string, params: Record<string, unknown>) => {
    calls.push({ key, params });
    if (key === "receiptsGetIdByCustomer") {
      if (opts.getError) throw opts.getError;
      const bytes = opts.original ?? (await makeOriginal());
      return {
        data: {
          id_by_customer: "1001",
          filename: "beleg1001",
          date: "2026-03-14",
          counterparty: "Beispiel-Restaurant GmbH",
          invoicenumber: "000001",
          amount: "44.00",
          type: "invoice inbound",
          account: "1200",
          file_type: "pdf",
          file_content: Buffer.from(bytes).toString("base64"),
          ...opts.data,
        },
      };
    }
    if (key === "receiptsUpload") {
      if (opts.uploadError) throw opts.uploadError;
      // Live shape per BHB spec: id_by_customer/filename at the top level.
      return opts.uploadResponse ?? { success: true, message: "", id_by_customer: "1042", filename: "receipt567" };
    }
    if (key === "receiptsGet") {
      if (opts.list instanceof Error) throw opts.list;
      return { data: opts.list ?? [] };
    }
    throw new Error(`unexpected call ${key}`);
  });
  const [, tool] = createEntertainmentReceiptTools({ call } as unknown as BBClient);
  const run = (extra: Record<string, unknown> = {}) => tool.handler({ ...baseArgs, ...extra } as never);
  const uploads = () => calls.filter((c) => c.key === "receiptsUpload");
  return { run, calls, uploads, call };
}

const dataOf = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent!.data as Record<string, any>;

describe("generate_and_upload_entertainment_receipt with source_receipt_id_by_customer", () => {
  it("uploads exactly one merged receipt (original + cover) and leaves the original alone", async () => {
    const original = await makeOriginal(true);
    const { run, calls, uploads } = setup({ original });
    const data = dataOf(await run());

    expect(uploads()).toHaveLength(1);
    expect(calls.map((c) => c.key)).not.toContain("receiptsDeleteIdByCustomer");
    const up = uploads()[0].params;
    expect(up.link_to_receipt_id_by_customer).toBeUndefined();
    expect(up.file_name).toBe("beleg1001_mit_Bewirtungsangaben.pdf");
    expect(up).toMatchObject({
      type: "invoice inbound",
      date: "2026-03-14",
      invoice_number: "000001",
      amount: 44,
      counterparty: "Beispiel-Restaurant GmbH",
      account: 1200,
      vat_rate: "",
    });
    const merged = await PDFDocument.load(Buffer.from(up.file as string, "base64"));
    expect(merged.getPageCount()).toBe(2);

    expect(data).toMatchObject({
      status: "ok",
      new_receipt_id_by_customer: 1042,
      original_receipt_id_by_customer: 1001,
      original_deleted: false,
      pages_before: 1,
      pages_after: 2,
      original_sha256: sha256Hex(original),
      duplicates_found: [],
      checks: {
        page_count_ok: true,
        text_contains_original_ok: true,
        text_contains_entertainment_ok: true,
        embedded_files_preserved: true,
      },
    });
    expect(data.next_step_hint).toContain("set_receipt_deleted");
  });

  it("prints the original's sha256 on the cover when include_original_hash is on (default)", async () => {
    const original = await makeOriginal();
    const { run, uploads } = setup({ original });
    await run();
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(uploads()[0].params.file as string, "base64")));
    const { text } = await extractText(pdf, { mergePages: false });
    expect((text as string[])[1]).toContain(sha256Hex(original));
  });

  it("omits the hash when include_original_hash is false", async () => {
    const original = await makeOriginal();
    const { run, uploads } = setup({ original });
    await run({ include_original_hash: false });
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(uploads()[0].params.file as string, "base64")));
    const { text } = await extractText(pdf, { mergePages: false });
    expect((text as string[])[1]).not.toContain(sha256Hex(original));
  });

  it("computes the worked example: 28,00 deductible, 12,00 non-deductible, 4,00 VAT", async () => {
    const data = dataOf(await setup().run());
    expect(data.amounts).toMatchObject({ gross_total: 44, vat_total: 4, deductible: 28, non_deductible: 12 });
  });

  it("rejects source + bill_file", async () => {
    const { run, calls } = setup();
    await expect(run({ bill_file: "AAAA", bill_file_type: "pdf" })).rejects.toThrow(/bill_file/);
    expect(calls).toHaveLength(0);
  });

  it("rejects source + link_to_receipt_id_by_customer", async () => {
    const { run, calls } = setup();
    await expect(run({ link_to_receipt_id_by_customer: 5 })).rejects.toThrow(/link_to_receipt_id_by_customer/);
    expect(calls).toHaveLength(0);
  });

  it("aborts on an amount mismatch with the difference, no upload", async () => {
    const { run, uploads } = setup({ data: { amount: "50.00" } });
    await expect(run()).rejects.toThrow(/6,00|6\.00/);
    expect(uploads()).toHaveLength(0);
  });

  it("aborts when the original cannot be loaded", async () => {
    const { run, uploads } = setup({ getError: new Error("HTTP 400 - invalid id") });
    await expect(run()).rejects.toThrow(/1001/);
    expect(uploads()).toHaveLength(0);
  });

  it("aborts when the original has no file", async () => {
    const { run, uploads } = setup({ data: { file_content: undefined } });
    await expect(run()).rejects.toThrow(/keine Datei/);
    expect(uploads()).toHaveLength(0);
  });

  it("aborts on an unsupported file type", async () => {
    const { run, uploads } = setup({ original: new Uint8Array(Buffer.from("nur Text")) });
    await expect(run()).rejects.toThrow(/nicht unterstützt/);
    expect(uploads()).toHaveLength(0);
  });

  it("aborts on a truncated pdf", async () => {
    const full = await makeOriginal();
    const { run, uploads } = setup({ original: full.slice(0, 80) });
    await expect(run()).rejects.toThrow(/defekt/);
    expect(uploads()).toHaveLength(0);
  });

  it("aborts when the original exceeds the size limit", async () => {
    const { run, uploads } = setup({ data: { file_content: "A".repeat(21 * 1024 * 1024) } });
    await expect(run()).rejects.toThrow(/15 MB/);
    expect(uploads()).toHaveLength(0);
  });

  it("reports an upload failure without further calls and without retrying", async () => {
    const { run, calls, uploads } = setup({ uploadError: new Error("timeout") });
    await expect(run()).rejects.toThrow(/list_receipts/);
    expect(uploads()).toHaveLength(1);
    expect(calls.map((c) => c.key)).toEqual(["receiptsGetIdByCustomer", "receiptsUpload"]);
  });

  it("reads the new id from the top-level upload response and uses it in the hint", async () => {
    const data = dataOf(await setup().run());
    expect(data.new_receipt_id_by_customer).toBe(1042);
    expect(data.next_step_hint).toContain("auf 1042 buchen");
    expect(JSON.stringify(data)).not.toContain("undefined");
  });

  it("still accepts the id nested under data", async () => {
    const data = dataOf(await setup({ uploadResponse: { data: { id_by_customer: "77" } } }).run());
    expect(data.new_receipt_id_by_customer).toBe(77);
  });

  it("resolves the id via the internal filename when the upload response has no id", async () => {
    const row = { id_by_customer: "521", filename: "receipt567", counterparty: "Beispiel-Restaurant GmbH", date: "2026-03-14", amount: "44.00", deleted: "0" };
    const { run } = setup({ uploadResponse: { success: true, filename: "receipt567" }, list: [row] });
    const data = dataOf(await run());
    expect(data.new_receipt_id_by_customer).toBe(521);
    expect(data.duplicates_found).toEqual([]);
    expect(data.next_step_hint).toContain("auf 521 buchen");
  });

  it("warns instead of printing 'undefined' when the new id cannot be determined", async () => {
    const { run } = setup({ uploadResponse: { success: true }, list: [] });
    const data = dataOf(await run());
    expect(data.new_receipt_id_by_customer).toBeNull();
    expect(data.warnings.join(" ")).toMatch(/Beleg-ID/);
    expect(JSON.stringify(data)).not.toContain("undefined");
  });

  it("lists only real duplicates (not the original, not the new receipt), with reasons and link info", async () => {
    const base = { counterparty: "Beispiel-Restaurant GmbH", date: "2026-03-14", amount: "44.00", deleted: "0" };
    const original = { ...base, id_by_customer: "1001", invoicenumber: "112693" };
    const oldLinkedPage = { ...base, id_by_customer: "513", invoicenumber: "000001", link_to_receipt_id_by_customer: "1001" };
    const newReceipt = { ...base, id_by_customer: "1042", invoicenumber: "000001" };
    const otherAmount = { ...base, id_by_customer: "1011", amount: "12.00" };
    const otherParty = { ...base, id_by_customer: "1012", counterparty: "Anderer Lieferant" };
    const deleted = { ...base, id_by_customer: "1013", deleted: "1" };
    const { run } = setup({ list: [original, oldLinkedPage, newReceipt, otherAmount, otherParty, deleted] });
    const data = dataOf(await run());
    expect(data.duplicates_found).toHaveLength(1);
    expect(data.duplicates_found[0]).toMatchObject({
      id_by_customer: "513",
      linked_to_original: true,
      matches: expect.arrayContaining(["date", "counterparty", "amount", "linked_to_original"]),
    });
  });

  it("matches duplicates on date + counterparty + amount even when the invoice number differs", async () => {
    const row = { id_by_customer: "900", counterparty: "beispiel-restaurant gmbh", date: "2026-03-14", amount: "44.00", invoicenumber: "XYZ", deleted: "0" };
    const data = dataOf(await setup({ list: [row] }).run());
    expect(data.duplicates_found).toEqual([expect.objectContaining({ id_by_customer: "900", linked_to_original: false })]);
    expect(data.duplicates_found[0].matches).not.toContain("invoicenumber");
  });

  it("never deletes anything", async () => {
    const row = { id_by_customer: "900", counterparty: "Beispiel-Restaurant GmbH", date: "2026-03-14", amount: "44.00", deleted: "0" };
    const { run, calls } = setup({ list: [row] });
    await run();
    expect(calls.map((c) => c.key).filter((k) => k.includes("elete"))).toEqual([]);
  });

  it("still succeeds with a warning when the duplicate check fails", async () => {
    const data = dataOf(await setup({ list: new Error("boom") }).run());
    expect(data.status).toBe("ok");
    expect(data.warnings.join(" ")).toMatch(/Duplikat/);
  });

  it("falls back to the form values when keep_original_metadata is false", async () => {
    const { run, uploads } = setup({ data: { counterparty: "Anderer Name", amount: "44.00" } });
    await run({ keep_original_metadata: false });
    expect(uploads()[0].params).toMatchObject({ counterparty: "Beispiel-Restaurant GmbH", date: "2026-03-14", amount: 44 });
  });

  it("does not need a counterparty argument in source mode", async () => {
    const { run, uploads } = setup();
    await run({ counterparty: undefined });
    expect(uploads()[0].params.counterparty).toBe("Beispiel-Restaurant GmbH");
  });

  it("makes at most get + upload + list calls (rate limit headroom)", async () => {
    const { run, calls } = setup();
    await run();
    expect(calls.map((c) => c.key)).toEqual(["receiptsGetIdByCustomer", "receiptsUpload", "receiptsGet"]);
  });
});

describe("legacy flows are unchanged", () => {
  it("Fall B still requires link_to_receipt_id_by_customer", async () => {
    const { run } = setup();
    await expect(run({ source_receipt_id_by_customer: undefined })).rejects.toThrow(/link_to_receipt_id_by_customer is required/);
  });

  it("Fall B returns the id from the top-level upload response", async () => {
    const { run } = setup();
    const data = dataOf(await run({ source_receipt_id_by_customer: undefined, link_to_receipt_id_by_customer: 1001 }));
    expect(data.id_by_customer).toBe("1042");
  });

  it("Fall B uploads a standalone page with the link", async () => {
    const { run, uploads } = setup();
    await run({ source_receipt_id_by_customer: undefined, link_to_receipt_id_by_customer: 1001 });
    expect(uploads()[0].params).toMatchObject({ link_to_receipt_id_by_customer: 1001, file_name: "Bewirtungsangaben_000001.pdf" });
  });
});
