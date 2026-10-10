import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createReportsTools } from "./reports.js";

function mockClient(result: unknown = { success: true }): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("reports tools", () => {
  it("create_report bwa calls reportsCreateBwa with the period only", async () => {
    const client = mockClient({ success: true, id_by_customer: "7" });
    const [createReport] = createReportsTools(client);
    await createReport.handler({ type: "bwa", date_from: "2026-01-01", date_to: "2026-03-31" });
    expect(client.call).toHaveBeenCalledWith("reportsCreateBwa", { date_from: "2026-01-01", date_to: "2026-03-31" });
  });

  it("create_report bwa rejects sums-only options instead of silently dropping them", async () => {
    const client = mockClient();
    const [createReport] = createReportsTools(client);
    await expect(
      createReport.handler({ type: "bwa", date_from: "2026-01-01", date_to: "2026-03-31", base: "date_delivery_else_date" })
    ).rejects.toThrow(/base gilt nur für type=sums/);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("create_report sums passes base and file options", async () => {
    const client = mockClient();
    const [createReport] = createReportsTools(client);
    await createReport.handler({
      type: "sums",
      date_from: "2026-01-01",
      date_to: "2026-03-31",
      base: "date_delivery_else_date",
      file_csv: true,
    });
    expect(client.call).toHaveBeenCalledWith("reportsCreateSums", {
      date_from: "2026-01-01",
      date_to: "2026-03-31",
      base: "date_delivery_else_date",
      file_csv: true,
    });
  });

  it("get_report bwa calls reportsGetBwa", async () => {
    const client = mockClient({ success: true, report: { totals: {} } });
    const [, getReport] = createReportsTools(client);
    await getReport.handler({ type: "bwa", report_id_by_customer: 7 });
    expect(client.call).toHaveBeenCalledWith("reportsGetBwa", { report_id_by_customer: 7 });
  });

  it("get_report sums keeps only the requested posting accounts", async () => {
    const client = mockClient({
      success: true,
      report: { integrityError: false, sums: { "1200": { a: 1 }, "4830": { a: 2 }, "8400": { a: 3 } } },
    });
    const [, getReport] = createReportsTools(client);
    const res = parse(await getReport.handler({ type: "sums", report_id_by_customer: 9, postingaccount_numbers: [4830, 8400] }));
    expect(client.call).toHaveBeenCalledWith("reportsGetSums", { report_id_by_customer: 9 });
    expect(Object.keys(res.report.sums)).toEqual(["4830", "8400"]);
    expect(res.report.integrityError).toBe(false);
  });

  it("get_report sums without a filter returns the report untouched", async () => {
    const full = { success: true, report: { sums: { "1200": {}, "4830": {} } } };
    const [, getReport] = createReportsTools(mockClient(full));
    expect(parse(await getReport.handler({ type: "sums", report_id_by_customer: 9 }))).toEqual(full);
  });

  it("get_account_ledger forwards the base for Leistungsdatum evaluation", async () => {
    const client = mockClient();
    const [, , ledger] = createReportsTools(client);
    await ledger.handler({
      postingaccount_number: 8400,
      date_from: "2026-01-01",
      date_to: "2026-01-31",
      base: "date_delivery_else_date",
    });
    expect(client.call).toHaveBeenCalledWith("reportsGetSumsLedger", {
      postingaccount_number: 8400,
      date_from: "2026-01-01",
      date_to: "2026-01-31",
      base: "date_delivery_else_date",
    });
  });

  it("only get tools are read-only; create_report is not", () => {
    const [createReport, getReport, ledger] = createReportsTools(mockClient());
    expect(createReport.annotations?.readOnlyHint).toBe(false);
    expect(getReport.annotations?.readOnlyHint).toBe(true);
    expect(ledger.annotations?.readOnlyHint).toBe(true);
  });
});

describe("get_account_ledger compact", () => {
  it("drops empty fields from ledger entries by default", async () => {
    const client = mockClient({
      success: true,
      report_sums_postingaccount_ledger: {
        postingaccount_number: 4950,
        postingaccountLedger: [{ date: "2026-02-25", record_amount: "84.03", oss_vat_rate: "", standard_chart: "SKR03", receiptsAssignedFileSuffix: "pdf" }],
      },
    });
    const [, , getAccountLedger] = createReportsTools(client);
    const res = parse(await getAccountLedger.handler({ postingaccount_number: 4950, date_from: "2026-01-01", date_to: "2026-12-31" }));
    expect(res.report_sums_postingaccount_ledger.postingaccountLedger).toEqual([{ date: "2026-02-25", record_amount: "84.03" }]);
  });

  it("keeps the stored tax fields and marks lines on a tax account", async () => {
    const mk = (n: number) =>
      mockClient({
        success: true,
        report_sums_postingaccount_ledger: {
          postingaccount_number: n,
          postingaccountLedger: [{ date: "2026-03-03", record_amount: "38.00", tax_key: "0", tax_key_effective: "101", vatPostingaccountNumbers: [1776] }],
        },
      });
    const rev = parse(await createReportsTools(mk(8400))[2].handler({ postingaccount_number: 8400, date_from: "2026-03-03", date_to: "2026-03-03" }));
    expect(rev.report_sums_postingaccount_ledger.postingaccountLedger[0]).toMatchObject({ tax_key_effective: "101", vatPostingaccountNumbers: [1776] });
    expect(rev.report_sums_postingaccount_ledger.postingaccountLedger[0].is_tax_line).toBeUndefined();
    const tax = parse(await createReportsTools(mk(1776))[2].handler({ postingaccount_number: 1776, date_from: "2026-03-03", date_to: "2026-03-03" }));
    expect(tax.report_sums_postingaccount_ledger.postingaccountLedger[0].is_tax_line).toBe(true);
  });
});
