import { z } from "zod";
import {
  assertOccasionIsConcrete,
  computeAmounts,
  mergeWithBillFile,
  renderEntertainmentReceiptCover,
} from "./entertainment-receipt-pdf.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// This tool makes no BuchhaltungsButler API calls - it's a pure generation
// function (structured fields in, PDF bytes out), which is why its factory
// takes no `client` parameter unlike every other tool factory in this
// codebase. VAT amounts are supplied by the caller exactly as printed on the
// real invoice rather than computed here (net x rate) - same reasoning as
// the 70/30-split validation in entertainment-expense.ts: a silently-wrong
// recomputed cent amount is harder to catch than a transcription error.
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
  participants: z.string().min(1).describe("Alle Teilnehmer mit Namen und Firma"),
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
  bill_reference: z.string().optional().describe("Rechnungsnummer der Original-Rechnung, nur zur Anzeige"),
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

export function createEntertainmentReceiptTools(): [ToolDef] {
  const generateEntertainmentReceipt = defineTool({
    name: "generate_entertainment_receipt",
    description:
      "Generate the 'Bewirtungsangaben' page required alongside a restaurant bill for a valid Bewirtungsbeleg " +
      "(§ 4 Abs. 5 Satz 1 Nr. 2 EStG). With bill_file: merges into one PDF (upload directly via upload_receipt). " +
      "Without bill_file: returns a standalone page to upload via upload_receipt's link_to_receipt_id_by_customer " +
      "against an already-existing receipt. Makes no BuchhaltungsButler API calls itself.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: generateShape,
    // Cross-field check kept as a plain thrown Error rather than a zod
    // .refine() on a separately-constructed schema, matching how every other
    // cross-field business rule in this codebase (assertEntertainmentExpenseFields,
    // amountsMatch in payment-confirmation.ts) is enforced in handler code, not
    // via schema re-parsing - inputSchema is a ZodRawShape, so a top-level
    // .refine() isn't available on it anyway. The ?? fallbacks mirror
    // receipts.ts's `limit ?? 20` idiom: zod's .default() only fires when the
    // MCP SDK parses real client input, not when a handler is called directly
    // (as the tests here do), so the manual fallback keeps both paths correct.
    async handler(args) {
      if ((args.bill_file === undefined) !== (args.bill_file_type === undefined)) {
        throw new Error(
          "bill_file and bill_file_type must be provided together - pass both to merge with the original bill " +
            "(Fall A), or neither for a standalone page to link via upload_receipt's link_to_receipt_id_by_customer " +
            "(Fall B)."
        );
      }
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
        },
        amounts,
        { kleinunternehmer, attachmentFollows: Boolean(args.bill_file) }
      );

      const finalPdf =
        args.bill_file && args.bill_file_type
          ? await mergeWithBillFile(cover, args.bill_file, args.bill_file_type)
          : cover;

      return ok({
        pdf_base64: Buffer.from(finalPdf).toString("base64"),
        merged_with_bill: Boolean(args.bill_file),
        gross_total: amounts.grossTotal,
        vat_total: amounts.vatTotal,
        deductible: amounts.deductible,
        non_deductible: amounts.nonDeductible,
      });
    },
  });

  return [generateEntertainmentReceipt];
}
