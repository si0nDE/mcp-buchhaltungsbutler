import { z } from "zod";
import { compactRows, compactShape } from "../formatting/compact.js";
import type { BBClient } from "../bb-client/client.js";
import {
  assertEntertainmentExpenseFields,
  COMMENT_MAX_BYTES,
  computeEntertainmentReclass,
  formatEntertainmentExpenseNote,
  truncateToBytes,
} from "./entertainment-expense.js";
import { anlagenWarnings, assertOssFields, personenkontoWarnings, VAT_CODE_GUIDE, withBookingHints, withWarnings } from "./bhb-systematik.js";
import { getChart } from "./posting-accounts.js";
import { vatWarnings } from "./vat-hints.js";
import { amountsMatch, buildSettlementPostingText } from "./payment-confirmation.js";
import { postingtextWarnings } from "./postingtext.js";
import { thirdPartyPaymentWarnings } from "./third-party-payment.js";
import { cashbackPostingWarnings, fetchCashbackIds } from "./cashback.js";
import { assertTravelExpenseFields, formatTravelExpenseNote } from "./travel-expense.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// BuchhaltungsButler's `vat`/`vats` fields take one of these fixed codes, not a
// percentage string — e.g. "0_none" for a 0%/no-VAT posting, not "0" or "0.00".
// Sending a percentage string fails with error_code 19 "Invalid vat specified".
const VAT_CODES = [
  "0_none",
  "19_vat",
  "7_vat",
  "19_pre",
  "7_pre",
  "19_both_1",
  "19_both_506",
  "19_both_6506",
  "19_both_511",
  "19_both_6511",
  "19_both_6501",
  "19_both_2",
  "7_both",
  "19_both_1_no_pre",
  "19_both_2_no_pre",
  "7_both_no_pre",
  "19_pre_app",
  "7_pre_app",
  "19_both_app_1",
  "19_both_app_506",
  "19_both_app_511",
  "19_both_app_2",
  "7_both_app",
  "vat_oss_deli_deeu",
  "vat_oss_deli_eueu",
  "vat_oss_serv_deeu",
  "vat_oss_serv_eueu",
  "vat_oss_deli_eude",
  "vat_oss_deli_eude_19",
] as const;

const vatShape = z.enum(VAT_CODES).describe(VAT_CODE_GUIDE);

const travelerFieldsShape = {
  traveler_name: z.string().optional(),
  traveler_role: z.enum(["employee", "owner_manager", "unclear"]).optional(),
  business_purpose: z.string().optional(),
};

const entertainmentFieldsShape = {
  participants: z.string().optional(),
  occasion: z.string().optional(),
  host_confirmed: z.boolean().optional(),
  entertainment_split_mode: z
    .enum(["gross_split", "net_reclass"])
    .optional()
    .describe(
      'Default "gross_split": 4650 and 4654 in the same call in a 70/30 ratio. "net_reclass": book only 4650/6640 ' +
        "with the full amount and input VAT; the response then contains entertainment_reclass_hints with the 30% " +
        "of NET to reclassify afterwards via add_free_postings (4654 an 4650, vat 0_none). Not booked automatically."
    ),
};

const ossFieldsShape = {
  oss_origin_country: z.string().optional().describe("OSS country of origin (ISO alpha-2). Only for vat_oss_* codes."),
  oss_destination_country: z
    .string()
    .optional()
    .describe("OSS country of destination (ISO alpha-2, EU, differs from origin). Only for vat_oss_* codes."),
  oss_vat_rate: z
    .string()
    .optional()
    .describe('Rate of the destination country on the delivery date, e.g. "20.00". Not needed for vat_oss_deli_eude_19.'),
};

// BHB verlangt amount als String; eine Zahl (52.33) wird still in einen String mit zwei Nachkommastellen umgewandelt.
const amountShape = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : String(v)));

const splitShape = z.object({
  postingaccount: z.number().int(),
  postingtext: z.string(),
  vat: vatShape,
  amount: amountShape,
  cost_location: z.string().optional(),
  cost_location_two: z.string().optional(),
  ...ossFieldsShape,
});

type Split = z.infer<typeof splitShape>;

function flattenSplits(splits: Split[]): {
  postingaccounts: number[];
  postingtexts: string[];
  vats: string[];
  amounts: string[];
  cost_locations?: string[];
  cost_locations_two?: string[];
  oss_origin_countries?: Array<string | null>;
  oss_destination_countries?: Array<string | null>;
  oss_vat_rates?: Array<string | null>;
} {
  splits.forEach((s, i) => assertOssFields(s.vat, s, `Split ${i + 1}`));
  const hasOss = splits.some((s) => s.oss_origin_country || s.oss_destination_country || s.oss_vat_rate);
  const hasCostLocation = splits.some((s) => s.cost_location !== undefined);
  const hasCostLocationTwo = splits.some((s) => s.cost_location_two !== undefined);
  return {
    postingaccounts: splits.map((s) => s.postingaccount),
    postingtexts: splits.map((s) => s.postingtext),
    vats: splits.map((s) => s.vat),
    amounts: splits.map((s) => s.amount),
    ...(hasCostLocation ? { cost_locations: splits.map((s) => s.cost_location ?? "") } : {}),
    ...(hasCostLocationTwo ? { cost_locations_two: splits.map((s) => s.cost_location_two ?? "") } : {}),
    ...(hasOss
      ? {
          oss_origin_countries: splits.map((s) => s.oss_origin_country ?? null),
          oss_destination_countries: splits.map((s) => s.oss_destination_country ?? null),
          oss_vat_rates: splits.map((s) => s.oss_vat_rate ?? null),
        }
      : {}),
  };
}

// oi_receipts_ids_by_customer only applies to transaction postings (assigning
// an existing "open item" receipt to one specific split of a bank-transaction
// posting) — receipt postings have no equivalent concept, so this extends
// splitShape rather than living on it directly.
const transactionSplitShape = splitShape.extend({
  receipt_id_by_customer: z.number().int().optional(),
});

type TransactionSplit = z.infer<typeof transactionSplitShape>;

