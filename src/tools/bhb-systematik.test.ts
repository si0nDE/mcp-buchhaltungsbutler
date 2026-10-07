import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createServer } from "../server.js";
import {
  anlagenWarnings,
  ANLAGEN_GUIDE,
  assertDeliveryDate,
  SERVER_INSTRUCTIONS,
  supplyDateWarnings,
  VAT_CODE_GUIDE,
  withWarnings,
} from "./bhb-systematik.js";
import { createInvoicesTools } from "./invoices.js";
import { createPostingsTools } from "./postings.js";
import { createReceiptsTools } from "./receipts.js";

function mockClient(result: unknown = { success: true }): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

const receipt = {
  type: "invoice inbound" as const,
  counterparty: "ACME",
  invoice_number: "R-1",
  date: "2026-03-10",
  amount: 10,
  currency: "EUR",
};

describe("assertDeliveryDate", () => {
  it("accepts a delivery date on or before the receipt date", () => {
    expect(() => assertDeliveryDate({ date: "2026-03-10", date_delivery: "2026-03-10" }, "x")).not.toThrow();
    expect(() => assertDeliveryDate({ date: "2026-03-10", date_delivery: "2026-02-28" }, "x")).not.toThrow();
  });

  it("rejects a delivery date after the receipt date", () => {
    expect(() => assertDeliveryDate({ date: "2026-03-10", date_delivery: "2026-03-11" }, "Beleg 1")).toThrow(
      /Beleg 1: date_delivery .* nach dem Belegdatum/
    );
  });

  it("does nothing when one of the dates is missing or not ISO", () => {
    expect(() => assertDeliveryDate({ date_delivery: "2026-03-11" }, "x")).not.toThrow();
    expect(() => assertDeliveryDate({ date: "10.03.2026", date_delivery: "11.03.2026" }, "x")).not.toThrow();
  });
});

describe("supplyDateWarnings", () => {
  it("is silent for a valid or absent Leistungsdatum", () => {
    expect(supplyDateWarnings({ date: "2026-03-10" })).toEqual([]);
    expect(supplyDateWarnings({ date: "2026-03-10", date_of_supply: "2026-03-01" })).toEqual([]);
  });

  it("warns when the Leistungsdatum is after the invoice date (ignored by BHB)", () => {
    expect(supplyDateWarnings({ date: "2026-03-10", date_of_supply: "2026-04-01" })[0]).toMatch(/ignoriert/);
  });

  it("warns when a period text is not taken over as date_delivery", () => {
    expect(supplyDateWarnings({ date: "2026-03-10", date_of_supply: "01.-31.03.2026" })[0]).toMatch(
      /nur auf dem PDF/
    );
  });
});

describe("withWarnings", () => {
  it("leaves the result untouched without warnings and adds a list otherwise", () => {
    const r = { success: true };
    expect(withWarnings(r, [])).toBe(r);
    expect(withWarnings(r, ["w"])).toEqual({ success: true, warnings: ["w"] });
  });
});

