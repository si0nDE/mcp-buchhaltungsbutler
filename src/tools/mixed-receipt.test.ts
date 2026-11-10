import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createMixedReceiptTools } from "./mixed-receipt.js";
import { neutralPostingText } from "./mixed-receipt-booking.js";
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
  // Read endpoints of the booking proposal and the Auslagenkonto detection. Unlisted endpoints still throw.
  accounts?: Array<Record<string, unknown>>;
  accountsFail?: boolean;
  newReceiptRow?: Record<string, unknown>;
  assigned?: Array<Record<string, unknown>>;
  transactions?: Array<Record<string, unknown>>;
  postings?: Array<Record<string, unknown>>;
  failEndpoint?: string;
}) {
  let uploaded = false;
  const newRow = { id_by_customer: "777", invoicenumber: "BEISPIEL-0815", deleted: "0", amount: "6.42" };
  const call = vi.fn(async (key: string, _params?: unknown, _options?: unknown) => {
    if (key === o.failEndpoint) throw new Error("HTTP 500");
    if (key === "receiptsGetIdByCustomer") {
      const id = (_options as { idSuffix?: number } | undefined)?.idSuffix;
      if (id === 777) return { success: true, data: { id_by_customer: "777", account: "", amount_paid: "0.00", ...o.newReceiptRow } };
      return { success: true, data: o.original };
    }
    if (key === "accountsGet") {
      if (o.accountsFail) throw new Error("HTTP 500");
      return { success: true, data: o.accounts ?? [] };
    }
    if (key === "receiptsAssignedTransactionsGet") return { success: true, data: o.assigned ?? [] };
    if (key === "transactionsGet") return { success: true, data: o.transactions ?? [] };
    if (key === "postingsGet") return { success: true, data: o.postings ?? [] };
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

// ---- Auslagenkonto + Buchungsvorschlag -------------------------------------------------------------------------------------------------

const ACCOUNTS = [
  { name: "Girokonto", postingaccount_number: "1200" },
  { name: "Verbindlichkeiten Gesellschafter Erika Beispiel", postingaccount_number: "745" },
];
const upload = (client: BBClient, extra: Record<string, unknown> = {}) => createMixedReceiptTools(client)[2].handler({ ...args, confirm: true, ...extra } as never);
const uploadParams = (call: ReturnType<typeof fakeClient>["call"]) => call.mock.calls.find((c) => c[0] === "receiptsUpload")![1] as Data;
const proposal = (d: Data) => d.booking_proposal as Data & { steps: string[]; notes: string[]; calls: Array<{ tool: string; arguments: Data }> };

const savedPolicyFile = process.env.BHB_POLICY_FILE;
afterEach(() => {
  process.env.BHB_POLICY_FILE = savedPolicyFile;
});
async function setGewinnermittlung(value: "euer" | "bilanz" | null) {
  const dir = await mkdtemp(join(tmpdir(), "bhb-mixed-policy-"));
  const file = join(dir, "policy.json");
  await writeFile(file, JSON.stringify({ tax_profile: { kleinunternehmer: false, gewinnermittlung: value } }));
  process.env.BHB_POLICY_FILE = file;
}

const EXPECTED_SPLITS = [
  { amount: "1.98", postingaccount: 4653, postingtext: "Milch", vat: "7_pre", receipt_id_by_customer: 777 },
  { amount: "4.44", postingaccount: 4653, postingtext: "Mineralwasser, Pfand", vat: "19_pre", receipt_id_by_customer: 777 },
];
const ASSIGNED = [{ id_by_customer: "9001", amount: "-6.42", to_from: "Erika Beispiel", booking_date: "2026-10-01" }];

describe("Auslagenkonto im Vorschau- und Upload-Werkzeug", () => {
  it("the preview names the auto-detected Auslagenkonto with its effect", async () => {
    const { client } = fakeClient({ original: await original(), accounts: ACCOUNTS });
    const d = data(await createMixedReceiptTools(client)[1].handler(args as never));
    expect(d.auslagenkonto).toMatchObject({ number: 745, name: "Verbindlichkeiten Gesellschafter Erika Beispiel", source: "auto" });
    expect((d.auslagenkonto as Data).effect).toMatch(/Beleg erzeugt Zahlung/);
  });

  it("the preview says why there is none (no match, several, detection failed)", async () => {
    const none = fakeClient({ original: await original(), accounts: [ACCOUNTS[0]] });
    const dNone = data(await createMixedReceiptTools(none.client)[1].handler(args as never));
    expect(dNone.auslagenkonto).toMatchObject({ number: null, source: "none" });
    expect((dNone.auslagenkonto as Data).effect).toMatch(/Kein Konto/);
    const several = fakeClient({ original: await original(), accounts: [...ACCOUNTS, { name: "Auslagen Erika Beispiel", postingaccount_number: "733" }] });
    const dSeveral = data(await createMixedReceiptTools(several.client)[1].handler(args as never));
    expect((dSeveral.auslagenkonto as Data).effect).toMatch(/mehrere.*Verbindlichkeiten Gesellschafter Erika Beispiel \(745\).*Auslagen Erika Beispiel \(733\)/);
    const failing = fakeClient({ original: await original(), accountsFail: true });
    const dFail = data(await createMixedReceiptTools(failing.client)[1].handler(args as never));
    expect(dFail.auslagenkonto).toMatchObject({ source: "none" });
    expect((dFail.warnings as string[]).join(" ")).toMatch(/Auslagenkonto.*nicht ermittelt/);
  });

  it("an explicit auslagenkonto skips detection; without_auslagenkonto opts out; both together are rejected", async () => {
    const given = fakeClient({ original: await original() });
    const dGiven = data(await createMixedReceiptTools(given.client)[1].handler({ ...args, auslagenkonto: 741 } as never));
    expect(dGiven.auslagenkonto).toMatchObject({ number: 741, source: "given" });
    expect(given.call.mock.calls.map((c) => c[0])).not.toContain("accountsGet");
    const out = fakeClient({ original: await original(), accounts: ACCOUNTS });
    const dOut = data(await createMixedReceiptTools(out.client)[1].handler({ ...args, without_auslagenkonto: true } as never));
    expect(dOut.auslagenkonto).toMatchObject({ number: null, source: "none" });
    expect(out.call.mock.calls.map((c) => c[0])).not.toContain("accountsGet");
    const both = fakeClient({ original: await original() });
    await expect(upload(both.client, { auslagenkonto: 741, without_auslagenkonto: true })).rejects.toThrow(/auslagenkonto.*without_auslagenkonto/);
    expect(both.call).not.toHaveBeenCalled();
  });

  it("the upload passes the detected account as an integer and reports it", async () => {
    const { client, call } = fakeClient({ original: await original(), accounts: ACCOUNTS });
    const d = data(await upload(client));
    expect(uploadParams(call).account).toBe(745);
    expect(d.auslagenkonto).toMatchObject({ number: 745, source: "auto" });
  });

  it("the upload omits account with without_auslagenkonto and uses an explicit one over the detected one", async () => {
    const out = fakeClient({ original: await original(), accounts: ACCOUNTS });
    const dOut = data(await upload(out.client, { without_auslagenkonto: true }));
    expect("account" in uploadParams(out.call)).toBe(false);
    expect(dOut.auslagenkonto).toMatchObject({ number: null, source: "none" });
    const given = fakeClient({ original: await original(), accounts: ACCOUNTS });
    const dGiven = data(await upload(given.client, { auslagenkonto: 741 }));
    expect(uploadParams(given.call).account).toBe(741);
    expect(dGiven.auslagenkonto).toMatchObject({ number: 741, source: "given" });
  });

  it("the upload omits account when nothing is found or detection fails, and warns in the second case", async () => {
    const none = fakeClient({ original: await original(), accounts: [ACCOUNTS[0]] });
    await upload(none.client);
    expect("account" in uploadParams(none.call)).toBe(false);
    const failing = fakeClient({ original: await original(), accountsFail: true });
    const d = data(await upload(failing.client));
    expect("account" in uploadParams(failing.call)).toBe(false);
    expect((d.warnings as string[]).join(" ")).toMatch(/Auslagenkonto.*nicht ermittelt/);
  });
});

describe("booking_proposal", () => {
  it("1: an assigned payment with the matching amount gives a ready add_transaction_postings call", async () => {
    const { client } = fakeClient({ original: await original(), accounts: ACCOUNTS, newReceiptRow: { account: "745" }, assigned: ASSIGNED });
    const d = data(await upload(client));
    const p = proposal(d);
    expect(d.status).toBe("uploaded");
    expect(p.status).toBe("ready");
    expect(p.auslagenkonto).toEqual({ number: 745, name: "Verbindlichkeiten Gesellschafter Erika Beispiel" });
    expect(p.receipt).toMatchObject({ id_by_customer: 777, account: "745", assigned_transactions: [{ id_by_customer: "9001", amount: "-6.42", to_from: "Erika Beispiel", booking_date: "2026-10-01" }] });
    expect(p.calls).toEqual([{ tool: "add_transaction_postings", arguments: { transactions: [{ transaction_id_by_customer: 9001, splits: EXPECTED_SPLITS }] } }]);
    expect(p.steps.join(" ")).toMatch(/Zahlung 9001 \(-6,42 €\) ist dem Beleg zugeordnet/);
    expect(p.notes.join(" ")).toMatch(/4653 \(SKR03\); SKR04: 6643; alternativ 4980 \| 6850 Sonstiger Betriebsbedarf; das Konto legt der Steuerberater fest/);
    expect((d.next_steps as string[]).join(" ")).toMatch(/booking_proposal/);
    expect((d.next_steps as string[]).join(" ")).not.toMatch(/booking_hint/);
    expect(d.booking_hint).toBeDefined();
  });

  it("2: an assigned payment that is already booked gives already_booked and no calls", async () => {
    const { client } = fakeClient({
      original: await original(),
      accounts: ACCOUNTS,
      newReceiptRow: { account: "745" },
      assigned: ASSIGNED,
      postings: [{ id_by_customer: "5001", transaction_id_by_customer: "9001", fixed: "0" }],
    });
    const p = proposal(data(await upload(client)));
    expect(p.status).toBe("already_booked");
    expect(p.calls).toEqual([]);
  });

  it("3: an assigned payment with a different amount, or several payments, give needs_decision with the amounts and no calls", async () => {
    const differs = fakeClient({ original: await original(), newReceiptRow: { account: "745" }, assigned: [{ ...ASSIGNED[0], amount: "-5.00" }] });
    const p = proposal(data(await upload(differs.client)));
    expect(p.status).toBe("needs_decision");
    expect(p.calls).toEqual([]);
    expect(p.steps.join(" ")).toMatch(/-5,00 €.*6,42 €/);
    // one cent off is not offered as a ready call: the split sum would not equal the payment
    const cent = fakeClient({ original: await original(), newReceiptRow: { account: "745" }, assigned: [{ ...ASSIGNED[0], amount: "-6.43" }] });
    const pCent = proposal(data(await upload(cent.client)));
    expect(pCent.status).toBe("needs_decision");
    expect(pCent.calls).toEqual([]);
    const several = fakeClient({ original: await original(), newReceiptRow: { account: "745" }, assigned: [ASSIGNED[0], { ...ASSIGNED[0], id_by_customer: "9002" }] });
    const p2 = proposal(data(await upload(several.client)));
    expect(p2.status).toBe("needs_decision");
    expect(p2.calls).toEqual([]);
  });

  it("4: EÜR, nothing assigned, no candidate payment: no_payment_exists says plainly there is no payment and names the ways", async () => {
    await setGewinnermittlung("euer");
    const { client } = fakeClient({ original: await original(), accounts: [ACCOUNTS[0]], transactions: [{ id_by_customer: "9200", amount: "-6.42", to_from: "Max Mustermann", purpose: "Miete", booking_date: "2026-10-05" }] });
    const p = proposal(data(await upload(client)));
    expect(p.status).toBe("no_payment_exists");
    expect(p.gewinnermittlung).toBe("euer");
    expect(p.calls).toEqual([]);
    const steps = p.steps.join("\n");
    expect(steps).toContain("Zu diesem Beleg gibt es in BuchhaltungsButler keine Zahlung, die man buchen könnte. Eine EÜR bucht nur Zahlungen; das ist normal, wenn nur Geschäftskonten angelegt sind und privat bezahlt wurde.");
    expect(steps).toMatch(/create_account/);
    expect(steps).toMatch(/Beleg erzeugt Zahlung/);
    expect(steps).toMatch(/add_free_postings/);
    expect(steps).toMatch(/1890 \| 2180/);
    expect(steps).toMatch(/730 \| 3510/);
    expect(steps).toMatch(/zählt nicht als Zahlung/);
    expect(steps).toMatch(/Erstattung abwarten/);
  });

  it("4b: EÜR with a resolved Auslagenkonto but no payment notes the account probably lacks 'Beleg erzeugt Zahlung' and fills the free-postings call", async () => {
    await setGewinnermittlung("euer");
    const { client } = fakeClient({ original: await original(), accounts: ACCOUNTS });
    const p = proposal(data(await upload(client)));
    expect(p.status).toBe("no_payment_exists");
    expect(p.notes.join(" ")).toMatch(/Beleg erzeugt Zahlung.*manage_account/);
    expect(p.calls).toEqual([
      {
        tool: "add_free_postings",
        arguments: {
          free_postings: EXPECTED_SPLITS.map((s) => ({
            date: "2026-10-01",
            postingtext: s.postingtext,
            amount: s.amount,
            postingaccount_debit: 4653,
            postingaccount_credit: 745,
            vat: s.vat,
            receipt_id_by_customer: 777,
          })),
        },
      },
    ]);
  });

  it("5: EÜR with a reimbursement payment found in the account list gives needs_decision with the candidates and no filled calls", async () => {
    await setGewinnermittlung("euer");
    const { client, call } = fakeClient({
      original: await original(),
      transactions: [
        { id_by_customer: "9100", amount: "-6.42", to_from: "Erika Beispiel", purpose: "Erstattung Auslagen Oktober", booking_date: "2026-10-20" },
        { id_by_customer: "9101", amount: "-6.42", to_from: "Max Mustermann", purpose: "Miete", booking_date: "2026-10-21" },
        { id_by_customer: "9102", amount: "6.42", to_from: "Erika Beispiel", purpose: "Rückzahlung", booking_date: "2026-10-22" },
        { id_by_customer: "9103", amount: "-7.00", to_from: "Erika Beispiel", purpose: "anderes", booking_date: "2026-10-22" },
      ],
    });
    const p = proposal(data(await upload(client)));
    expect(p.status).toBe("needs_decision");
    expect(p.calls).toEqual([]);
    expect(p.payment_candidates).toEqual([{ id_by_customer: "9100", amount: "-6.42", to_from: "Erika Beispiel", booking_date: "2026-10-20" }]);
    expect(p.steps.join(" ")).toMatch(/assign_receipts_to_transactions/);
    expect(p.notes.join(" ")).toMatch(/1\.98.*4653.*7_pre/);
    const tx = call.mock.calls.find((c) => c[0] === "transactionsGet")![1] as Data;
    expect(tx).toMatchObject({ date_from: "2026-10-01", date_to: "2026-11-30" });
  });

  it("6: Bilanz without a payment describes add_receipt_postings (creditor unknown) as needs_decision", async () => {
    await setGewinnermittlung("bilanz");
    const { client } = fakeClient({ original: await original(), accounts: [ACCOUNTS[0]] });
    const p = proposal(data(await upload(client)));
    expect(p.gewinnermittlung).toBe("bilanz");
    expect(p.status).toBe("needs_decision");
    expect(p.calls).toEqual([]);
    const text = [...p.steps, ...p.notes].join(" ");
    expect(text).toMatch(/add_receipt_postings/);
    expect(text).toMatch(/Kreditor/);
    expect(text).toMatch(/get_booking_guide auslagen/);
  });

  it("7: without gewinnermittlung the note says so and both ways are shown", async () => {
    await setGewinnermittlung(null);
    const { client } = fakeClient({ original: await original(), accounts: [ACCOUNTS[0]] });
    const p = proposal(data(await upload(client)));
    expect(p.gewinnermittlung).toBeNull();
    expect(p.status).toBe("needs_decision");
    expect(p.notes).toContain("Gewinnermittlung nicht festgelegt (set_policy gewinnermittlung); beide Wege unten");
    const text = p.steps.join(" ");
    expect(text).toMatch(/keine Zahlung/);
    expect(text).toMatch(/add_receipt_postings/);
  });

  it("notes the Privateinlage hint for the Inhaber of a Einzelunternehmen", async () => {
    const { client } = fakeClient({ original: await original(), accounts: [ACCOUNTS[0]] });
    expect(proposal(data(await upload(client))).notes.join(" ")).toMatch(/Privateinlage/);
  });

  it("8: any failing read endpoint gives status unavailable, the upload result stays uploaded and the original deleted", async () => {
    for (const failEndpoint of ["receiptsAssignedTransactionsGet", "postingsGet", "transactionsGet"]) {
      await setGewinnermittlung("euer");
      const { client } = fakeClient({ original: await original(), accounts: ACCOUNTS, newReceiptRow: { account: "745" }, assigned: failEndpoint === "transactionsGet" ? [] : ASSIGNED, failEndpoint });
      const d = data(await upload(client));
      expect(d).toMatchObject({ status: "uploaded", original_deleted: true, new_receipt_verified: true });
      expect(proposal(d).status).toBe("unavailable");
      expect(proposal(d).steps.join(" ")).toMatch(/Buchungsvorschlag konnte nicht erstellt werden.*HTTP 500/);
      expect(proposal(d).calls).toEqual([]);
    }
    // a broken policy file also gives "unavailable", not an error
    process.env.BHB_POLICY_FILE = join(await mkdtemp(join(tmpdir(), "bhb-mixed-policy-")), "kaputt.json");
    await writeFile(process.env.BHB_POLICY_FILE, "{kaputt");
    const { client } = fakeClient({ original: await original() });
    const d = data(await upload(client));
    expect(d).toMatchObject({ status: "uploaded", original_deleted: true });
    expect(proposal(d).status).toBe("unavailable");
  });

  it("8b: without a new receipt id the proposal is unavailable and points to list_receipts", async () => {
    const { client } = fakeClient({ original: await original(), upload: { success: true }, uploadedRow: { invoicenumber: "BEISPIEL-0815", deleted: "0", amount: "6.42" } });
    // the verification accepts a row without id when the upload returned none; the proposal has no id to work with
    const d = data(await upload(client));
    expect(proposal(d).status).toBe("unavailable");
    expect(proposal(d).steps.join(" ")).toMatch(/list_receipts/);
  });

  it("9: the proposal only reads: no add/assign/create endpoint is ever called", async () => {
    await setGewinnermittlung("euer");
    const { client, call } = fakeClient({ original: await original(), accounts: ACCOUNTS, newReceiptRow: { account: "745" }, assigned: ASSIGNED });
    await upload(client);
    const allowed = new Set([
      // main flow
      "receiptsGetIdByCustomer", "receiptsGet", "receiptsUpload", "commentsAdd", "receiptsDeleteIdByCustomer",
      // reads
      "accountsGet", "receiptsAssignedTransactionsGet", "postingsGet", "transactionsGet",
    ]);
    for (const [key] of call.mock.calls) expect(allowed.has(key)).toBe(true);
    const keys = call.mock.calls.map((c) => c[0]);
    expect(keys.filter((k) => k === "receiptsUpload")).toHaveLength(1);
    expect(keys.filter((k) => k === "commentsAdd")).toHaveLength(1);
    expect(keys.filter((k) => k === "receiptsDeleteIdByCustomer")).toHaveLength(1);
    // the proposal runs after the delete
    expect(keys.lastIndexOf("receiptsDeleteIdByCustomer")).toBeLessThan(keys.indexOf("receiptsAssignedTransactionsGet"));
  });
});

describe("neutral booking text", () => {
  it("strips quantities, sizes and percentages and never contains the merchant", () => {
    expect(neutralPostingText(["H-Milch 1,5 % 1 l"])).toBe("H-Milch");
    expect(neutralPostingText(["Milch 1 l", "Milch 1 l"])).toBe("Milch");
    expect(neutralPostingText(["Mineralwasser 0,5 l", "Pfand 6 × 0,25 €"])).toBe("Mineralwasser, Pfand");
    expect(neutralPostingText(["12345"])).toBe("12345");
  });

  it("limits the derived text to 40 characters", () => {
    expect(neutralPostingText(["Aufmerksamkeiten für Kundenbesprechungen im Büro und Team", "Zweite Position"]).length).toBeLessThanOrEqual(40);
  });

  it("uses booking_text for every split and shows the text in the preview", async () => {
    const { client } = fakeClient({ original: await original(), accounts: ACCOUNTS, newReceiptRow: { account: "745" }, assigned: ASSIGNED });
    const [, generate, upload] = createMixedReceiptTools(client);
    const preview = data(await generate.handler({ ...args, booking_text: "Büroverpflegung" } as never));
    expect(preview.booking_text).toEqual({ value: "Büroverpflegung", source: "given" });
    const derived = data(await generate.handler(args as never));
    expect((derived.booking_text as Data).source).toBe("derived");
    const d = data(await upload.handler({ ...args, booking_text: "Büroverpflegung", confirm: true } as never));
    const proposal = d.booking_proposal as { calls: Array<{ arguments: { transactions: Array<{ splits: Array<{ postingtext: string }> }> } }> };
    const texts = proposal.calls[0].arguments.transactions[0].splits.map((x) => x.postingtext);
    expect(texts).toEqual(["Büroverpflegung", "Büroverpflegung"]);
  });

  it("rejects an empty or overlong booking_text", async () => {
    const { client } = fakeClient({ original: await original() });
    const schema = createMixedReceiptTools(client)[1].inputSchema.booking_text as unknown as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse("x".repeat(41)).success).toBe(false);
    expect(schema.safeParse("Milch").success).toBe(true);
  });
});
