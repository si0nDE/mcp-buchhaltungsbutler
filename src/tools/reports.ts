import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { compactRows, compactShape } from "../formatting/compact.js";
import { TAX_ACCOUNTS } from "./vat-preview.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

const BASE_GUIDE =
  "Date the postings are taken into account by: 'date' (Buchungsdatum, default) or 'date_delivery_else_date' " +
  "(Leistungsdatum where an abweichendes Leistungsdatum exists, else Buchungsdatum). Use the latter to reconcile " +
  "with the USt-Voranmeldung, which follows the Leistungsdatum.";

// Check set for ledger entries (compact default): what is needed to verify a posting. The other ~15 fields of the
// real API rows (file names, journal numbers, standard_chart, tax_key_effective, oss_*, ...) come back with
// fields: [...] or compact: false.
const LEDGER_CHECK_FIELDS = [
  "id_by_customer",
  "date",
  "record_side",
  "record_amount",
  "counterRecordPostingaccountNumber",
  "postingTextFull",
  "vatRate",
  // How the posting was taxed. The code passed when booking (19_vat, 19_pre, ...) is not echoed by BHB; these fields are what
  // it stores: tax_key_effective (e.g. 101 on a 19 % revenue line) and the tax account(s) the line posts its tax to.
  "tax_key",
  "tax_key_effective",
  "vatPostingaccountNumbers",
  "is_tax_line",
  "receipts_id_by_customer",
  // Free postings with an assigned receipt carry it ONLY here (receipts_id_by_customer is null; confirmed live).
  "receiptsAssignedFilenamesServerPlain",
  "transactions_id_by_customer",
  "reversed_by_id",
  "reversal_for_id",
  "balanceAfterAbsolute",
  "balanceAfterSide",
];

const baseShape = z.enum(["date", "date_delivery_else_date"]).optional().describe(BASE_GUIDE);

// The sums report holds every postingaccount of the customer; a filter keeps the answer small for an agent.
function filterSums(report: unknown, numbers: number[] | undefined): unknown {
  if (!numbers || numbers.length === 0 || typeof report !== "object" || report === null) return report;
  const r = report as { sums?: Record<string, unknown> };
  if (!r.sums || typeof r.sums !== "object") return report;
  const wanted = new Set(numbers.map(String));
  return { ...r, sums: Object.fromEntries(Object.entries(r.sums).filter(([k]) => wanted.has(k))) };
}

