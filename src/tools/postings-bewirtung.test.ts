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

describe("new Bewirtung fields in the posting tools", () => {
  const noInvoice = {
    participants: "Max Mustermann, Erika Beispiel",
    occasion: "Besprechung zur Angebotsplanung 2026",
    original_invoice_status: "missing_requested",
    entertainment_type: "business",
    missing_invoice_treatment: "practice_70_30_no_vat",
    bewirtungsangaben_signed: true,
  };
  const splits = [
    { postingaccount: 4650, postingtext: "Bewirtung", vat: "0_none", amount: "26.25" },
    { postingaccount: 4654, postingtext: "Bewirtung nicht abz.", vat: "0_none", amount: "11.25" },
  ];

  it("does not send the audit fields to BuchhaltungsButler and adds the variant to the comment", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    const result = await addTx.handler({ transactions: [{ transaction_id_by_customer: 1001, splits, ...noInvoice }] } as never);
    const sent = vi.mocked(c.call).mock.calls.find((x) => x[0] === "postingsAddBatchTransactions")![1] as {
      transactions: Array<Record<string, unknown>>;
    };
    for (const key of [
      "entertainment_type",
      "original_invoice_status",
      "missing_invoice_treatment",
      "bewirtungsangaben_signed",
      "participants",
      "occasion",
    ]) {
      expect(sent.transactions[0]).not.toHaveProperty(key);
    }
    const comment = vi.mocked(c.call).mock.calls.find((x) => x[0] === "commentsAdd")![1] as { comment_text: string };
    expect(comment.comment_text).toContain("Variante: practice_70_30_no_vat");
    expect(JSON.stringify(result)).toContain("X R 57/09");
  });

  it("rejects an input-VAT code without an invoice before anything is sent", async () => {
    const c = client();
    const [, addReceipt] = createPostingsTools(c);
    await expect(
      addReceipt.handler({
        receipts: [
          {
            receipt_id_by_customer: 521,
            creditor: 0,
            debtor: 0,
            splits: [
              { postingaccount: 4650, postingtext: "Bewirtung", vat: "19_pre", amount: "26.25" },
              { postingaccount: 4654, postingtext: "Bewirtung nicht abz.", vat: "0_none", amount: "11.25" },
            ],
            ...noInvoice,
          },
        ],
      } as never)
    ).rejects.toThrow(/Vorsteuer ohne Rechnung/);
    expect(c.call).not.toHaveBeenCalled();
  });

  it("rejects host_confirmed together with original_invoice_status before anything is sent", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    await expect(
      addTx.handler({
        transactions: [{ transaction_id_by_customer: 1001, splits, ...noInvoice, host_confirmed: true }],
      } as never)
    ).rejects.toThrow(/host_confirmed/);
    expect(c.call).not.toHaveBeenCalled();
  });

  it("puts the guard warnings into the dry run", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    const result = await addTx.handler({
      dry_run: true,
      transactions: [{ transaction_id_by_customer: 1001, splits, ...noInvoice }],
    } as never);
    expect(JSON.stringify(result)).toContain("X R 57/09");
  });

  it("uses invoice_net_total for the net_reclass hint (6.18 instead of 6.19)", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    const result = await addTx.handler({
      transactions: [
        {
          transaction_id_by_customer: 1002,
          participants: "Max Mustermann",
          occasion: "Besprechung zur Angebotsplanung 2026",
          bewirtungsangaben_signed: true,
          entertainment_split_mode: "net_reclass",
          invoice_net_total: 20.6,
          splits: [
            { postingaccount: 4650, postingtext: "Bewirtung 7 %", vat: "7_pre", amount: "14.15" },
            { postingaccount: 4650, postingtext: "Bewirtung 19 %", vat: "19_pre", amount: "8.80" },
          ],
        },
      ],
    } as never);
    const text = JSON.stringify(result);
    expect(text).toContain('"amount":"6.18"');
    expect(text).toContain('"net_total":"20.60"');
  });
});

