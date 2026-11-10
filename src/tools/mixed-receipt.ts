import { PDFDocument, StandardFonts } from "pdf-lib";
import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { receiptDisplayRef } from "../formatting/display-ref.js";
import { readUploadedId, toId, type UploadResponse } from "./entertainment-receipt.js";
import { MAX_ORIGINAL_BYTES, sha256Hex } from "./entertainment-receipt-append.js";
import { buildBookingProposal } from "./mixed-receipt-booking.js";
import { findAuslagenkonto, type Auslagenkonto } from "./mixed-receipt-account.js";
import { computeMixedReceipt, type MixedReceiptAmounts } from "./mixed-receipt-calc.js";
import { renderMixedReceiptPdf } from "./mixed-receipt-pdf.js";
import { renderPreview } from "./mixed-receipt-preview.js";
import { renderPdfPagesToPng } from "./mixed-receipt-render.js";
import { assertUsableBands, findLines, findTallBands, parseLineSpec, readBilevelScan, redactLines, tallLinesWarning, writeScan } from "./mixed-receipt-scan.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, withImages, type ToolDef } from "./types.js";

const MIN_OCCASION_LENGTH = 15;

const QUESTIONS = [
  "Welche Zeilen sind geschäftlich? Zeilennummern aus dem Bild; alle übrigen Artikelzeilen werden geschwärzt (Kopf, Summe, MwSt-Zeilen, Zahlungs- und TSE-Daten bleiben sichtbar).",
  "Wie sind Pfand, Pfandrückgabe und Rabatte zuzuordnen (gehören sie zu geschäftlichen Artikeln)?",
  "Wie lautet die Bonnummer so, wie BuchhaltungsButler sie führt? Bei Discountern die Zeile mit Filial-/Kassenkennung, nicht die Beleg-Nr. der Kartenzahlung.",
  "Wer hat ausgelegt (Name), und wofür ist der Einkauf (konkreter Anlass)?",
  "Bonsumme und MwSt-Zeilen (Netto und Steuer je Steuersatz) vom Bon ablesen und vom Nutzer bestätigen lassen.",
  "Hat die auslegende Person den Beleg bestätigt? Nur dann confirmation angeben, sonst steht 'Bestätigung ausstehend' auf dem Beleg.",
];

const vatRate = z.union([z.literal(0), z.literal(7), z.literal(19)]);
const sourceId = z.number().int().describe("id_by_customer of the original receipt in BuchhaltungsButler (list_receipts).");

