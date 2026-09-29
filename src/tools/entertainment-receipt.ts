import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import {
  assertOccasionIsConcrete,
  computeAmounts,
  type ComputedAmounts,
  mergeWithBillFile,
  type Participant,
  renderEntertainmentReceiptCover,
} from "./entertainment-receipt-pdf.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

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
  participants: Participant[];
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
}

// Shared by both tools below: the pure "build the PDF" step (validate,
// compute amounts, render, optionally merge with the original bill) that
// generate_entertainment_receipt returns as-is, and that
// generate_and_upload_entertainment_receipt additionally uploads. Kept as a
// plain function (no BuchhaltungsButler access) so it stays exactly as
// testable without network-mocking as it was before this tool existed.
async function buildEntertainmentReceiptDocument(
  args: EntertainmentReceiptDocumentArgs
): Promise<{ pdfBytes: Uint8Array; amounts: ComputedAmounts; mergedWithBill: boolean }> {
  assertBillFileFieldsPaired(args.bill_file, args.bill_file_type);
  assertOccasionIsConcrete(args.occasion);

  const kleinunternehmer = args.kleinunternehmer ?? false;
  const amounts = computeAmounts({
    foodNet: args.food_net ?? 0,
    foodVat: args.food_vat ?? 0,
    drinksNet: args.drinks_net ?? 0,
    drinksVat: args.drinks_vat ?? 0,
    tip: args.tip ?? 0,
    kleinunternehmer,
  });

  const cover = await renderEntertainmentReceiptCover(
    {
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
      foodNet: args.food_net ?? 0,
      foodVat: args.food_vat ?? 0,
      drinksNet: args.drinks_net ?? 0,
      drinksVat: args.drinks_vat ?? 0,
      tip: args.tip ?? 0,
    },
    amounts,
    { kleinunternehmer, attachmentFollows: Boolean(args.bill_file) }
  );

  const pdfBytes =
    args.bill_file && args.bill_file_type
      ? await mergeWithBillFile(cover, args.bill_file, args.bill_file_type)
      : cover;

  return { pdfBytes, amounts, mergedWithBill: Boolean(args.bill_file) };
}

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
  bill_file: z
    .string()
    .optional()
    .describe(
      "Original-Rechnung, base64. Vorhanden -> gemergtes PDF (Fall A: Rechnung noch nicht in BuchhaltungsButler). " +
        "Fehlt -> einseitiges PDF nur mit den Bewirtungsangaben, zum Hochladen mit " +
        "link_to_receipt_id_by_customer (Fall B: Rechnung existiert schon)."
    ),
  bill_file_type: z.enum(["pdf", "png", "jpeg"]).optional(),
};

const uploadShape = {
  ...generateShape,
  date: z.string().describe('Bewirtungsdatum im ISO-Format "YYYY-MM-DD", z.B. 2026-09-17 (wird an BuchhaltungsButler weitergereicht und für die Anzeige auf der Seite ins deutsche Format umgewandelt).'),
  counterparty: z.string().min(1).describe("Die bewirtende Gaststätte/das Restaurant, wie bei BuchhaltungsButler als Gegenpartei hinterlegt werden soll."),
  link_to_receipt_id_by_customer: z
    .number()
    .int()
    .optional()
    .describe(
      "id_by_customer der bereits in BuchhaltungsButler vorhandenen Original-Rechnung. Pflicht, wenn kein " +
        "bill_file mitgegeben wird (Fall B) - sonst würde die reine Bewirtungsangaben-Seite als unverknüpfter " +
        "eigener Beleg hochgeladen."
    ),
  account: z.number().int().optional().describe("Zahlungskonto-Kontonummer, falls der Beleg direkt zugeordnet werden soll."),
  creditor_debtor: z.number().int().optional().describe("Kreditor-Kontonummer, falls der Beleg direkt zugeordnet werden soll."),
};

export function createEntertainmentReceiptTools(client: BBClient): [ToolDef, ToolDef] {
  const generateEntertainmentReceipt = defineTool({
    name: "generate_entertainment_receipt",
    description:
      "Generate the 'Bewirtungsangaben' page required alongside a restaurant bill for a valid Bewirtungsbeleg " +
      "(§ 4 Abs. 5 Satz 1 Nr. 2 EStG). With bill_file: merges into one PDF (upload directly via upload_receipt). " +
      "Without bill_file: returns a standalone page to upload via upload_receipt's link_to_receipt_id_by_customer " +
      "against an already-existing receipt. Makes no BuchhaltungsButler API calls itself - prefer " +
      "generate_and_upload_entertainment_receipt when the PDF doesn't need to be inspected before upload, it " +
      "avoids round-tripping the full base64 PDF through the model twice.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: generateShape,
    async handler(args) {
      const { pdfBytes, amounts, mergedWithBill } = await buildEntertainmentReceiptDocument(args);
      return ok({
        pdf_base64: Buffer.from(pdfBytes).toString("base64"),
        merged_with_bill: mergedWithBill,
        gross_total: amounts.grossTotal,
        vat_total: amounts.vatTotal,
        deductible: amounts.deductible,
        non_deductible: amounts.nonDeductible,
      });
    },
  });

  const generateAndUploadEntertainmentReceipt = defineTool({
    name: "generate_and_upload_entertainment_receipt",
    description:
      "Generate the 'Bewirtungsangaben' page (see generate_entertainment_receipt) and upload it to " +
      "BuchhaltungsButler in one call, instead of round-tripping the full base64 PDF through the model via a " +
      "separate upload_receipt call. Always uploads as type 'invoice inbound'. Returns the new receipt's " +
      "id_by_customer, not the PDF itself. BuchhaltungsButler does not deduplicate by invoice number - if " +
      "this is a re-upload (e.g. a previous send failed), check list_receipts for an existing duplicate " +
      "first and remove it with set_receipt_deleted (see docs/bewirtungsbeleg-faq.md).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: uploadShape,
    async handler(args) {
      if (args.bill_file === undefined && args.link_to_receipt_id_by_customer === undefined) {
        throw new Error(
          "link_to_receipt_id_by_customer is required when no bill_file is given (Fall B) - otherwise the " +
            "standalone Bewirtungsangaben page would be uploaded as its own unlinked receipt."
        );
      }

      const { pdfBytes, amounts, mergedWithBill } = await buildEntertainmentReceiptDocument({
        ...args,
        date: formatGermanDate(args.date),
      });

      const vatRate = deriveVatRate({
        foodNet: args.food_net ?? 0,
        foodVat: args.food_vat ?? 0,
        drinksNet: args.drinks_net ?? 0,
        drinksVat: args.drinks_vat ?? 0,
      });

      const result = await client.call<{ data?: { id_by_customer?: string | number } }>("receiptsUpload", {
        file: Buffer.from(pdfBytes).toString("base64"),
        type: "invoice inbound",
        file_name: `Bewirtungsangaben${args.bill_reference ? `_${args.bill_reference}` : ""}.pdf`,
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

      return ok({
        id_by_customer: result.data?.id_by_customer,
        merged_with_bill: mergedWithBill,
        gross_total: amounts.grossTotal,
        vat_total: amounts.vatTotal,
        deductible: amounts.deductible,
        non_deductible: amounts.nonDeductible,
      });
    },
  });

  return [generateEntertainmentReceipt, generateAndUploadEntertainmentReceipt];
}
