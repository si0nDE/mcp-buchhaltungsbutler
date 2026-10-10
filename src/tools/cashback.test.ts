import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { SERVER_INSTRUCTIONS } from "./bhb-systematik.js";
import { findBookingGuide } from "./booking-guide.js";
import { CASHBACK_POSTINGTEXT, cashbackPostingWarnings, fetchCashbackIds, isPayPalCashback, resolveCashback } from "./cashback.js";
import { createPostingsTools } from "./postings.js";
import { createTransactionsTools } from "./transactions.js";

// Form der Zahlung wie am PayPal-Konto beobachtet (10.10.2026), IDs und Transaktionsnummer erfunden.
const cashback = {
  id_by_customer: 901,
  account: 1299,
  to_from: "PayPal Inc Debit Card",
  booking_date: "2026-03-10 23:00:00",
  amount: "1.23",
  purpose: "1AB23456CD7890123",
  type: "Cash Back Bonus",
};
const purchase = { id_by_customer: 902, account: 1299, to_from: "Beispiel Shop", amount: "-246.00", purpose: "Einkauf", type: "Debit Card" };
// Die Liste (transactionsGet) liefert weder type noch account (live geprüft 10.10.2026), nur die Einzelabfrage.
const listRow = ({ type: _t, account: _a, ...rest }: Record<string, unknown>) => rest;
// Positive Zahlung von PayPal Debit Card ohne Cashback-Typ (z. B. Erstattung), erfunden.
const refund = { id_by_customer: 903, account: 1299, to_from: "PayPal Inc Debit Card", amount: "5.00", purpose: "2CD", type: "Refund" };
const byId: Record<number, Record<string, unknown>> = { 901: cashback, 902: purchase, 903: refund };

function routedClient(routes: Record<string, unknown>): BBClient {
  return {
    call: vi.fn((key: string, _params: unknown, opts?: { idSuffix?: number }) => {
      if (key === "transactionsGetIdByCustomer" && !(key in routes)) {
        const tx = byId[opts?.idSuffix ?? -1];
        return tx ? Promise.resolve({ success: true, data: tx }) : Promise.reject(new Error("not found"));
      }
      return key in routes ? Promise.resolve(routes[key]) : Promise.reject(new Error(`unexpected ${key}`));
    }),
  } as unknown as BBClient;
}

describe("isPayPalCashback", () => {
  it("recognises the observed PayPal cashback payment by type and counterparty", () => {
    expect(isPayPalCashback(cashback)).toBe(true);
    expect(isPayPalCashback({ ...cashback, type: "Cashback" })).toBe(true);
  });

  it("ignores card purchases, other counterparties, outgoing amounts and payments without type", () => {
    expect(isPayPalCashback(purchase)).toBe(false);
    expect(isPayPalCashback({ ...cashback, to_from: "Beispiel Cashback-Portal" })).toBe(false);
    expect(isPayPalCashback({ ...cashback, amount: "-1.23" })).toBe(false);
    const { type: _type, ...withoutType } = cashback;
    expect(isPayPalCashback(withoutType)).toBe(false);
  });
});

describe("transaction tools flag cashback", () => {
  it("list_transactions looks up candidates (list rows have no type) and returns a booking hint", async () => {
    const client = routedClient({ transactionsGet: { data: [cashback, purchase, refund].map(listRow) }, settingsGetPostingaccounts: { data: [] } });
    const [listTransactions] = createTransactionsTools(client);
    const res = await listTransactions.handler({});
    const lookups = vi.mocked(client.call).mock.calls.filter((c) => c[0] === "transactionsGetIdByCustomer").map((c) => (c[2] as { idSuffix: number }).idSuffix);
    expect(lookups.sort()).toEqual([901, 903]);
    const hints = res.structuredContent!.booking_hints as Array<Record<string, unknown>>;
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ kind: "paypal_cashback", transaction_ids: [901], buchung: { vat: "0_none", postingtext: CASHBACK_POSTINGTEXT } });
    expect(res.content.at(-1)!.text).toMatch(/0_none.*PayPal Business Debit Cashback.*paypal_cashback/);
  });

  it("list_transactions with query flags the cashback among the matches", async () => {
    const client = routedClient({ transactionsGet: { data: [cashback, purchase].map(listRow) }, settingsGetPostingaccounts: { data: [] } });
    const [listTransactions] = createTransactionsTools(client);
    const res = await listTransactions.handler({ query: "paypal inc debit card" });
    expect(res.structuredContent!.query_counts).toMatchObject({ matched: 1 });
    expect((res.structuredContent!.booking_hints as unknown[])[0]).toMatchObject({ transaction_ids: [901] });
  });

  it("caps the lookups and names the unchecked candidates", async () => {
    const rows = Array.from({ length: 27 }, (_, i) => ({ id_by_customer: 1000 + i, to_from: "PayPal Inc Debit Card", amount: "0.10" }));
    const client = routedClient({});
    const r = await resolveCashback(client, rows);
    expect(vi.mocked(client.call)).toHaveBeenCalledTimes(25);
    // erfundene IDs ohne Datensatz: Abfrage schlägt fehl, alle bleiben unbestätigt
    expect(r.confirmed).toEqual([]);
    expect(r.unconfirmed).toHaveLength(27);
  });

  it("list_transactions without cashback adds no hint", async () => {
    const client = routedClient({ transactionsGet: { data: [listRow(purchase)] } });
    const [listTransactions] = createTransactionsTools(client);
    const res = await listTransactions.handler({});
    expect(res.structuredContent!.booking_hints).toBeUndefined();
    expect(res.content).toHaveLength(1);
  });

  it("get_transaction flags a single cashback payment", async () => {
    const client = routedClient({ settingsGetPostingaccounts: { data: [] } });
    const [, getTransaction] = createTransactionsTools(client);
    const res = await getTransaction.handler({ id_by_customer: 901 });
    expect((res.structuredContent!.booking_hints as unknown[])[0]).toMatchObject({ kind: "paypal_cashback", transaction_ids: [901] });
  });
});