const generateShape = {
  source_receipt_id_by_customer: sourceId,
  redact_lines: z
    .array(z.union([z.number().int(), z.string()]))
    .min(1)
    .describe("Line numbers from prepare_mixed_receipt's image to black out, single numbers or ranges like \"5-16\". Every private article line, given explicitly."),
  positions: z
    .array(
      z.object({
        description: z.string().min(1),
        quantity_text: z.string().optional().describe("e.g. \"2 × 0,85 €\""),
        gross: z.number().describe("Gross euro amount; negative for Pfandrückgabe or Rabatt."),
        vat_rate: vatRate,
      })
    )
    .min(1)
    .max(10)
    .describe("Business positions only, as confirmed by the user. Pfand and Rabatt of business articles as their own positions."),
  receipt_total: z.number().describe("Total of the whole receipt (business and private), gross."),
  receipt_vat_lines: z
    .array(z.object({ vat_rate: vatRate, net: z.number(), vat: z.number() }))
    .min(1)
    .describe("The receipt's VAT summary lines (net and tax per rate) as printed."),
  merchant: z.object({ name: z.string().min(1), address: z.string().min(1) }),
  receipt_number: z.string().min(1).describe("Receipt number as BuchhaltungsButler keeps it (for discounters the line with store/register id, not the card payment's Beleg-Nr.)."),
  receipt_datetime: z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/).describe("YYYY-MM-DD or YYYY-MM-DD HH:MM as printed on the receipt."),
  payment_method: z.string().optional(),
  paid_by: z.string().min(1).describe("Person who paid privately and gets reimbursed."),
  occasion: z.string().describe("Concrete business purpose, at least 15 characters (e.g. 'Milch für Kaffee bei Kundenbesprechungen im Büro')."),
  company_name: z.string().min(1),
  company_address: z.string().min(1),
  confirmation: z
    .object({ name: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .optional()
    .describe("Only if the paying person explicitly confirmed the receipt; otherwise omit."),
  auslagenkonto: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Posting account number of the paying person's Auslagenkonto. Skips the automatic detection; the upload assigns the receipt to this account."),
  without_auslagenkonto: z
    .boolean()
    .optional()
    .describe("true = upload without an account (opt out of the automatically detected Auslagenkonto). Not together with auslagenkonto."),
};

type GenerateArgs = z.infer<z.ZodObject<typeof generateShape>>;

const AMOUNT_TOLERANCE = 0.01;

const isDeleted = (row: Record<string, unknown>) => row.deleted === "1" || row.deleted === 1 || row.deleted === true;
const germanDate = (iso: string) => iso.split("-").reverse().join(".");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface LoadedOriginal {
  row: Record<string, unknown>;
  bytes: Uint8Array;
  sha256: string;
  displayRef: string;
}

async function loadOriginal(client: BBClient, id: number): Promise<LoadedOriginal> {
  let row: Record<string, unknown> | undefined;
  try {
    const result = await client.call<{ data?: Record<string, unknown> }>("receiptsGetIdByCustomer", { get_file: true }, { idSuffix: id });
    row = result.data;
  } catch (error) {
    throw new Error(`Original-Beleg ${id} konnte nicht geladen werden (${message(error)}). id_by_customer per list_receipts prüfen. Es wurde nichts erzeugt.`);
  }
  if (!row) throw new Error(`Original-Beleg ${id} nicht gefunden. id_by_customer per list_receipts prüfen. Es wurde nichts erzeugt.`);
  const { file_content: file, ...meta } = row;
  const displayRef = receiptDisplayRef(meta);
  if (isDeleted(meta)) {
    throw new Error(`${displayRef} ist in BuchhaltungsButler gelöscht. Den richtigen Beleg wählen oder ihn erst wiederherstellen (set_receipt_deleted, deleted: false). Es wurde nichts erzeugt.`);
  }
  if (typeof file !== "string" || file === "") throw new Error(`${displayRef} hat keine Datei. Es wurde nichts erzeugt.`);
  if ((file.length * 3) / 4 > MAX_ORIGINAL_BYTES) throw new Error(`${displayRef} ist größer als 15 MB. Es wurde nichts erzeugt.`);
  const bytes = new Uint8Array(Buffer.from(file, "base64"));
  return { row: meta, bytes, sha256: sha256Hex(bytes), displayRef };
}

async function scanWithLines(original: LoadedOriginal) {
  const scan = await readBilevelScan(original.bytes);
  const bands = findLines(scan);
  assertUsableBands(bands);
  return { scan, bands, tall: findTallBands(bands) };
}

function amountsView(a: MixedReceiptAmounts) {
  return {
    rates: a.rates,
    reimbursement: a.reimbursement,
    net_total: a.netTotal,
    input_vat_total: a.inputVatTotal,
    receipt_total: a.receiptTotal,
    private_gross: a.privateGross,
  };
}

function bookingHint(a: MixedReceiptAmounts, paidBy: string) {
  return {
    auslagenkonto: `Neuen Beleg dem Auslagenkonto von ${paidBy} zuweisen ('Beleg erzeugt Zahlung'); ohne Auslagenkonto get_booking_guide auslagen.`,
    splits: a.rates.map((r) => ({
      vat_rate: r.vat_rate,
      gross: r.gross,
      vat_code: r.vat_rate === 0 ? "0_none" : `${r.vat_rate}_pre`,
      konto_vorschlag: "4653/6643 Aufmerksamkeiten (Kaffee, Milch, Getränke im Büro) oder 4980/6850 Sonstiger Betriebsbedarf; das Konto legt der Steuerberater fest.",
    })),
    inhaber: "Hat der Inhaber eines Einzelunternehmens selbst ausgelegt, ist das keine Erstattung, sondern eine Privateinlage (get_booking_guide auslagen).",
    original: "Das Original nie buchen. Nach dem Upload löscht das Tool es (soft), sobald der neue Beleg in BuchhaltungsButler bestätigt ist; es bleibt dort archiviert und wiederherstellbar.",
  };
}

interface AuslagenkontoInfo {
  number: number | null;
  name: string | null;
  source: "auto" | "given" | "none";
  effect: string;
}

const ASSIGN_EFFECT = "Beim Upload wird der Beleg diesem Konto zugewiesen; BuchhaltungsButler legt dann eine Zahlung an, wenn das Konto 'Beleg erzeugt Zahlung' nutzt.";

// Explicit number > opt-out > detection by the paying person's name. A failing detection counts as "none" with a warning.
async function resolveAuslagenkonto(client: BBClient, args: GenerateArgs): Promise<{ info: AuslagenkontoInfo; warnings: string[] }> {
  if (args.auslagenkonto !== undefined && args.without_auslagenkonto === true) {
    throw new Error("auslagenkonto und without_auslagenkonto schließen sich aus: entweder ein Konto angeben oder ohne Konto hochladen. Es wurde nichts erzeugt.");
  }
  if (args.auslagenkonto !== undefined) return { info: { number: args.auslagenkonto, name: null, source: "given", effect: ASSIGN_EFFECT }, warnings: [] };
  if (args.without_auslagenkonto === true) {
    return { info: { number: null, name: null, source: "none", effect: "Abgewählt (without_auslagenkonto): Der Beleg wird ohne Konto hochgeladen, BuchhaltungsButler legt keine Zahlung an." }, warnings: [] };
  }
  try {
    const { found, candidates } = await findAuslagenkonto(client, args.paid_by);
    if (found) return { info: { number: found.number, name: found.name, source: "auto", effect: ASSIGN_EFFECT }, warnings: [] };
    const effect =
      candidates.length > 0
        ? `Es gibt mehrere passende Konten (${candidates.join("; ")}): Der Beleg wird ohne Konto hochgeladen. Mit auslagenkonto das richtige angeben.`
        : `Kein Konto mit dem Namen "${args.paid_by}" und "Gesellschafter" oder "Auslage" gefunden: Der Beleg wird ohne Konto hochgeladen, BuchhaltungsButler legt keine Zahlung an.`;
    return { info: { number: null, name: null, source: "none", effect }, warnings: [] };
  } catch (error) {
    return {
      info: { number: null, name: null, source: "none", effect: "Die Konten konnten nicht gelesen werden: Der Beleg wird ohne Konto hochgeladen." },
      warnings: [`Auslagenkonto nicht ermittelt (${message(error)}): Beleg ohne Konto. Mit auslagenkonto lässt sich eines angeben.`],
    };
  }
}

// Free text goes onto the PDF and into one-line fields: line breaks become ", ".
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ", ").trim();
}

