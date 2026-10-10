import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { assertTransactionEntry, lockedAccountHint, LOCKED_SACHKONTEN } from "./bhb-systematik.js";
import { createMonthEndTools } from "./month-end.js";
import { createPostingAccountsTools } from "./posting-accounts.js";
import { createTransactionsTools } from "./transactions.js";
import { createUstVaTools, lookupUstVa, UST_VA_ACCOUNTS, UST_VA_BY_RATE } from "./ustva-mapping.js";

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("USt-VA Kennziffer lookup", () => {
  it("holds all 95 rows of the BHB table with unique account/position rows", () => {
    expect(UST_VA_ACCOUNTS).toHaveLength(95);
    for (const r of UST_VA_ACCOUNTS) {
      expect(Number.isInteger(r[0]) && Number.isInteger(r[1]) && Number.isInteger(r[3])).toBe(true);
      expect(r[2].length).toBeGreaterThan(3);
    }
  });

  it("finds the documented positions for the special-case accounts", () => {
    expect(lookupUstVa({ account: 8336 })[0]).toMatchObject({ kennziffer: 21, treffer: "SKR03" });
    expect(lookupUstVa({ account: 4336 })[0]).toMatchObject({ kennziffer: 21, treffer: "SKR04" });
    expect(lookupUstVa({ account: 1794 })[0].kennziffer).toBe(69);
    expect(lookupUstVa({ account: 1573 })[0].kennziffer).toBe(66);
    expect(lookupUstVa({ account: 1784 })[0].kennziffer).toBe(96);
    expect(lookupUstVa({ account: 3440 })[0].kennziffer).toBe(94);
    expect(lookupUstVa({ account: 8125 })[0].kennziffer).toBe(41);
  });

  it("searches by Kennziffer and by name, and reports nothing for an ordinary account", () => {
    expect(lookupUstVa({ kennziffer: 61 }).length).toBeGreaterThanOrEqual(4);
    expect(lookupUstVa({ search: "dreiecksgeschäft" }).length).toBeGreaterThan(0);
    expect(lookupUstVa({ account: 4930 })).toEqual([]);
  });

  it("the tool needs exactly one selector and explains the rate rules without any", async () => {
    const [tool] = createUstVaTools();
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    await expect(tool.handler({ account: 8336, kennziffer: 21 })).rejects.toThrow(/Nur eines/);
    const none = parse(await tool.handler({}));
    expect(none.nach_steuerschluessel).toEqual(UST_VA_BY_RATE);
    expect(none.nach_steuerschluessel.map((r: any) => r.position)).toContain("Kz 81");
    const positions = none.nach_steuerschluessel.map((r: any) => r.position).join(" | ");
    expect(positions).toMatch(/Kz 46 \(Bemessung\), Kz 47 \(USt\.\) und Kz 67/);
    expect(positions).toMatch(/Kz 84 \(Bemessung\), Kz 85 \(USt\.\) und Kz 67/);
    const miss = parse(await tool.handler({ account: 4930 }));
    expect(miss.treffer).toEqual([]);
    expect(miss.hinweis).toMatch(/Steuerschlüssel/);
  });
});

