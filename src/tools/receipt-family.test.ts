import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";

vi.mock("./receipt-text-extraction.js", () => ({
  extractReceiptText: vi.fn(async (b64: string) => (b64 === "none" ? undefined : Buffer.from(b64, "base64").toString("utf8"))),
}));

import { candidateKeys, createReceiptFamilyTools, groupByShared } from "./receipt-family.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("candidateKeys", () => {
  it("keeps case numbers and drops dates, amounts, IBAN, VAT id and short tokens", () => {
    const keys = candidateKeys(
      "Abrechnung 2026-10001 vom 16.04.2026 über 1.234,56 EUR, IBAN DE12500105170648489890, USt-IdNr. DE123456789, Nr. 1/23, RE-000123"
    );
    expect([...keys].sort()).toEqual(["000123", "2026-10001"]);
  });
});

describe("groupByShared", () => {
  const docs = [
    { id: 1, text: "Abrechnung 2026-10001 Kundennr 4711-0815 Musterstr 1" },
    { id: 2, text: "Kostenrechnung zu 2026-10001 Kundennr 4711-0815" },
    { id: 3, text: "Abrechnung 2026-10002 Kundennr 4711-0815" },
    { id: 4, text: "Kostenrechnung zu 2026-10002 Kundennr 4711-0815" },
    { id: 5, text: "Etwas ganz anderes 99-AB-777" },
  ];

  it("links by a number shared by few receipts and ignores a number that is in nearly all", () => {
    const groups = groupByShared(docs, 3).map((g) => g.ids).sort();
    expect(groups).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("links a number with and without a letter prefix (Rechnung KR-2026-10001 to Abrechnung 2026-10001)", () => {
    const g = groupByShared([
      { id: 10, text: "Abrechnung / Gutschrift Nr. 2026-10001" },
      { id: 11, text: "Verwendungszweck: Rechnungsnummer KR-2026-10001 – Anwaltshonorar" },
    ]);
    expect(g).toEqual([{ ids: [10, 11], keys: ["2026-10001"] }]);
  });

  it("names the shared numbers", () => {
    const g = groupByShared(docs, 3).find((x) => x.ids.includes(1))!;
    expect(g.keys).toEqual(["2026-10001"]);
  });
});

describe("pair_receipt_family", () => {
  function client(receipts: Record<number, { text: string | null; date?: string | null; amount: string; tx: Array<{ id_by_customer: number; amount: string }> }>) {
    return {
      call: vi.fn(async (key: string, params: Record<string, unknown>, opts?: { idSuffix?: number }) => {
        if (key === "receiptsGetIdByCustomer") {
          const r = receipts[opts!.idSuffix!];
          return {
            data: {
              type: "invoice inbound",
              counterparty: "Beispiel",
              invoicenumber: `N-${opts!.idSuffix}`,
              date: r.date === undefined ? "2026-04-16" : r.date,
              amount: r.amount,
              file_type: "pdf",
              file_content: r.text === null ? "none" : b64(r.text),
            },
          };
        }
        if (key === "receiptsAssignedTransactionsGet") return { data: receipts[params.receipt_id_by_customer as number].tx };
        throw new Error(`unexpected ${key}`);
      }),
    } as unknown as BBClient;
  }
  const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

  it("groups a case, lists the gaps and asks about receipts it cannot place", async () => {
    const c = client({
      1: { text: "Abrechnung 2026-10001", amount: "80.00", tx: [{ id_by_customer: 7001, amount: "80.00" }] },
      2: { text: "Kostenrechnung zu 2026-10001", amount: "388.12", date: null, tx: [] },
      3: { text: "Nichts Gemeinsames 55-ZZ-123", amount: "10.00", tx: [{ id_by_customer: 7002, amount: "9.00" }] },
      4: { text: null, amount: "5.00", tx: [] },
    });
    const [tool] = createReceiptFamilyTools(c);
    const res = parse(await tool.handler({ receipt_ids: [1, 2, 3, 4], max_family_size: 4 }));

    expect(res.cases).toHaveLength(1);
    expect(res.cases[0].shared_numbers).toEqual(["2026-10001"]);
    const byId = Object.fromEntries(res.cases[0].receipts.map((r: { id_by_customer: number }) => [r.id_by_customer, r]));
    expect(byId[1].gaps).toBeUndefined();
    expect(byId[2].gaps).toEqual(["Beleg ohne Datum", "keine Zahlung zugeordnet"]);

    const un = Object.fromEntries(res.unassigned.map((r: { id_by_customer: number }) => [r.id_by_customer, r]));
    expect(un[3].question).toMatch(/Zu welchem Fall gehört Beleg 3/);
    expect(un[3].gaps[0]).toMatch(/weichen vom Belegbetrag/);
    expect(un[4].reason).toMatch(/Kein Text lesbar/);
  });

  it("does not report a payment shared by the receipts of a case as a gap", async () => {
    const c = client({
      1: { text: "Abrechnung Nr. 2026-10001", amount: "152.00", tx: [{ id_by_customer: 7001, amount: "152.00" }] },
      2: { text: "Rechnungsnummer KR-2026-10001", amount: "400.00", tx: [{ id_by_customer: 7001, amount: "152.00" }] },
    });
    const [tool] = createReceiptFamilyTools(c);
    const res = parse(await tool.handler({ receipt_ids: [1, 2], max_family_size: 4 }));
    const r2 = res.cases[0].receipts.find((r: { id_by_customer: number }) => r.id_by_customer === 2);
    expect(r2.gaps).toBeUndefined();
    expect(r2.hints[0]).toMatch(/hängt auch an Beleg 1.*Drittzahlung/);
  });

  it("flags two payments of the same amount on one receipt as a likely wrong assignment, not as Drittzahlung", async () => {
    const c = client({
      1: { text: "Abrechnung Nr. 2026-10003", amount: "80.00", tx: [{ id_by_customer: 7001, amount: "80.00" }, { id_by_customer: 7002, amount: "80.00" }] },
      2: { text: "Rechnungsnummer KR-2026-10003", amount: "388.12", tx: [{ id_by_customer: 7001, amount: "80.00" }] },
    });
    const [tool] = createReceiptFamilyTools(c);
    const res = parse(await tool.handler({ receipt_ids: [1, 2], max_family_size: 4 }));
    const by = Object.fromEntries(res.cases[0].receipts.map((r: { id_by_customer: number }) => [r.id_by_customer, r]));
    expect(by[1].gaps[0]).toMatch(/übersteigen den Belegbetrag 80.00.*7001, 7002/);
    expect(by[1].hints).toBeUndefined();
    expect(by[2].gaps).toBeUndefined();
    expect(by[2].hints[0]).toMatch(/Drittzahlung/);
  });

  it("is read-only and only reads from BHB", async () => {
    const c = client({
      1: { text: "A 2026-10001", amount: "1.00", tx: [] },
      2: { text: "B 2026-10001", amount: "1.00", tx: [] },
    });
    const [tool] = createReceiptFamilyTools(c);
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    await tool.handler({ receipt_ids: [1, 2], max_family_size: 4 });
    const keys = (c.call as ReturnType<typeof vi.fn>).mock.calls.map((x) => x[0]);
    expect(new Set(keys)).toEqual(new Set(["receiptsGetIdByCustomer", "receiptsAssignedTransactionsGet"]));
  });
});
