import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import {
  assertOccasionIsConcrete,
  computeAmounts,
  type ComputedAmounts,
  type EntertainmentReceiptFields,
  mergeWithBillFile,
  type Participant,
  renderEntertainmentReceiptCover,
} from "./entertainment-receipt-pdf.js";
import {
  appendCoverToOriginal,
  classifyOriginal,
  MAX_ORIGINAL_BYTES,
  runDryChecks,
  sha256Hex,
} from "./entertainment-receipt-append.js";
import { assertGeneratorType, planMissingInvoice, type MissingInvoicePlan } from "./entertainment-missing-invoice.js";
import {
  ENTERTAINMENT_TYPES,
  type EntertainmentType,
  INVOICE_STATUSES,
  type InvoiceStatus,
  MISSING_INVOICE_TREATMENT_HELP,
  MISSING_INVOICE_TREATMENTS,
  type MissingInvoiceTreatment,
  PARTICIPANT_RELATIONS,
  type ParticipantRelation,
  SHAREHOLDER_MANAGER_TREATMENT_HELP,
  SHAREHOLDER_MANAGER_TREATMENTS,
  type ShareholderManagerTreatment,
  consistencyWarnings,
  typeFromParticipants,
} from "./entertainment-policy.js";
import { largeAmountNotice, transactionDateWarnings, vatRatePlausibility, zeitnahWarning } from "./bewirtung-plausibility.js";
import { getChart } from "./posting-accounts.js";
import { extractReceiptText } from "./receipt-text-extraction.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type CallToolResult, type ToolDef } from "./types.js";