describe("calculate_account_balance", () => {
  const rows = [
    { id_by_customer: "1", amount: "1000.00", booking_date: "2026-01-01" },
    { id_by_customer: "2", amount: "-250.10", booking_date: "2026-02-03" },
    { id_by_customer: "3", amount: "0.10", booking_date: "2026-02-04" },
  ];
  const setup = (data: unknown[]) => {
    const call = vi.fn().mockResolvedValue({ data });
    const [, tool] = createMonthEndTools({ call } as unknown as BBClient);
    return { call, tool };
  };

  it("sums the payments in cents up to the cut-off date", async () => {
    const { call, tool } = setup(rows);
    const res = parse(await tool.handler({ account: 1201, date_to: "2026-02-28" }));
    expect(res.berechneter_kontostand).toBe(750);
    expect(res.anzahl_zahlungen).toBe(3);
    expect(call).toHaveBeenCalledWith("transactionsGet", expect.objectContaining({ account: 1201, date_to: "2026-02-28", limit: 500, offset: 0 }));
  });

  it("reports the difference to the statement balance", async () => {
    const { tool } = setup(rows);
    const ok = parse(await tool.handler({ account: 1201, date_to: "2026-02-28", statement_balance: 750 }));
    expect(ok.differenz).toBe(0);
    expect(ok.hinweis).toBe("Stimmt überein.");
    const off = parse(await tool.handler({ account: 1201, date_to: "2026-02-28", statement_balance: 800.5 }));
    expect(off.differenz).toBe(50.5);
    expect(off.hinweis).toMatch(/Anfangsbestand/);
  });

  it("warns instead of presenting a truncated sum as complete", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({ id_by_customer: String(i), amount: "1.00" }));
    const call = vi.fn().mockResolvedValue({ data: full });
    const [, tool] = createMonthEndTools({ call } as unknown as BBClient);
    const res = parse(await tool.handler({ account: 1201, date_to: "2026-02-28" }));
    expect(res.warnung).toMatch(/unvollständig/);
  });

  it("is read-only", () => {
    expect(setup([]).tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  });
});

describe("create_transactions rules from the import article", () => {
  const entry = { account: 1201, to_from: "Muster GmbH", amount: 10, booking_date: "2026-03-01" };

  it("rejects a 0.00 payment before calling the API", async () => {
    const client = { call: vi.fn() } as unknown as BBClient;
    const create = createTransactionsTools(client)[2];
    await expect(create.handler({ transactions: [{ ...entry, amount: 0 }] })).rejects.toThrow(/Betrag 0,00/);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("rejects a purpose longer than 500 characters and accepts exactly 500", async () => {
    expect(() => assertTransactionEntry({ ...entry, purpose: "x".repeat(501) }, "Zahlung 1")).toThrow(/501 Zeichen/);
    expect(() => assertTransactionEntry({ ...entry, purpose: "x".repeat(500) }, "Zahlung 1")).not.toThrow();
  });

  it("still sends a valid batch", async () => {
    const client = { call: vi.fn().mockResolvedValue({ success: true }) } as unknown as BBClient;
    const create = createTransactionsTools(client)[2];
    await create.handler({ transactions: [entry] });
    expect(client.call).toHaveBeenCalledWith("transactionsAddBatch", { transactions: [entry] });
  });
});

describe("locked account numbers for individual Sachkonten", () => {
  it("names the chart in which a number is locked and nothing for a free number", () => {
    expect(lockedAccountHint(3553)).toMatch(/SKR03/);
    expect(lockedAccountHint(5553)).toMatch(/SKR04/);
    expect(lockedAccountHint(9303)).toMatch(/SKR03 und SKR04/);
    expect(lockedAccountHint(3260)).toBeUndefined();
    expect(LOCKED_SACHKONTEN.SKR03).toHaveLength(55);
    expect(LOCKED_SACHKONTEN.SKR04).toHaveLength(56);
  });

  it("manage_posting_account adds the hint to a BHB refusal, but not to an unrelated error", async () => {
    const refuse = vi.fn().mockRejectedValue(new Error("BHB error 9"));
    const [, manage] = createPostingAccountsTools({ call: refuse } as unknown as BBClient);
    await expect(
      manage.handler({ action: "create", name: "Eigenes Konto", postingaccount_number: 3553, parent_postingaccount_number: 3200 })
    ).rejects.toThrow(/BHB error 9.*gesperrter Kontonummern/s);
    await expect(
      manage.handler({ action: "create", name: "Eigenes Konto", postingaccount_number: 3260, parent_postingaccount_number: 3200 })
    ).rejects.toThrow(/^BHB error 9$/);
  });
});
