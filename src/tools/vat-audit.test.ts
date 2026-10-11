import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { analyzeReceiptsAndPostings, AUDIT_CHECKS, createVatAuditTools } from "./vat-audit.js";

const receipt = (o: Record<string, unknown>) => ({ type: "invoice inbound", list_direction: "inbound", deleted: "0", date: "2026-08-10", ...o });
const posting = (o: Record<string, unknown>) => ({ date: "2026-08-10 00:00:00", tax_key: "0", ...o });

describe("analyzeReceiptsAndPostings", () => {
  it("DUP_POSTING: receipt posting plus free posting with tax on a 11,90 € receipt", () => {
    const r = receipt({ id_by_customer: "1", invoicenumber: "A-1", counterparty: "Muster SaaS", amount: "11.90" });
    const p = [
      posting({ id_by_customer: "10", receipt_id_by_customer: "1", amount: "11.90", tax_key: "9", vat: "19.00" }),
      posting({ id_by_customer: "11", receipts_assigned_ids_by_customer: "1", amount: "11.90", tax_key: "9", vat: "19.00" }),
    ];
    const { findings } = analyzeReceiptsAndPostings([r], p, ["DUP_POSTING"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "DUP_POSTING", severity: "error", receipt_id: "1", posting_ids: ["10", "11"] });
    expect(findings[0].display_ref).toBe("Rg. A-1 · Muster SaaS · 10.08.2026 · 11,90 €");
    expect(findings[0].vat_effect).toMatchObject({ vorsteuer_zu_viel: 1.9, zahllast_delta_bei_korrektur: 1.9 });
  });

  it("DUP_POSTING: no finding for one taxed posting, split postings that add up, or automatic accounts (key 0)", () => {
    const r = receipt({ id_by_customer: "1", invoicenumber: "A-1", counterparty: "X", amount: "22.70" });
    const split = [
      posting({ id_by_customer: "10", receipt_id_by_customer: "1", amount: "12.90", tax_key: "9" }),
      posting({ id_by_customer: "11", receipt_id_by_customer: "1", amount: "9.80", tax_key: "8" }),
    ];
    expect(analyzeReceiptsAndPostings([r], split, ["DUP_POSTING"]).findings).toEqual([]);
    const auto = [
      posting({ id_by_customer: "12", receipt_id_by_customer: "1", amount: "22.70", vat: "19.00" }),
      posting({ id_by_customer: "13", receipt_id_by_customer: "1", amount: "22.70", vat: "19.00" }),
    ];
    expect(analyzeReceiptsAndPostings([r], auto, ["DUP_POSTING"]).findings).toEqual([]);
  });

  it("DUP_POSTING on an outbound receipt reports Umsatzsteuer", () => {
    const r = receipt({ type: "invoice outbound", list_direction: "outbound", id_by_customer: "2", invoicenumber: "AR-1", counterparty: "Kunde", amount: "119.00" });
    const p = [
      posting({ id_by_customer: "1", receipt_id_by_customer: "2", amount: "119.00", tax_key: "3", vat: "19.00" }),
      posting({ id_by_customer: "2", receipt_id_by_customer: "2", amount: "119.00", tax_key: "3", vat: "19.00" }),
    ];
    const { findings } = analyzeReceiptsAndPostings([r], p, ["DUP_POSTING"]);
    expect(findings[0].vat_effect).toMatchObject({ umsatzsteuer_zu_viel: 19, zahllast_delta_bei_korrektur: -19 });
  });

  it("DUP_RECEIPT: same invoice number is an error, same amount within 3 days a warning, deleted receipts are ignored", () => {
    const a = receipt({ id_by_customer: "1", invoicenumber: "R 1", counterparty: "Muster", amount: "10.00" });
    const b = receipt({ id_by_customer: "2", invoicenumber: "R1", counterparty: "Muster", amount: "10.00" });
    const c = receipt({ id_by_customer: "3", invoicenumber: "Q-9", counterparty: "Andere", amount: "5.00", date: "2026-08-01" });
    const d = receipt({ id_by_customer: "4", invoicenumber: "Q-10", counterparty: "Andere", amount: "5.00", date: "2026-08-03" });
    const gone = receipt({ id_by_customer: "5", invoicenumber: "R1", counterparty: "Muster", amount: "10.00", deleted: "1" });
    const { findings } = analyzeReceiptsAndPostings([a, b, c, d, gone], [], ["DUP_RECEIPT"]);
    expect(findings.map((f) => [f.receipt_id, f.severity])).toEqual([["2", "error"], ["4", "warning"]]);
  });

  it("UNBOOKED: receipt without any posting, but not when only a payment posting references it", () => {
    const a = receipt({ id_by_customer: "1", invoicenumber: "A", counterparty: "X", amount: "10.00" });
    const b = receipt({ id_by_customer: "2", invoicenumber: "B", counterparty: "Y", amount: "20.00" });
    const p = [posting({ id_by_customer: "9", transaction_id_by_customer: "7", receipts_assigned_ids_by_customer: "2", amount: "20.00" })];
    const { findings, checkedReceipts } = analyzeReceiptsAndPostings([a, b], p, ["UNBOOKED"]);
    expect(findings.map((f) => f.receipt_id)).toEqual(["1"]);
    expect(checkedReceipts).toBe(2);
  });
});

