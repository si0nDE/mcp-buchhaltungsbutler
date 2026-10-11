// Pure Bewirtung policy: enums, decision logic and warning texts. No API calls,
// no imports from the other entertainment files (so every one of them may use it).
// Sources and open points: docs/bewirtungsbeleg-faq.md.

export const DEDUCTIBLE_SHARE = 0.7;

export const ENTERTAINMENT_TYPES = [
  "business",
  "business_mixed",
  "internal_employees",
  "internal_shareholder_managers",
  "attention",
  "sole_proprietor_self",
] as const;
export type EntertainmentType = (typeof ENTERTAINMENT_TYPES)[number];

export const INVOICE_STATUSES = ["present", "missing_requested", "lost"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const MISSING_INVOICE_TREATMENTS = ["practice_70_30_no_vat", "conservative_100_nondeductible"] as const;
export type MissingInvoiceTreatment = (typeof MISSING_INVOICE_TREATMENTS)[number];

export const SHAREHOLDER_MANAGER_TREATMENTS = ["as_employees", "business_70_30"] as const;
export type ShareholderManagerTreatment = (typeof SHAREHOLDER_MANAGER_TREATMENTS)[number];

export const PARTICIPANT_RELATIONS = ["external", "employee", "shareholder_manager", "shareholder", "freelancer"] as const;
export type ParticipantRelation = (typeof PARTICIPANT_RELATIONS)[number];

const round2 = (value: number) => Math.round(value * 100) / 100;

// One source for the rounding: the page and the booking guard both use this.
// The deductible share is 70 % rounded to the cent, the rest is the non-deductible share.
export function splitGross(
  gross: number,
  treatment: MissingInvoiceTreatment | "standard" = "standard"
): { deductible: number; nonDeductible: number } {
  const total = round2(gross);
  if (treatment === "conservative_100_nondeductible") return { deductible: 0, nonDeductible: total };
  const deductible = round2(total * DEDUCTIBLE_SHARE);
  return { deductible, nonDeductible: round2(total - deductible) };
}

// Shareholders (not employed, Q6) and freelancers (Folie 21) count like external third parties.
const EXTERNAL_LIKE: ReadonlySet<ParticipantRelation> = new Set<ParticipantRelation>(["external", "shareholder", "freelancer"]);
export const isExternalLike = (relation: ParticipantRelation) => EXTERNAL_LIKE.has(relation);

export function allShareholderManagers(relations?: readonly ParticipantRelation[]): boolean {
  return relations === undefined || (relations.length > 0 && relations.every((r) => r === "shareholder_manager"));
}

// Whether the entertainment falls under § 4 Abs. 5 Satz 1 Nr. 2 EStG ("aus geschäftlichem Anlass").
export function isBusinessAnlass(
  type: EntertainmentType,
  shareholderTreatment?: ShareholderManagerTreatment,
  relations?: readonly ParticipantRelation[]
): boolean {
  switch (type) {
    case "business":
    case "business_mixed":
      return true;
    case "internal_shareholder_managers":
      if (relations !== undefined && !allShareholderManagers(relations)) return relations.some(isExternalLike);
      return shareholderTreatment === "business_70_30";
    default:
      return false;
  }
}

export const ASK_USER = "MUSS aktiv beim Nutzer erfragt werden – nicht aus Kontext ableiten.";

export const MISSING_INVOICE_TREATMENT_HELP =
  `missing_invoice_treatment ${ASK_USER} Optionen: ` +
  "practice_70_30_no_vat = 70/30 des Zahlbetrags ohne Vorsteuer (Dennerlein Q42, bezogen auf Beträge unter 250 €; " +
  "Anerkennung durch das Finanzamt offen, BFH X R 57/09 spricht dagegen); " +
  "conservative_100_nondeductible = 100 % nicht abziehbar auf 4654/6644 ohne Vorsteuer (folgt BFH X R 57/09).";

export const SHAREHOLDER_MANAGER_TREATMENT_HELP =
  `shareholder_manager_treatment ${ASK_USER} Optionen: ` +
  "as_employees = wie Bewirtung eigener Arbeitnehmer, unbegrenzt abziehbar (Dennerlein Q48; R 4.10 Abs. 7 EStR spricht dafür); " +
  "business_70_30 = wie geschäftliche Bewirtung 70/30 (Dennerlein Q55; die vorsichtigere Variante mit weniger Abzug). " +
  "Bei beiden besteht vGA-Risiko, wenn die Bewirtung unangemessen ist (§ 8 Abs. 3 Satz 2 KStG).";

export interface PolicyFields {
  host_confirmed?: boolean;
  bewirtungsangaben_signed?: boolean;
  original_invoice_status?: InvoiceStatus;
  entertainment_type?: EntertainmentType;
  missing_invoice_treatment?: MissingInvoiceTreatment;
  shareholder_manager_treatment?: ShareholderManagerTreatment;
  participant_relations?: readonly ParticipantRelation[];
}

export interface EntertainmentContext {
  invoiceStatus: InvoiceStatus;
  signed: boolean | undefined;
  type?: EntertainmentType;
  // undefined = type unknown (legacy call): the booking guard then behaves as before.
  business: boolean | undefined;
  missingTreatment?: MissingInvoiceTreatment;
  shareholderTreatment?: ShareholderManagerTreatment;
  relations?: readonly ParticipantRelation[];
  viaAlias: boolean;
}

// All fields that are still missing, in ONE list, so the caller needs a single round of questions.
export function collectMissingPolicyFields(f: PolicyFields, invoiceStatus: InvoiceStatus): string[] {
  const missing: string[] = [];
  const type = f.entertainment_type;
  const noInvoice = invoiceStatus !== "present";
  if (noInvoice && type === undefined) missing.push(`entertainment_type (${ENTERTAINMENT_TYPES.join(" | ")})`);
  const askShareholder =
    type === "internal_shareholder_managers" && allShareholderManagers(f.participant_relations) && f.shareholder_manager_treatment === undefined;
  if (askShareholder) missing.push(SHAREHOLDER_MANAGER_TREATMENT_HELP);
  if (noInvoice && type !== undefined && f.missing_invoice_treatment === undefined) {
    // Unknown shareholder treatment: ask for both now, so a later "business_70_30" does not trigger a second round.
    const business = askShareholder || isBusinessAnlass(type, f.shareholder_manager_treatment, f.participant_relations);
    if (business) missing.push(MISSING_INVOICE_TREATMENT_HELP);
  }
  return missing;
}

export function consistencyWarnings(
  type: EntertainmentType | undefined,
  relations?: readonly ParticipantRelation[],
  shareholderTreatment?: ShareholderManagerTreatment
): string[] {
  const warnings: string[] = [];
  const hasExternal = relations?.some(isExternalLike) ?? false;
  if (type === "business" && relations !== undefined && relations.length > 0 && !hasExternal) {
    warnings.push(
      "entertainment_type business, aber kein Teilnehmer mit relation external/shareholder/freelancer: ein geschäftlicher Anlass setzt " +
        "Betriebsfremde voraus (Dennerlein Folie 6; für Gesellschafter-GF unter sich Q48/Q55, R 4.10 Abs. 7 EStR)."
    );
  }
  if (type === "internal_shareholder_managers" && hasExternal) {
    warnings.push(
      "entertainment_type internal_shareholder_managers, aber ein externer Teilnehmer ist dabei: gemischte Gruppe, Gesamtbetrag 70/30 " +
        "(R 4.10 Abs. 6 Satz 7 EStR; Dennerlein Q16/Q45). shareholder_manager_treatment wird ignoriert."
    );
  } else if (shareholderTreatment !== undefined && !(type === "internal_shareholder_managers" && allShareholderManagers(relations))) {
    warnings.push(
      "shareholder_manager_treatment wird ignoriert: es gilt nur, wenn alle Bewirteten relation shareholder_manager haben " +
        "(entertainment_type internal_shareholder_managers)."
    );
  }
  return warnings;
}

export function typeFromParticipants(relations: readonly ParticipantRelation[]): EntertainmentType | undefined {
  if (relations.length === 0) return undefined;
  if (relations.every(isExternalLike)) return "business";
  if (relations.some(isExternalLike)) return "business_mixed";
  if (relations.every((r) => r === "shareholder_manager")) return "internal_shareholder_managers";
  return "internal_employees";
}

export const GF_REMUNERATION_NOTE =
  "Bei Geschäftsführerverträgen mit Vergütungs- oder Sachbezugsverzicht ist der Lohnansatz gesondert zu prüfen.";

// SKR03 only. No SKR04 numbers that are not documented.
export function accountAdvice(type: EntertainmentType, shareholderTreatment?: ShareholderManagerTreatment): string | undefined {
  const internal =
    "Nicht geschäftliche Bewirtung: SKR03 4140 (freiwillige soziale Aufwendungen), 100 % abziehbar (Dennerlein Q14/Q54). " +
    "Lohnsteuer prüfen: 50-€-Freigrenze, 60-€-Grenze für Arbeitsessen, Auswärtstätigkeit (Dennerlein Folie 24); Arbeitgeberfeste: BFH VI R 18/24.";
  switch (type) {
    case "internal_employees":
      return internal;
    case "internal_shareholder_managers":
      return shareholderTreatment === "as_employees" ? `${internal} ${GF_REMUNERATION_NOTE}` : undefined;
    case "attention":
      return (
        "Aufmerksamkeit: SKR03 4653 bzw. 4140 netto (Dennerlein Q47); nach R 4.10 Abs. 5 Satz 9 EStR keine Bewirtung, " +
        "unbegrenzt abziehbar. Bei Arbeitnehmern gilt die 60-€-Grenze je Anlass und Person."
      );
    default:
      return undefined;
  }
}

const NO_VAT_WITHOUT_INVOICE = "Kein Vorsteuerabzug ohne Rechnung (§ 15 Abs. 1 Satz 1 Nr. 1 UStG).";

export const INTERNAL_NO_INVOICE_WARNING =
  `${NO_VAT_WITHOUT_INVOICE} Betriebsausgabe grundsätzlich mit allgemeinem Nachweis (Eigenbeleg, Zahlungsnachweis, GoBD) möglich; ` +
  "keine Quelle regelt den Fall ausdrücklich. Nach R 4.10 Abs. 5 Satz 9 (Aufmerksamkeiten) bzw. Abs. 7 Satz 1 EStR (Bewirtung eigener " +
  "Arbeitnehmer) liegt keine Bewirtung aus geschäftlichem Anlass vor; die Rechnungspflicht des § 4 Abs. 5 Satz 1 Nr. 2 EStG greift daher nicht. " +
  "Lohnsteuer prüfen.";

export function businessNoInvoiceWarnings(treatment: MissingInvoiceTreatment): string[] {
  if (treatment === "practice_70_30_no_vat") {
    return [
      NO_VAT_WITHOUT_INVOICE,
      "Der Betriebsausgabenabzug kann vollständig versagt werden: BFH X R 57/09 verlangt die Gaststättenrechnung ohne Ausnahme und lässt " +
        "keinen Eigenbeleg als Ersatz zu. Die Buchung 70/30 folgt der Praxisauffassung Dennerlein Q42 (nur Beträge unter 250 €, Anerkennung offen).",
    ];
  }
  return [
    NO_VAT_WITHOUT_INVOICE,
    "100 % nicht abziehbar (folgt BFH X R 57/09). Geht die Rechnung später ein, siehe den Ablauf „Rechnung nachgereicht“ in docs/bewirtungsbeleg-faq.md.",
  ];
}

export function noInvoiceWarnings(context: EntertainmentContext): string[] {
  if (context.invoiceStatus === "present") return [];
  if (context.business === false) return [INTERNAL_NO_INVOICE_WARNING];
  if (context.business === true && context.missingTreatment) return businessNoInvoiceWarnings(context.missingTreatment);
  return [];
}

// Short text for the audit comment (210-byte limit, see formatEntertainmentExpenseNote).
export function variantNote(context: EntertainmentContext): string | undefined {
  if (context.invoiceStatus !== "present" && context.business === true && context.missingTreatment) {
    const source = context.missingTreatment === "practice_70_30_no_vat" ? "Q42" : "BFH X R 57/09";
    return `Rechnung ${context.invoiceStatus}; Variante: ${context.missingTreatment} (${source}) – Nutzerentscheid`;
  }
  if (context.type === "internal_shareholder_managers" && context.shareholderTreatment && allShareholderManagers(context.relations)) {
    const source = context.shareholderTreatment === "business_70_30" ? "Q55" : "Q48";
    return `GF-Variante: ${context.shareholderTreatment} (${source}) – Nutzerentscheid`;
  }
  return undefined;
}

const ALIAS_MIX_ERROR =
  'host_confirmed (deprecated) darf nicht zusammen mit bewirtungsangaben_signed oder original_invoice_status angegeben werden - es ' +
  'soll nur eine Quelle der Wahrheit geben. host_confirmed:true entspricht bewirtungsangaben_signed:true plus original_invoice_status:"present"; ' +
  "bei fehlender Rechnung nur die neuen Felder verwenden.";

export function resolveEntertainmentContext(f: PolicyFields): { context: EntertainmentContext; warnings: string[] } {
  const warnings: string[] = [];
  const viaAlias = f.host_confirmed !== undefined;
  if (viaAlias && (f.bewirtungsangaben_signed !== undefined || f.original_invoice_status !== undefined)) {
    throw new Error(ALIAS_MIX_ERROR);
  }
  const invoiceStatus: InvoiceStatus = viaAlias ? "present" : (f.original_invoice_status ?? "present");
  const signed = viaAlias ? f.host_confirmed : f.bewirtungsangaben_signed;

  const missing = collectMissingPolicyFields(f, invoiceStatus);
  if (missing.length > 0) {
    throw new Error(`Pflichtangaben fehlen für diese Bewirtung (alle auf einmal beim Nutzer erfragen): ${missing.join(" | ")}`);
  }

  if (viaAlias) {
    warnings.push(
      "host_confirmed ist deprecated: stattdessen bewirtungsangaben_signed und original_invoice_status verwenden " +
        "(host_confirmed:true entspricht beiden mit Status present)."
    );
  }
  const type = f.entertainment_type;
  if (type === undefined) {
    const suggested = f.participant_relations?.length ? typeFromParticipants(f.participant_relations) : undefined;
    warnings.push(
      "entertainment_type fehlt: ohne Bewirtungsart kann der Konnektor Konto, Lohnsteuer und vGA-Risiko nicht einordnen." +
        (suggested ? ` Vorschlag aus den Teilnehmern: ${suggested}.` : "")
    );
  }
  const business =
    type === undefined ? undefined : isBusinessAnlass(type, f.shareholder_manager_treatment, f.participant_relations);
  warnings.push(...consistencyWarnings(type, f.participant_relations, f.shareholder_manager_treatment));

  return {
    context: {
      invoiceStatus,
      signed,
      type,
      business,
      missingTreatment: f.missing_invoice_treatment,
      shareholderTreatment: f.shareholder_manager_treatment,
      relations: f.participant_relations,
      viaAlias,
    },
    warnings,
  };
}
