import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { findMerchantCreditor } from "./mixed-receipt-creditor.js";

const NOW = new Date("2026-11-10T12:00:00Z");

const receipt = (id: number, extra: Record<string, unknown> = {}) => ({ id_by_customer: String(id), counterparty: "Beispielmarkt", invoicenumber: `BM-${id}`, deleted: "0", ...extra });
// A receipt posting on a Kreditor: Soll expense / Haben Kreditor.
const receiptPosting = (receiptId: number, credit: number, extra: Record<string, unknown> = {}) => ({
  id_by_customer: `p${receiptId}`,
  receipt_id_by_customer: String(receiptId),
  transaction_id_by_customer: "",
  debit_postingaccount_number: "4653",
  credit_postingaccount_number: String(credit),
  ...extra,
});

function fake(o: { receipts?: Array<Record<string, unknown>>; postings?: Array<Record<string, unknown>>; fail?: string }) {
  const call = vi.fn(async (key: string, _params?: unknown) => {
    if (key === o.fail) throw new Error("HTTP 500");
    if (key === "receiptsGet") return { success: true, data: o.receipts ?? [] };
    if (key === "postingsGet") return { success: true, data: o.postings ?? [] };
    throw new Error(`unexpected endpoint ${key}`);
  });
  return { client: { call } as unknown as BBClient, call };
}
const find = (client: BBClient, excludeIds: number[] = [777, 42]) => findMerchantCreditor(client, "Beispielmarkt", { excludeIds, now: NOW });

describe("findMerchantCreditor", () => {
  it("derives the one Kreditor an earlier receipt of the merchant was booked on, with the receipts as evidence", async () => {
    const { client, call } = fake({ receipts: [receipt(500), receipt(501)], postings: [receiptPosting(500, 70555), receiptPosting(501, 70555)] });
    const r = await find(client);
    expect(r).toEqual({ creditor: 70555, source: "derived", evidence: ["Beleg 500 (BM-500)", "Beleg 501 (BM-501)"] });
    const list = call.mock.calls.find((c) => c[0] === "receiptsGet")![1] as Record<string, unknown>;
    expect(list).toMatchObject({ list_direction: "inbound", counterparty: "Beispielmarkt", order: { date: "DESC" } });
    const postings = call.mock.calls.find((c) => c[0] === "postingsGet")![1] as Record<string, unknown>;
    expect(postings).toMatchObject({ date_from: "2024-11-10", date_to: "2026-11-10", posting_status: "all" });
  });

  it("returns candidates when earlier receipts sit on different Kreditoren", async () => {
    const { client } = fake({ receipts: [receipt(500), receipt(501)], postings: [receiptPosting(500, 70555), receiptPosting(501, 70556)] });
    const r = await find(client);
    expect(r).toEqual({
      candidates: [
        { creditor: 70555, evidence: ["Beleg 500 (BM-500)"] },
        { creditor: 70556, evidence: ["Beleg 501 (BM-501)"] },
      ],
    });
  });

  it("ignores deleted receipts, the new receipt, the original and other merchants; matches by receipt, never by name", async () => {
    const { client } = fake({
      receipts: [
        receipt(500, { deleted: "1" }),
        receipt(777),
        receipt(42),
        receipt(502, { counterparty: "Anderer Markt" }),
        receipt(503),
      ],
      postings: [receiptPosting(500, 70999), receiptPosting(777, 70998), receiptPosting(42, 70997), receiptPosting(502, 70996), receiptPosting(503, 70555)],
    });
    expect(await find(client)).toEqual({ creditor: 70555, source: "derived", evidence: ["Beleg 503 (BM-503)"] });
  });

  it("only counts credit accounts in the Kreditor range on receipt postings", async () => {
    const { client } = fake({
      receipts: [receipt(500)],
      postings: [
        receiptPosting(500, 1200), // credit is no Kreditor
        receiptPosting(500, 70555, { debit_postingaccount_number: "70555", credit_postingaccount_number: "1200" }), // Kreditor on the debit side (Ausgleich)
        receiptPosting(500, 70555, { transaction_id_by_customer: "9001" }), // payment posting
        receiptPosting(500, 10000), // Debitoren-Sammelkonto
      ],
    });
    const r = await find(client);
    expect("none" in r).toBe(true);
  });

  it("says why there is none: no receipts, no postings", async () => {
    const noReceipts = await find(fake({ receipts: [] }).client);
    expect(noReceipts).toEqual({ none: expect.stringMatching(/früheren Belege/) });
    const noPostings = await find(fake({ receipts: [receipt(500)], postings: [] }).client);
    expect(noPostings).toEqual({ none: expect.stringMatching(/keine Beleg-Buchung auf einem Kreditor/) });
  });

  it("never throws: a failing endpoint gives none with the reason", async () => {
    for (const fail of ["receiptsGet", "postingsGet"]) {
      const r = await find(fake({ receipts: [receipt(500)], postings: [], fail }).client);
      expect(r).toEqual({ none: expect.stringMatching(/HTTP 500/) });
    }
  });

  it("only reads and never asks for contacts or accounts by name", async () => {
    const { client, call } = fake({ receipts: [receipt(500)], postings: [receiptPosting(500, 70555)] });
    await find(client);
    expect(call.mock.calls.map((c) => c[0]).sort()).toEqual(["postingsGet", "receiptsGet"]);
  });

  it("looks at no more than 10 receipts, newest first", async () => {
    const receipts = Array.from({ length: 12 }, (_, i) => receipt(600 + i));
    const postings = receipts.map((r) => receiptPosting(Number(r.id_by_customer), 70555));
    const r = await find(fake({ receipts, postings }).client);
    expect("evidence" in r && r.evidence).toHaveLength(10);
  });
});