// BuchhaltungsButler requires oi_receipts_ids_by_customer to be a *parallel*
// array — one entry per split, positionally aligned with postingaccounts/
// postingtexts/vats/amounts, null where a split has no receipt — not a
// free-standing list of receipt ids for the transaction as a whole. Sending
// a shorter (or longer) array than the split count causes a generic
// "error_code 0 / An internal error occurred" on BuchhaltungsButler's side
// rather than a clear validation error, which is what surfaced this: every
// add_transaction_postings call failed because the connector previously
// passed through whatever flat array the caller supplied, unrelated to the
// actual split count.
function flattenTransactionSplits(splits: TransactionSplit[]) {
  return {
    ...flattenSplits(splits),
    oi_receipts_ids_by_customer: splits.map((s) => s.receipt_id_by_customer ?? null),
  };
}

interface CommentJob {
  target: { receipt_id_by_customer: number } | { transaction_id_by_customer: number };
  text: string;
}

// Comments are sent AFTER the booking succeeded. A failing comment must not
// turn a completed booking into an error (a retry would book twice), so it is
// reported as a warning instead. The text is always cut to BHB's limit first.
async function sendComments(client: BBClient, jobs: CommentJob[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const job of jobs) {
    const [kind, id] = Object.entries(job.target)[0];
    try {
      await client.call("commentsAdd", { ...job.target, comment_text: truncateToBytes(job.text, COMMENT_MAX_BYTES) });
    } catch (error) {
      warnings.push(
        `Kommentar zu ${kind === "receipt_id_by_customer" ? "Beleg" : "Transaktion"} ${id} konnte nicht angelegt werden ` +
          `(${error instanceof Error ? error.message : String(error)}). Die Buchung wurde bereits gebucht - NICHT erneut ` +
          "buchen; den Kommentar bei Bedarf per add_comment nachtragen."
      );
    }
  }
  return warnings;
}

interface AuditItem {
  target: CommentJob["target"];
  entry: {
    splits: Array<{ postingaccount: number; amount: string; vat: string }>;
    traveler_name?: string;
    business_purpose?: string;
    participants?: string;
    occasion?: string;
    entertainment_split_mode?: string;
  };
  travelMatch: ReturnType<typeof assertTravelExpenseFields>;
  entertainmentMatch: true | undefined;
}

// Built BEFORE booking so everything that can fail on our side fails before
// anything is sent to BuchhaltungsButler.
function collectAuditArtifacts(items: AuditItem[]): { commentJobs: CommentJob[]; hints: Array<Record<string, unknown>> } {
  const commentJobs: CommentJob[] = [];
  const hints: Array<Record<string, unknown>> = [];
  for (const { target, entry, travelMatch, entertainmentMatch } of items) {
    if (travelMatch) {
      commentJobs.push({
        target,
        text: formatTravelExpenseNote({
          traveler_name: entry.traveler_name!,
          traveler_role: travelMatch.role,
          business_purpose: entry.business_purpose!,
        }),
      });
    }
    if (entertainmentMatch) {
      commentJobs.push({
        target,
        text: formatEntertainmentExpenseNote({ participants: entry.participants!, occasion: entry.occasion! }),
      });
      if (entry.entertainment_split_mode === "net_reclass") {
        const hint = computeEntertainmentReclass(entry.splits);
        if (hint) hints.push({ ...target, ...hint });
      }
    }
  }
  return { commentJobs, hints };
}

function withExtras(result: unknown, extras: { warnings: string[]; hints: Array<Record<string, unknown>> }) {
  const add: Record<string, unknown> = {};
  if (extras.warnings.length > 0) add.warnings = extras.warnings;
  if (extras.hints.length > 0) add.entertainment_reclass_hints = extras.hints;
  return ok(Object.keys(add).length > 0 ? { ...(result as Record<string, unknown>), ...add } : result);
}

type CancelType = "transaction" | "receipt" | "free";
type PostingRow = Record<string, unknown>;

const CANCEL_PAGE_SIZE = 1000;
const CANCEL_MAX_PAGES = 10;

const isBlank = (v: unknown) => v === undefined || v === null || String(v).trim() === "";

// /postings/get cannot filter by id, so the affected postings are picked
// client-side. A transaction/receipt is unconfirmed as a whole (all its
// postings go at once); a free posting is matched by its own id and must not
// belong to a receipt or transaction.
function matchesCancelTarget(p: PostingRow, type: CancelType, id: number): boolean {
  if (type === "transaction") return Number(p.transaction_id_by_customer) === id;
  if (type === "receipt") return Number(p.receipt_id_by_customer) === id;
  return (
    Number(p.id_by_customer) === id && isBlank(p.receipt_id_by_customer) && isBlank(p.transaction_id_by_customer)
  );
}

const isFixed = (p: PostingRow) => String(p.fixed ?? "0") !== "0";

function summarizePosting(p: PostingRow) {
  const pick = [
    "id_by_customer",
    "date",
    "postingtext",
    "amount",
    "vat",
    "debit_postingaccount_number",
    "credit_postingaccount_number",
    "fixed",
    "receipt_id_by_customer",
    "transaction_id_by_customer",
    "receipts_assigned_ids_by_customer",
    "receipts_assigned_invoice_numbers",
    "comment",
  ];
  return Object.fromEntries(pick.filter((k) => k in p).map((k) => [k, p[k]]));
}

async function readRange(client: BBClient, range: { date_from: string; date_to: string }): Promise<PostingRow[]> {
  const all: PostingRow[] = [];
  for (let page = 0; page < CANCEL_MAX_PAGES; page++) {
    const res = await client.call<{ data?: PostingRow[] }>("postingsGet", {
      ...range,
      posting_status: "all",
      limit: CANCEL_PAGE_SIZE,
      offset: page * CANCEL_PAGE_SIZE,
    });
    const rows = res.data ?? [];
    all.push(...rows);
    if (rows.length < CANCEL_PAGE_SIZE) break;
  }
  return all;
}

const CANCEL_LABEL: Record<CancelType, string> = {
  transaction: "Zahlung (Transaktion)",
  receipt: "Beleg",
  free: "freie Buchung",
};

const dryRunShape = {
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "true: run all checks and return what WOULD be sent (would_send), plus warnings (e.g. a vat code that does not fit " +
        "the account) - nothing is written, no comments are added, no receipt is assigned. Same input as the real call."
    ),
};