// Converts an ISO date ("2026-09-17") to the German display format used on
// the generated page ("17.09.2026"). Pure string slicing, not a Date object -
// parsing/reformatting through Date would risk a timezone-driven off-by-one
// day shift, which a receipt date can't afford.
export function formatGermanDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year}`;
}

// The only VAT rates that exist in German law for these receipt lines.
const VALID_GERMAN_VAT_RATES = [0, 7, 19];
// Generous enough to absorb cent-rounding noise on the printed net/vat
// amounts (e.g. 0.50 / 7.15 = 6.993%, not exactly 7%), tight enough that a
// genuinely wrong or blended figure (which lands nowhere near 0, 7, or 19)
// still falls through to undefined instead of snapping to a misleading rate.
const RATE_SNAP_TOLERANCE_PERCENT = 0.5;

// Never returns a percentage that isn't one of the valid German rates -
// snaps to the nearest one within a small tolerance, or undefined if
// nothing is close enough. A raw, un-snapped ratio could otherwise turn a
// data-entry slip (wrong net or vat figure) into an invalid rate value
// silently sent to BuchhaltungsButler as if it were legitimate.
function effectiveRatePercent(net: number, vat: number): number | undefined {
  if (net <= 0) return undefined;
  const raw = (vat / net) * 100;
  const nearest = VALID_GERMAN_VAT_RATES.reduce((best, candidate) =>
    Math.abs(candidate - raw) < Math.abs(best - raw) ? candidate : best
  );
  return Math.abs(nearest - raw) <= RATE_SNAP_TOLERANCE_PERCENT ? nearest : undefined;
}

// Derives the vat_rate to send to BuchhaltungsButler's upload endpoint from
// the same food/drinks amounts already on the page, instead of leaving the
// field unset and letting BuchhaltungsButler's own OCR guess at a rate from
// page text never meant to look like an invoice total line (a plausible,
// unconfirmed source of the "-70.00" vat value seen on a real upload).
//
// Deliberately computed from the caller's actual net/vat amounts (exactly as
// printed on the real invoice) rather than a hardcoded food=7%/drinks=19% -
// food's statutory rate depends on the receipt's date (7% dine-in only since
// 1.1.2026 per § 12 Abs. 2 Nr. 15 UStG; 19% dine-in before that, with the
// pre-2024 Corona reduction as a further wrinkle), and hardcoding either
// value or a cutoff date would silently mislabel an older receipt with an
// asserted-but-wrong rate - worse than sending none at all. The real amounts
// are correct for any date without the code needing to know why.
//
// Food and drinks carry different statutory rates in the common case, so a
// receipt with both present has no single rate - the API's own spec calls an
// empty string the signal for "non-available or multiple vat rates", which
// is exactly this case, and is preferable to a guess.
export function deriveVatRate(input: {
  foodNet: number;
  foodVat: number;
  drinksNet: number;
  drinksVat: number;
}): number | "" | undefined {
  const hasFood = input.foodNet > 0 || input.foodVat > 0;
  const hasDrinks = input.drinksNet > 0 || input.drinksVat > 0;
  if (hasFood && hasDrinks) return "";
  if (hasFood) return effectiveRatePercent(input.foodNet, input.foodVat);
  if (hasDrinks) return effectiveRatePercent(input.drinksNet, input.drinksVat);
  return undefined;
}

function assertBillFileFieldsPaired(billFile: string | undefined, billFileType: string | undefined): void {
  if ((billFile === undefined) !== (billFileType === undefined)) {
    throw new Error(
      "bill_file and bill_file_type must be provided together - pass both to merge with the original bill " +
        "(Fall A), or neither for a standalone page to link via link_to_receipt_id_by_customer (Fall B)."
    );
  }
}

interface EntertainmentReceiptDocumentArgs {
  date: string;
  location: string;
  occasion: string;
  participants: Array<Participant & { relation?: ParticipantRelation }>;
  host_name: string;
  host_role?: string;
  food_net?: number;
  food_vat?: number;
  drinks_net?: number;
  drinks_vat?: number;
  tip?: number;
  kleinunternehmer?: boolean;
  company_name?: string;
  company_address?: string;
  receipt_number?: string;
  bill_reference?: string;
  bill_file?: string;
  bill_file_type?: "pdf" | "png" | "jpeg";
  entertainment_type?: EntertainmentType;
  original_invoice_status?: InvoiceStatus;
  gross_amount?: number;
  payment_evidence?: { transaction_id_by_customer?: number; description?: string };
  invoice_requests?: Array<{ date: string; channel: string }>;
  missing_invoice_treatment?: MissingInvoiceTreatment;
  shareholder_manager_treatment?: ShareholderManagerTreatment;
  acknowledge_practice_over_250?: boolean;
}

type CoverArgs = EntertainmentReceiptDocumentArgs & { counterparty?: string; source_receipt_id_by_customer?: number };

// Validated, computed content of the Bewirtungsseite, before rendering. Pure (no API, no PDF), so every
// validation error is thrown before anything is loaded from or sent to BuchhaltungsButler.
interface PlannedCover {
  fields: EntertainmentReceiptFields;
  amounts: ComputedAmounts;
  kleinunternehmer: boolean;
  warnings: string[];
  // Only in the mode "Rechnung fehlt" (original_invoice_status missing_requested | lost).
  plan?: MissingInvoicePlan;
}

function planCover(args: CoverArgs, opts: { requireCounterparty: boolean }): PlannedCover {
  assertGeneratorType(args.entertainment_type);
  assertOccasionIsConcrete(args.occasion);
  const kleinunternehmer = args.kleinunternehmer ?? false;
  const relations = args.participants.map((p) => p.relation).filter((r): r is ParticipantRelation => r !== undefined);
  const knownRelations = relations.length > 0 ? relations : undefined;
  const status = args.original_invoice_status ?? "present";
  const baseFields = {
    date: args.date,
    location: args.location,
    occasion: args.occasion,
    participants: args.participants,
    hostName: args.host_name,
    hostRole: args.host_role,
    companyName: args.company_name,
    companyAddress: args.company_address,
    receiptNumber: args.receipt_number,
    billReference: args.bill_reference,
  };

  if (status !== "present") {
    const plan = planMissingInvoice(
      {
        original_invoice_status: status,
        entertainment_type: args.entertainment_type,
        missing_invoice_treatment: args.missing_invoice_treatment,
        shareholder_manager_treatment: args.shareholder_manager_treatment,
        participant_relations: knownRelations,
        gross_amount: args.gross_amount,
        tip: args.tip,
        food_net: args.food_net,
        food_vat: args.food_vat,
        drinks_net: args.drinks_net,
        drinks_vat: args.drinks_vat,
        payment_evidence: args.payment_evidence,
        invoice_requests: args.invoice_requests,
        counterparty: args.counterparty,
        source_receipt_id_by_customer: args.source_receipt_id_by_customer,
        acknowledge_practice_over_250: args.acknowledge_practice_over_250,
      },
      { requireCounterparty: opts.requireCounterparty }
    );
    const planWarnings = [...plan.warnings];
    const late = zeitnahWarning(args.date);
    if (late) planWarnings.push(late);
    const bigMissing = largeAmountNotice(plan.gross);
    if (bigMissing) planWarnings.push(bigMissing);
    return {
      // No billReference on the page: there is no original invoice the page could supplement.
      fields: { ...baseFields, billReference: undefined, foodNet: 0, foodVat: 0, drinksNet: 0, drinksVat: 0, tip: plan.tip },
      amounts: {
        grossTotal: plan.gross,
        vatTotal: 0,
        deductibleBase: plan.gross,
        deductible: plan.deductible,
        nonDeductible: plan.nonDeductible,
      },
      kleinunternehmer,
      warnings: planWarnings,
      plan,
    };
  }

  const amounts = computeAmounts({
    foodNet: args.food_net ?? 0,
    foodVat: args.food_vat ?? 0,
    drinksNet: args.drinks_net ?? 0,
    drinksVat: args.drinks_vat ?? 0,
    tip: args.tip ?? 0,
    kleinunternehmer,
  });
  const warnings: string[] = [];
  if (args.entertainment_type === undefined) {
    const suggested = knownRelations ? typeFromParticipants(knownRelations) : undefined;
    warnings.push(
      "entertainment_type fehlt: ohne Bewirtungsart kann der Konnektor Konto, Lohnsteuer und vGA-Risiko nicht einordnen." +
        (suggested ? ` Vorschlag aus den Teilnehmern: ${suggested}.` : "")
    );
  }
  warnings.push(...consistencyWarnings(args.entertainment_type, knownRelations, args.shareholder_manager_treatment));
  const ignored = (
    ["gross_amount", "payment_evidence", "invoice_requests", "missing_invoice_treatment", "acknowledge_practice_over_250"] as const
  ).filter((key) => args[key] !== undefined);
  if (ignored.length > 0) {
    warnings.push(
      `${ignored.join(", ")} gilt nur ohne Originalrechnung (original_invoice_status missing_requested | lost) und wurde ignoriert.`
    );
  }
  const vat = vatRatePlausibility({
    date: args.date,
    foodNet: args.food_net ?? 0,
    foodVat: args.food_vat ?? 0,
    drinksNet: args.drinks_net ?? 0,
    drinksVat: args.drinks_vat ?? 0,
  });
  warnings.push(...vat.warnings, ...vat.hints);
  const big = largeAmountNotice(amounts.grossTotal);
  if (big) warnings.push(big);
  const late = zeitnahWarning(args.date);
  if (late) warnings.push(late);
  return {
    fields: {
      ...baseFields,
      foodNet: args.food_net ?? 0,
      foodVat: args.food_vat ?? 0,
      drinksNet: args.drinks_net ?? 0,
      drinksVat: args.drinks_vat ?? 0,
      tip: args.tip ?? 0,
    },
    amounts,
    kleinunternehmer,
    warnings,
  };
}

function renderCover(
  planned: PlannedCover,
  options: { attachmentFollows?: boolean; attachmentPrecedes?: boolean; originalSha256?: string }
): Promise<Uint8Array> {
  return renderEntertainmentReceiptCover(planned.fields, planned.amounts, {
    kleinunternehmer: planned.kleinunternehmer,
    attachmentFollows: options.attachmentFollows,
    attachmentPrecedes: options.attachmentPrecedes,
    originalSha256: options.originalSha256,
    ...(planned.plan ? { missingInvoice: planned.plan.page } : {}),
  });
}

// Shared by both tools below: the pure "build the PDF" step (validate,
// compute amounts, render, optionally merge with the original bill) that
// generate_entertainment_receipt returns as-is, and that
// generate_and_upload_entertainment_receipt additionally uploads. Kept as a
// plain function (no BuchhaltungsButler access) so it stays exactly as
// testable without network-mocking as it was before this tool existed.
async function buildEntertainmentReceiptDocument(
  args: CoverArgs,
  opts: { requireCounterparty?: boolean } = {}
): Promise<{
  pdfBytes: Uint8Array;
  amounts: ComputedAmounts;
  mergedWithBill: boolean;
  warnings: string[];
  plan?: MissingInvoicePlan;
}> {
  assertBillFileFieldsPaired(args.bill_file, args.bill_file_type);
  const planned = planCover(args, { requireCounterparty: opts.requireCounterparty ?? false });
  const cover = await renderCover(planned, { attachmentFollows: Boolean(args.bill_file) });

  const pdfBytes =
    args.bill_file && args.bill_file_type
      ? await mergeWithBillFile(cover, args.bill_file, args.bill_file_type)
      : cover;

  return {
    pdfBytes,
    amounts: planned.amounts,
    mergedWithBill: Boolean(args.bill_file),
    warnings: planned.warnings,
    plan: planned.plan,
  };
}

type Chart = Awaited<ReturnType<typeof getChart>> | "SKR04";

interface BookingHint {
  chart: Chart;
  vat: "0_none";
  splits: Array<{ kind: "deductible" | "non_deductible" | "internal"; postingaccount?: number; amount: string }>;
  note: string;
}

// Without an invoice: the splits for the booking tools, always without input VAT. Account numbers only
// when the chart is known (SKR03 4650/4654/4140; SKR04 6640/6644, no internal account documented).
function buildBookingHint(plan: MissingInvoicePlan, chart: Chart): BookingHint {
  const acc =
    chart === "SKR03"
      ? { d: 4650, n: 4654, i: 4140 }
      : chart === "SKR04"
        ? { d: 6640, n: 6644, i: undefined }
        : undefined;
  const split = (kind: BookingHint["splits"][number]["kind"], amount: number, postingaccount: number | undefined) => ({
    kind,
    ...(postingaccount !== undefined ? { postingaccount } : {}),
    amount: amount.toFixed(2),
  });
  const splits: BookingHint["splits"] = [];
  if (plan.business) {
    if (plan.deductible > 0) splits.push(split("deductible", plan.deductible, acc?.d));
    if (plan.nonDeductible > 0) splits.push(split("non_deductible", plan.nonDeductible, acc?.n));
  } else {
    splits.push(split("internal", plan.deductible, acc?.i));
  }
  return {
    chart,
    vat: "0_none",
    splits,
    note:
      "Splits mit vat 0_none buchen (keine Vorsteuer ohne Rechnung), entertainment_split_mode gross_split. " +
      (acc === undefined || splits.some((s) => s.postingaccount === undefined)
        ? "Kontenrahmen bzw. Konto nicht ermittelbar: Kontonummern selbst wählen. "
        : "") +
      "original_invoice_status, entertainment_type und die gewählten Varianten an das Buchungs-Tool weitergeben.",
  };
}

// With an invoice: the exact net total and reclass amount of the page, to be passed on as invoice_net_total.
function buildPresentHint(amounts: ComputedAmounts, kleinunternehmer: boolean) {
  if (kleinunternehmer) return undefined; // Kleinunternehmer split on gross, there is no net reclass
  return {
    invoice_net_total: amounts.deductibleBase.toFixed(2),
    reclass_amount: amounts.nonDeductible.toFixed(2),
    note:
      "Bei entertainment_split_mode net_reclass invoice_net_total an das Buchungs-Tool übergeben; die Umbuchung 4654 an 4650 " +
      "beträgt reclass_amount (vat 0_none) und stimmt mit der Bewirtungsseite überein.",
  };
}

async function bookingHintFor(
  client: BBClient,
  planned: { plan?: MissingInvoicePlan; amounts: ComputedAmounts },
  kleinunternehmer: boolean
): Promise<{ booking_hint?: unknown }> {
  if (planned.plan) {
    const chart: Chart = await getChart(client).catch(() => "unknown" as const);
    return { booking_hint: buildBookingHint(planned.plan, chart) };
  }
  const hint = buildPresentHint(planned.amounts, kleinunternehmer);
  return hint ? { booking_hint: hint } : {};
}

const NO_TEXT_LAYER_WARNING =
  "Der Originalbeleg hat keine Textebene (Scan, Foto oder handschriftlich): bei Kassensystem sind handschriftliche oder nur " +
  "maschinell erstellte Belege vom Abzug ausgeschlossen (BMF 19.11.2025 Rn. 13; Dennerlein Q32/Q57 sehen das milder). " +
  "Thermopapier: dauerhafte Kopie beifügen.";

// This shape makes no BuchhaltungsButler API calls when used by
// generate_entertainment_receipt below - it's a pure generation function
// (structured fields in, PDF bytes out). VAT amounts are supplied by the
// caller exactly as printed on the real invoice rather than computed here
// (net x rate) - same reasoning as the 70/30-split validation in
// entertainment-expense.ts: a silently-wrong recomputed cent amount is
// harder to catch than a transcription error.
const generateShape = {
  date: z.string().describe("Bewirtungsdatum, z.B. 24.09.2026"),
  location: z.string().min(1).describe("Ort der Bewirtung (Name des Restaurants + Stadt)"),
  occasion: z
    .string()
    .min(1)
    .describe(
      "Konkreter geschäftlicher Anlass - so detailliert, dass ein Außenstehender den Zusammenhang sofort " +
        'erkennt. Pauschale Floskeln wie "Geschäftsessen" oder "Kundenpflege" werden abgelehnt (BFH-Rechtsprechung).'
    ),
  participants: z
    .array(
      z.object({
        name: z.string().min(1),
        company: z.string().optional(),
        relation: z
          .enum(PARTICIPANT_RELATIONS)
          .optional()
          .describe("Beziehung zum bewirtenden Unternehmen (external | employee | shareholder_manager | shareholder | freelancer)."),
      })
    )
    .min(1)
    .describe(
      "Nur die Personen, deren Verzehr durch DIESEN Beleg (diesen Betrag) tatsächlich bezahlt wurde - " +
        "NICHT automatisch jeder, der am Tisch saß. MUSS aktiv beim Nutzer erfragt werden, ob wirklich alle " +
        "hier aufgeführten Personen aus diesem Betrag bewirtet wurden oder ob einzelne (z. B. bei getrennter " +
        "Rechnung/Zahlung) selbst bezahlt haben - in letzterem Fall gehören nur die von diesem Betrag " +
        "tatsächlich bezahlten Personen hierher, auch wenn andere mit am Tisch saßen. Nicht identisch mit den " +
        "Teilnehmern einer größeren umgebenden Veranstaltung (§ 4 Abs. 5 Satz 1 Nr. 2 Satz 3 EStG) - eine " +
        "dafür mitgelieferte Teilnehmerliste (z. B. Anmeldeliste eines Verbandstreffens) darf nicht ungeprüft " +
        "hier übernommen werden, ohne diese Rückfrage zu stellen."
    ),
  host_name: z
    .string()
    .min(1)
    .describe(
      "Die bewirtende Person. MUSS aktiv beim Nutzer erfragt werden - nicht aus Teilnehmerliste, " +
        "Meeting-Kontext oder allgemeinem Wissen ableiten, selbst wenn es naheliegend erscheint."
    ),
  host_role: z.string().optional().describe("Rolle/Position der bewirtenden Person, nur zur Anzeige"),
  food_net: z.number().nonnegative().default(0).describe("Speisen, Netto, exakt wie auf der Rechnung (7 % USt)"),
  food_vat: z.number().nonnegative().default(0).describe("Speisen, ausgewiesene USt exakt wie auf der Rechnung"),
  drinks_net: z.number().nonnegative().default(0).describe("Getränke, Netto, exakt wie auf der Rechnung (19 % USt)"),
  drinks_vat: z.number().nonnegative().default(0).describe("Getränke, ausgewiesene USt exakt wie auf der Rechnung"),
  tip: z.number().nonnegative().default(0).describe("Trinkgeld - kein Entgelt, keine USt"),
  kleinunternehmer: z
    .boolean()
    .default(false)
    .describe(
      "Vor dem Aufruf aus Organisations-/Projektanweisungen oder dem bisherigen Gesprächsverlauf ableiten, " +
        "ob die bewirtende Firma Kleinunternehmer nach § 19 UStG ist. Ohne jeden Hinweis: false " +
        "(Regelbesteuerung) - kein aktives Nachfragen nötig, anders als bei host_name."
    ),
  company_name: z.string().optional().describe("Für den Briefkopf; leer = Platzhalter im PDF"),
  company_address: z.string().optional(),
  receipt_number: z.string().optional().describe("Interne Belegnummer, nur zur Anzeige"),
  bill_reference: z
    .string()
    .optional()
    .describe(
      "Nur die Rechnungsnummer der Original-Rechnung selbst, z. B. \"92119\" - kein zusammengesetzter Satz " +
        "wie \"Rechnung-Nr. 92119 / Beleg-Nr. ...\", das wird im Beleg automatisch als \"Ergänzung zu Rechnung " +
        '92119" formatiert.'
    ),
  entertainment_type: z
    .enum(ENTERTAINMENT_TYPES)
    .optional()
    .describe(
      "Bewirtungsart. Pflicht, wenn original_invoice_status nicht present ist, sonst optional (ohne Angabe nur eine Warnung). " +
        "sole_proprietor_self wird abgelehnt: Einzelunternehmer allein erhalten keinen Bewirtungsbeleg (nur Verpflegungspauschale 14/28 €)."
    ),
  original_invoice_status: z
    .enum(INVOICE_STATUSES)
    .default("present")
    .describe(
      "present (Default, bisheriges Verhalten) | missing_requested (beim Gastwirt angefordert, nicht erhalten) | lost (verloren/unleserlich). " +
        "Ohne Rechnung: gross_amount, payment_evidence und ggf. missing_invoice_treatment Pflicht; Speisen/Getränke-Beträge müssen leer sein."
    ),
  gross_amount: z.number().positive().optional().describe("Nur ohne Rechnung: Zahlbetrag inklusive Trinkgeld."),
  payment_evidence: z
    .object({ transaction_id_by_customer: z.number().int().optional(), description: z.string().optional() })
    .optional()
    .describe(
      "Nur ohne Rechnung, Pflicht: Zahlungsnachweis (Banktransaktion und/oder Beschreibung). Mit Transaktion wird der Betrag geprüft " +
        "und der Beleg zugeordnet (beim Hochladen ohne source_receipt_id_by_customer)."
    ),
  invoice_requests: z
    .array(z.object({ date: z.string(), channel: z.string().min(1) }))
    .optional()
    .describe("Nur ohne Rechnung: Anforderungen der Rechnung beim Gastwirt (Datum, Kanal). Bei missing_requested mindestens eine."),
  missing_invoice_treatment: z.enum(MISSING_INVOICE_TREATMENTS).optional().describe(MISSING_INVOICE_TREATMENT_HELP),
  shareholder_manager_treatment: z.enum(SHAREHOLDER_MANAGER_TREATMENTS).optional().describe(SHAREHOLDER_MANAGER_TREATMENT_HELP),
  acknowledge_practice_over_250: z
    .boolean()
    .optional()
    .describe(
      "Nur practice_70_30_no_vat über 250 €: ausdrückliche Bestätigung des Nutzers (Dennerlein Q42 nennt nur Beträge unter 250 €). " +
        "Beim Nutzer erfragen, nicht ableiten."
    ),
  bill_file: z
    .string()
    .optional()
    .describe(
      "NUR für Dateien, die NICHT in BuchhaltungsButler liegen (bei vorhandenem Beleg stattdessen " +
        "source_receipt_id_by_customer verwenden - große Base64-Strings kann das Modell nicht fehlerfrei durchreichen). " +
        "Original-Rechnung, base64. Vorhanden -> gemergtes PDF (Fall A: Rechnung noch nicht in BuchhaltungsButler). " +
        "Fehlt -> einseitiges PDF nur mit den Bewirtungsangaben, zum Hochladen mit " +
        "link_to_receipt_id_by_customer (Fall B: Rechnung existiert schon)."
    ),
  bill_file_type: z.enum(["pdf", "png", "jpeg"]).optional(),
};

const uploadShape = {
  ...generateShape,
  date: z.string().describe('Bewirtungsdatum im ISO-Format "YYYY-MM-DD", z.B. 2026-09-17 (wird an BuchhaltungsButler weitergereicht und für die Anzeige auf der Seite ins deutsche Format umgewandelt).'),
  counterparty: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Die bewirtende Gaststätte/das Restaurant, wie bei BuchhaltungsButler als Gegenpartei hinterlegt werden soll. " +
        "Pflicht außer bei source_receipt_id_by_customer (dort wird die Gegenpartei des Originalbelegs übernommen, " +
        "sofern hier nichts anderes angegeben ist)."
    ),
  source_receipt_id_by_customer: z
    .number()
    .int()
    .optional()
    .describe(
      "EMPFOHLEN, wann immer der Original-Beleg schon in BuchhaltungsButler liegt: id_by_customer des Originals. " +
        "Der Konnektor lädt das Original serverseitig, hängt die Bewirtungsangaben als letzte Seite an und lädt " +
        "EINEN neuen Beleg hoch (Original + Bewirtungsangaben). Kein Base64 durch den Modell-Kontext. Das Original " +
        "bleibt unverändert und wird NICHT gelöscht - erst nach Rückfrage beim Nutzer per set_receipt_deleted. " +
        "Nicht kombinierbar mit bill_file oder link_to_receipt_id_by_customer."
    ),
  include_original_hash: z
    .boolean()
    .default(true)
    .describe("Nur mit source_receipt_id_by_customer: SHA-256 des Originaldokuments in die Fußzeile der Bewirtungsseite."),
  keep_original_metadata: z
    .boolean()
    .default(true)
    .describe(
      "Nur mit source_receipt_id_by_customer: Datum, Rechnungsnummer, Betrag, Gegenpartei und Konto des " +
        "Originalbelegs für den neuen Beleg übernehmen (Gegenpartei/Rechnungsnummer/Konto nur, wenn nicht " +
        "ausdrücklich angegeben). false = Werte aus den Tool-Parametern."
    ),
  link_to_receipt_id_by_customer: z
    .number()
    .int()
    .optional()
    .describe(
      "id_by_customer der bereits in BuchhaltungsButler vorhandenen Original-Rechnung. Pflicht, wenn kein " +
        "bill_file und kein source_receipt_id_by_customer mitgegeben wird (Fall B) - sonst würde die reine " +
        "Bewirtungsangaben-Seite als unverknüpfter eigener Beleg hochgeladen. Legt in BuchhaltungsButler einen " +
        "ZWEITEN Beleg an - bevorzugt source_receipt_id_by_customer verwenden."
    ),
  account: z.number().int().optional().describe("Zahlungskonto-Kontonummer, falls der Beleg direkt zugeordnet werden soll."),
  creditor_debtor: z.number().int().optional().describe("Kreditor-Kontonummer, falls der Beleg direkt zugeordnet werden soll."),
};

const AMOUNT_TOLERANCE = 0.01;

const toId = (value: unknown): string | number | undefined => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return typeof value === "string" ? value : undefined;
};

// BuchhaltungsButler's upload response carries id_by_customer and the internal
// filename at the TOP level (per spec: ReceiptsUpload_Success), not under
// `data`. Older code/tests assumed `data.id_by_customer`, so both are read.
interface UploadResponse {
  id_by_customer?: string | number;
  filename?: string;
  data?: { id_by_customer?: string | number; filename?: string };
}
const readUploadedId = (r: UploadResponse): string | number | undefined =>
  r.id_by_customer ?? r.data?.id_by_customer;
const readUploadedFilename = (r: UploadResponse): string | undefined => r.filename ?? r.data?.filename;

const formatDe = (n: number) => n.toFixed(2).replace(".", ",");

// Mode "Rechnung fehlt" with payment_evidence.transaction_id_by_customer: the amount check aborts before
// anything is uploaded; the date check only warns. Returns the warnings.
async function verifyPaymentEvidence(
  client: BBClient,
  args: { date: string; payment_evidence?: { transaction_id_by_customer?: number } },
  plan: MissingInvoicePlan
): Promise<string[]> {
  const id = args.payment_evidence?.transaction_id_by_customer;
  if (id === undefined) return [];
  let row: Record<string, unknown> | undefined;
  try {
    const result = await client.call<{ data?: Record<string, unknown> }>("transactionsGetIdByCustomer", {}, { idSuffix: id });
    row = result?.data;
  } catch (error) {
    throw new Error(
      `Transaktion ${id} (payment_evidence) konnte nicht geladen werden (${error instanceof Error ? error.message : String(error)}). ` +
        "Es wurde nichts hochgeladen."
    );
  }
  if (!row) throw new Error(`Transaktion ${id} (payment_evidence) nicht gefunden. Es wurde nichts hochgeladen.`);
  const txAmount = row.amount === undefined || row.amount === null || row.amount === "" ? NaN : Math.abs(Number(row.amount));
  if (!Number.isFinite(txAmount) || Math.abs(txAmount - plan.gross) > AMOUNT_TOLERANCE + 1e-9) {
    throw new Error(
      `Betragsabweichung: gross_amount ${formatDe(plan.gross)} € ≠ Betrag der Transaktion ${id} ` +
        `(${Number.isFinite(txAmount) ? `${formatDe(txAmount)} €` : `unbekannt: ${String(row.amount)}`}). Es wurde nichts hochgeladen. ` +
        "gross_amount (inkl. Trinkgeld) und die Transaktion mit dem Nutzer abgleichen."
    );
  }
  return transactionDateWarnings(args.date, typeof row.booking_date === "string" ? row.booking_date : undefined);
}

type SourceArgs = EntertainmentReceiptDocumentArgs & {
  source_receipt_id_by_customer: number;
  counterparty?: string;
  link_to_receipt_id_by_customer?: number;
  account?: number;
  creditor_debtor?: number;
  include_original_hash?: boolean;
  keep_original_metadata?: boolean;
};

interface OriginalReceiptData {
  filename?: string;
  date?: string;
  counterparty?: string;
  invoicenumber?: string;
  amount?: string | number;
  type?: string;
  account?: string | number;
  file_content?: string;
  [key: string]: unknown;
}

// Server-side variant: the original never passes through the model. Order is
// load -> validate -> merge -> dry-check -> upload (exactly once, never
// retried) -> duplicate check. Everything before the upload throws without
// side effects; the original receipt is never modified or deleted. Only IDs,
// page counts and check results are returned - no document content.
async function uploadWithSourceReceipt(client: BBClient, args: SourceArgs): Promise<CallToolResult> {
  const sourceId = args.source_receipt_id_by_customer;
  if (args.bill_file !== undefined || args.bill_file_type !== undefined) {
    throw new Error(
      "source_receipt_id_by_customer und bill_file schließen sich aus - das Original wird serverseitig aus " +
        "BuchhaltungsButler geladen. bill_file nur für Dateien nutzen, die nicht in BuchhaltungsButler liegen."
    );
  }
  if (args.link_to_receipt_id_by_customer !== undefined) {
    throw new Error(
      "source_receipt_id_by_customer und link_to_receipt_id_by_customer schließen sich aus - sonst entstünde " +
        "wieder ein verknüpfter Zweitbeleg statt eines Belegs."
    );
  }
  // All validation (occasion, Bewirtungsart, mode "Rechnung fehlt") before the original is loaded.
  const planned = planCover({ ...args, date: formatGermanDate(args.date) }, { requireCounterparty: false });
  const { amounts, plan } = planned;
  const keep = args.keep_original_metadata ?? true;
  const warnings: string[] = [...planned.warnings];

  let original: OriginalReceiptData;
  try {
    const result = await client.call<{ data?: OriginalReceiptData }>(
      "receiptsGetIdByCustomer",
      { get_file: true },
      { idSuffix: sourceId }
    );
    if (!result.data) throw new Error("leere Antwort");
    original = result.data;
  } catch (error) {
    throw new Error(
      `Original-Beleg ${sourceId} konnte nicht geladen werden (${error instanceof Error ? error.message : String(error)}). ` +
        "Es wurde nichts hochgeladen. id_by_customer per list_receipts prüfen."
    );
  }
  if (!original.file_content) {
    throw new Error(`Original-Beleg ${sourceId} hat keine Datei - es wurde nichts hochgeladen.`);
  }
  if ((original.file_content.length * 3) / 4 > MAX_ORIGINAL_BYTES) {
    throw new Error(
      `Original-Beleg ${sourceId} ist größer als das Limit von 15 MB - es wurde nichts hochgeladen. ` +
        "Datei verkleinern oder die Bewirtungsangaben per Fall B (link_to_receipt_id_by_customer) hochladen."
    );
  }
  const originalBytes = new Uint8Array(Buffer.from(original.file_content, "base64"));
  const kind = classifyOriginal(originalBytes);
  const originalSha256 = sha256Hex(originalBytes);

  const originalAmount = original.amount === undefined || original.amount === "" ? NaN : Number(original.amount);
  if (Number.isFinite(originalAmount)) {
    const diff = Math.round((amounts.grossTotal - originalAmount) * 100) / 100;
    if (Math.abs(diff) > AMOUNT_TOLERANCE + 1e-9) {
      throw new Error(
        plan
          ? `Betragsabweichung: gross_amount ${formatDe(amounts.grossTotal)} € ≠ Betrag des Quell-Belegs ` +
              `${formatDe(originalAmount)} € (Differenz ${formatDe(diff)} €). Es wurde nichts hochgeladen. ` +
              "Zahlbetrag (inkl. Trinkgeld) mit dem Quell-Beleg abgleichen."
          : `Betragsabweichung: Summe der Teilbeträge ${formatDe(amounts.grossTotal)} € ≠ Betrag des Originalbelegs ` +
              `${formatDe(originalAmount)} € (Differenz ${formatDe(diff)} €). Es wurde nichts hochgeladen. ` +
              "Beträge (Speisen/Getränke/Trinkgeld) mit der Rechnung abgleichen."
      );
    }
  } else {
    warnings.push(
      plan
        ? "Der Quell-Beleg hat keinen Betrag - Betragsprüfung übersprungen, gross_amount verwendet."
        : "Der Originalbeleg hat keinen Betrag - Betragsprüfung übersprungen, Betrag aus den Teilbeträgen verwendet."
    );
  }
  if (plan) warnings.push(...(await verifyPaymentEvidence(client, args, plan)));
  if (kind !== "pdf" || (await extractReceiptText(original.file_content)) === undefined) {
    warnings.push(NO_TEXT_LAYER_WARNING);
  }

  const billReference = args.bill_reference ?? (keep ? original.invoicenumber || undefined : undefined);
  const cover = await renderCover(
    // Mode "Rechnung fehlt": the source receipt's number is upload metadata only, never printed as "Ergänzung zu Rechnung".
    { ...planned, fields: { ...planned.fields, billReference: plan ? undefined : billReference } },
    {
      attachmentPrecedes: true,
      originalSha256: (args.include_original_hash ?? true) ? originalSha256 : undefined,
    }
  );

  const merged = await appendCoverToOriginal(originalBytes, kind, cover);
  const checks = await runDryChecks(originalBytes, kind, merged);
  const failed = Object.entries(checks).filter(([, v]) => v === false).map(([k]) => k);
  if (failed.length > 0) {
    throw new Error(`Prüfung des zusammengeführten Belegs fehlgeschlagen (${failed.join(", ")}) - es wurde nichts hochgeladen.`);
  }

  const counterparty = args.counterparty ?? (keep ? original.counterparty : undefined);
  if (!counterparty) {
    throw new Error("Keine Gegenpartei: weder counterparty angegeben noch im Originalbeleg vorhanden - es wurde nichts hochgeladen.");
  }
  const originalAccount = Number(original.account);
  const account = args.account ?? (keep && Number.isInteger(originalAccount) && originalAccount > 0 ? originalAccount : undefined);
  const baseName = original.filename ? String(original.filename).replace(/\.[A-Za-z0-9]{1,5}$/, "") : `Beleg_${sourceId}`;
  const uploadParams = {
    file: Buffer.from(merged.pdfBytes).toString("base64"),
    type: keep && original.type ? original.type : "invoice inbound",
    file_name: `${baseName}_mit_Bewirtungsangaben.pdf`,
    account,
    creditor_debtor: args.creditor_debtor,
    counterparty,
    invoice_number: billReference,
    date: keep && original.date ? original.date : args.date,
    amount: keep && Number.isFinite(originalAmount) ? originalAmount : amounts.grossTotal,
    currency: "EUR",
    // Without an invoice there is no rate: "" is BuchhaltungsButler's "not available" signal.
    vat_rate: plan
      ? ""
      : deriveVatRate({
          foodNet: args.food_net ?? 0,
          foodVat: args.food_vat ?? 0,
          drinksNet: args.drinks_net ?? 0,
          drinksVat: args.drinks_vat ?? 0,
        }),
  };

  let newId: string | number | undefined;
  let uploadedFilename: string | undefined;
  try {
    const result = await client.call<UploadResponse>("receiptsUpload", uploadParams);
    newId = toId(readUploadedId(result));
    uploadedFilename = readUploadedFilename(result);
  } catch (error) {
    throw new Error(
      `Upload fehlgeschlagen (${error instanceof Error ? error.message : String(error)}). Nicht automatisch ` +
        "wiederholt (Duplikatgefahr: der Beleg kann trotzdem angelegt worden sein). Vor einem erneuten Versuch per " +
        `list_receipts (Gegenpartei/Datum) prüfen. Original ${sourceId} ist unverändert.`
    );
  }

  const duplicates: Array<Record<string, unknown>> = [];
  try {
    const direction = String(uploadParams.type).includes("outbound") ? "outbound" : "inbound";
    const list = await client.call<{ data?: Array<Record<string, unknown>> }>("receiptsGet", {
      list_direction: direction,
      date_from: uploadParams.date,
      date_to: uploadParams.date,
      limit: 500,
      offset: 0,
    });
    const rows = list.data ?? [];

    // The upload response should carry the id; if it doesn't, the internal
    // filename it returned identifies the new receipt - only if unambiguous.
    if (newId === undefined && uploadedFilename) {
      const byFilename = rows.filter((r) => r.filename === uploadedFilename);
      if (byFilename.length === 1) newId = toId(byFilename[0].id_by_customer);
    }

    // Invoice numbers can legitimately differ (receipt number on the original,
    // invoice number on the Bewirtungsseite), so a duplicate is date +
    // counterparty + amount; a receipt linked to the original always counts.
    const wantedParty = counterparty.trim().toLowerCase();
    const wantedAmount = Number(uploadParams.amount);
    for (const row of rows) {
      const rowId = toId(row.id_by_customer);
      if (rowId === sourceId || (newId !== undefined && rowId === newId)) continue;
      if (row.deleted === "1" || row.deleted === 1 || row.deleted === true) continue;
      const matches: string[] = [];
      if (row.date === uploadParams.date) matches.push("date");
      if (typeof row.counterparty === "string" && row.counterparty.trim().toLowerCase() === wantedParty) {
        matches.push("counterparty");
      }
      if (Math.abs(Number(row.amount) - wantedAmount) <= AMOUNT_TOLERANCE + 1e-9) matches.push("amount");
      const linkedToOriginal = toId(row.link_to_receipt_id_by_customer) === sourceId;
      const sameCore = ["date", "counterparty", "amount"].every((m) => matches.includes(m));
      if (!sameCore && !linkedToOriginal) continue;
      if (billReference && row.invoicenumber && String(row.invoicenumber) === billReference) matches.push("invoicenumber");
      if (linkedToOriginal) matches.push("linked_to_original");
      duplicates.push({
        id_by_customer: row.id_by_customer,
        date: row.date,
        counterparty: row.counterparty,
        amount: row.amount,
        invoicenumber: row.invoicenumber,
        link_to_receipt_id_by_customer: row.link_to_receipt_id_by_customer,
        linked_to_original: linkedToOriginal,
        matches,
      });
    }
  } catch {
    warnings.push(
      "Duplikatprüfung fehlgeschlagen - der Upload war erfolgreich. Bitte per list_receipts (Gegenpartei/Datum) manuell auf Duplikate prüfen."
    );
  }

  if (newId === undefined) {
    warnings.push(
      "Die Beleg-ID des neuen Belegs konnte nicht eindeutig ermittelt werden (Upload-Antwort ohne ID). " +
        "Neuen Beleg per list_receipts (Gegenpartei/Datum) suchen; duplicates_found kann den neuen Beleg enthalten."
    );
  }

  const hint = await bookingHintFor(client, planned, planned.kleinunternehmer);
  // The new receipt replaces the original, which may already be assigned to the payment: no automatic assignment here.
  const txId = plan ? args.payment_evidence?.transaction_id_by_customer : undefined;
  const assignHint =
    txId !== undefined
      ? ` Danach die Transaktion ${txId} dem neuen Beleg zuordnen (assign_receipts_to_transactions), falls BuchhaltungsButler das ` +
        "nicht selbst tut; eine Zuordnung zum Original vorher lösen (unassign_receipt)."
      : "";

  return ok({
    status: "ok",
    new_receipt_id_by_customer: newId ?? null,
    original_receipt_id_by_customer: sourceId,
    original_deleted: false,
    pages_before: merged.pagesBefore,
    pages_after: merged.pagesAfter,
    original_sha256: originalSha256,
    merge_method: "full_rewrite (pdf-lib; Seiteninhalt unverändert, Dateibytes neu geschrieben)",
    duplicates_found: duplicates,
    checks,
    amounts: {
      gross_total: amounts.grossTotal,
      vat_total: amounts.vatTotal,
      deductible: amounts.deductible,
      non_deductible: amounts.nonDeductible,
    },
    warnings,
    ...hint,
    next_step_hint:
      (newId !== undefined
        ? `Original ${sourceId} nach Bestätigung des Anwenders mit set_receipt_deleted entfernen, dann auf ${newId} buchen.`
        : `Neue Beleg-ID per list_receipts ermitteln. Original ${sourceId} nach Bestätigung des Anwenders mit set_receipt_deleted entfernen, dann auf den neuen Beleg buchen.`) +
      assignHint,
  });
}

const MISSING_INVOICE_DESCRIPTION =
  "Ohne Gaststättenrechnung (original_invoice_status = missing_requested | lost): gross_amount, payment_evidence, " +
  "Bewirtungsart und bei geschäftlichen Typen missing_invoice_treatment angeben (beim Nutzer erfragen). Die erzeugte Seite ist " +
  "dann selbst der Beleg (ein Upload), ohne Vorsteuer. source_receipt_id_by_customer bleibt optional. Die Antwort enthält " +
  "booking_hint mit den Splits für die Buchungs-Tools.";

export function createEntertainmentReceiptTools(client: BBClient): [ToolDef, ToolDef] {
  const generateEntertainmentReceipt = defineTool({
    name: "generate_entertainment_receipt",
    description:
      "Generate the 'Bewirtungsangaben' page required alongside a restaurant bill for a valid Bewirtungsbeleg " +
      "(§ 4 Abs. 5 Satz 1 Nr. 2 EStG). With bill_file: merges into one PDF (upload directly via upload_receipt). " +
      "Without bill_file: returns a standalone page to upload via upload_receipt's link_to_receipt_id_by_customer " +
      "against an already-existing receipt. Makes no BuchhaltungsButler API calls itself - prefer " +
      "generate_and_upload_entertainment_receipt when the PDF doesn't need to be inspected before upload, it " +
      "avoids round-tripping the full base64 PDF through the model twice. " +
      MISSING_INVOICE_DESCRIPTION,
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: generateShape,
    async handler(args) {
      const { pdfBytes, amounts, mergedWithBill, warnings, plan } = await buildEntertainmentReceiptDocument(args);
      // No API calls here, so the chart stays unknown (no account numbers in the hint).
      const presentHint = plan ? undefined : buildPresentHint(amounts, args.kleinunternehmer ?? false);
      return ok({
        pdf_base64: Buffer.from(pdfBytes).toString("base64"),
        merged_with_bill: mergedWithBill,
        gross_total: amounts.grossTotal,
        vat_total: amounts.vatTotal,
        deductible: amounts.deductible,
        non_deductible: amounts.nonDeductible,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(plan ? { booking_hint: buildBookingHint(plan, "unknown") } : presentHint ? { booking_hint: presentHint } : {}),
      });
    },
  });

  const generateAndUploadEntertainmentReceipt = defineTool({
    name: "generate_and_upload_entertainment_receipt",
    description:
      "Generate the 'Bewirtungsangaben' page (see generate_entertainment_receipt) and upload it to " +
      "BuchhaltungsButler in one call, instead of round-tripping the full base64 PDF through the model via a " +
      "separate upload_receipt call. If the original receipt already exists in BuchhaltungsButler, ALWAYS pass " +
      "source_receipt_id_by_customer: the connector loads the original server-side, appends the page as the last " +
      "page and uploads ONE new receipt (original + page); the original is never changed or deleted - after the " +
      "user confirms, remove it with set_receipt_deleted (restorable) and book on the new receipt. Use bill_file " +
      "only for files that are NOT in BuchhaltungsButler; link_to_receipt_id_by_customer (Fall B) creates a second " +
      "receipt and is only a fallback. Returns the new receipt's " +
      "id_by_customer, not the PDF itself. BuchhaltungsButler does not deduplicate by invoice number - if " +
      "this is a re-upload (e.g. a previous send failed), check list_receipts for an existing duplicate " +
      "first and remove it with set_receipt_deleted (see docs/bewirtungsbeleg-faq.md). " +
      MISSING_INVOICE_DESCRIPTION,
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: uploadShape,
    async handler(args) {
      if (args.source_receipt_id_by_customer !== undefined) {
        return uploadWithSourceReceipt(client, { ...args, source_receipt_id_by_customer: args.source_receipt_id_by_customer });
      }
      const status = args.original_invoice_status ?? "present";
      if (status === "present") {
        if (args.counterparty === undefined) {
          throw new Error("counterparty is required unless source_receipt_id_by_customer is given.");
        }
        if (args.bill_file === undefined && args.link_to_receipt_id_by_customer === undefined) {
          throw new Error(
            "link_to_receipt_id_by_customer is required when no bill_file is given (Fall B) - otherwise the " +
              "standalone Bewirtungsangaben page would be uploaded as its own unlinked receipt."
          );
        }
      } else if (args.link_to_receipt_id_by_customer !== undefined) {
        throw new Error(
          "Ohne Originalrechnung ist die Bewirtungsseite selbst der Beleg: link_to_receipt_id_by_customer würde einen verknüpften " +
            "Zweitbeleg mit demselben Betrag anlegen. Liegt ein Quell-Beleg (z. B. Kartenbeleg) in BuchhaltungsButler, " +
            "source_receipt_id_by_customer verwenden, sonst link_to_receipt_id_by_customer weglassen. Es wurde nichts hochgeladen."
        );
      }

      // Without a source receipt the page itself is the receipt in the mode "Rechnung fehlt", so the
      // counterparty is mandatory there (reported together with all other missing fields).
      const { pdfBytes, amounts, mergedWithBill, warnings, plan } = await buildEntertainmentReceiptDocument(
        { ...args, date: formatGermanDate(args.date) },
        { requireCounterparty: true }
      );
      if (plan) warnings.push(...(await verifyPaymentEvidence(client, args, plan)));

      const vatRate = plan
        ? ""
        : deriveVatRate({
            foodNet: args.food_net ?? 0,
            foodVat: args.food_vat ?? 0,
            drinksNet: args.drinks_net ?? 0,
            drinksVat: args.drinks_vat ?? 0,
          });

      const result = await client.call<UploadResponse>("receiptsUpload", {
        file: Buffer.from(pdfBytes).toString("base64"),
        type: "invoice inbound",
        file_name: plan
          ? `Bewirtungsbeleg_ohne_Rechnung_${args.date}.pdf`
          : `Bewirtungsangaben${args.bill_reference ? `_${args.bill_reference}` : ""}.pdf`,
        account: args.account,
        creditor_debtor: args.creditor_debtor,
        counterparty: args.counterparty,
        invoice_number: args.bill_reference,
        date: args.date,
        amount: amounts.grossTotal,
        currency: "EUR",
        vat_rate: vatRate,
        link_to_receipt_id_by_customer: args.link_to_receipt_id_by_customer,
      });

      // Mode "Rechnung fehlt": assign the new receipt to the payment. The upload has happened, so a failure here
      // only becomes a warning - never retry the upload.
      let assigned = false;
      const txId = plan ? args.payment_evidence?.transaction_id_by_customer : undefined;
      if (txId !== undefined) {
        const newId = toId(readUploadedId(result));
        if (typeof newId === "number") {
          try {
            const assignResult = await client.call<{ success?: boolean; message?: string }>("transactionsAssignBatchReceipt", {
              transactions_to_receipts: [{ transaction_id_by_customer: txId, receipt_id_by_customer: newId }],
            });
            if (assignResult?.success === false) throw new Error(assignResult.message || "success: false");
            assigned = true;
          } catch (error) {
            warnings.push(
              `Zuordnung zur Transaktion ${txId} fehlgeschlagen (${error instanceof Error ? error.message : String(error)}). ` +
                `Der Beleg ${newId} ist hochgeladen - mit assign_receipts_to_transactions nachtragen, nicht erneut hochladen.`
            );
          }
        } else {
          warnings.push(
            `Die Beleg-ID des neuen Belegs ist unbekannt: Zuordnung zur Transaktion ${txId} bitte selbst vornehmen ` +
              "(Beleg per list_receipts suchen, dann assign_receipts_to_transactions). Nicht erneut hochladen."
          );
        }
      }
      const hint = await bookingHintFor(client, { plan, amounts }, args.kleinunternehmer ?? false);

      return ok({
        id_by_customer: readUploadedId(result) ?? null,
        merged_with_bill: mergedWithBill,
        gross_total: amounts.grossTotal,
        vat_total: amounts.vatTotal,
        deductible: amounts.deductible,
        non_deductible: amounts.nonDeductible,
        ...(txId !== undefined ? { assigned_to_transaction: assigned } : {}),
        ...hint,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    },
  });

  return [generateEntertainmentReceipt, generateAndUploadEntertainmentReceipt];
}
