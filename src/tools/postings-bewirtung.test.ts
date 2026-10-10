import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { formatEntertainmentExpenseNote } from "./entertainment-expense.js";
import { createPostingsTools } from "./postings.js";

// All data is invented.
const LONG_PARTICIPANTS = "Max Mustermann (Beispiel Consulting GmbH), Erika Beispiel (Muster AG), Hans Testmann (Test KG)";
const LONG_OCCASION =
  "Gespräch mit Netzwerkpartnern zur Planung einer gemeinsamen Veranstaltung im Herbst 2026 inklusive Abstimmung der Aufgabenverteilung und des Budgets";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function client(opts: { commentError?: Error } = {}): BBClient {
  return {
    call: vi.fn(async (key: string) => {
      if (key === "commentsAdd" && opts.commentError) throw opts.commentError;
      return { success: true };
    }) as BBClient["call"],
  };
}

const docs = { participants: "Max Mustermann", occasion: "Planung der gemeinsamen Veranstaltung 2026", host_confirmed: true };

describe("audit comment length (BHB: comment_text 2-210 characters)", () => {
  it("keeps a short note unchanged", () => {
    expect(formatEntertainmentExpenseNote({ participants: "Person A", occasion: "Kundengespräch" })).toBe(
      "Bewirtung: Teilnehmer: Person A, Anlass: Kundengespräch"
    );
  });

  it("shortens a long note to at most 210 bytes and keeps both fields recognisable", () => {
    const note = formatEntertainmentExpenseNote({ participants: LONG_PARTICIPANTS, occasion: LONG_OCCASION });
    expect(bytes(note)).toBeLessThanOrEqual(210);
    expect(note).toContain("Teilnehmer: Max Mustermann");
    expect(note).toContain("Anlass: Gespräch mit Netzwerkpartnern");
  });

  it("counts umlauts as multiple bytes", () => {
    const note = formatEntertainmentExpenseNote({ participants: "Ä".repeat(150), occasion: "Ö".repeat(150) });
    expect(bytes(note)).toBeLessThanOrEqual(210);
  });

  it("add_transaction_postings sends a comment that fits the limit", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    await addTx.handler({
      transactions: [
        {
          transaction_id_by_customer: 705,
          participants: LONG_PARTICIPANTS,
          occasion: LONG_OCCASION,
          host_confirmed: true,
          splits: [
            { postingaccount: 4650, postingtext: "Bewirtung", vat: "19_vat", amount: "30.80" },
            { postingaccount: 4654, postingtext: "Bewirtung nicht abz.", vat: "19_vat", amount: "13.20" },
          ],
        },
      ],
    } as never);
    const call = vi.mocked(c.call).mock.calls.find((x) => x[0] === "commentsAdd")!;
    expect(bytes((call[1] as { comment_text: string }).comment_text)).toBeLessThanOrEqual(210);
  });

  it("add_receipt_postings sends a comment that fits the limit", async () => {
    const c = client();
    const [, addReceipt] = createPostingsTools(c);
    await addReceipt.handler({
      receipts: [
        {
          receipt_id_by_customer: 521,
          creditor: 70001,
          debtor: 10001,
          participants: LONG_PARTICIPANTS,
          occasion: LONG_OCCASION,
          host_confirmed: true,
          splits: [
            { postingaccount: 4650, postingtext: "Bewirtung", vat: "19_vat", amount: "70.00" },
            { postingaccount: 4654, postingtext: "Bewirtung nicht abz.", vat: "19_vat", amount: "30.00" },
          ],
        },
      ],
    } as never);
    const call = vi.mocked(c.call).mock.calls.find((x) => x[0] === "commentsAdd")!;
    expect(bytes((call[1] as { comment_text: string }).comment_text)).toBeLessThanOrEqual(210);
  });

  it("shortens a long travel-expense comment too", async () => {
    const c = client();
    const [, addReceipt] = createPostingsTools(c);
    await addReceipt.handler({
      receipts: [
        {
          receipt_id_by_customer: 9,
          creditor: 70001,
          debtor: 10001,
          traveler_name: "Max Mustermann",
          traveler_role: "owner_manager",
          business_purpose: "Kundentermin ".repeat(30),
          splits: [{ postingaccount: 4670, postingtext: "Reise", vat: "19_pre", amount: "10.00" }],
        },
      ],
    } as never);
    const call = vi.mocked(c.call).mock.calls.find((x) => x[0] === "commentsAdd")!;
    expect(bytes((call[1] as { comment_text: string }).comment_text)).toBeLessThanOrEqual(210);
  });

  it("does not throw when the comment fails after the booking - it reports a warning instead", async () => {
    const c = client({ commentError: new Error("invalid comment_text specified") });
    const [, , addTx] = createPostingsTools(c);
    const result = await addTx.handler({
      transactions: [
        {
          transaction_id_by_customer: 705,
          ...docs,
          splits: [
            { postingaccount: 4650, postingtext: "Bewirtung", vat: "19_vat", amount: "70.00" },
            { postingaccount: 4654, postingtext: "Bewirtung nicht abz.", vat: "19_vat", amount: "30.00" },
          ],
        },
      ],
    } as never);
    // transactionsGet: Cashback-Prüfung vor dem Buchen (nur lesend).
    expect(vi.mocked(c.call).mock.calls.map((x) => x[0])).toEqual(["transactionsGet", "postingsAddBatchTransactions", "commentsAdd"]);
    const data = result.structuredContent!.data as { warnings?: string[] };
    expect(data.warnings?.join(" ")).toMatch(/Kommentar.*705/);
    expect(data.warnings?.join(" ")).toMatch(/gebucht/);
  });
});