async function dryRunResult(
  client: BBClient,
  endpoint: string,
  body: unknown,
  splitRefs: Array<{ account: number; vat: string; label: string }>,
  extras: {
    commentJobs?: CommentJob[];
    hints?: Array<Record<string, unknown>>;
    assignReceipts?: Array<Record<string, unknown>>;
    taxAccountsOnly?: boolean;
    postingtexts?: Array<string | undefined>;
    extraWarnings?: string[];
  } = {}
) {
  const chart = await getChart(client).catch(() => "unknown" as const);
  const warnings = [
    ...vatWarnings(splitRefs, chart, extras.taxAccountsOnly),
    ...anlagenWarnings(splitRefs.map((r) => r.account)),
    ...postingtextWarnings(extras.postingtexts ?? []),
    ...(extras.extraWarnings ?? []),
  ];
  return ok({
    dry_run: true,
    written: false,
    would_send: { endpoint, body },
    ...(extras.commentJobs?.length ? { would_comment: extras.commentJobs } : {}),
    ...(extras.assignReceipts?.length ? { would_assign_receipts: extras.assignReceipts } : {}),
    ...(extras.hints?.length ? { entertainment_reclass_hints: extras.hints } : {}),
    ...(warnings.length ? { warnings } : {}),
  });
}

type FreeSent = {
  date: string;
  postingtext: string;
  amount: string;
  postingaccount_debit: number;
  postingaccount_credit: number;
};

async function freePostingRows(client: BBClient, date: string): Promise<PostingRow[]> {
  const res = await client.call<{ data?: PostingRow[] }>("postingsGet", {
    date_from: date,
    date_to: date,
    account: "free booking",
    posting_status: "all",
    limit: CANCEL_PAGE_SIZE,
    offset: 0,
  });
  return res.data ?? [];
}

async function freePostingIds(client: BBClient, date: string): Promise<Set<number>> {
  return new Set((await freePostingRows(client, date)).map((p) => Number(p.id_by_customer)));
}

const sameAmount = (a: unknown, b: unknown) => Math.abs(Number(a)) === Math.abs(Number(b));