describe("audit_vat_period", () => {
  function client(receipts: Record<string, unknown[]>, postings: unknown[]) {
    return {
      call: vi.fn(async (key: string, params: Record<string, unknown>) => {
        if (key === "receiptsGet") return { data: params.offset ? [] : receipts[params.list_direction as string] ?? [] };
        if (key === "postingsGet") return { data: params.offset ? [] : postings };
        throw new Error(`unexpected ${key}`);
      }),
    } as unknown as BBClient;
  }

  it("is read-only, filters postings to the period (date or date_vat_effective) and lists what is not checked", async () => {
    const c = client(
      { inbound: [receipt({ id_by_customer: "1", invoicenumber: "A", counterparty: "X", amount: "10.00" })], outbound: [] },
      [
        posting({ id_by_customer: "1", receipt_id_by_customer: "1", amount: "10.00", tax_key: "9", date: "2026-10-05 00:00:00", date_vat_effective: "2026-09-28" }),
        posting({ id_by_customer: "2", receipt_id_by_customer: "1", amount: "10.00", tax_key: "9", date: "2026-10-05 00:00:00" }),
      ]
    );
    const [tool] = createVatAuditTools(c);
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    const res = await tool.handler({ date_from: "2026-07-01", date_to: "2026-09-30", read_receipt_text: false, max_text_reads: 25, max_findings: 200 } as never);
    const data = JSON.parse(res.content[0].text);
    expect(data.checked.postings).toBe(1);
    expect(data.findings).toEqual([]);
    expect(data.not_checked.length).toBeGreaterThan(3);
    expect(data.notes[0]).toMatch(/read_receipt_text/);
    expect(AUDIT_CHECKS).toContain("DATE_SHIFT");
  });
});

import { classifyForeignSupplier } from "./vat-audit.js";