describe("final review: Nahtstellen in den Buchungs-Tools", () => {
  const internalSplit = [{ postingaccount: 4650, postingtext: "Teamessen", vat: "19_pre", amount: "50.00" }];
  const callKeys = (c: BBClient) => vi.mocked(c.call).mock.calls.map((x) => x[0]);
  const dataOf = (result: { structuredContent?: { data?: unknown } }) =>
    result.structuredContent!.data as { warnings?: string[]; entertainment_reclass_hints?: Array<Record<string, unknown>> };

  describe("item 1: non-business types without participants/occasion", () => {
    for (const type of ["internal_employees", "sole_proprietor_self"] as const) {
      it(`add_transaction_postings ${type} on 4650 without participants/occasion: no throw, warning, no comment`, async () => {
        const c = client();
        const [, , addTx] = createPostingsTools(c);
        const result = await addTx.handler({
          transactions: [{ transaction_id_by_customer: 1001, entertainment_type: type, splits: internalSplit }],
        } as never);
        expect(callKeys(c)).toContain("postingsAddBatchTransactions");
        expect(callKeys(c)).not.toContain("commentsAdd");
        expect(dataOf(result).warnings?.length).toBeGreaterThan(0);
      });

      it(`add_receipt_postings ${type} on 4650 without participants/occasion: no throw, warning, no comment`, async () => {
        const c = client();
        const [, addReceipt] = createPostingsTools(c);
        const result = await addReceipt.handler({
          receipts: [{ receipt_id_by_customer: 521, creditor: 70001, debtor: 0, entertainment_type: type, splits: internalSplit }],
        } as never);
        expect(callKeys(c)).toContain("postingsAddBatchReceipts");
        expect(callKeys(c)).not.toContain("commentsAdd");
        expect(dataOf(result).warnings?.length).toBeGreaterThan(0);
      });
    }

    it("sends the audit comment for internal_employees when participants and occasion are given", async () => {
      const c = client();
      const [, , addTx] = createPostingsTools(c);
      await addTx.handler({
        transactions: [
          {
            transaction_id_by_customer: 1001,
            entertainment_type: "internal_employees",
            participants: "Team Beispiel",
            occasion: "Teamessen zum Projektabschluss Musterprojekt",
            splits: internalSplit,
          },
        ],
      } as never);
      expect(callKeys(c)).toContain("commentsAdd");
    });
  });

  describe("item 2: 250 EUR limit for practice_70_30_no_vat", () => {
    const practice = {
      participants: "Max Mustermann, Erika Beispiel",
      occasion: "Besprechung zur Angebotsplanung 2026",
      original_invoice_status: "lost",
      entertainment_type: "business",
      missing_invoice_treatment: "practice_70_30_no_vat",
      bewirtungsangaben_signed: true,
    };
    const split = (a: string, b: string) => [
      { postingaccount: 4650, postingtext: "Bewirtung", vat: "0_none", amount: a },
      { postingaccount: 4654, postingtext: "Bewirtung nicht abz.", vat: "0_none", amount: b },
    ];

    it("rejects 400.00 without acknowledge_practice_over_250, before anything is sent", async () => {
      const c = client();
      const [, , addTx] = createPostingsTools(c);
      await expect(
        addTx.handler({ transactions: [{ transaction_id_by_customer: 1001, ...practice, splits: split("280.00", "120.00") }] } as never)
      ).rejects.toThrow(/acknowledge_practice_over_250/);
      expect(c.call).not.toHaveBeenCalled();
    });

    it("books 400.00 with acknowledge_practice_over_250 and warns, without sending the flag", async () => {
      const c = client();
      const [, , addTx] = createPostingsTools(c);
      const result = await addTx.handler({
        transactions: [
          { transaction_id_by_customer: 1001, ...practice, acknowledge_practice_over_250: true, splits: split("280.00", "120.00") },
        ],
      } as never);
      expect(dataOf(result).warnings?.join(" ")).toMatch(/400,00 € liegt über 250 €.*Nutzerentscheid/);
      const sent = vi.mocked(c.call).mock.calls.find((x) => x[0] === "postingsAddBatchTransactions")![1] as {
        transactions: Array<Record<string, unknown>>;
      };
      expect(sent.transactions[0]).not.toHaveProperty("acknowledge_practice_over_250");
    });

    it("books exactly 250.00 with practice without the flag", async () => {
      const c = client();
      const [, addReceipt] = createPostingsTools(c);
      await addReceipt.handler({
        receipts: [{ receipt_id_by_customer: 521, creditor: 70001, debtor: 0, ...practice, splits: split("175.00", "75.00") }],
      } as never);
      expect(callKeys(c)).toContain("postingsAddBatchReceipts");
    });

    it("has no limit for conservative_100_nondeductible", async () => {
      const c = client();
      const [, , addTx] = createPostingsTools(c);
      await addTx.handler({
        transactions: [
          {
            transaction_id_by_customer: 1001,
            ...practice,
            missing_invoice_treatment: "conservative_100_nondeductible",
            splits: [{ postingaccount: 4654, postingtext: "Bewirtung nicht abz.", vat: "0_none", amount: "400.00" }],
          },
        ],
      } as never);
      expect(callKeys(c)).toContain("postingsAddBatchTransactions");
    });
  });

  it("item 3: business type on 4140 warns that it belongs on 4650/4654", async () => {
    const c = client();
    const [, , addTx] = createPostingsTools(c);
    const result = await addTx.handler({
      transactions: [
        {
          transaction_id_by_customer: 1001,
          entertainment_type: "business",
          splits: [{ postingaccount: 4140, postingtext: "Essen", vat: "19_pre", amount: "50.00" }],
        },
      ],
    } as never);
    expect(dataOf(result).warnings?.join(" ")).toContain(
      "entertainment_type business (geschäftliche Bewirtung) gehört auf 4650/4654 (SKR04 6640/6644) im 70/30-Verhältnis"
    );
  });

  describe("item 5: invoice_net_total with decimal comma", () => {
    const entry = {
      transaction_id_by_customer: 1002,
      participants: "Max Mustermann",
      occasion: "Besprechung zur Angebotsplanung 2026",
      bewirtungsangaben_signed: true,
      entertainment_split_mode: "net_reclass",
      splits: [
        { postingaccount: 4650, postingtext: "Bewirtung 7 %", vat: "7_pre", amount: "14.15" },
        { postingaccount: 4650, postingtext: "Bewirtung 19 %", vat: "19_pre", amount: "8.80" },
      ],
    };

    it('accepts "20,60" (6.18 / 20.60)', async () => {
      const c = client();
      const [, , addTx] = createPostingsTools(c);
      const result = await addTx.handler({ transactions: [{ ...entry, invoice_net_total: "20,60" }] } as never);
      expect(dataOf(result).entertainment_reclass_hints?.[0]).toMatchObject({ amount: "6.18", net_total: "20.60" });
    });

    it('rejects "abc" before anything is sent', async () => {
      const c = client();
      const [, , addTx] = createPostingsTools(c);
      await expect(addTx.handler({ transactions: [{ ...entry, invoice_net_total: "abc" }] } as never)).rejects.toThrow(
        /invoice_net_total ist keine Zahl/
      );
      expect(c.call).not.toHaveBeenCalled();
    });
  });

  describe("net_reclass without an invoice (100 % on 4650, 30 % reclassified)", () => {
    const base = {
      transaction_id_by_customer: 1001,
      participants: "Max Mustermann, Erika Beispiel",
      occasion: "Besprechung zur Angebotsplanung 2026",
      bewirtungsangaben_signed: true,
      original_invoice_status: "lost",
      entertainment_type: "business",
      missing_invoice_treatment: "practice_70_30_no_vat",
      entertainment_split_mode: "net_reclass",
    };
    const book37 = [{ postingaccount: 4650, postingtext: "Bewirtung", vat: "0_none", amount: "37.50" }];

    it("37.50 EUR without an invoice -> hint 11.25 from 4654 to 4650, 0_none (base = gross = net)", async () => {
      const c = client();
      const [, , addTx] = createPostingsTools(c);
      const result = await addTx.handler({ transactions: [{ ...base, splits: book37 }] } as never);
      expect(dataOf(result).entertainment_reclass_hints?.[0]).toMatchObject({
        net_total: "37.50",
        amount: "11.25",
        postingaccount_debit: 4654,
        postingaccount_credit: 4650,
        vat: "0_none",
      });
      const sent = vi.mocked(c.call).mock.calls.find((x) => x[0] === "postingsAddBatchTransactions")![1] as {
        transactions: Array<{ amounts: string[]; vats: string[] }>;
      };
      expect(sent.transactions[0]).toMatchObject({ amounts: ["37.50"], vats: ["0_none"] });
    });

    it("conservative variant: the whole amount is reclassified", async () => {
      const c = client();
      const [, , addTx] = createPostingsTools(c);
      const result = await addTx.handler({
        transactions: [{ ...base, missing_invoice_treatment: "conservative_100_nondeductible", splits: book37 }],
      } as never);
      expect(dataOf(result).entertainment_reclass_hints?.[0]).toMatchObject({ amount: "37.50" });
    });

    it("also works for add_receipt_postings", async () => {
      const c = client();
      const [, addReceipt] = createPostingsTools(c);
      const { transaction_id_by_customer, ...rest } = base;
      const result = await addReceipt.handler({
        receipts: [{ ...rest, receipt_id_by_customer: 521, creditor: 0, debtor: 0, splits: book37 }],
      } as never);
      expect(dataOf(result).entertainment_reclass_hints?.[0]).toMatchObject({ amount: "11.25" });
    });

    it("ignores invoice_net_total when there is no invoice", async () => {
      const c = client();
      const [, , addTx] = createPostingsTools(c);
      const result = await addTx.handler({ transactions: [{ ...base, invoice_net_total: "20,60", splits: book37 }] } as never);
      expect(dataOf(result).entertainment_reclass_hints?.[0]).toMatchObject({ net_total: "37.50", amount: "11.25" });
    });

    it("internal_employees without an invoice: allowed, 50.00 -> 15.00", async () => {
      const c = client();
      const [, , addTx] = createPostingsTools(c);
      const result = await addTx.handler({
        transactions: [
          {
            transaction_id_by_customer: 1001,
            entertainment_type: "internal_employees",
            original_invoice_status: "lost",
            entertainment_split_mode: "net_reclass",
            participants: "Team Beispiel",
            occasion: "Teamessen zum Projektabschluss Musterprojekt",
            splits: [{ postingaccount: 4650, postingtext: "Teamessen", vat: "0_none", amount: "50.00" }],
          },
        ],
      } as never);
      expect(dataOf(result).entertainment_reclass_hints?.[0]).toMatchObject({ amount: "15.00" });
    });

    it("keeps blocking an input-VAT code and any VAT code other than 0_none, before anything is sent", async () => {
      const c = client();
      const [, , addTx] = createPostingsTools(c);
      await expect(
        addTx.handler({ transactions: [{ ...base, splits: [{ ...book37[0], vat: "19_pre" }] }] } as never)
      ).rejects.toThrow(/Vorsteuer ohne Rechnung/);
      await expect(
        addTx.handler({ transactions: [{ ...base, splits: [{ ...book37[0], vat: "19_vat" }] }] } as never)
      ).rejects.toThrow(/0_none/);
      expect(c.call).not.toHaveBeenCalled();
    });

    it("with an invoice present the net-based hint is unchanged", async () => {
      const c = client();
      const [, , addTx] = createPostingsTools(c);
      const result = await addTx.handler({
        transactions: [
          {
            transaction_id_by_customer: 1002,
            participants: "Max Mustermann",
            occasion: "Besprechung zur Angebotsplanung 2026",
            bewirtungsangaben_signed: true,
            entertainment_split_mode: "net_reclass",
            invoice_net_total: 20.6,
            splits: [{ postingaccount: 4650, postingtext: "Bewirtung", vat: "19_pre", amount: "24.51" }],
          },
        ],
      } as never);
      expect(dataOf(result).entertainment_reclass_hints?.[0]).toMatchObject({ net_total: "20.60", amount: "6.18" });
    });
  });
});