async function assignOne(
  client: BBClient,
  base: { index: number; receipt_id_by_customer: number },
  receipt: number,
  posting: number
) {
  try {
    await client.call("postingsAssignReceiptToFreePosting", { receipt_id_by_customer: receipt, posting_id_by_customer: posting });
    return { ...base, posting_id_by_customer: posting, status: "assigned" };
  } catch (error) {
    return {
      ...base,
      posting_id_by_customer: posting,
      status: "assign_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Fallback when the batch answer carries no posting id, so a new free posting is recognised by what was sent
// (date, text, amount, both accounts) among the ids that did not exist before the call. Ambiguous or
// missing matches are reported, never guessed: the posting exists either way and must not be booked twice.
async function assignNewFreePostings(
  client: BBClient,
  wanted: Array<{ index: number; receipt: number; sent: FreeSent }>,
  before: Map<string, Set<number>>,
  returned: Array<{ id_by_customer?: unknown }> = []
): Promise<Array<{ index: number; receipt_id_by_customer: number; posting_id_by_customer?: number; status: string; error?: string }>> {
  const rowsByDate = new Map<string, PostingRow[]>();
  const used = new Set<number>();
  const out = [];
  for (const w of wanted) {
    const { date } = w.sent;
    const base = { index: w.index, receipt_id_by_customer: w.receipt };
    // The batch endpoint answers with the new posting's id per entry (confirmed live); the search below is only a fallback.
    const givenId = Number(returned[w.index]?.id_by_customer);
    if (Number.isInteger(givenId) && givenId > 0) {
      used.add(givenId);
      out.push(await assignOne(client, base, w.receipt, givenId));
      continue;
    }
    if (!rowsByDate.has(date)) rowsByDate.set(date, await freePostingRows(client, date));
    const known = before.get(date) ?? new Set<number>();
    const candidates = rowsByDate
      .get(date)!
      .filter(
        (p) =>
          !known.has(Number(p.id_by_customer)) &&
          !used.has(Number(p.id_by_customer)) &&
          String(p.postingtext) === w.sent.postingtext &&
          sameAmount(p.amount, w.sent.amount) &&
          Number(p.debit_postingaccount_number) === w.sent.postingaccount_debit &&
          Number(p.credit_postingaccount_number) === w.sent.postingaccount_credit
      );
    if (candidates.length === 0) {
      out.push({ ...base, status: "posting_not_found" });
      continue;
    }
    const posting = Number(candidates.sort((a, b) => Number(a.id_by_customer) - Number(b.id_by_customer))[0].id_by_customer);
    used.add(posting);
    out.push(await assignOne(client, base, w.receipt, posting));
  }
  return out;
}

export function createPostingsTools(
  client: BBClient
): [ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef] {
  const listShape = {
    date_from: z.string(),
    date_to: z.string(),
    date_last_action_from: z.string().optional(),
    date_last_action_to: z.string().optional(),
    account: z.string().optional(),
    postingaccount: z.string().optional(),
    posting_status: z.enum(["all", "fixed", "unfixed"]).optional(),
    cost_location: z.string().optional(),
    order: z
      .enum([
        "default",
        "date ASC",
        "date DESC",
        "date_last_action ASC",
        "date_last_action DESC",
        "id_by_customer ASC",
        "id_by_customer DESC",
      ])
      .optional(),
    limit: z.number().int().max(1000).default(20),
    offset: z.number().int().default(0),
    ...compactShape,
  };

  const listPostings = defineTool({
    name: "list_postings",
    description:
      "List postings (Buchungen) within a required date range, with optional filters. Rows have ~40 fields; by default " +
      "(compact) empty fields and PDF links are left out - cheap enough for checks. fields: [...] keeps only the named " +
      "fields, include_links: true brings the PDF links back, compact: false returns the raw rows. Example: " +
      '{"date_from":"2026-01-01","date_to":"2026-01-31","postingaccount":"4950","fields":["id_by_customer","date","amount","postingtext"]}.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: listShape,
    async handler(args) {
      const { compact, include_links, fields, ...filters } = args;
      const result = await client.call<{ data?: unknown }>("postingsGet", {
        ...filters,
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      });
      return ok(
        result.data === undefined ? result : { ...result, data: compactRows(result.data, { compact, include_links, fields }) }
      );
    },
  });

  const receiptPostingEntryShape = z.object({
    receipt_id_by_customer: z.number().int(),
    creditor: z.number().int(),
    debtor: z.number().int(),
    splits: z.array(splitShape).min(1),
    ...travelerFieldsShape,
    ...entertainmentFieldsShape,
  });

  const addReceiptPostingsShape = {
    receipts: z.array(receiptPostingEntryShape).min(1),
    ...dryRunShape,
  };

  const addReceiptPostings = defineTool({
    name: "add_receipt_postings",
    description:
      "Book one or more receipts onto posting accounts in a single batch call. Complete example (Bilanzierer, Eingangsrechnung " +
      'auf Kreditor): {"receipts":[{"receipt_id_by_customer":2001,"creditor":70001,"debtor":10001,"splits":[{"amount":"119.00",' +
      '"postingaccount":4950,"postingtext":"Beispiel GmbH Beratung","vat":"19_pre"}]}]}. ' +
      "Use this when the " +
      "posting is backed by a receipt/invoice document; for a bank transaction use " +
      "add_transaction_postings, and for entries with no receipt or transaction (e.g. opening balances) use " +
      "add_free_postings (not for depreciation of Anlagegüter - see add_free_postings). A receipt's date_delivery (abweichendes Leistungsdatum) only " +
      "takes effect when the receipt is booked on a creditor/debtor. Book the receipt BEFORE its payment. Only for bilanzierende " +
      "Unternehmen/Soll-Versteuerer and for receipts with payment terms in a different period; a Vorsteuer for a receipt paid in " +
      "a later period must be booked on a Kreditor at the receipt date, otherwise it can only be claimed at payment. A receipt on an " +
      "account with receipt_creates_transaction cannot be booked on a creditor/debtor. Sammelkonten: Debitoren 10000, Kreditoren " +
      "70000. BuchhaltungsButler refuses a second booking of the same receipt as expense and as creditor/debtor. Booking onto a travel-expense account (Reisekosten " +
      "Arbeitnehmer/Unternehmer, SKR03 4660-4678 or SKR04 6650-6680) requires traveler_name, " +
      "traveler_role (employee or owner_manager — ask the user if unclear, never infer it from the " +
      "invoice address or payment method), and business_purpose. Booking onto a Bewirtungskosten " +
      "(business entertainment) account (SKR03 4650/4654 or SKR04 6640/6644) requires the deductible " +
      "(4650/6640) and non-deductible (4654/6644) splits to both be present in an approximately 70/30 " +
      "ratio, plus participants, occasion, and host_confirmed: true (confirming a proper signed " +
      "Bewirtungsbeleg exists per § 4 Abs. 5 Nr. 2 EStG — ask the user if unsure, don't assume). Both " +
      "sets of fields are recorded as a comment on the receipt for the audit trail." +
      " The audit comment is cut to BuchhaltungsButler's 210-character limit; if it still fails after the booking " +
      "the call returns a warning instead of an error (never re-book). entertainment_split_mode " +
      '"net_reclass" books only 4650/6640 with full amount and input VAT and returns ' +
      "entertainment_reclass_hints (30% of NET, to book via add_free_postings as 4654 an 4650, vat 0_none).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: addReceiptPostingsShape,
    async handler(args) {
      const travelMatches = args.receipts.map((entry) =>
        assertTravelExpenseFields(
          entry.splits.map((s) => s.postingaccount),
          entry
        )
      );
      const entertainmentMatches = args.receipts.map((entry) => assertEntertainmentExpenseFields(entry.splits, entry));
      const receipts = args.receipts.map(
        ({ splits, traveler_name, traveler_role, business_purpose, participants, occasion, host_confirmed, entertainment_split_mode, ...rest }) => ({
          ...rest,
          ...flattenSplits(splits),
        })
      );
      const { commentJobs, hints } = collectAuditArtifacts(
        args.receipts.map((entry, i) => ({
          target: { receipt_id_by_customer: entry.receipt_id_by_customer },
          entry,
          travelMatch: travelMatches[i],
          entertainmentMatch: entertainmentMatches[i],
        }))
      );
      if (args.dry_run) {
        return dryRunResult(
          client,
          "postingsAddBatchReceipts",
          { receipts },
          args.receipts.flatMap((e) =>
            e.splits.map((s) => ({ account: s.postingaccount, vat: s.vat, label: `Beleg ${e.receipt_id_by_customer}` }))
          ),
          { commentJobs, hints, postingtexts: args.receipts.flatMap((e) => e.splits.map((s) => s.postingtext)) }
        );
      }
      const result = await withBookingHints(() => client.call("postingsAddBatchReceipts", { receipts }));
      const warnings = [
        ...(await sendComments(client, commentJobs)),
        ...anlagenWarnings(args.receipts.flatMap((e) => e.splits.map((s) => s.postingaccount))),
        ...postingtextWarnings(args.receipts.flatMap((e) => e.splits.map((s) => s.postingtext))),
      ];
      return withExtras(result, { warnings, hints });
    },
  });

  const transactionPostingEntryShape = z.object({
    transaction_id_by_customer: z.number().int(),
    splits: z.array(transactionSplitShape).min(1),
    ...travelerFieldsShape,
    ...entertainmentFieldsShape,
  });

  const addTransactionPostingsShape = {
    transactions: z.array(transactionPostingEntryShape).min(1),
    ...dryRunShape,
  };

  const addTransactionPostings = defineTool({
    name: "add_transaction_postings",
    description:
      "Book one or more transactions onto posting accounts in a single batch call. Complete example (Aufwand, bezahlt von " +
      'Bank): {"transactions":[{"transaction_id_by_customer":1001,"splits":[{"amount":"119.00","postingaccount":4950,' +
      '"postingtext":"Beispiel GmbH Beratung","vat":"19_pre","receipt_id_by_customer":2001}]}]} - the array is ' +
      "always transactions[] with splits[]; vat on an Aufwandskonto is 19_pre/7_pre (Vorsteuer), on an Erlöskonto " +
      "19_vat/7_vat, neutral 0_none. Run ONE call first, then parallelise: an error in six parallel calls costs six answers. " +
      "Use this for a bank " +
      "transaction; for a receipt/invoice use add_receipt_postings, and for entries with no receipt or " +
      "transaction use add_free_postings. Each split may optionally set receipt_id_by_customer to assign " +
      "an existing 'open item' receipt to that specific split — omit it for splits with no receipt; the " +
      "connector aligns these into BuchhaltungsButler's required parallel array automatically. Booking " +
      "onto a travel-expense account (Reisekosten " +
      "Arbeitnehmer/Unternehmer, SKR03 4660-4678 or SKR04 6650-6680) requires traveler_name, " +
      "traveler_role (employee or owner_manager — ask the user if unclear, never infer it from the " +
      "invoice address or payment method), and business_purpose. Booking onto a Bewirtungskosten " +
      "(business entertainment) account (SKR03 4650/4654 or SKR04 6640/6644) requires the deductible " +
      "(4650/6640) and non-deductible (4654/6644) splits to both be present in an approximately 70/30 " +
      "ratio, plus participants, occasion, and host_confirmed: true (confirming a proper signed " +
      "Bewirtungsbeleg exists per § 4 Abs. 5 Nr. 2 EStG — ask the user if unsure, don't assume). Both " +
      "sets of fields are recorded as a comment on the transaction for the audit trail." +
      " The audit comment is cut to BuchhaltungsButler's 210-character limit; if it still fails after the booking " +
      "the call returns a warning instead of an error (never re-book). entertainment_split_mode " +
      '"net_reclass" books only 4650/6640 with full amount and input VAT and returns ' +
      "entertainment_reclass_hints (30% of NET, to book via add_free_postings as 4654 an 4650, vat 0_none). " +
      "Settling a creditor/debtor receipt: book the payment against the Debitor/Kreditor account WITHOUT tax (vat 0_none) - the " +
      "expense/revenue and its tax were booked on the receipt; with a receipt that is already booked on a creditor/debtor the payment " +
      "can only be booked against it, not against an expense/revenue account (and vice versa). Under Ist-Versteuerung the USt is " +
      "moved from 'nicht fällig' to 'fällig' automatically. " +
      "Give split amounts as positive numbers; the direction follows the transaction. A NEGATIVE split reverses " +
      "Soll/Haben and is only for Skonto (negative split on the Skonto account with the receipt's tax rate) or for " +
      "netting a receivable against a payable; the splits must then still add up to the transaction amount. The " +
      "connector passes amounts through unchanged. Observed live on one outgoing card payment: all-negative splits " +
      "were rejected with BuchhaltungsButler error 27 (sum does not match the transaction amount), positive ones " +
      "were accepted. Special cases (Skonto, Geldtransit, Storno, Trinkgeld, Rücklastschrift, 5.5%/10.7% VAT): see " +
      "get_booking_guide.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: addTransactionPostingsShape,
    async handler(args) {
      const travelMatches = args.transactions.map((entry) =>
        assertTravelExpenseFields(
          entry.splits.map((s) => s.postingaccount),
          entry
        )
      );
      const entertainmentMatches = args.transactions.map((entry) =>
        assertEntertainmentExpenseFields(entry.splits, entry)
      );
      const transactions = args.transactions.map(
        ({ splits, traveler_name, traveler_role, business_purpose, participants, occasion, host_confirmed, entertainment_split_mode, ...rest }) => ({
          ...rest,
          ...flattenTransactionSplits(splits),
        })
      );
      const { commentJobs, hints } = collectAuditArtifacts(
        args.transactions.map((entry, i) => ({
          target: { transaction_id_by_customer: entry.transaction_id_by_customer },
          entry,
          travelMatch: travelMatches[i],
          entertainmentMatch: entertainmentMatches[i],
        }))
      );
      const cashbackIds = await fetchCashbackIds(client, args.transactions.map((e) => e.transaction_id_by_customer));
      const cashbackWarnings =
        cashbackIds.size === 0
          ? []
          : cashbackPostingWarnings(args.transactions, cashbackIds, await getChart(client).catch(() => "unknown" as const));
      if (args.dry_run) {
        return dryRunResult(
          client,
          "postingsAddBatchTransactions",
          { transactions },
          args.transactions.flatMap((e) =>
            e.splits.map((s) => ({ account: s.postingaccount, vat: s.vat, label: `Transaktion ${e.transaction_id_by_customer}` }))
          ),
          {
            commentJobs,
            hints,
            postingtexts: args.transactions.flatMap((e) => e.splits.map((s) => s.postingtext)),
            extraWarnings: cashbackWarnings,
          }
        );
      }
      const result = await withBookingHints(() => client.call("postingsAddBatchTransactions", { transactions }));
      const warnings = [
        ...cashbackWarnings,
        ...(await sendComments(client, commentJobs)),
        ...anlagenWarnings(args.transactions.flatMap((e) => e.splits.map((s) => s.postingaccount))),
        ...postingtextWarnings(args.transactions.flatMap((e) => e.splits.map((s) => s.postingtext))),
      ];
      return withExtras(result, { warnings, hints });
    },
  });

  const freePostingEntryShape = z.object({
    date: z.string(),
    postingtext: z.string(),
    amount: amountShape,
    postingaccount_debit: z.number().int(),
    postingaccount_credit: z.number().int(),
    vat: vatShape,
    cost_location: z.string().optional(),
    cost_location_two: z.string().optional(),
    receipt_id_by_customer: z
      .number()
      .int()
      .optional()
      .describe(
        "Optional: assign this receipt to the new free posting right away (replaces a separate assign_receipt_to_free_posting call). " +
          "The batch endpoint returns no posting ids, so the connector finds the new posting itself; the result lists per entry " +
          "whether the assignment worked."
      ),
    ...ossFieldsShape,
    ...travelerFieldsShape,
  });

  const addFreePostingsShape = {
    free_postings: z.array(freePostingEntryShape).min(1),
    ...dryRunShape,
  };

  const addFreePostings = defineTool({
    name: "add_free_postings",
    description:
      "Add one or more free-form postings (not tied to a receipt or transaction) in a single batch " +
      "call, e.g. opening balances. Complete example (Plattformverkauf, Auszahlung privat, Beleg gleich zugeordnet): " +
      '{"free_postings":[{"date":"2026-03-10","postingtext":"Plattform Gutschrift","amount":"20.00",' +
      '"postingaccount_debit":1800,"postingaccount_credit":8400,"vat":"19_vat","receipt_id_by_customer":3001}]} - the ' +
      "parameter is free_postings (not postings). receipt_id_by_customer is optional; with it the receipt is assigned in the " +
      "same call and the result lists receipt_assignments per entry. A free posting with a receipt does NOT count as payment " +
      "(amount_paid stays 0, the receipt stays 'teilausgeglichen'). NOT for Abschreibung of Anlagegüter: BuchhaltungsButler's Anlagenverwaltung (UI only, no API) books " +
      "that monthly itself once the asset is captured there, so a manual AfA posting would depreciate twice; a booking on an " +
      "Anlagenkonto (0001-0599) via API creates no asset - ask the user to capture it in the UI. For a receipt or bank transaction, use " +
      "add_receipt_postings or add_transaction_postings instead. Year-start bookings (ask the Steuerberater " +
      "first, they usually do these): EB-Werte of Sachkonten (Bestand, Bilanz only) are booked against 9000 " +
      "Saldenvortrag Sachkonten, dated 31.12. of the previous year so that SuSa shows 'Saldo zum 01.01.' " +
      "(9090 Summenvortrag for in-year totals); to correct an EB-Wert book only the difference against 9000 at " +
      "the end of the old year. Bank/cash opening balances are NOT free postings: create a manual transaction " +
      "(create_transactions, last day of the previous year, signed balance) and post it against 9000. Open " +
      "creditor/debtor items are better entered as unpaid receipts - an EB-Wert booked here does not settle " +
      "automatically when paid and triggers no USt reclassification under Ist-Versteuerung. " +
      "Erlös/Aufwand accounts and all USt/VSt accounts start every Wirtschaftsjahr at 0: to carry a USt/VSt " +
      "balance, sum the USt and VSt accounts from the SuSa and book it on 01.01. to 1790 (SKR03) / 3841 (SKR04) " +
      "Umsatzsteuer Vorjahr (Erstattung = Soll, Nachzahlung = Haben); the payment is then booked against the same " +
      "account. Before that, defer the Vorauszahlungen for Dec (and Nov with Dauerfristverlängerung) on 31.12. from " +
      "1780/3820 to 1789/3840 and move 1789/3840 to 1790/3841 on 01.01. A Jahresüberschuss is carried manually on " +
      "01.01.: Gewinnvortrag 9000 (Soll) an 860/2970 (Haben), Verlustvortrag 868/2978 (Soll) an 9000 (Haben). Use vat " +
      "0_none for all of these. Booking onto a travel-expense account " +
      "(Reisekosten Arbeitnehmer/Unternehmer, SKR03 4660-4678 or SKR04 6650-6680) requires " +
      "traveler_name, traveler_role (employee or owner_manager — ask the user if unclear, never infer " +
      "it from the invoice address or payment method), and business_purpose; these are appended to " +
      "postingtext for the audit trail (free postings have no id to attach a comment to).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: addFreePostingsShape,
    async handler(args) {
      args.free_postings.forEach((f, i) => assertOssFields(f.vat, f, `Freie Buchung ${i + 1}`));
      const free_postings = args.free_postings.map(
        ({ traveler_name, traveler_role, business_purpose, receipt_id_by_customer, ...rest }) => {
          const match = assertTravelExpenseFields([rest.postingaccount_debit, rest.postingaccount_credit], {
            traveler_name,
            traveler_role,
            business_purpose,
          });
          if (!match) return rest;
          return {
            ...rest,
            postingtext: `${rest.postingtext} — ${formatTravelExpenseNote({
              traveler_name: traveler_name!,
              traveler_role: match.role,
              business_purpose: business_purpose!,
            })}`,
          };
        }
      );
      const wanted = args.free_postings.flatMap((f, i) =>
        f.receipt_id_by_customer === undefined ? [] : [{ index: i, receipt: f.receipt_id_by_customer, sent: free_postings[i] }]
      );
      if (args.dry_run) {
        return dryRunResult(
          client,
          "postingsAddBatchFree",
          { free_postings },
          args.free_postings.flatMap((f, i) => [
            { account: f.postingaccount_debit, vat: f.vat, label: `Freie Buchung ${i + 1} (Soll)` },
            { account: f.postingaccount_credit, vat: f.vat, label: `Freie Buchung ${i + 1} (Haben)` },
          ]),
          {
            assignReceipts: wanted.map((w) => ({ index: w.index, receipt_id_by_customer: w.receipt })),
            taxAccountsOnly: true,
            postingtexts: args.free_postings.map((f) => f.postingtext),
            extraWarnings: thirdPartyPaymentWarnings(args.free_postings),
          }
        );
      }
      const dates = [...new Set(wanted.map((w) => w.sent.date))];
      const before = new Map<string, Set<number>>();
      for (const date of dates) before.set(date, await freePostingIds(client, date));

      const result = await withBookingHints(() => client.call("postingsAddBatchFree", { free_postings }));
      const returned = (result as { free_postings?: Array<{ id_by_customer?: unknown }> }).free_postings ?? [];
      const assignments = wanted.length > 0 ? await assignNewFreePostings(client, wanted, before, returned) : [];
      return ok(
        withWarnings(
          assignments.length > 0 ? { ...(result as Record<string, unknown>), receipt_assignments: assignments } : result,
          [
            ...anlagenWarnings(args.free_postings.flatMap((f) => [f.postingaccount_debit, f.postingaccount_credit])),
            ...personenkontoWarnings(args.free_postings.flatMap((f) => [f.postingaccount_debit, f.postingaccount_credit])),
            ...postingtextWarnings(args.free_postings.map((f) => f.postingtext)),
            ...thirdPartyPaymentWarnings(args.free_postings),
            ...(assignments.some((a) => a.status !== "assigned")
              ? [
                  "Mindestens eine Buchung wurde angelegt, aber der Beleg nicht zugeordnet (siehe receipt_assignments). " +
                    "NICHT erneut buchen; die Zuordnung per assign_receipt_to_free_posting nachholen.",
                ]
              : []),
          ]
        )
      );
    },
  });

  const unconfirmShape = {
    type: z.enum(["transaction", "receipt", "free"]),
    id_by_customer: z.number().int(),
  };

  const unconfirmPosting = defineTool({
    name: "unconfirm_posting",
    description:
      "Unconfirm a fixed posting so it can be edited again. type selects which kind of posting. This lifts the " +
      "Festschreibung (GoBD) - to correct a fixed posting use cancel_posting, which reverses it with a reversal posting " +
      "instead. Only if the user explicitly decides to unfix.",
    // Flips an existing posting's fixed/confirmed status — a non-additive
    // state change, same class as update_contact/manage_posting_account/
    // unassign_receipt, so destructiveHint follows them for consistency.
    annotations: { readOnlyHint: false, destructiveHint: true },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: unconfirmShape,
    async handler(args) {
      if (args.type === "transaction") {
        const result = await client.call("postingsUnconfirmTransaction", {
          transaction_id_by_customer: args.id_by_customer,
        });
        return ok(result);
      }
      if (args.type === "receipt") {
        const result = await client.call("postingsUnconfirmReceipt", {
          receipt_id_by_customer: args.id_by_customer,
        });
        return ok(result);
      }
      const result = await client.call("postingsUnconfirmFree", { posting_id_by_customer: args.id_by_customer });
      return ok(result);
    },
  });

  const assignShape = {
    receipt_id_by_customer: z.number().int(),
    posting_id_by_customer: z.number().int().optional(),
    free_posting_id_by_customer: z.number().int().optional().describe("Alias for posting_id_by_customer."),
  };

  const assignReceiptToFreePosting = defineTool({
    name: "assign_receipt_to_free_posting",
    description:
      "Assign a receipt to an existing free posting (parameters receipt_id_by_customer and posting_id_by_customer). Not for transactions — to assign a receipt to a " +
      "transaction, use assign_receipts_to_transactions instead.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: assignShape,
    async handler(args) {
      const posting = args.posting_id_by_customer ?? args.free_posting_id_by_customer;
      if (posting === undefined) {
        throw new Error("posting_id_by_customer is required (the id_by_customer of the free posting; alias free_posting_id_by_customer).");
      }
      const result = await client.call("postingsAssignReceiptToFreePosting", {
        receipt_id_by_customer: args.receipt_id_by_customer,
        posting_id_by_customer: posting,
      });
      return ok(result);
    },
  });

  const confirmPaymentShape = {
    receipt_id_by_customer: z.number().int(),
    transaction_id_by_customer: z.number().int(),
    posting_account: z
      .number()
      .int()
      .describe(
        "The creditor/debtor posting account the receipt was originally booked against (the same account " +
          "passed as creditor/debtor to add_receipt_postings). Not auto-discovered — the BuchhaltungsButler " +
          "API has no way to look up which account a given receipt was booked against, so pass the account " +
          "you already used or can look up with a single list_postings call."
      ),
    postingtext: z.string().optional(),
  };

  const confirmPayment = defineTool({
    name: "confirm_payment",
    description:
      "Close out a receipt that was booked on a creditor/debtor against a matching bank transaction (Bilanz, or " +
      "Ist-Versteuerung with Debitoren/Kreditoren; books with vat 0_none against posting_account, which also lets " +
      "BuchhaltungsButler move the USt under Ist-Versteuerung). Do NOT use it for receipts without a creditor/debtor " +
      "booking (typical EÜR): there the payment itself carries the expense/revenue account and the real VAT code - " +
      "use add_transaction_postings. Differing amounts (Skonto, payment-provider fees, Sammelzahlung) are refused " +
      "here; book those with add_transaction_postings: Skonto = negative split on the Skonto account with the " +
      "receipt's tax rate (see get_booking_guide skonto), receipt_id_by_customer on the settling split. Background: assigning a receipt to a transaction " +
      "(assign_receipts_to_transactions) creates no posting and leaves the creditor/debtor balance " +
      "untouched by itself — a booking against posting_account is still required to actually settle it. " +
      "This tool does both in the right order and reports which of them actually completed, so a caller " +
      "can't mistake 'assigned' for 'paid'. Rejects with an error if the receipt's and transaction's " +
      "amounts don't match (no silent partial settlement). Does not set or ask about the fixed/festgeschrieben " +
      "state — that has no equivalent in the BuchhaltungsButler API and is a client-specific policy decision, " +
      "not something this connector can or should decide.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: confirmPaymentShape,
    async handler(args) {
      const receipt = await client.call<{ data: { amount: string; invoicenumber?: string; counterparty?: string } }>(
        "receiptsGetIdByCustomer",
        {},
        { idSuffix: args.receipt_id_by_customer }
      );
      const transaction = await client.call<{ data: { amount: string } }>(
        "transactionsGetIdByCustomer",
        {},
        { idSuffix: args.transaction_id_by_customer }
      );

      if (!amountsMatch(receipt.data.amount, transaction.data.amount)) {
        throw new Error(
          `Receipt ${args.receipt_id_by_customer} amount (${receipt.data.amount}) does not match transaction ` +
            `${args.transaction_id_by_customer} amount (${transaction.data.amount}) — refusing to assign or book ` +
            `a partial settlement. Confirm the correct receipt/transaction pair with the user instead of guessing.`
        );
      }

      const assignResult = await client.call("transactionsAssignBatchReceipt", {
        transactions_to_receipts: [
          {
            transaction_id_by_customer: args.transaction_id_by_customer,
            receipt_id_by_customer: args.receipt_id_by_customer,
          },
        ],
      });

      const amount = Math.abs(Number(receipt.data.amount)).toFixed(2);
      const postingtext = args.postingtext ?? buildSettlementPostingText(receipt.data, args.receipt_id_by_customer);

      try {
        const postingResult = await client.call("postingsAddBatchTransactions", {
          transactions: [
            {
              transaction_id_by_customer: args.transaction_id_by_customer,
              oi_receipts_ids_by_customer: [args.receipt_id_by_customer],
              postingaccounts: [args.posting_account],
              postingtexts: [postingtext],
              vats: ["0_none"],
              amounts: [amount],
            },
          ],
        });
        return ok({ status: "booked", amount, assign: assignResult, posting: postingResult });
      } catch (err) {
        return ok({
          status: "assigned_only",
          amount,
          assign: assignResult,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  const cancelPostingShape = {
    type: z.enum(["transaction", "receipt", "free"]),
    id_by_customer: z
      .number()
      .int()
      .describe(
        "transaction: id of the bank transaction; receipt: id of the receipt; free: id of the free posting itself."
      ),
    date_from: z.string().describe("YYYY-MM-DD. Start of a range that surely contains the posting's date."),
    date_to: z.string().describe("YYYY-MM-DD. End of that range."),
    reverse_posting_ids: z
      .array(z.number().int())
      .optional()
      .describe(
        "Ids (id_by_customer) of FIXED postings the user explicitly approved to be reversed by a reversal posting " +
          "(Stornobuchung). Take them from the preview. Fixed postings not listed here are never touched."
      ),
    confirm: z
      .boolean()
      .default(false)
      .describe("false/omitted: preview only, nothing is changed. true: actually cancel the postings."),
  };

  const cancelPosting = defineTool({
    name: "cancel_posting",
    description:
      "Cancel wrongly created postings (e.g. before re-booking them correctly) via BuchhaltungsButler's " +
      "/postings/cancel, called once per posting: postings that are NOT fixed are deleted (irreversible, nicht " +
      "umkehrbar); FIXED (festgeschrieben) postings are cancelled by a new reversal posting (Stornobuchung, GoBD-" +
      "conform) - the original stays. Always call first with confirm=false: the preview lists every posting with " +
      "its action (löschen / stornieren) - BHB's API gives no change log, so note the data - and let the user approve " +
      "before confirm=true. type=transaction/receipt cancels ALL postings of that transaction/receipt, type=free a " +
      "single posting. Fixed postings are only reversed when their ids are passed in reverse_posting_ids (a reversal " +
      "posting is itself a posting - never run this twice for the same unit and never list reversal postings). Do " +
      "not use for periods already covered by a VAT pre-return (USt-Voranmeldung) or annual accounts without the " +
      "Steuerberater. Afterwards the tool re-reads the postings: gelöscht true/false for the deleted ones, " +
      "neu_angelegt lists the reversal postings that appeared. Recommended order when booking: check receipt, book " +
      "receipt, assign payment, book payment.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: cancelPostingShape,
    async handler(args) {
      const { type, id_by_customer: id, date_from, date_to } = args;
      const range = { date_from, date_to };
      const label = `${CANCEL_LABEL[type]} ${id}`;

      const before = await readRange(client, range);
      const targets = before.filter((p) => matchesCancelTarget(p, type, id));
      if (targets.length === 0) {
        throw new Error(
          `Buchung nicht gefunden: keine Buchungen zu ${label} im Zeitraum ${date_from} bis ${date_to}. ` +
            "ID, type und Zeitraum prüfen (der Zeitraum muss das Buchungsdatum enthalten)."
        );
      }
      const idOf = (p: PostingRow) => Number(p.id_by_customer);
      const fixed = targets.filter(isFixed);
      const reverseIds = new Set(args.reverse_posting_ids ?? []);
      const plan = targets.map((p) => ({
        ...summarizePosting(p),
        aktion: isFixed(p) ? "stornieren (Gegenbuchung)" : "löschen",
      }));
      const note =
        "Vor dem Löschen die Buchungsdaten notieren: BuchhaltungsButler liefert über die API kein Änderungsprotokoll.";

      if (!args.confirm) {
        const fixedIds = fixed.map(idOf);
        return ok({
          mode: "preview",
          gelöscht: false,
          target: label,
          postings: plan,
          hinweis:
            fixed.length > 0
              ? `${fixed.length} Buchung(en) festgeschrieben: werden per Gegenbuchung storniert (Original bleibt). ` +
                `Dafür reverse_posting_ids=[${fixedIds.join(", ")}] mit confirm=true übergeben - nur nach Entscheidung des Nutzers. ` +
                `Nicht festgeschriebene werden gelöscht. ${note}`
              : `Nichts geändert. Mit confirm=true würden genau diese Buchungen gelöscht. ${note}`,
        });
      }

      const unknown = [...reverseIds].filter((rid) => !fixed.some((p) => idOf(p) === rid));
      if (unknown.length > 0) {
        throw new Error(
          `reverse_posting_ids ${unknown.join(", ")} gehören nicht zu den festgeschriebenen Buchungen von ${label}. ` +
            "Nur IDs aus der Vorschau übergeben (keine bereits vorhandenen Stornobuchungen)."
        );
      }
      const notApproved = fixed.filter((p) => !reverseIds.has(idOf(p)));
      if (notApproved.length > 0) {
        throw new Error(
          `${label}: ${notApproved.length} Buchung(en) sind festgeschrieben (${notApproved.map(idOf).join(", ")}) und ` +
            "würden per Gegenbuchung storniert. Ausdrücklich per reverse_posting_ids freigeben (nur nach Entscheidung des " +
            "Nutzers), sonst nichts ausführen."
        );
      }

      const done: number[] = [];
      for (const p of targets) {
        try {
          await client.call("postingsCancel", { posting_id_by_customer: idOf(p) });
          done.push(idOf(p));
        } catch (error) {
          throw new Error(
            `Buchung ${idOf(p)} konnte nicht storniert werden: ${error instanceof Error ? error.message : String(error)}. ` +
              `Bereits erledigt: ${done.length > 0 ? done.join(", ") : "keine"}; noch offen: ` +
              `${targets.map(idOf).filter((x) => x !== idOf(p) && !done.includes(x)).join(", ") || "keine"}. ` +
              "Nicht blind wiederholen - zuerst mit confirm=false den aktuellen Stand prüfen."
          );
        }
      }

      // Do not trust the API's success answer alone: read the postings again.
      const after = await readRange(client, range);
      const beforeIds = new Set(before.map(idOf));
      const removable = targets.filter((p) => !isFixed(p));
      const remaining = after.filter((p) => removable.some((r) => idOf(r) === idOf(p)));
      const created = after.filter((p) => !beforeIds.has(idOf(p)));
      const warnings = [
        ...(remaining.length > 0
          ? [
              `API meldete Erfolg, aber ${remaining.length} Buchung(en) sind noch vorhanden. In BuchhaltungsButler prüfen; nicht blind erneut buchen.`,
            ]
          : []),
        ...(fixed.length > 0 && created.length === 0
          ? [
              "Es wurde keine neue Buchung im Zeitraum gefunden, obwohl festgeschriebene Buchungen storniert werden sollten. " +
                "Zeitraum erweitern oder in BuchhaltungsButler prüfen (Gegenbuchung evtl. mit anderem Datum).",
            ]
          : []),
      ];
      return ok({
        mode: "executed",
        gelöscht: remaining.length === 0,
        target: label,
        cancelled: plan,
        ...(created.length > 0 ? { neu_angelegt: created.map(summarizePosting) } : {}),
        ...(remaining.length > 0 ? { remaining: remaining.map(summarizePosting) } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        hinweis: note,
      });
    },
  });

  return [
    listPostings,
    addReceiptPostings,
    addTransactionPostings,
    addFreePostings,
    unconfirmPosting,
    assignReceiptToFreePosting,
    confirmPayment,
    cancelPosting,
  ];
}
