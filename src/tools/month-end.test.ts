import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import {
  accountBalance,
  bookedReceiptIds,
  bookedTransactionIds,
  createMonthEndTools,
  findDuplicateReceipts,
  findTransitAccounts,
} from "./month-end.js";

// Fiktive Beispieldaten.
const R = (id: number, over: Record<string, unknown> = {}) => ({
  id_by_customer: String(id),
  type: "invoice inbound",
  date: "2026-09-10",
  counterparty: "Muster Bürobedarf GmbH",
  invoicenumber: `RE-${id}`,
  amount: "119.00",
  ...over,
});
const T = (id: number) => ({ id_by_customer: String(id), to_from: "Bank", amount: "-50.00", booking_date: "2026-09-12" });
const P = (over: Record<string, unknown>) => ({
  id_by_customer: "1",
  amount: "10.00",
  fixed: "0",
  debit_postingaccount_number: "4930",
  credit_postingaccount_number: "1200",
  receipt_id_by_customer: "",
  transaction_id_by_customer: "",
  receipts_assigned_ids_by_customer: "",
  ...over,
});
const RANGE = { date_from: "2026-09-01", date_to: "2026-09-30" };
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

function setup(data: {
  inbound?: unknown[];
  outbound?: unknown[];
  transactions?: unknown[];
  postings?: unknown[];
  accounts?: unknown[];
}) {
  const call = vi.fn((key: string, params: Record<string, unknown>) => {
    if (key === "receiptsGet") return Promise.resolve({ data: params.list_direction === "inbound" ? (data.inbound ?? []) : (data.outbound ?? []) });
    if (key === "transactionsGet") return Promise.resolve({ data: data.transactions ?? [] });
    if (key === "postingsGet") return Promise.resolve({ data: data.postings ?? [] });
    if (key === "settingsGetPostingaccounts") return Promise.resolve({ data: data.accounts ?? [] });
    throw new Error(`unexpected call ${key}`);
  });
  const [tool] = createMonthEndTools({ call } as unknown as BBClient);
  return { call, tool };
}

describe("helpers", () => {
  it("findDuplicateReceipts groups same supplier + invoice number, ignoring case and spacing", () => {
    const g = findDuplicateReceipts([R(1, { invoicenumber: "RE-7" }), R(2, { invoicenumber: " re-7 ", counterparty: "muster bürobedarf gmbh" }), R(3)]);
    expect(g).toHaveLength(1);
    expect(g[0].ids).toEqual([1, 2]);
    expect(g[0].grund).toMatch(/Rechnungsnummer/);
  });

  it("falls back to supplier + date + amount when there is no invoice number", () => {
    const g = findDuplicateReceipts([R(1, { invoicenumber: "" }), R(2, { invoicenumber: "" }), R(3, { invoicenumber: "", amount: "5.00" })]);
    expect(g).toHaveLength(1);
    expect(g[0].ids).toEqual([1, 2]);
  });

  it("does not mix inbound and outbound receipts of the same counterparty", () => {
    expect(findDuplicateReceipts([R(1, { invoicenumber: "X" }), R(2, { invoicenumber: "X", type: "invoice outbound" })])).toEqual([]);
  });

  it("booked ids come from the posting references, including a comma list of assigned receipts", () => {
    const postings = [P({ receipt_id_by_customer: "11" }), P({ transaction_id_by_customer: "21", receipts_assigned_ids_by_customer: "12, 13" })];
    expect([...bookedReceiptIds(postings)].sort()).toEqual([11, 12, 13]);
    expect([...bookedTransactionIds(postings)]).toEqual([21]);
  });

  it("accountBalance is debit minus credit, in cents", () => {
    const postings = [P({ amount: "0.10", debit_postingaccount_number: "1360" }), P({ amount: "0.20", debit_postingaccount_number: "1360" }), P({ amount: "0.30", credit_postingaccount_number: "1360", debit_postingaccount_number: "1200" })];
    expect(accountBalance(postings, 1360)).toBe(0);
    expect(accountBalance(postings, 1200)).toBe(0);
    expect(accountBalance([P({ amount: "5.00" })], 4930)).toBe(5);
    expect(accountBalance([P({ amount: "5.00" })], 1200)).toBe(-5);
  });

  it("findTransitAccounts matches Geldtransit and Interimskonto by name only", () => {
    expect(
      findTransitAccounts([
        { postingaccount_number: "1360", name: "Geldtransit" },
        { postingaccount_number: "1590", name: "Interimskonto / Kontierung nicht bekannt" },
        { postingaccount_number: "1200", name: "Bank" },
      ]).map((a) => a.number)
    ).toEqual([1360, 1590]);
  });
});