// Standard Helvetica only encodes WinAnsi; check before anything is loaded or generated.
async function sanitiseFreeText(args: GenerateArgs): Promise<GenerateArgs> {
  const out: GenerateArgs = {
    ...args,
    merchant: { name: oneLine(args.merchant.name), address: oneLine(args.merchant.address) },
    receipt_number: oneLine(args.receipt_number),
    payment_method: args.payment_method === undefined ? undefined : oneLine(args.payment_method),
    paid_by: oneLine(args.paid_by),
    occasion: oneLine(args.occasion),
    company_name: oneLine(args.company_name),
    company_address: oneLine(args.company_address),
    positions: args.positions.map((p) => ({ ...p, description: oneLine(p.description), quantity_text: p.quantity_text === undefined ? undefined : oneLine(p.quantity_text) })),
    confirmation: args.confirmation ? { ...args.confirmation, name: oneLine(args.confirmation.name) } : undefined,
  };
  const fields: Array<[string, string | undefined]> = [
    ["merchant.name", out.merchant.name],
    ["merchant.address", out.merchant.address],
    ["receipt_number", out.receipt_number],
    ["payment_method", out.payment_method],
    ["paid_by", out.paid_by],
    ["occasion", out.occasion],
    ["company_name", out.company_name],
    ["company_address", out.company_address],
    ["confirmation.name", out.confirmation?.name],
    ...out.positions.flatMap((p, i): Array<[string, string | undefined]> => [
      [`positions[${i}].description`, p.description],
      [`positions[${i}].quantity_text`, p.quantity_text],
    ]),
  ];
  const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  for (const [field, text] of fields) {
    if (text === undefined) continue;
    for (const ch of text) {
      try {
        font.encodeText(ch);
      } catch {
        throw new Error(`${field} enthält das Zeichen "${ch}", das der Beleg nicht darstellen kann. Bitte umschreiben (z. B. "L"). Es wurde nichts erzeugt.`);
      }
    }
  }
  return out;
}

