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

  it("create_einvoice calls invoicesCreateEInvoice with tax fields flattened", async () => {
    const client = mockClient({ success: true });
    const [, createEInvoice] = createInvoicesTools(client);

    await createEInvoice.handler({
      type: "invoice",
      show_prices_type: "net",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      e_invoice_id: "XR-1",
      street: "Hauptstr. 1",
      zip: "10115",
      city: "Berlin",
      country: "Deutschland",
      email: "buchhaltung@acme.example",
      items: [{ name: "Beratung", amount: "1", unit: "Std.", tax_type: "19", tax_amount: "19.00", single_price: "100.00" }],
    });

    expect(client.call).toHaveBeenCalledWith("invoicesCreateEInvoice", {
      type: "invoice",
      show_prices_type: "net",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      e_invoice_id: "XR-1",
      street: "Hauptstr. 1",
      zip: "10115",
      city: "Berlin",
      country: "Deutschland",
      email: "buchhaltung@acme.example",
      item_name: ["Beratung"],
      item_amount: ["1"],
      item_unit: ["Std."],
      item_tax_type: ["19"],
      item_tax_amount: ["19.00"],
      item_single_price: ["100.00"],
    });
  });
});