export function createReportsTools(client: BBClient): [ToolDef, ToolDef, ToolDef] {
  const createReport = defineTool({
    name: "create_report",
    description:
      "Start an evaluation: type bwa (Betriebswirtschaftliche Auswertung) or sums (Summen- und Saldenliste, always for all " +
      "posting accounts). It is generated ASYNCHRONOUSLY: the answer only holds the report id; fetch the result with " +
      "get_report (retry a few seconds later). Only one report of a type can be in progress, and a new report of the " +
      "same type REPLACES the previous one - so do not start a second one before the first was read. Evaluate a period " +
      "with the Besteuerungsart (Ist/Soll) that applied to it: it is calculated at evaluation time. base, file_pdf, " +
      "file_csv, archive_export apply to sums only. Evaluations only contain CONFIRMED (bestätigte) postings: an empty or " +
      "too small report usually means unconfirmed postings in Zahlungen, Belege or Erweitert.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      type: z.enum(["bwa", "sums"]),
      date_from: z.string().describe("YYYY-MM-DD, first day of the period."),
      date_to: z.string().describe("YYYY-MM-DD, last day of the period."),
      base: baseShape,
      file_pdf: z.boolean().optional().describe("sums only: also create a PDF."),
      file_csv: z.boolean().optional().describe("sums only: also create a CSV."),
      archive_export: z
        .boolean()
        .optional()
        .describe("sums only: also create a ZIP with the CSV and all Kontenblätter."),
    },
    async handler(args) {
      const { type, date_from, date_to, ...sumsOnly } = args;
      if (type === "bwa") {
        const set = Object.entries(sumsOnly).filter(([, v]) => v !== undefined);
        if (set.length > 0) {
          throw new Error(`${set.map(([k]) => k).join(", ")} gilt nur für type=sums, nicht für bwa.`);
        }
        return ok(await client.call("reportsCreateBwa", { date_from, date_to }));
      }
      return ok(await client.call("reportsCreateSums", { date_from, date_to, ...sumsOnly }));
    },
  });

  const getReport = defineTool({
    name: "get_report",
    description:
      "Fetch a report started with create_report, by the id it returned. Not available until the generation finished - " +
      "if it is not ready yet, retry shortly instead of creating a new one (that would replace it). For type sums the " +
      "result holds all posting accounts keyed by number; pass postingaccount_numbers to keep only some. get_files adds " +
      "PDF/CSV/ZIP as base64 and is very large - leave it off unless the file itself is needed. Only confirmed (bestätigte) " +
      "postings are in a report, as they were when it was generated.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      type: z.enum(["bwa", "sums"]),
      report_id_by_customer: z.number().int(),
      get_files: z.boolean().optional(),
      postingaccount_numbers: z.array(z.number().int()).optional().describe("sums only: keep only these accounts."),
    },
    async handler(args) {
      const { type, postingaccount_numbers, ...rest } = args;
      if (type === "bwa") {
        return ok(await client.call("reportsGetBwa", rest));
      }
      const result = await client.call<{ report?: unknown }>("reportsGetSums", rest);
      return ok(result.report === undefined ? result : { ...result, report: filterSums(result.report, postingaccount_numbers) });
    },
  });

  const getAccountLedger = defineTool({
    name: "get_account_ledger",
    description:
      "Kontenblatt of ONE posting account for a period, built on the fly (no create_report needed; may take a while for " +
      "an account with many postings). Entries are compact by default (check set: id, date, side, amount, counter account, text, vat rate, tax_key/tax_key_effective/vatPostingaccountNumbers (how BHB stored the tax; the booking code itself is not echoed), is_tax_line (line on a USt/VSt account), receipt ids and assigned receipt file names, transaction ids, " +
      "reversal ids, balance; fields: [...] picks other fields, compact: false returns the raw rows). Take account numbers from get_report type sums. With base " +
      "date_delivery_else_date postings follow the Leistungsdatum; the default is the Buchungsdatum.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      postingaccount_number: z.number().int(),
      date_from: z.string().describe("YYYY-MM-DD"),
      date_to: z.string().describe("YYYY-MM-DD"),
      base: baseShape,
      ...compactShape,
    },
    async handler(args) {
      const { compact, include_links, fields, ...params } = args;
      const result = await client.call<{ report_sums_postingaccount_ledger?: { postingaccountLedger?: unknown } }>(
        "reportsGetSumsLedger",
        params
      );
      const ledger = result.report_sums_postingaccount_ledger;
      if (!ledger || !Array.isArray(ledger.postingaccountLedger)) return ok(result);
      // Lines on a USt/VSt account itself carry no vatRate and no tax account; mark them so they are not read as untaxed.
      const isTaxAccount = TAX_ACCOUNTS.some((a) => a.skr03 === params.postingaccount_number || a.skr04 === params.postingaccount_number);
      if (isTaxAccount) {
        ledger.postingaccountLedger = ledger.postingaccountLedger.map((r: unknown) =>
          r !== null && typeof r === "object" ? { ...(r as Record<string, unknown>), is_tax_line: true } : r
        );
      }
      return ok({
        ...result,
        report_sums_postingaccount_ledger: {
          ...ledger,
          postingaccountLedger: compactRows(
            compact === false || fields?.length
              ? ledger.postingaccountLedger
              : compactRows(ledger.postingaccountLedger, { fields: LEDGER_CHECK_FIELDS }),
            { compact, include_links, fields }
          ),
        },
      });
    },
  });

  return [createReport, getReport, getAccountLedger];
}