describe("booking a cashback payment", () => {
  const entry = (split: Record<string, unknown>) => ({
    transactions: [{ transaction_id_by_customer: 901, splits: [{ amount: "1.23", postingaccount: 2700, postingtext: CASHBACK_POSTINGTEXT, vat: "0_none", ...split }] }],
    dry_run: true,
  });

  it("warns in dry_run when vat, account or text deviate", async () => {
    const client = routedClient({ transactionsGet: { data: [listRow(cashback)] }, settingsGetPostingaccounts: { data: [] } });
    const [, , addTransactionPostings] = createPostingsTools(client);
    const res = JSON.parse((await addTransactionPostings.handler(entry({ postingaccount: 4950, vat: "19_pre", postingtext: "Cashback" }) as never)).content[0].text);
    const w = (res.warnings as string[]).find((x) => x.includes("Cashback"))!;
    expect(w).toMatch(/Transaktion 901/);
    expect(w).toMatch(/0_none/);
    expect(w).toMatch(/2700/);
    expect(w).toMatch(/Buchungstext/);
  });

  it("stays silent for the recommended booking", async () => {
    const client = routedClient({ transactionsGet: { data: [listRow(cashback)] }, settingsGetPostingaccounts: { data: [] } });
    const [, , addTransactionPostings] = createPostingsTools(client);
    const res = JSON.parse((await addTransactionPostings.handler(entry({}) as never)).content[0].text);
    expect(JSON.stringify(res.warnings ?? [])).not.toMatch(/Cashback/);
  });

  it("checks the batch with one transactionsGet over the id range and skips wide ranges", async () => {
    const client = routedClient({ transactionsGet: { data: [cashback, purchase].map(listRow) } });
    expect([...(await fetchCashbackIds(client, [901, 902]))]).toEqual([901]);
    // BHB-Grenzen sind exklusiv: 900..903 liefert 901 und 902.
    expect(client.call).toHaveBeenCalledWith("transactionsGet", { id_by_customer_from: 900, id_by_customer_to: 903, limit: 500, offset: 0 });
    // nur der Kandidat 901 wird nachgeschlagen, der Einkauf 902 nicht
    expect(vi.mocked(client.call).mock.calls.filter((c) => c[0] === "transactionsGetIdByCustomer")).toHaveLength(1);
    expect((await fetchCashbackIds(client, [1, 900])).size).toBe(0);
    expect(client.call).toHaveBeenCalledTimes(2);
  });

  it("accepts the SKR04 account when the chart is unknown", () => {
    const splits = [{ postingaccount: 4830, vat: "0_none", postingtext: CASHBACK_POSTINGTEXT }];
    expect(cashbackPostingWarnings([{ transaction_id_by_customer: 901, splits }], new Set([901]), "unknown")).toEqual([]);
    expect(cashbackPostingWarnings([{ transaction_id_by_customer: 901, splits }], new Set([901]), "SKR03")[0]).toMatch(/2700/);
  });
});

describe("cashback knowledge", () => {
  it("the guide carries the legal reasoning, the sources and the open point", () => {
    const g = JSON.stringify(findBookingGuide("paypal_cashback"));
    expect(g).toMatch(/§ 17 Abs\. 1 UStG/);
    expect(g).toMatch(/V R 42\/17/);
    expect(g).toMatch(/§ 11 EStG/);
    expect(g).toMatch(/0_none/);
    expect(g).toMatch(/2700 \| 4830/);
    expect(g).toMatch(/kein BFH-Urteil/);
    expect(g).toMatch(/docs\/rechtsgrundlagen-paypal-cashback\.md/);
  });

  it("the server instructions point to the guide", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Cash Back Bonus.*paypal_cashback/s);
  });
});