describe("entertainment_split_mode: net_reclass", () => {
  const netReclassEntry = {
    transaction_id_by_customer: 705,
    ...docs,
    entertainment_split_mode: "net_reclass",
    splits: [
      { postingaccount: 4650, postingtext: "Bewirtung Speisen", vat: "7_pre", amount: "32.10" },
      { postingaccount: 4650, postingtext: "Bewirtung Getränke", vat: "19_pre", amount: "11.90" },
    ],
  };

  it("books only the deductible account with full VAT and does not send the mode to BHB", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    await addTx.handler({ transactions: [netReclassEntry] } as never);
    expect(c.call).toHaveBeenCalledWith("postingsAddBatchTransactions", {
      transactions: [
        {
          transaction_id_by_customer: 705,
          oi_receipts_ids_by_customer: [null, null],
          postingaccounts: [4650, 4650],
          postingtexts: ["Bewirtung Speisen", "Bewirtung Getränke"],
          vats: ["7_pre", "19_pre"],
          amounts: ["32.10", "11.90"],
        },
      ],
    });
  });

  it("returns the 30 % of net reclass booking as a hint (12.00 for the worked example), not booked", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    const result = await addTx.handler({ transactions: [netReclassEntry] } as never);
    const data = result.structuredContent!.data as { entertainment_reclass_hints?: Array<Record<string, unknown>> };
    expect(data.entertainment_reclass_hints).toEqual([
      expect.objectContaining({
        transaction_id_by_customer: 705,
        net_total: "40.00",
        postingaccount_debit: 4654,
        postingaccount_credit: 4650,
        amount: "12.00",
        vat: "0_none",
      }),
    ]);
    expect(vi.mocked(c.call).mock.calls.map((x) => x[0])).not.toContain("postingsAddBatchFree");
  });

  it("maps SKR04 accounts", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    const entry = { ...netReclassEntry, splits: [{ postingaccount: 6640, postingtext: "B", vat: "19_pre", amount: "11.90" }] };
    const result = await addTx.handler({ transactions: [entry] } as never);
    const hints = (result.structuredContent!.data as { entertainment_reclass_hints: Array<Record<string, unknown>> })
      .entertainment_reclass_hints;
    expect(hints[0]).toMatchObject({ postingaccount_debit: 6644, postingaccount_credit: 6640, amount: "3.00" });
  });

  it("gives no amount when a VAT code cannot be converted to a net value", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    const entry = { ...netReclassEntry, splits: [{ postingaccount: 4650, postingtext: "B", vat: "19_both_1_no_pre", amount: "10.00" }] };
    const result = await addTx.handler({ transactions: [entry] } as never);
    const hints = (result.structuredContent!.data as { entertainment_reclass_hints: Array<Record<string, unknown>> })
      .entertainment_reclass_hints;
    expect(hints[0].amount).toBeNull();
  });

  it("rejects a non-deductible split in the same call, without booking", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    const entry = {
      ...netReclassEntry,
      splits: [...netReclassEntry.splits, { postingaccount: 4654, postingtext: "x", vat: "0_none", amount: "12.00" }],
    };
    await expect(addTx.handler({ transactions: [entry] } as never)).rejects.toThrow(/net_reclass.*4654|4654.*net_reclass/s);
    expect(c.call).not.toHaveBeenCalled();
  });

  it("still requires the documentation fields", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    await expect(
      addTx.handler({ transactions: [{ ...netReclassEntry, occasion: undefined }] } as never)
    ).rejects.toThrow(/occasion/);
    expect(c.call).not.toHaveBeenCalled();
  });

  it("works for add_receipt_postings with the receipt id in the hint", async () => {
    const c = client();
    const [, addReceipt] = createPostingsTools(c);
    const { transaction_id_by_customer, ...rest } = netReclassEntry;
    const result = await addReceipt.handler({
      receipts: [{ ...rest, receipt_id_by_customer: 521, creditor: 70001, debtor: 10001 }],
    } as never);
    const hints = (result.structuredContent!.data as { entertainment_reclass_hints: Array<Record<string, unknown>> })
      .entertainment_reclass_hints;
    expect(hints[0]).toMatchObject({ receipt_id_by_customer: 521, amount: "12.00" });
  });

  it("keeps the default gross_split behaviour: a lone 4650 is still rejected", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    const entry = { ...netReclassEntry, entertainment_split_mode: undefined };
    await expect(addTx.handler({ transactions: [entry] } as never)).rejects.toThrow(/4654/);
    expect(c.call).not.toHaveBeenCalled();
  });
});
