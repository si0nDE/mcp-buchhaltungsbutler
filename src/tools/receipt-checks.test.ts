import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { isReverseChargeVat, median, quarterOf, receiptCheckWarnings } from "./receipt-checks.js";

// Erfundene Belege eines erfundenen Lieferanten "Beispiel Cloud Inc.".
type Receipt = Record<string, unknown>;

function clientFor(receipts: Record<number, Receipt>, booking: Record<number, string> = {}): BBClient {
  const list = Object.entries(receipts).map(([id, r]) => ({ id_by_customer: id, date: r.date, counterparty: r.counterparty }));
  return {
    call: vi.fn(async (key: string, _params: unknown, options?: { idSuffix?: number }) => {
      if (key === "receiptsGetIdByCustomer") return { success: true, data: receipts[options?.idSuffix as number] };
      if (key === "transactionsGetIdByCustomer") return { success: true, data: { booking_date: booking[options?.idSuffix as number] } };
      if (key === "receiptsGet") return { success: true, data: list };
      throw new Error(`unexpected ${key}`);
    }) as BBClient["call"],
  };
}

const usd = (id: number, date: string, rate: number): [number, Receipt] => [
  id,
  { date, counterparty: "Beispiel Cloud Inc.", amount: "10.00", amount_original: "11.00", currency_original: "USD", exchangerate: rate },
];

describe("helpers", () => {
  it("knows the §13b codes, quarters and the median", () => {
    expect(isReverseChargeVat("19_both_511")).toBe(true);
    expect(isReverseChargeVat("19_pre")).toBe(false);
    expect(quarterOf("2026-03-31 00:00:00")).toBe("2026-Q1");
    expect(quarterOf("2026-04-01")).toBe("2026-Q2");
    expect(quarterOf("kaputt")).toBeUndefined();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("W4: § 13b Meldeperiode", () => {
  it("warns when receipt and payment lie in different quarters, using the transaction's booking date", async () => {
    const client = clientFor({ 7: { date: "2026-03-28", counterparty: "Beispiel Cloud Inc." } }, { 100: "2026-04-02 00:00:00" });
    const w = await receiptCheckWarnings(client, [
      { label: "Transaktion 100", transactionId: 100, splits: [{ vat: "19_both_511", receipt_id_by_customer: 7 }] },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/Meldeperiode weicht ab.*Beleg 7.*2026-Q1.*2026-Q2/);
    expect(w[0]).toMatch(/Nicht umdatieren/);
  });

  it("uses the abweichendes Leistungsdatum and the date of a free posting; stays silent in the same quarter or for other codes", async () => {
    const client = clientFor({
      7: { date: "2026-03-28", delivery_date: "2026-04-05" },
      8: { date: "2026-03-28" },
    });
    expect(await receiptCheckWarnings(client, [{ label: "Freie Buchung 1", paymentDate: "2026-04-20", splits: [{ vat: "19_both_511", receipt_id_by_customer: 7 }] }])).toEqual([]);
    expect(await receiptCheckWarnings(client, [{ label: "Freie Buchung 1", paymentDate: "2026-04-20", splits: [{ vat: "19_pre", receipt_id_by_customer: 8 }] }])).toEqual([]);
    const across = await receiptCheckWarnings(client, [{ label: "Freie Buchung 1", paymentDate: "2027-01-10", splits: [{ vat: "19_both_511", receipt_id_by_customer: 8 }] }]);
    expect(across[0]).toMatch(/2026-Q1.*2027-Q1/);
  });

  it("makes no calls without a receipt and swallows lookup failures", async () => {
    const client = clientFor({});
    expect(await receiptCheckWarnings(client, [{ label: "x", paymentDate: "2026-04-20", splits: [{ vat: "19_both_511" }] }])).toEqual([]);
    expect(client.call).not.toHaveBeenCalled();
    const broken = { call: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as BBClient;
    expect(await receiptCheckWarnings(broken, [{ label: "x", paymentDate: "2026-04-20", splits: [{ vat: "19_both_511", receipt_id_by_customer: 1 }] }])).toEqual([]);
  });
});

describe("W3: Kurs-Ausreißer", () => {
  const base = Object.fromEntries([usd(1, "2026-01-05", 1.1), usd(2, "2026-02-05", 1.11), usd(3, "2026-03-05", 1.09), usd(4, "2026-04-05", 1.1)]);

  it("warns when the rate deviates more than 5 % from the median of the nearest receipts", async () => {
    const client = clientFor({ ...base, ...Object.fromEntries([usd(9, "2026-03-06", 1.2386)]) });
    const w = await receiptCheckWarnings(client, [{ label: "Transaktion 1", paymentDate: "2026-03-07", splits: [{ vat: "19_pre", receipt_id_by_customer: 9 }] }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/Kurs auffällig.*Beleg 9: Kurs 1\.2386 \(USD\).*Median der 4 nächsten Belege 1\.1000/);
  });

  it("stays silent for a normal rate, for EUR receipts and with fewer than 3 neighbours", async () => {
    const normal = clientFor({ ...base, ...Object.fromEntries([usd(9, "2026-03-06", 1.12)]) });
    expect(await receiptCheckWarnings(normal, [{ label: "T", paymentDate: "2026-03-07", splits: [{ vat: "19_pre", receipt_id_by_customer: 9 }] }])).toEqual([]);
    const eur = clientFor({ 9: { date: "2026-03-06", counterparty: "Beispiel Cloud Inc.", currency_original: "EUR", exchangerate: 1 } });
    expect(await receiptCheckWarnings(eur, [{ label: "T", paymentDate: "2026-03-07", splits: [{ vat: "19_pre", receipt_id_by_customer: 9 }] }])).toEqual([]);
    const few = clientFor(Object.fromEntries([usd(1, "2026-01-05", 1.1), usd(9, "2026-03-06", 1.5)]));
    expect(await receiptCheckWarnings(few, [{ label: "T", paymentDate: "2026-03-07", splits: [{ vat: "19_pre", receipt_id_by_customer: 9 }] }])).toEqual([]);
  });
});