// True when BuchhaltungsButler lists an active receipt with this number that is not the original and carries the reimbursement
// (and the id the upload returned, if it returned one). Any failure counts as "not verified": then nothing is deleted.
async function verifyNewReceipt(
  client: BBClient,
  receiptNumber: string,
  sourceId: number,
  newId: string | number | undefined,
  reimbursement: number
): Promise<{ ok: boolean; id?: string | number }> {
  try {
    const list = await client.call<{ data?: Array<Record<string, unknown>> }>("receiptsGet", {
      list_direction: "inbound",
      invoicenumber: receiptNumber,
      limit: 500,
      offset: 0,
    });
    const row = (list.data ?? []).find((r) => {
      const id = toId(r.id_by_customer);
      if (id === sourceId || isDeleted(r)) return false;
      if (newId !== undefined && id !== newId) return false;
      return Math.abs(Number(r.amount) - reimbursement) <= AMOUNT_TOLERANCE + 1e-9;
    });
    return row ? { ok: true, id: toId(row.id_by_customer) } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function buildMixedReceipt(client: BBClient, rawArgs: GenerateArgs) {
  if (rawArgs.auslagenkonto !== undefined && rawArgs.without_auslagenkonto === true) {
    throw new Error("auslagenkonto und without_auslagenkonto schließen sich aus: entweder ein Konto angeben oder ohne Konto hochladen. Es wurde nichts erzeugt.");
  }
  const args = await sanitiseFreeText(rawArgs);
  if (args.occasion.trim().length < MIN_OCCASION_LENGTH) {
    throw new Error(`Anlass "${args.occasion}" ist zu knapp (mindestens ${MIN_OCCASION_LENGTH} Zeichen): konkret sagen, wofür der Einkauf ist. Es wurde nichts erzeugt.`);
  }
  const amounts = computeMixedReceipt(args.positions, args.receipt_total, args.receipt_vat_lines);
  const original = await loadOriginal(client, args.source_receipt_id_by_customer);
  const { scan, bands, tall } = await scanWithLines(original);
  const lines = parseLineSpec(args.redact_lines, bands.length);
  const { bits, blocks } = redactLines(scan, bands, lines);
  const redactedScan = await writeScan(scan, bits);
  const [date, time] = args.receipt_datetime.split(" ");
  const { pdf, bonOnSecondPage } = await renderMixedReceiptPdf(
    {
      companyName: args.company_name,
      companyAddress: args.company_address,
      merchantName: args.merchant.name,
      merchantAddress: args.merchant.address,
      receiptNumber: args.receipt_number,
      receiptDate: germanDate(date),
      receiptTime: time,
      receiptTotal: args.receipt_total,
      paymentMethod: args.payment_method,
      paidBy: args.paid_by,
      occasion: args.occasion,
      positions: args.positions,
      amounts,
      originalDisplayRef: original.displayRef,
      originalSha256: original.sha256,
      confirmation: args.confirmation ? { name: args.confirmation.name, date: germanDate(args.confirmation.date) } : undefined,
    },
    redactedScan
  );
  const pages = await renderPdfPagesToPng(pdf);
  const bonParts = renderPreview(scan, bits, bands, { numbers: true });
  const warnings = [...amounts.warnings];
  const konto = await resolveAuslagenkonto(client, args);
  warnings.push(...konto.warnings);
  if (tall.length > 0) warnings.push(tallLinesWarning(tall));
  if (!args.confirmation) warnings.push("Keine Bestätigung angegeben: Auf dem Beleg steht 'Bestätigung ausstehend'.");
  const bhbNumber = typeof original.row.invoicenumber === "string" ? original.row.invoicenumber.trim() : "";
  if (bhbNumber && bhbNumber !== args.receipt_number.trim()) {
    warnings.push(`Bonnummer '${args.receipt_number}' weicht von der Rechnungsnummer des Originals in BHB ab ('${bhbNumber}'). Nutzer fragen, welche gilt.`);
  }
  return {
    original,
    amounts,
    auslagenkonto: konto.info,
    args,
    pdf,
    date,
    warnings,
    blocks: blocks.map((b) => (b.from === b.to ? `${b.from}` : `${b.from}-${b.to}`)),
    images: [
      ...pages.map((png, i) => ({ png, info: { kind: "page", page: i + 1 } })),
      ...bonParts.map((p) => ({ png: p.png, info: { kind: "bon", from_line: p.fromLine, to_line: p.toLine } })),
    ],
    bonOnSecondPage,
  };
}

function fileSlug(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Haendler";
}

export function createMixedReceiptTools(client: BBClient): ToolDef[] {
  const prepare = defineTool({
    name: "prepare_mixed_receipt",
    description:
      "Step 1 for a receipt that mixes private and business items and was paid privately (Auslage): loads the original scan from " +
      "BuchhaltungsButler, finds its text lines and returns the receipt as images with line numbers in the left margin, plus the " +
      "questions to clarify with the user BEFORE generating (business lines, Pfand/Rabatt, receipt number as kept in BHB, who paid, " +
      "occasion, VAT lines, confirmation). Ask them, never assume. v1 supports one-page black-and-white scans (PDF with one 1-bit " +
      "image, no text layer); anything else is refused with the reason and the manual way. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: { source_receipt_id_by_customer: sourceId },
    async handler(args) {
      const original = await loadOriginal(client, args.source_receipt_id_by_customer);
      const { scan, bands, tall } = await scanWithLines(original);
      const parts = renderPreview(scan, scan.bits, bands, { numbers: true });
      const r = original.row;
      return withImages(
        ok({
          original: {
            display_ref: original.displayRef,
            id_by_customer: toId(r.id_by_customer) ?? args.source_receipt_id_by_customer,
            invoicenumber: r.invoicenumber ?? null,
            date: r.date ?? null,
            amount: r.amount ?? null,
            counterparty: r.counterparty ?? null,
          },
          original_sha256: original.sha256,
          line_count: bands.length,
          tall_lines: tall.map((b) => b.nr),
          ...(tall.length > 0 ? { warnings: [tallLinesWarning(tall)] } : {}),
          images: parts.map((p) => ({ kind: "bon", from_line: p.fromLine, to_line: p.toLine })),
          questions: QUESTIONS,
          next_step: "Fragen mit dem Nutzer klären, dann generate_mixed_receipt (Vorschau). Nichts annehmen.",
        }),
        parts.map((p) => p.png)
      );
    },
  });

  const generate = defineTool({
    name: "generate_mixed_receipt",
    description:
      "Step 2: builds the A4 Auslagenbeleg (redacted receipt left; business positions, net/tax per rate per § 35 UStDV, reimbursement, " +
      "who paid, occasion, hint on the unchanged original in BHB, SHA-256 of the original) and returns the rendered page(s) and the " +
      "redacted receipt as images. Uploads nothing. Show the preview to the user; only after their approval call " +
      "generate_and_upload_mixed_receipt with the same arguments and confirm: true. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: generateShape,
    async handler(args) {
      const built = await buildMixedReceipt(client, args);
      return withImages(
        ok({
          status: "preview",
          original: { display_ref: built.original.displayRef, id_by_customer: args.source_receipt_id_by_customer },
          original_sha256: built.original.sha256,
          redacted_blocks: built.blocks,
          bon_on_second_page: built.bonOnSecondPage,
          amounts: amountsView(built.amounts),
          booking_hint: bookingHint(built.amounts, args.paid_by),
          auslagenkonto: built.auslagenkonto,
          images: built.images.map((i) => i.info),
          warnings: built.warnings,
          next_step:
            "Vorschau dem Nutzer zeigen. Erst nach seiner Freigabe generate_and_upload_mixed_receipt mit denselben Argumenten und confirm: true.",
        }),
        built.images.map((i) => i.png)
      );
    },
  });

  const generateAndUpload = defineTool({
    name: "generate_and_upload_mixed_receipt",
    description:
      "Step 3, only after the user approved generate_mixed_receipt's preview: builds the same Auslagenbeleg, checks for another active " +
      "receipt with the same receipt number, uploads it with explicit counterparty/date/amount (the reimbursement)/invoice_number and adds " +
      "a comment to the original. Then it checks that the new receipt is in BuchhaltungsButler (active, same receipt number, amount = " +
      "reimbursement) and only then soft-deletes the original (receiptsDeleteIdByCustomer; it stays archived and can be restored). " +
      "If the new receipt cannot be confirmed or the deletion fails, the original stays and next_steps says what to do. Requires " +
      "confirm: true; the delete follows that approved upload without another question. The upload assigns the receipt to the paying person's " +
      "Auslagenkonto (detected by name, or auslagenkonto; opt out with without_auslagenkonto), so BuchhaltungsButler can create the payment. " +
      "Finally it returns booking_proposal: a read-only proposal how to book the receipt (Bilanz) or the payment (EÜR, house rule gewinnermittlung), " +
      "including the case that no payment exists at all; it books, assigns and creates nothing.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      ...generateShape,
      confirm: z.boolean().describe("Must be true: the user approved the preview of generate_mixed_receipt."),
    },
    async handler(args) {
      if (args.confirm !== true) {
        throw new Error(
          "confirm ist nicht true: Erst generate_mixed_receipt aufrufen, die Vorschau dem Nutzer zeigen und nach seiner Freigabe mit confirm: true hochladen. Es wurde nichts hochgeladen."
        );
      }
      const built = await buildMixedReceipt(client, args);
      const list = await client.call<{ data?: Array<Record<string, unknown>> }>("receiptsGet", {
        list_direction: "inbound",
        invoicenumber: args.receipt_number,
        limit: 500,
        offset: 0,
      });
      const duplicates = (list.data ?? []).filter((row) => toId(row.id_by_customer) !== args.source_receipt_id_by_customer && !isDeleted(row));
      if (duplicates.length > 0) {
        throw new Error(
          `Es gibt schon einen aktiven Beleg mit der Bonnummer ${args.receipt_number}: ${duplicates.map((d) => receiptDisplayRef(d)).join("; ")}. ` +
            "Doppelt hochladen kostet Kontingent und führt zu doppelter Vorsteuer. Es wurde nichts hochgeladen."
        );
      }
      const uploadParams: Record<string, unknown> = {
        file: Buffer.from(built.pdf).toString("base64"),
        type: "invoice inbound",
        file_name: `Auslagenbeleg_${built.date}_${fileSlug(args.merchant.name)}.pdf`,
        counterparty: args.merchant.name,
        invoice_number: args.receipt_number,
        date: built.date,
        amount: built.amounts.reimbursement,
        currency: "EUR",
      };
      if (built.auslagenkonto.number !== null) uploadParams.account = built.auslagenkonto.number;
      if (built.amounts.rates.length === 1) uploadParams.vat_rate = built.amounts.rates[0].vat_rate;
      let newId: string | number | undefined;
      try {
        newId = toId(readUploadedId(await client.call<UploadResponse>("receiptsUpload", uploadParams)));
      } catch (error) {
        throw new Error(
          `Upload fehlgeschlagen (${message(error)}). Nicht automatisch wiederholt (Duplikatgefahr: der Beleg kann trotzdem angelegt worden sein). ` +
            `Vor einem neuen Versuch per list_receipts (Bonnummer ${args.receipt_number}) prüfen. Das Original ist unverändert.`
        );
      }
      const newRef = receiptDisplayRef({ invoicenumber: args.receipt_number, counterparty: args.merchant.name, date: built.date, amount: built.amounts.reimbursement });
      let commentAdded = false;
      let commentError: string | undefined;
      try {
        await client.call("commentsAdd", {
          comment_text: `Original zur geschwärzten Fassung ${newRef} (Auslagenbeleg), nicht ungültig. Nicht buchen.`,
          receipt_id_by_customer: args.source_receipt_id_by_customer,
        });
        commentAdded = true;
      } catch (error) {
        commentError = message(error);
      }
      // The original is soft-deleted only after the new receipt is confirmed in BuchhaltungsButler (nothing is deleted physically).
      const check = await verifyNewReceipt(client, args.receipt_number, args.source_receipt_id_by_customer, newId, built.amounts.reimbursement);
      const verified = check.ok;
      let originalDeleted = false;
      let deleteError: string | undefined;
      if (verified) {
        try {
          await client.call("receiptsDeleteIdByCustomer", {}, { idSuffix: args.source_receipt_id_by_customer });
          originalDeleted = true;
        } catch (error) {
          deleteError = message(error);
        }
      }
      const deleteSteps = originalDeleted
        ? ["Das Original ist soft-gelöscht und bleibt in BuchhaltungsButler archiviert (wiederherstellbar mit set_receipt_deleted, deleted: false)."]
        : verified
          ? [
              `Das Original konnte nicht gelöscht werden (${deleteError}). Ist es schon gebucht oder einer Zahlung zugeordnet, erst die Buchung aufheben (get_booking_guide festgeschriebene_loeschen), dann set_receipt_deleted. Bis dahin das Original nicht buchen.`,
            ]
          : [
              "Der neue Beleg war in BuchhaltungsButler nicht eindeutig zu finden, deshalb bleibt das Original aktiv: mit list_receipts (Bonnummer) prüfen und dann set_receipt_deleted auf das Original. Bis dahin das Original nicht buchen.",
            ];
      // Read-only proposal after the delete step; never throws (failure = status "unavailable").
      const auslagenkonto: Auslagenkonto | null =
        built.auslagenkonto.number === null ? null : { number: built.auslagenkonto.number, name: built.auslagenkonto.name ?? `Konto ${built.auslagenkonto.number}` };
      const bookingProposal = await buildBookingProposal(client, {
        newId: newId ?? check.id,
        amounts: built.amounts,
        positions: built.args.positions,
        merchant: built.args.merchant.name,
        paidBy: built.args.paid_by,
        receiptDate: built.date,
        auslagenkonto,
        accountPassedOnUpload: auslagenkonto !== null,
      });
      return ok({
        status: "uploaded",
        new_receipt_id_by_customer: newId ?? null,
        new_receipt_display_ref: newRef,
        new_receipt_verified: verified,
        original_receipt_id_by_customer: args.source_receipt_id_by_customer,
        original_display_ref: built.original.displayRef,
        original_deleted: originalDeleted,
        ...(deleteError ? { original_delete_error: deleteError } : {}),
        comment_added: commentAdded,
        ...(commentError ? { comment_error: commentError } : {}),
        amounts: amountsView(built.amounts),
        booking_hint: bookingHint(built.amounts, args.paid_by),
        auslagenkonto: built.auslagenkonto,
        booking_proposal: bookingProposal,
        warnings: built.warnings,
        next_steps: [
          ...deleteSteps,
          "Buchung des neuen Belegs bzw. der Zahlung: booking_proposal (nur ein Vorschlag, das Tool bucht nichts).",
          ...(commentAdded ? [] : [`Kommentar am Original fehlt: mit add_comment nachtragen ("Original zur geschwärzten Fassung ${newRef}").`]),
        ],
      });
    },
  });

  return [prepare, generate, generateAndUpload];
}
