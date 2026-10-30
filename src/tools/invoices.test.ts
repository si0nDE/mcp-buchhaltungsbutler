import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createInvoicesTools } from "./invoices.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("invoices tools", () => {
  it("create_invoice flattens items and calls invoicesCreate by default", async () => {
    const client = mockClient({ success: true, id_by_customer: "1" });
    const [createInvoice] = createInvoicesTools(client);

    await createInvoice.handler({
      type: "invoice",
      show_prices_type: "net",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      items: [{ name: "Beratung", amount: "10", unit: "Std.", vat: "19", single_price: "100.00" }],
    });

    expect(client.call).toHaveBeenCalledWith("invoicesCreate", {
      type: "invoice",
      show_prices_type: "net",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      item_name: ["Beratung"],
      item_amount: ["10"],
      item_unit: ["Std."],
      item_vat: ["19"],
      item_single_price: ["100.00"],
    });
  });

  it("create_invoice routes to invoicesCreateDraft when draft is true", async () => {
    const client = mockClient({ success: true });
    const [createInvoice] = createInvoicesTools(client);

    await createInvoice.handler({
      type: "offer",
      show_prices_type: "gross",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      draft: true,
      items: [{ name: "Beratung", amount: "1", unit: "Std.", vat: "19", single_price: "50.00" }],
    });

    expect(client.call).toHaveBeenCalledWith(
      "invoicesCreateDraft",
      expect.objectContaining({ type: "offer" })
    );
  });

  it("create_invoice forwards invoicenumber/due_days/payment_reference for non-draft", async () => {
    const client = mockClient({ success: true });
    const [createInvoice] = createInvoicesTools(client);

    await createInvoice.handler({
      type: "invoice",
      show_prices_type: "net",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      invoicenumber: "R-42",
      due_days: "14",
      payment_reference: "REF-1",
      items: [{ name: "Beratung", amount: "1", unit: "Std.", vat: "19", single_price: "50.00" }],
    });

    expect(client.call).toHaveBeenCalledWith(
      "invoicesCreate",
      expect.objectContaining({ invoicenumber: "R-42", due_days: "14", payment_reference: "REF-1" })
    );
  });

  it("create_invoice strips invoicenumber/due_days/payment_reference when draft is true", async () => {
    const client = mockClient({ success: true });
    const [createInvoice] = createInvoicesTools(client);

    await createInvoice.handler({
      type: "invoice",
      show_prices_type: "net",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      draft: true,
      invoicenumber: "R-42",
      due_days: "14",
      payment_reference: "REF-1",
      items: [{ name: "Beratung", amount: "1", unit: "Std.", vat: "19", single_price: "50.00" }],
    });

    const [, payload] = (client.call as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).not.toHaveProperty("invoicenumber");
    expect(payload).not.toHaveProperty("due_days");
    expect(payload).not.toHaveProperty("payment_reference");
  });

  const einvoiceBase = {
    type: "invoice" as const,
    show_prices_type: "net" as const,
    company_name: "ACME GmbH",
    date: "2026-01-01",
    e_invoice: true,
    street: "Hauptstr. 1",
    zip: "10115",
    city: "Berlin",
    country: "Deutschland",
    email: "buchhaltung@acme.example",
    draft: false,
  };

  it("create_invoice with e_invoice calls invoicesCreateEInvoice, vat becomes tax type S and default reference 0", async () => {
    const client = mockClient({ success: true });
    const [createInvoice] = createInvoicesTools(client);

    await createInvoice.handler({
      ...einvoiceBase,
      items: [{ name: "Beratung", amount: "1", unit: "Std.", vat: "19", single_price: "100.00" }],
    });

    expect(client.call).toHaveBeenCalledWith("invoicesCreateEInvoice", {
      type: "invoice",
      show_prices_type: "net",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      street: "Hauptstr. 1",
      zip: "10115",
      city: "Berlin",
      country: "Deutschland",
      email: "buchhaltung@acme.example",
      e_invoice_id: "0",
      item_name: ["Beratung"],
      item_amount: ["1"],
      item_unit: ["Std."],
      item_single_price: ["100.00"],
      item_tax_type: ["S"],
      item_tax_amount: ["19"],
    });
  });

  it("e_invoice takes an explicit tax_type for vat 0 and a given reference", async () => {
    const client = mockClient({ success: true });
    const [createInvoice] = createInvoicesTools(client);
    await createInvoice.handler({
      ...einvoiceBase,
      e_invoice_id: "04011000-12345-34",
      items: [
        { name: "A", amount: "1", unit: "Std.", vat: "19", single_price: "10" },
        { name: "B", amount: "1", unit: "Std.", vat: "0", tax_type: "AE", single_price: "10" },
      ],
    });
    expect(client.call).toHaveBeenCalledWith(
      "invoicesCreateEInvoice",
      expect.objectContaining({ e_invoice_id: "04011000-12345-34", item_tax_type: ["S", "AE"], item_tax_amount: ["19", "0"] })
    );
  });

  it("e_invoice rejects vat 0 without tax_type, missing address fields, drafts and stray fields; BHB is not called", async () => {
    const client = mockClient({ success: true });
    const [createInvoice] = createInvoicesTools(client);
    const item = { name: "A", amount: "1", unit: "Std.", vat: "19", single_price: "10" };
    await expect(createInvoice.handler({ ...einvoiceBase, items: [{ ...item, vat: "0" }] })).rejects.toThrow(/tax_type/);
    await expect(createInvoice.handler({ ...einvoiceBase, street: " ", items: [item] })).rejects.toThrow(/street/);
    await expect(createInvoice.handler({ ...einvoiceBase, draft: true, items: [item] })).rejects.toThrow(/Entwurf/);
    await expect(createInvoice.handler({ ...einvoiceBase, e_invoice: undefined, items: [{ ...item, tax_type: "S" }] })).rejects.toThrow(/e_invoice/);
    await expect(createInvoice.handler({ ...einvoiceBase, e_invoice: undefined, e_invoice_id: "0", items: [item] })).rejects.toThrow(/e_invoice/);
    expect(client.call).not.toHaveBeenCalled();
  });
});