describe("classifyForeignSupplier", () => {
  const r = { id_by_customer: "7", type: "invoice inbound", list_direction: "inbound", date: "2026-08-02", counterparty: "Beispiel Ireland Ltd", amount: "11.90", invoicenumber: "X-1" };
  const irish = "Beispiel Distribution International, Cork, Ireland\nVAT ID: IE9700053D\nSubscription 10.00\nVAT 19 % 1.90\nTotal 11.90";

  it("ask: decision with both options in Kennziffern and Zahllast delta", () => {
    const f = classifyForeignSupplier(irish, r, "ask")!;
    expect(f).toMatchObject({ check: "FOREIGN_SUPPLIER", severity: "warning", status: "decision", auto_fixable: false });
    expect(f.options).toMatchObject({
      as_invoiced: { kz66_vorsteuer: 1.9, zahllast_delta: 0 },
      reverse_charge_strict: { kz46_bemessungsgrundlage: 10, kz66_vorsteuer: 0, zahllast_delta_gegen_as_invoiced: 1.9 },
    });
  });

  it("as_invoiced: ok (Hausregel) without options", () => {
    const f = classifyForeignSupplier(irish, r, "as_invoiced")!;
    expect(f).toMatchObject({ severity: "info", status: "ok_hausregel" });
    expect(f.options).toBeUndefined();
  });

  it("reverse_charge_strict: asks to verify § 13b was booked, only that option", () => {
    const f = classifyForeignSupplier(irish, r, "reverse_charge_strict")!;
    expect(f.status).toBe("decision");
    expect(Object.keys(f.options!)).toEqual(["reverse_charge_strict"]);
  });

  it("stays silent with a reverse-charge note, without German VAT, for domestic suppliers and outbound receipts", () => {
    expect(classifyForeignSupplier(irish + "\nReverse charge applies", r, "ask")).toBeUndefined();
    expect(classifyForeignSupplier("Beispiel Ltd Ireland\nTotal 11.90 EUR", r, "ask")).toBeUndefined();
    expect(classifyForeignSupplier("Muster GmbH, Würzburg\nUSt-IdNr. DE123456789\nMwSt 19 % 1,90", r, "ask")).toBeUndefined();
    expect(classifyForeignSupplier(irish, { ...r, type: "invoice outbound", list_direction: "outbound" }, "ask")).toBeUndefined();
  });

  it("recognises a non-German EU VAT ID without any country word", () => {
    expect(classifyForeignSupplier("Anbieter\nUSt-IdNr. ATU12345678\nMwSt 19 % 1,90", r, "ask")).toBeDefined();
  });
});

import { PDFDocument, StandardFonts } from "pdf-lib";

describe("audit_vat_period with read_receipt_text and a house rule", () => {
  async function pdfWith(lines: string[]) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    lines.forEach((l, i) => page.drawText(l, { x: 20, y: 270 - i * 18, size: 11, font }));
    return Buffer.from(await doc.save()).toString("base64");
  }

  it("reports the foreign supplier as ok (Hausregel) and puts the legal note into the answer once", async () => {
    const file = await pdfWith(["Beispiel Ltd, Cork, Ireland", "Subscription 10.00", "VAT 19 % 1.90", "Total 11.90"]);
    const c = {
      call: async (key: string, params: Record<string, unknown>) => {
        if (key === "receiptsGet") {
          return {
            data: params.offset || params.list_direction !== "inbound" ? [] : [{ id_by_customer: "1", type: "invoice inbound", date: "2026-08-02", counterparty: "Beispiel Ltd", amount: "11.90", invoicenumber: "X-1", deleted: "0" }],
          };
        }
        if (key === "postingsGet") return { data: [] };
        if (key === "receiptsGetIdByCustomer") return { data: { file_type: "pdf", file_content: file } };
        throw new Error(key);
      },
    } as unknown as BBClient;
    const [tool] = createVatAuditTools(c, async () => ({
      vat_policy: { foreign_supplier_domestic_vat_no_rc_hint: "as_invoiced" },
      history: [],
    }));
    const res = JSON.parse(
      (await tool.handler({ date_from: "2026-07-01", date_to: "2026-09-30", checks: ["FOREIGN_SUPPLIER"], read_receipt_text: true, max_text_reads: 25, max_findings: 200 } as never)).content[0].text
    );
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ check: "FOREIGN_SUPPLIER", status: "ok_hausregel", severity: "info" });
    expect(res.house_rule).toEqual({ foreign_supplier_domestic_vat_no_rc_hint: "as_invoiced", source: "Policy-Datei" });
    expect(res.legal_note).toMatch(/§ 14c UStG/);
  });
});