describe("check_month_end", () => {
  it("is read-only", () => {
    expect(setup({}).tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it("reports ok everywhere on clean data and lists the checks the API cannot do", async () => {
    const { tool } = setup({
      inbound: [R(1)],
      transactions: [T(21)],
      postings: [P({ receipt_id_by_customer: "1", transaction_id_by_customer: "21", fixed: "1" })],
      accounts: [{ postingaccount_number: "1360", name: "Geldtransit" }],
    });
    const res = parse(await tool.handler({ ...RANGE }));
    const byName = Object.fromEntries(res.ergebnisse.map((e: any) => [e.pruefung, e]));
    expect(byName.duplikatsverdacht_belege.status).toBe("ok");
    expect(byName.zahlungen_ohne_buchung.status).toBe("ok");
    expect(byName.belege_ohne_buchung.status).toBe("ok");
    expect(byName.festschreibung.status).toBe("ok");
    expect(byName.geldtransit_und_interimskonto_saldo.status).toBe("ok");
    expect(byName.banksalden.status).toBe("nicht_pruefbar");
    expect(byName.festschreiben_und_ust_voranmeldung.status).toBe("nicht_pruefbar");
    expect(res.unvollstaendig).toBeUndefined();
  });

  it("flags unbooked payments and receipts, duplicates, unfixed postings and a non-zero Geldtransit", async () => {
    const { tool } = setup({
      inbound: [R(1, { invoicenumber: "A" }), R(2, { invoicenumber: "A" })],
      transactions: [T(21), T(22)],
      postings: [P({ transaction_id_by_customer: "21", debit_postingaccount_number: "1360", amount: "40.00" })],
      accounts: [{ postingaccount_number: "1360", name: "Geldtransit" }],
    });
    const res = parse(await tool.handler({ ...RANGE }));
    const byName = Object.fromEntries(res.ergebnisse.map((e: any) => [e.pruefung, e]));
    expect(byName.duplikatsverdacht_belege).toMatchObject({ status: "pruefen", anzahl: 1 });
    expect(byName.zahlungen_ohne_buchung.details.map((d: any) => d.id_by_customer)).toEqual(["22"]);
    expect(byName.belege_ohne_buchung.anzahl).toBe(2);
    expect(byName.festschreibung).toMatchObject({ status: "pruefen", anzahl: 1 });
    expect(byName.geldtransit_und_interimskonto_saldo.details).toEqual([{ konto: 1360, name: "Geldtransit", saldo: 40 }]);
    expect(byName.geldtransit_und_interimskonto_saldo.status).toBe("pruefen");
  });

  it("reads a wider posting range for the Geldtransit balance when balance_from is given", async () => {
    const { call, tool } = setup({ accounts: [{ postingaccount_number: "1360", name: "Geldtransit" }] });
    await tool.handler({ ...RANGE, balance_from: "2026-01-01" });
    expect(call).toHaveBeenCalledWith("postingsGet", expect.objectContaining({ date_from: "2026-01-01", date_to: "2026-09-30" }));
  });

  it("says nicht_pruefbar when no Geldtransit account exists", async () => {
    const res = parse(await setup({}).tool.handler({ ...RANGE }));
    expect(res.ergebnisse.find((e: any) => e.pruefung === "geldtransit_und_interimskonto_saldo").status).toBe("nicht_pruefbar");
  });

  it("warns when the page limit was hit instead of reporting a false ok", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => P({ id_by_customer: String(i), transaction_id_by_customer: String(i) }));
    const call = vi.fn((key: string) => Promise.resolve({ data: key === "postingsGet" ? full : [] }));
    const [tool] = createMonthEndTools({ call } as unknown as BBClient);
    const res = parse(await tool.handler({ ...RANGE }));
    expect(res.unvollstaendig).toContain("Buchungen");
    expect(res.warnung).toMatch(/Seitenlimit/);
  });

  it("only reads: never calls a write endpoint", async () => {
    const { call, tool } = setup({ inbound: [R(1)], transactions: [T(1)] });
    await tool.handler({ ...RANGE });
    expect(new Set(call.mock.calls.map(([k]) => k))).toEqual(
      new Set(["receiptsGet", "transactionsGet", "postingsGet", "settingsGetPostingaccounts"])
    );
  });
});
