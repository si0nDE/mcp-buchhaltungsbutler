import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createAccountsTools } from "./accounts.js";
import { assertOssFields } from "./bhb-systematik.js";
import { createInvoicesTools } from "./invoices.js";
import { createPostingsTools } from "./postings.js";
import { createReceiptsTools } from "./receipts.js";
import { createTransactionsTools } from "./transactions.js";

function mockClient(result: unknown = { success: true }): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("tools for endpoints added in the live API spec", () => {
  it("delete_transaction calls transactionsDelete and is destructive", async () => {
    const client = mockClient();
    const tool = createTransactionsTools(client)[6];
    expect(tool.name).toBe("delete_transaction");
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    await tool.handler({ transaction_id_by_customer: 42 });
    expect(client.call).toHaveBeenCalledWith("transactionsDelete", { transaction_id_by_customer: 42 });
  });

  it("manage_account update sends only the given fields", async () => {
    const client = mockClient();
    const tool = createAccountsTools(client)[2];
    await tool.handler({ action: "update", postingaccount_number: 1200, name: "Bank neu" });
    expect(client.call).toHaveBeenCalledWith("accountsUpdate", { postingaccount_number: 1200, name: "Bank neu" });
  });

  it("manage_account delete sends the number only", async () => {
    const client = mockClient();
    const tool = createAccountsTools(client)[2];
    await tool.handler({ action: "delete", postingaccount_number: 1200, name: "ignored" });
    expect(client.call).toHaveBeenCalledWith("accountsDelete", { postingaccount_number: 1200 });
  });

  it("create_invoice_correction calls invoicesInvoiceCorrectionCreate", async () => {
    const client = mockClient();
    const tool = createInvoicesTools(client)[2];
    await tool.handler({ receipt_id_by_customer: 5 });
    expect(client.call).toHaveBeenCalledWith("invoicesInvoiceCorrectionCreate", { receipt_id_by_customer: 5 });
  });

  it("list_receipts forwards date_since_last_modified", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const tool = createReceiptsTools(client)[0];
    await tool.handler({ list_direction: "inbound", date_since_last_modified: "2026-10-01 08:00:00", limit: 20, offset: 0 });
    expect(client.call).toHaveBeenCalledWith(
      "receiptsGet",
      expect.objectContaining({ date_since_last_modified: "2026-10-01 08:00:00" })
    );
  });

  it("list_transactions forwards date_since_last_modified", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const tool = createTransactionsTools(client)[0];
    await tool.handler({ date_since_last_modified: "2026-10-01", limit: 20, offset: 0 });
    expect(client.call).toHaveBeenCalledWith(
      "transactionsGet",
      expect.objectContaining({ date_since_last_modified: "2026-10-01" })
    );
  });
});

describe("OSS postings", () => {
  const oss = { oss_origin_country: "DE", oss_destination_country: "FR", oss_vat_rate: "20.00" };

  it("assertOssFields accepts a complete OSS case and ignores other vat codes", () => {
    expect(() => assertOssFields("vat_oss_deli_deeu", oss, "x")).not.toThrow();
    expect(() => assertOssFields("19_vat", {}, "x")).not.toThrow();
    expect(() => assertOssFields("vat_oss_deli_eude_19", { oss_origin_country: "FR", oss_destination_country: "DE" }, "x")).not.toThrow();
  });

  it("assertOssFields names what is missing", () => {
    expect(() => assertOssFields("vat_oss_deli_deeu", { oss_vat_rate: "20.00" }, "Split 1")).toThrow(/Split 1.*oss_origin_country/);
    expect(() => assertOssFields("vat_oss_serv_deeu", { ...oss, oss_vat_rate: undefined }, "x")).toThrow(/oss_vat_rate/);
    expect(() => assertOssFields("vat_oss_deli_deeu", { ...oss, oss_destination_country: "DE" }, "x")).toThrow(/identisch/);
  });

  it("add_receipt_postings sends OSS data as parallel arrays with null for non-OSS splits", async () => {
    const client = mockClient();
    const tool = createPostingsTools(client)[1];
    await tool.handler({
      receipts: [
        {
          receipt_id_by_customer: 1,
          creditor: 0,
          debtor: 10001,
          splits: [
            { postingaccount: 8400, postingtext: "FR", vat: "vat_oss_deli_deeu", amount: "120.00", ...oss },
            { postingaccount: 8400, postingtext: "DE", vat: "19_vat", amount: "119.00" },
          ],
        },
      ],
    });
    const sent = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1].receipts[0];
    expect(sent.oss_origin_countries).toEqual(["DE", null]);
    expect(sent.oss_destination_countries).toEqual(["FR", null]);
    expect(sent.oss_vat_rates).toEqual(["20.00", null]);
  });

  it("add_receipt_postings sends no oss arrays when no split uses OSS", async () => {
    const client = mockClient();
    const tool = createPostingsTools(client)[1];
    await tool.handler({
      receipts: [
        {
          receipt_id_by_customer: 1,
          creditor: 0,
          debtor: 10001,
          splits: [{ postingaccount: 8400, postingtext: "DE", vat: "19_vat", amount: "119.00" }],
        },
      ],
    });
    const sent = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1].receipts[0];
    expect(sent).not.toHaveProperty("oss_origin_countries");
  });

  it("add_transaction_postings rejects an OSS code without countries before calling the API", async () => {
    const client = mockClient();
    const tool = createPostingsTools(client)[2];
    await expect(
      tool.handler({
        transactions: [
          {
            transaction_id_by_customer: 1,
            splits: [{ postingaccount: 8400, postingtext: "x", vat: "vat_oss_deli_deeu", amount: "10.00" }],
          },
        ],
      })
    ).rejects.toThrow(/oss_origin_country/);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("add_free_postings passes the scalar OSS fields through", async () => {
    const client = mockClient();
    const tool = createPostingsTools(client)[3];
    await tool.handler({
      free_postings: [
        {
          date: "2026-03-01",
          postingtext: "OSS",
          amount: "10.00",
          postingaccount_debit: 1200,
          postingaccount_credit: 8400,
          vat: "vat_oss_serv_deeu",
          ...oss,
        },
      ],
    });
    expect((client.call as ReturnType<typeof vi.fn>).mock.calls[0][1].free_postings[0]).toMatchObject(oss);
  });
});
