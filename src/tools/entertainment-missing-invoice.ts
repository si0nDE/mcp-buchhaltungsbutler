// Pure validation and planning for the generator mode "Rechnung fehlt" (no invoice from the restaurant).
// No API calls, no PDF: the result drives the page (entertainment-receipt-pdf.ts) and the upload.
import {
  businessNoInvoiceWarnings,
  collectMissingPolicyFields,
  INTERNAL_NO_INVOICE_WARNING,
  isBusinessAnlass,
  LATE_INVOICE_POINTER,
  resolveEntertainmentContext,
  splitGross,
  type EntertainmentType,
  type InvoiceStatus,
  type MissingInvoiceTreatment,
  type ParticipantRelation,
  type ShareholderManagerTreatment,
} from "./entertainment-policy.js";
import type { MissingInvoicePageData } from "./entertainment-receipt-pdf.js";

export const SMALL_AMOUNT_LIMIT = 250;

export interface MissingInvoiceArgs {
  original_invoice_status: InvoiceStatus;
  entertainment_type?: EntertainmentType;
  missing_invoice_treatment?: MissingInvoiceTreatment;
  shareholder_manager_treatment?: ShareholderManagerTreatment;
  participant_relations?: readonly ParticipantRelation[];
  gross_amount?: number;
  tip?: number;
  food_net?: number;
  food_vat?: number;
  drinks_net?: number;
  drinks_vat?: number;
  payment_evidence?: { transaction_id_by_customer?: number; description?: string };
  invoice_requests?: Array<{ date: string; channel: string }>;
  counterparty?: string;
  source_receipt_id_by_customer?: number;
  acknowledge_practice_over_250?: boolean;
}

export interface MissingInvoicePlan {
  gross: number;
  tip: number;
  business: boolean;
  treatment: MissingInvoiceTreatment | "internal";
  deductible: number;
  nonDeductible: number;
  warnings: string[];
  page: MissingInvoicePageData;
}

// The generator never produces a Bewirtungsbeleg for a sole proprietor eating alone.
export function assertGeneratorType(type: EntertainmentType | undefined): void {
  if (type === "sole_proprietor_self") {
    throw new Error(
      "Für einen Einzelunternehmer, der allein isst (sole_proprietor_self), gibt es keinen Bewirtungsbeleg: auf Geschäftsreisen sind nur " +
        "die Verpflegungsmehraufwendungen abziehbar (14 € bei 8 bis 24 Stunden Abwesenheit und am An-/Abreisetag, 28 € ab 24 Stunden), " +
        "ohne Essensbelege, aber mit Reisedokumentation (Dennerlein Folie 27/28, Q25). Bei geschäftlichem Anlass mit Gästen den Typ business wählen."
    );
  }
}

const money = (value: number) => value.toFixed(2).replace(".", ",");

const STATUS_TEXT: Record<Exclude<InvoiceStatus, "present">, string> = {
  missing_requested: "Originalrechnung nicht vorhanden (beim Gastwirt angefordert, nicht erhalten)",
  lost: "Originalrechnung nicht mehr vorhanden (verloren oder unleserlich)",
};

