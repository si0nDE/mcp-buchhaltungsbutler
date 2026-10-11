import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createVatPreviewTools, elsterEstimate, sumLedger, TAX_ACCOUNTS } from "./vat-preview.js";
import { UST_VA_ACCOUNTS } from "./ustva-mapping.js";

const row = (side: "debit" | "credit", amount: string) => ({ record_side: side, record_amount: amount });
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("TAX_ACCOUNTS", () => {
  it("matches the Kennziffern and chart numbers of the USt-VA table", () => {
    for (const a of TAX_ACCOUNTS) {
      const t = UST_VA_ACCOUNTS.find(([skr03]) => skr03 === a.skr03);
      expect(t, `${a.skr03} missing in ustva-mapping`).toBeDefined();
      expect(t![1]).toBe(a.skr04);
      expect(t![3]).toBe(a.kz);
    }
  });
});

describe("sumLedger", () => {
  it("adds debit and credit separately and ignores the sign", () => {
    expect(sumLedger([row("debit", "61.97"), row("debit", "10.00"), row("credit", "2.45")])).toEqual({ debit: 71.97, credit: 2.45, rows: 3 });
  });
});

describe("preview_vat_impact", () => {
  function client(ledgers: Record<number, Array<ReturnType<typeof row>>>) {
    return {
      call: vi.fn(async (key: string, params: Record<string, unknown>) => {
        if (key !== "reportsGetSumsLedger") throw new Error(`unexpected ${key}`);
        return { report_sums_postingaccount_ledger: { postingaccountLedger: ledgers[params.postingaccount_number as number] ?? [] } };
      }),
    } as unknown as BBClient;
  }

  it("computes Zahllast from the tax accounts (Vorsteuer in Soll minus Storno, Umsatzsteuer in Haben)", async () => {
    const c = client({
      1576: [row("debit", "61.97"), row("debit", "61.97"), row("credit", "2.45")],
      1577: [row("debit", "9.94")],
      1776: [row("credit", "200.00")],
      1787: [row("credit", "9.94")],
    });
    const [tool] = createVatPreviewTools(c);
    const res = parse(await tool.handler({ date_from: "2026-07-01", date_to: "2026-09-30", base: "date_delivery_else_date", chart: "SKR03" }));
    expect(res.vorsteuer).toBe(131.43);
    expect(res.umsatzsteuer).toBe(209.94);
    expect(res.zahllast_oder_erstattung).toBe(78.51);
    expect(res.result).toBe("Zahllast");
    expect(res.notes[0]).toMatch(/Nicht die ELSTER-Zahl/);
    const call = (c.call as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toMatchObject({ date_from: "2026-07-01", date_to: "2026-09-30", base: "date_delivery_else_date" });
  });

  it("reports an Erstattung and uses SKR04 numbers when asked", async () => {
    const c = client({ 1406: [row("debit", "50.00")] });
    const [tool] = createVatPreviewTools(c);
    const res = parse(await tool.handler({ date_from: "2026-07-01", date_to: "2026-09-30", base: "date", chart: "SKR04" }));
    expect(res.result).toBe("Erstattung");
    expect(res.zahllast_oder_erstattung).toBe(-50);
    expect(res.accounts.map((a: { account: number }) => a.account)).toEqual([1401, 1406, 1407, 3801, 3806, 3837]);
  });

  it("adds elster_estimate with the Bemessungsgrundlage floored to full euros (Kz 81: 8065.88 -> 8065)", async () => {
    // 19 % von 8.065,88 = 1.532,52 laut Konto; ELSTER rechnet 19 % von 8.065 = 1.532,35.
    const c = client({ 1776: [row("credit", "1532.52")], 1576: [row("debit", "710.74")] });
    const [tool] = createVatPreviewTools(c);
    const res = parse(await tool.handler({ date_from: "2026-07-01", date_to: "2026-09-30", base: "date_delivery_else_date", chart: "SKR03" }));
    expect(res.zahllast_oder_erstattung).toBe(821.78);
    const kz81 = res.elster_estimate.kennziffern.find((k: { kz: number }) => k.kz === 81);
    expect(kz81).toMatchObject({ bemessungsgrundlage: 8065, steuer: 1532.35, steuer_laut_konto: 1532.52 });
    expect(res.elster_estimate.zahllast_oder_erstattung).toBe(821.61);
    expect(res.elster_estimate.differenz_zu_konten).toBe(-0.17);
  });

  it("is read-only", () => {
    const [tool] = createVatPreviewTools(client({}));
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  });
});

describe("elsterEstimate", () => {
  const acc = (account: number, side: "vorsteuer" | "umsatzsteuer", kennziffer: number, amount: number) => ({ account, side, kennziffer, amount });

  it("does not drift on exact euro bases (1900.00 / 0.19 = 10000)", () => {
    const e = elsterEstimate([acc(1776, "umsatzsteuer", 81, 1900)], "SKR03");
    expect(e.kennziffern[0]).toMatchObject({ kz: 81, bemessungsgrundlage: 10000, steuer: 1900 });
  });

  it("rounds 7 % and 13b separately and keeps Vorsteuer Kz 66/67 unrounded", () => {
    const e = elsterEstimate(
      [acc(1771, "umsatzsteuer", 86, 7.69), acc(1787, "umsatzsteuer", 46, 9.94), acc(1577, "vorsteuer", 67, 9.94), acc(1576, "vorsteuer", 66, 61.97)],
      "SKR03"
    );
    expect(e.kennziffern.find((k) => k.kz === 86)).toMatchObject({ bemessungsgrundlage: 109, steuer: 7.63 });
    expect(e.kennziffern.find((k) => k.kz === 46)).toMatchObject({ bemessungsgrundlage: 52, steuer: 9.88 });
    expect(e.vorsteuer_kz66).toBe(61.97);
    expect(e.vorsteuer_kz67).toBe(9.94);
  });
});