describe("receipt tools reject a delivery date after the receipt date before calling the API", () => {
  it("create_receipts", async () => {
    const client = mockClient();
    const [, , createReceipts] = createReceiptsTools(client);
    await expect(
      createReceipts.handler({ receipts: [{ ...receipt, date_delivery: "2026-03-11" }] })
    ).rejects.toThrow(/date_delivery/);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("upload_receipt", async () => {
    const client = mockClient();
    const [, , , uploadReceipt] = createReceiptsTools(client);
    await expect(
      uploadReceipt.handler({ file: "AA==", type: "invoice inbound", date: "2026-03-10", date_delivery: "2026-03-11" })
    ).rejects.toThrow(/date_delivery/);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("create_receipts still sends a valid delivery date", async () => {
    const client = mockClient();
    const [, , createReceipts] = createReceiptsTools(client);
    await createReceipts.handler({ receipts: [{ ...receipt, date_delivery: "2026-03-01" }] });
    expect(client.call).toHaveBeenCalledWith("receiptsAddBatch", {
      receipts: [{ ...receipt, date_delivery: "2026-03-01" }],
    });
  });
});

describe("create_invoice date_of_supply", () => {
  const base = {
    type: "invoice" as const,
    show_prices_type: "net" as const,
    company_name: "ACME GmbH",
    date: "2026-03-10",
    items: [{ name: "Beratung", amount: "1", unit: "Std.", vat: "19", single_price: "100.00" }],
  };

  it("still sends the invoice and reports a warning for a later Leistungsdatum", async () => {
    const client = mockClient({ success: true });
    const [createInvoice] = createInvoicesTools(client);
    const res = await createInvoice.handler({ ...base, date_of_supply: "2026-04-01" });
    expect(client.call).toHaveBeenCalledWith("invoicesCreate", expect.objectContaining({ date_of_supply: "2026-04-01" }));
    expect(JSON.parse(res.content[0].text).warnings).toHaveLength(1);
  });

  it("adds no warnings key for a valid Leistungsdatum", async () => {
    const [createInvoice] = createInvoicesTools(mockClient({ success: true }));
    const res = await createInvoice.handler({ ...base, date_of_supply: "2026-03-01" });
    expect(JSON.parse(res.content[0].text)).toEqual({ success: true });
  });
});

describe("BHB rules are exposed to the agent", () => {
  it("the server publishes the system logic as instructions", async () => {
    const server = createServer(mockClient());
    const instructions = (server as unknown as { server: { _instructions?: string } }).server._instructions;
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).toMatch(/9000/);
  });

  it("the vat guide covers the pitfalls from BHB's Steuerschlüssel article", () => {
    expect(VAT_CODE_GUIDE).toMatch(/Irish VAT/);
    expect(VAT_CODE_GUIDE).toMatch(/never for services/);
    expect(VAT_CODE_GUIDE).toMatch(/Automatikkonto/);
  });
});

describe("Anlagenverwaltung (UI only)", () => {
  it("flags Anlagenkonten 0001-0599 but not Aufwand, Verbindlichkeiten or Kapital", () => {
    expect(anlagenWarnings([4830, 1200, 650, 800])).toEqual([]);
    expect(anlagenWarnings([0, 1200])).toEqual([]);
    expect(anlagenWarnings([420, 420, 1200])[0]).toMatch(/Konto 420 gehört zum Anlagevermögen/);
    expect(anlagenWarnings([599])).toHaveLength(1);
    expect(anlagenWarnings([600])).toEqual([]);
  });

  it("add_receipt_postings books normally but warns when a split hits an Anlagenkonto", async () => {
    const client = mockClient({ success: true });
    const [, addReceiptPostings] = createPostingsTools(client);
    const res = await addReceiptPostings.handler({
      receipts: [
        {
          receipt_id_by_customer: 1,
          creditor: 70001,
          debtor: 0,
          splits: [{ postingaccount: 420, postingtext: "Laptop", vat: "19_pre", amount: "1190.00" }],
        },
      ],
    });
    expect(client.call).toHaveBeenCalledWith("postingsAddBatchReceipts", expect.anything());
    expect(JSON.parse(res.content[0].text).warnings[0]).toMatch(/Anlagenverwaltung/);
  });

  it("add_free_postings warns for a manual posting against an Anlagenkonto", async () => {
    const client = mockClient({ success: true });
    const [, , , addFreePostings] = createPostingsTools(client);
    const res = await addFreePostings.handler({
      free_postings: [
        {
          date: "2026-12-31",
          postingtext: "AfA",
          amount: "100.00",
          postingaccount_debit: 4830,
          postingaccount_credit: 420,
          vat: "0_none",
        },
      ],
    });
    expect(JSON.parse(res.content[0].text).warnings[0]).toMatch(/Doppelabschreibung/);
  });

  it("add_free_postings adds no warnings key for ordinary accounts", async () => {
    const client = mockClient({ success: true });
    const [, , , addFreePostings] = createPostingsTools(client);
    const res = await addFreePostings.handler({
      free_postings: [
        { date: "2026-01-31", postingtext: "x", amount: "1.00", postingaccount_debit: 4930, postingaccount_credit: 1200, vat: "0_none" },
      ],
    });
    expect(JSON.parse(res.content[0].text)).toEqual({ success: true });
  });

  it("the guide and server instructions state that the API cannot create assets", () => {
    expect(ANLAGEN_GUIDE).toMatch(/NO asset and NO depreciation/);
    expect(SERVER_INSTRUCTIONS).toMatch(/Anlagenverwaltung exists only in the BHB UI/);
  });
});