export function planMissingInvoice(args: MissingInvoiceArgs, opts: { requireCounterparty: boolean }): MissingInvoicePlan {
  assertGeneratorType(args.entertainment_type);
  const status = args.original_invoice_status;
  if (status === "present") {
    throw new Error('planMissingInvoice is only for original_invoice_status "missing_requested" or "lost".');
  }

  const policyFields = {
    entertainment_type: args.entertainment_type,
    missing_invoice_treatment: args.missing_invoice_treatment,
    shareholder_manager_treatment: args.shareholder_manager_treatment,
    participant_relations: args.participant_relations,
  };
  const missing = collectMissingPolicyFields(policyFields, status);
  if (args.gross_amount === undefined) missing.push("gross_amount (Zahlbetrag inkl. Trinkgeld)");
  const evidence = args.payment_evidence;
  if (!evidence || (evidence.transaction_id_by_customer === undefined && !evidence.description?.trim())) {
    missing.push("payment_evidence (transaction_id_by_customer und/oder description)");
  }
  if (status === "missing_requested" && !(args.invoice_requests && args.invoice_requests.length > 0)) {
    missing.push("invoice_requests (mindestens eine Anforderung beim Gastwirt mit Datum und Kanal)");
  }
  if (opts.requireCounterparty && args.source_receipt_id_by_customer === undefined && !args.counterparty?.trim()) {
    missing.push("counterparty (Gaststätte; ohne source_receipt_id_by_customer ist die Seite selbst der Beleg)");
  }

  const invalid: string[] = [];
  if ([args.food_net, args.food_vat, args.drinks_net, args.drinks_vat].some((v) => (v ?? 0) !== 0)) {
    invalid.push("food_*/drinks_* müssen im Modus „Rechnung fehlt“ leer sein: eine erfundene Aufteilung wäre falsch");
  }
  if (args.gross_amount !== undefined && !(Number.isFinite(args.gross_amount) && args.gross_amount > 0)) {
    invalid.push("gross_amount muss eine endliche Zahl größer 0 sein");
  }
  if (args.tip !== undefined && !(Number.isFinite(args.tip) && args.tip >= 0)) {
    invalid.push("tip muss eine endliche Zahl größer oder gleich 0 sein");
  }
  if (args.gross_amount !== undefined && (args.tip ?? 0) > args.gross_amount) {
    invalid.push("tip darf nicht größer sein als gross_amount (gross_amount enthält das Trinkgeld)");
  }
  const business =
    args.entertainment_type === undefined
      ? undefined
      : isBusinessAnlass(args.entertainment_type, args.shareholder_manager_treatment, args.participant_relations);
  const practiceOver250 =
    business === true &&
    args.missing_invoice_treatment === "practice_70_30_no_vat" &&
    args.gross_amount !== undefined &&
    args.gross_amount > SMALL_AMOUNT_LIMIT;
  if (practiceOver250 && args.acknowledge_practice_over_250 !== true) {
    invalid.push(
      `Zahlbetrag über ${SMALL_AMOUNT_LIMIT} €: Dennerlein Q42 betrifft nur Beträge unter ${SMALL_AMOUNT_LIMIT} €. Mit practice_70_30_no_vat ` +
        "nur mit acknowledge_practice_over_250: true (beim Nutzer erfragen, nicht ableiten) oder conservative_100_nondeductible wählen"
    );
  }
  if (missing.length > 0 || invalid.length > 0) {
    throw new Error(
      [
        missing.length > 0 ? `Pflichtangaben fehlen (alle auf einmal beim Nutzer erfragen): ${missing.join(" | ")}` : "",
        invalid.length > 0 ? `Ungültige Angaben: ${invalid.join(" | ")}` : "",
      ]
        .filter(Boolean)
        .join(" || ")
    );
  }

  const gross = args.gross_amount!;
  const tip = args.tip ?? 0;
  const { context, warnings: contextWarnings } = resolveEntertainmentContext({
    ...policyFields,
    original_invoice_status: status,
  });
  const isBusiness = context.business === true;
  const treatment: MissingInvoiceTreatment | "internal" = isBusiness ? args.missing_invoice_treatment! : "internal";
  const split = isBusiness ? splitGross(gross, treatment as MissingInvoiceTreatment) : { deductible: gross, nonDeductible: 0 };

  const businessWarnings = isBusiness ? businessNoInvoiceWarnings(treatment as MissingInvoiceTreatment) : [];
  // contextWarnings already contain the consistency warnings (entertainment_type is mandatory here).
  const warnings = [...contextWarnings, ...(isBusiness ? businessWarnings : [INTERNAL_NO_INVOICE_WARNING])];
  if (practiceOver250) {
    warnings.push(
      `Zahlbetrag ${money(gross)} € liegt über ${SMALL_AMOUNT_LIMIT} €: keine Quelle deckt diesen Fall ab (Dennerlein Q42 nennt nur Beträge unter ${SMALL_AMOUNT_LIMIT} €); ` +
        "auf ausdrücklichen Nutzerentscheid gebucht."
    );
  }

  const noteLines: string[] = [STATUS_TEXT[status]];
  for (const request of args.invoice_requests ?? []) {
    noteLines.push(`Anforderung der Rechnung beim Gastwirt am ${request.date} (${request.channel}).`);
  }
  if (evidence?.transaction_id_by_customer !== undefined) {
    noteLines.push(`Zahlungsnachweis: Banktransaktion ${evidence.transaction_id_by_customer} über ${money(gross)} €.`);
  }
  if (evidence?.description?.trim()) noteLines.push(`Zahlungsnachweis: ${evidence.description.trim()}`);
  noteLines.push("Aufteilung Speisen/Getränke und Umsatzsteuer: nicht bekannt. Kein Vorsteuerabzug (§ 15 Abs. 1 Satz 1 Nr. 1 UStG).");
  // businessWarnings[0] is the "Kein Vorsteuerabzug" sentence, already its own note line above. The pointer into
  // the repo docs stays in the warnings only: a receipt page must not print repository paths.
  noteLines.push(
    ...(isBusiness ? businessWarnings.slice(1).filter((w) => w !== LATE_INVOICE_POINTER) : [INTERNAL_NO_INVOICE_WARNING])
  );
  if (practiceOver250) noteLines.push(warnings[warnings.length - 1]);

  const labels = isBusiness
    ? treatment === "conservative_100_nondeductible"
      ? { deductible: "Abziehbar (Faktor 0,00 v. Zahlbetrag)", nonDeductible: "Nicht abziehbar (Faktor 1,00)" }
      : { deductible: "Abziehbar (Faktor 0,70 v. Zahlbetrag)", nonDeductible: "Nicht abziehbar (Faktor 0,30)" }
    : { deductible: "Betrieblich, voll abziehbar", nonDeductible: "Nicht abziehbar" };

  return {
    gross,
    tip,
    business: isBusiness,
    treatment,
    deductible: split.deductible,
    nonDeductible: split.nonDeductible,
    warnings,
    page: {
      gross,
      tip,
      deductibleLabel: labels.deductible,
      nonDeductibleLabel: labels.nonDeductible,
      subtitle: isBusiness
        ? "Angaben nach § 4 Abs. 5 Satz 1 Nr. 2 EStG – Originalrechnung fehlt"
        : "Nicht geschäftliche Bewirtung (R 4.10 Abs. 7 EStR) – Originalrechnung fehlt",
      noteLines,
    },
  };
}
