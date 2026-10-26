import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { buildBookingHint, type BookingHint, type Chart } from "./travel-expense-booking.js";
import { computeTrip, round2, type Meal, type TripInput, type TripResult } from "./travel-expense-calc.js";
import {
  computeTotals,
  nextDateKey,
  processExpenses,
  processKmTrips,
  type CostLine,
  type Expense,
  type KmLine,
  type KmTrip,
  type Totals,
} from "./travel-expense-costs.js";
import { mergeAttachments, renderTravelExpenseReport, type TravelReportData } from "./travel-expense-pdf.js";
import { getChart } from "./posting-accounts.js";
import { resolveRateTables } from "./travel-rates-online.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// Reasons the connector rejects: generic purposes say nothing about the professional cause. R 9.4 Abs. 1 Satz 5 LStR
// requires the professional cause, the duration and the route to be recorded.
const PURPOSE_DENYLIST = new Set([
  "geschäftsreise",
  "dienstreise",
  "kundenbesuch",
  "kundentermin",
  "termin",
  "auswärtstermin",
  "meeting",
  "besprechung",
  "fortbildung",
]);
const MIN_PURPOSE_LENGTH = 15;

export function assertPurposeIsConcrete(purpose: string): void {
  const trimmed = purpose.trim();
  if (PURPOSE_DENYLIST.has(trimmed.toLowerCase()) || trimmed.length < MIN_PURPOSE_LENGTH) {
    throw new Error(
      `"${purpose}" ist als Reisezweck zu unkonkret: Die berufliche Veranlassung der Reise ist aufzuzeichnen und nachzuweisen ` +
        `(R 9.4 Abs. 1 Satz 5 LStR). Frag nach, wen oder was die Reise betraf (Kunde, Thema, Veranstaltung) und trage das ein.`
    );
  }
}

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MEALS = ["breakfast", "lunch", "dinner"] as const;

const stopSchema = z.object({
  country: z.string().min(2).describe('Land auf Deutsch, z. B. "Frankreich"; Inland: "Deutschland".'),
  place: z.string().optional().describe('Stadt, wenn die BMF-Tabelle sie gesondert führt (z. B. "Paris", "London", "New York City").'),
  arrival: z.string().regex(LOCAL_DATE_TIME).describe("Ankunft an diesem Ort in Ortszeit dort, YYYY-MM-DDTHH:mm."),
  transport: z.enum(["car", "train", "flight", "ship", "other"]).optional().describe("Beförderungsart der Etappe zu diesem Ort. Flug über mehr als zwei Kalendertage und Schiff haben eigene Regeln (R 9.6 Abs. 3 LStR)."),
  departs_at: z.string().regex(LOCAL_DATE_TIME).optional().describe(
    "Nur ab der zweiten Station: Beginn der Etappe zu diesem Ort (Abflug/Abfahrt), YYYY-MM-DDTHH:mm in Ortszeit am vorigen Ort; zwischen der Ankunft an der vorigen Station und der Ankunft hier. " +
      "Bei Flug oder Schiff über mehrere Kalendertage angeben: nur dann rechnet das Tool Zwischentage (Flug Österreich, Schiff Luxemburg) und zählt die Nächte an Bord nicht als Übernachtung. " +
      "Ohne departs_at gilt die Etappe als am Ankunftstag zurückgelegt. Die erste Etappe beginnt mit departure."
  ),
});

const expenseSchema = z.object({
  category: z.enum(["fare", "lodging", "incidental"]).describe("fare = Fahrtkosten (Bahn, Flug, Taxi), lodging = Übernachtung, incidental = Reisenebenkosten (Parken, Maut, Gepäck, Telefon)."),
  description: z.string().min(2),
  date: z.string().regex(DATE_ONLY).describe("Belegdatum YYYY-MM-DD. Bei Übernachtung: der Tag, an dem die Nacht beginnt (das Frühstück ist am Folgetag)."),
  amount: z.number().positive().describe("Bruttobetrag in der Belegwährung. Ein Beleg mit zwei Steuersätzen (z. B. 7 % Übernachtung + 19 % Getränke) wird als ZWEI Ausgaben erfasst, jede mit einem vat_rate/vat_amount und beide mit derselben receipt_id."),
  vat_amount: z.number().min(0).optional().describe("Umsatzsteuerbetrag wie auf dem Beleg ausgewiesen (Belegwährung). Nicht aus dem Satz berechnen."),
  vat_rate: z.union([z.literal(0), z.literal(7), z.literal(19)]).optional().describe("Steuersatz des Belegs; Pflicht und nur 7 oder 19, wenn vat_amount größer 0 ist. Ausländische Umsatzsteuer: foreign_vat: true statt vat_rate."),
  currency: z.string().length(3).optional().describe("ISO-Währung, Standard EUR."),
  fx_rate: z.number().positive().optional().describe("EUR je 1 Einheit Fremdwährung; Pflicht bei Fremdwährung."),
  fx_source: z.string().optional().describe('Quelle des Kurses, z. B. "BMF Monatskurs 03/2026"; Pflicht bei Fremdwährung.'),
  invoice_recipient: z.enum(["company", "traveller", "unknown"]).optional().describe("Auf wen lautet die Rechnung? Vorsteuerabzug über 250 € (Summe aller Positionen derselben receipt_id) nur bei Rechnung auf die Firma. Beim Nutzer erfragen."),
  foreign_vat: z.boolean().optional().describe("Beleg weist ausländische Umsatzsteuer aus (kein deutscher Vorsteuerabzug). Bei Belegen aus dem Ausland oder in Fremdwährung beim Nutzer erfragen."),
  receipt_missing: z.boolean().optional().describe("Beleg fehlt (Aufwand muss glaubhaft gemacht werden, kein Eigenbeleg als Ersatz)."),
  breakfast_included: z.boolean().optional().describe("Nur Übernachtung: Frühstück im Preis enthalten."),
  breakfast_amount: z.number().min(0).optional().describe("Frühstück separat ausgewiesen (Belegwährung)."),
  fare_kind: z.enum(["train", "flight", "taxi", "bus", "other"]).optional(),
  receipt_id: z.string().min(1).optional().describe(
    "Kennung des Belegs, z. B. die Rechnungsnummer. Zwei Steuersätze = zwei Positionen mit derselben receipt_id: sie gelten als EIN Beleg für die 250-€-Grenze (Kleinbetragsrechnung) und den Rechnungsempfänger (gleiche Währung und gleicher invoice_recipient)."
  ),
  paid_by: z.enum(["traveller", "company"]).optional().describe(
    'Wer hat bezahlt? Standard "traveller" (erstattet). "company" = vom Unternehmen direkt bezahlt (z. B. Firmenkarte, Rechnung an die Firma bezahlt): steht in der Abrechnung, zählt aber nicht zum Gesamt- und Erstattungsbetrag und nicht in die Buchungssplits (eigener Beleg). Ein darin enthaltenes Frühstück kürzt bei Angestellten trotzdem die Verpflegungspauschale. Beim Nutzer erfragen.'
  ),
});

const kmSchema = z.object({
  mode: z.enum(["car", "other_motor"]).describe("car = Pkw (0,30 €/km), other_motor = anderes motorbetriebenes Fahrzeug (0,20 €/km)."),
  km: z.number().positive(),
  date: z.string().regex(DATE_ONLY),
  description: z.string().optional(),
  ownership: z
    .enum(["private", "business"], { error: "ownership (private oder business) beim Nutzer erfragen: die Kilometerpauschale gilt nur für private Fahrzeuge." })
    .describe('Pflicht, beim Nutzer erfragen: "private" (Privatfahrzeug, Kilometerpauschale) oder "business" (Betriebs-Pkw, nicht pauschalierbar: dort tatsächliche Kosten als Beleg erfassen).'),
});

const attachmentSchema = z.object({ file: z.string().min(1), type: z.enum(["pdf", "png", "jpeg"]) });

const generateShape = {
  traveller_name: z.string().min(2).describe("Reisende Person. IMMER beim Nutzer erfragen, nie aus Kontext, Kalender oder Teilnehmern ableiten."),
  traveller_type: z.enum(["employee", "self_employed"]).describe(
    "employee = Angestellte UND Gesellschafter-Geschäftsführer mit Anstellungsvertrag (Erstattung durch den Arbeitgeber); self_employed = Selbstständige, Einzelunternehmer und Gesellschafter-Geschäftsführer ohne Anstellungsvertrag (owner_manager; Betriebsausgabe, nur tatsächliche Übernachtungskosten). Im Zweifel beim Nutzer erfragen."
  ),
  traveller_confirmed: z.boolean().describe("true erst, nachdem die reisende Person die Angaben bestätigt hat (elektronische Bestätigung mit Zeitstempel im Beleg)."),
  purpose: z.string().describe("Konkreter Reisezweck (wen/was/warum). Pauschalangaben wie 'Geschäftsreise' werden abgelehnt."),
  departure: z.string().regex(LOCAL_DATE_TIME).describe("Abreise von Wohnung bzw. erster Tätigkeitsstätte, YYYY-MM-DDTHH:mm (Ortszeit am Wohnort)."),
  return: z.string().regex(LOCAL_DATE_TIME).describe("Rückkehr zur Wohnung bzw. ersten Tätigkeitsstätte, YYYY-MM-DDTHH:mm."),
  stops: z.array(stopSchema).min(1).describe(
    "Stationen der Reise in zeitlicher Reihenfolge. Die Rückkehr nach Hause muss nicht als Station erfasst werden; wird sie als " +
      "letzte Station (Deutschland) nach Auslandsstationen erfasst und kommt die erste Inlandsstation danach am Rückreisetag an, gilt für den Rückreisetag der Satz des letzten Auslandsorts (§ 9 Abs. 4a Satz 5 EStG)."
  ),
  meals_provided: z.record(z.string().regex(DATE_ONLY), z.array(z.enum(MEALS))).optional().describe('Vom Arbeitgeber oder Dritten gestellte Mahlzeiten je Datum, z. B. {"2026-03-10": ["breakfast"]}. Kürzung 20 %/40 % der 24-Stunden-Pauschale.'),
  overnight_without_accommodation: z.boolean().optional().describe("Einsatz über Nacht ohne Übernachtung (14 € für den Tag mit der überwiegenden Abwesenheit)."),
  same_location_since: z.string().regex(DATE_ONLY).optional().describe("Beginn der Tätigkeit an derselben Tätigkeitsstätte (Dreimonatsfrist)."),
  use_lodging_flat_rate: z.boolean().optional().describe("Nur Angestellte bei Erstattung durch den Arbeitgeber: Übernachtungspauschale statt Beleg (Inland 20 €, Ausland laut BMF)."),
  lodging_nights: z.number().int().min(0).optional().describe("Anzahl der Übernachtungen, für die die Pauschale gilt; korrigiert die aus den Zeiten abgeleitete Zahl."),
  is_shareholder_manager: z.boolean().optional().describe("Reisende Person ist Gesellschafter-Geschäftsführer (mit oder ohne Anstellungsvertrag). Beim Nutzer erfragen."),
  agreement_in_advance: z.boolean().optional().describe("Gesellschafter-Geschäftsführer: gibt es eine klare, im Voraus getroffene Vereinbarung zur Reisekostenerstattung (R 8.5 KStR)? Beim Nutzer erfragen."),
  advance_paid: z.number().min(0).optional().describe("Bereits gezahlter Vorschuss in EUR."),
  expenses: z.array(expenseSchema).optional().describe("Belege (Fahrt, Übernachtung, Nebenkosten). Zwei Steuersätze = zwei Positionen mit derselben receipt_id."),
  km_trips: z.array(kmSchema).optional(),
  company_name: z.string().optional(),
  company_address: z.string().optional(),
  report_number: z.string().optional(),
  attachments: z.array(attachmentSchema).optional().describe("Belege als Base64 (PDF, PNG, JPEG), werden hinter die Abrechnung gehängt."),
};

const uploadShape = {
  ...generateShape,
  account: z.number().int().optional().describe("Zahlungskonto-Kontonummer, falls der Beleg direkt zugeordnet werden soll."),
  creditor_debtor: z.number().int().optional().describe("Kreditor-Kontonummer, falls der Beleg direkt zugeordnet werden soll."),
};

type GenerateArgs = z.infer<z.ZodObject<typeof generateShape>>;

export interface BuiltReport {
  pdfBytes: Uint8Array;
  trip: TripResult;
  lines: CostLine[];
  kmLines: KmLine[];
  totals: Totals;
  warnings: string[];
  data: TravelReportData;
}

function validateRequest(args: GenerateArgs): string[] {
  const warnings: string[] = [];
  if (args.traveller_confirmed !== true) {
    throw new Error(
      "Die Abrechnung muss von der reisenden Person bestätigt sein (traveller_confirmed: true): erst die Angaben vorlegen und bestätigen lassen."
    );
  }
  if (args.traveller_name.trim().length < 2) throw new Error("traveller_name fehlt: reisende Person beim Nutzer erfragen.");
  assertPurposeIsConcrete(args.purpose);
  if (args.is_shareholder_manager === true) {
    if (args.agreement_in_advance === undefined) {
      throw new Error(
        "Gesellschafter-Geschäftsführer: agreement_in_advance angeben (true/false). Beim beherrschenden Gesellschafter braucht die " +
          "Reisekostenerstattung eine klare, im Voraus getroffene Vereinbarung, sonst droht verdeckte Gewinnausschüttung (R 8.5 Abs. 2 KStR). Beim Nutzer erfragen."
      );
    }
    if (args.agreement_in_advance === false) {
      warnings.push(
        "Gesellschafter-Geschäftsführer ohne Vorab-Vereinbarung zur Reisekostenerstattung: vGA-Risiko (R 8.5 Abs. 2 KStR, H 8.5 KStH). " +
          "Reisekostenrichtlinie oder Anstellungsvertrag mit klarer Regelung für die Zukunft vereinbaren; Steuerberater einbinden."
      );
    }
  }
  return warnings;
}

export interface BuildOptions {
  chart?: () => Promise<Chart>;
  /** fetch used for the online lookup of a missing BMF table (default: global fetch). */
  fetchImpl?: typeof fetch;
}

export async function buildTravelReport(args: GenerateArgs, options: BuildOptions = {}): Promise<BuiltReport & { hint: BookingHint }> {
  const warnings = validateRequest(args);
  const travellerType = args.traveller_type;
  const expenses = (args.expenses ?? []) as Expense[];

  // Employees: breakfast in the hotel price is a provided meal on the following morning (reduces the allowance), also
  // when the company paid the hotel. Interpretation (A) of Rz. 117 BMF 25.11.2020 (employer reimburses the breakfast).
  const meals: Record<string, Meal[]> = {};
  for (const [date, list] of Object.entries(args.meals_provided ?? {})) meals[date] = [...list];
  if (travellerType === "employee") {
    for (const e of expenses) {
      if (e.category === "lodging" && e.breakfast_included) {
        const morning = nextDateKey(e.date);
        meals[morning] = [...(meals[morning] ?? []), "breakfast"];
      }
    }
  }

  const tripInput: TripInput = {
    travellerType,
    departure: args.departure,
    returnTime: args.return,
    stops: args.stops.map((s) => ({ country: s.country, place: s.place, arrival: s.arrival, transport: s.transport, departs: s.departs_at })),
    mealsProvided: meals,
    overnightWithoutAccommodation: args.overnight_without_accommodation,
    sameLocationSince: args.same_location_since,
    useLodgingFlatRate: args.use_lodging_flat_rate,
    lodgingNights: args.lodging_nights,
  };
  // First pass without network: it tells which years with foreign days have no built-in table (provisional). Only
  // those are looked up online; domestic-only trips never trigger a request.
  let trip = computeTrip(tripInput);
  const missingYears = trip.rateTables.filter((t) => t.origin === "provisional").map((t) => t.year);
  if (missingYears.length > 0) {
    trip = computeTrip({ ...tripInput, rateTables: await resolveRateTables(missingYears, { fetchImpl: options.fetchImpl }) });
  }
  const fullRateByDate = new Map(trip.days.map((d) => [d.date, d.fullRate]));
  const countryByDate = new Map(trip.days.map((d) => [d.date, d.country]));
  const tripRange = { from: args.departure.slice(0, 10), to: args.return.slice(0, 10) };
  const costs = processExpenses(expenses, {
    travellerType,
    breakfastRate: (date) => fullRateByDate.get(date),
    countryOfDate: (date) => countryByDate.get(date),
    tripRange,
  });
  const km = processKmTrips((args.km_trips ?? []) as KmTrip[], { tripRange });

  const hasLodging = costs.lines.some((l) => l.category === "lodging") || trip.lodgingFlat.length > 0;
  if (trip.nights > 0 && !hasLodging) {
    warnings.push(
      `Die Reise hat ${trip.nights} Übernachtung(en), aber weder Übernachtungsbeleg noch Pauschale ist erfasst. Fehlt eine Übernachtung, ` +
        "nachtragen (Beleg oder, bei Angestellten mit Arbeitgebererstattung, use_lodging_flat_rate)."
    );
  }
  if (trip.lodgingFlat.length > 0 && costs.lines.some((l) => l.category === "lodging")) {
    const n = trip.lodgingFlat.length;
    warnings.push(
      `Übernachtungspauschale für ${n} ${n === 1 ? "Nacht" : "Nächte"} und Übernachtungsbeleg gleichzeitig erfasst: nur eines von beiden je Nacht ` +
        "ansetzen (lodging_nights begrenzt die Pauschale auf die Nächte ohne Beleg)."
    );
  }
  if (args.attachments && args.attachments.length > 0) {
    warnings.push(
      "Anhänge werden als Seiten hinter die Abrechnung gehängt; eine in einer E-Rechnung eingebettete XML-Datei (ZUGFeRD/XRechnung) geht dabei " +
        "nicht mit. E-Rechnungen im Empfangsformat separat aufbewahren (GoBD Rz. 131 in der Fassung des BMF-Schreibens vom 14.07.2025)."
    );
  }
  if (travellerType === "self_employed") {
    warnings.push(
      "Selbstständige und Gesellschafter-Geschäftsführer ohne Anstellungsvertrag: Übernachtungspauschalen gibt es nur bei Arbeitgebererstattung; hier zählen nur tatsächliche Kosten " +
        "(Auslegung aus R 4.12 EStR und R 9.7 LStR, nicht wörtlich geregelt)."
    );
  }

  const totals = computeTotals({
    allowances: trip.allowanceTotal,
    lodgingFlat: trip.lodgingFlatTotal,
    lines: costs.lines,
    kmLines: km.lines,
    advance: round2(args.advance_paid ?? 0),
  });
  if (totals.total === 0) {
    warnings.push(
      totals.companyPaid > 0
        ? "Gesamtbetrag 0 €: keine Verpflegungspauschale und nur vom Unternehmen gezahlte Kosten erfasst (paid_by company), es wird nichts erstattet — Eingaben prüfen."
        : "Gesamtbetrag 0 €: keine Verpflegungspauschale, keine Kosten erfasst — Eingaben prüfen."
    );
  }
  const allWarnings = [...warnings, ...trip.warnings, ...costs.warnings, ...km.warnings];
  const chart = options.chart ? await options.chart() : "unknown";
  const hint = buildBookingHint({
    travellerType,
    travellerName: args.traveller_name.trim(),
    purpose: args.purpose.trim(),
    chart,
    allowances: trip.allowanceTotal,
    lodgingFlat: trip.lodgingFlatTotal,
    kmLines: km.lines,
    lines: costs.lines,
  });

  const route = args.stops.map((s) => {
    const at = `${s.arrival.slice(8, 10)}.${s.arrival.slice(5, 7)}.${s.arrival.slice(0, 4)} ${s.arrival.slice(11, 16)}`;
    return `${s.country}${s.place ? ` (${s.place})` : ""}, Ankunft ${at}`;
  });
  const data: TravelReportData = {
    companyName: args.company_name,
    companyAddress: args.company_address,
    reportNumber: args.report_number,
    travellerName: args.traveller_name.trim(),
    travellerType,
    purpose: args.purpose.trim(),
    departure: args.departure,
    returnTime: args.return,
    route,
    days: trip.days,
    lodgingFlat: trip.lodgingFlat,
    costs: costs.lines,
    kmLines: km.lines,
    totals,
    warnings: allWarnings,
    sources: trip.sources,
    rateTables: trip.rateTables,
  };
  let pdfBytes = await renderTravelExpenseReport(data);
  if (args.attachments && args.attachments.length > 0) pdfBytes = await mergeAttachments(pdfBytes, args.attachments);
  return { pdfBytes, trip, lines: costs.lines, kmLines: km.lines, totals, warnings: allWarnings, data, hint };
}

function summary(built: BuiltReport & { hint: BookingHint }) {
  return {
    totals: built.totals,
    days: built.trip.days,
    nights: built.trip.nights,
    lodging_flat: built.trip.lodgingFlat,
    costs: built.lines,
    km: built.kmLines,
    sources: built.trip.sources,
    rates_provisional: built.trip.rateTables.some((t) => t.origin === "provisional"),
    rates_sources: built.trip.rateTables.map((t) => ({
      year: t.year,
      origin: t.origin,
      source: t.source,
      ...(t.origin === "provisional" ? { provisional_from: t.provisionalFrom } : {}),
    })),
    ...(built.warnings.length > 0 ? { warnings: built.warnings } : {}),
    booking_hint: built.hint,
  };
}

export function createTravelExpenseTools(client: BBClient, options: { fetchImpl?: typeof fetch } = {}): [ToolDef, ToolDef] {
  const generate = defineTool({
    name: "generate_travel_expense_report",
    description:
      "Erzeugt eine Reisekostenabrechnung als PDF (Verpflegungspauschalen Inland und Ausland nach BMF-Tabelle mit Mahlzeitenkürzung und " +
      "Dreimonatsfrist, Übernachtung, Fahrt, Kilometer, Nebenkosten) und einen Buchungshinweis. Auslandssätze: eingebaute BMF-Tabelle; fehlt sie " +
      "für ein Reisejahr, ruft der Konnektor die BMF-Tabelle online ab (LStH Anhang 25 I), sonst rechnet er vorläufig mit der letzten bekannten " +
      "Tabelle und markiert das (rates_provisional, Warnung, VORLÄUFIG im PDF; vor dem Buchen neu berechnen). traveller_type: employee = Angestellte UND " +
      "Gesellschafter-Geschäftsführer mit Anstellungsvertrag (Erstattung durch den Arbeitgeber); self_employed = Selbstständige, Einzelunternehmer " +
      "und Gesellschafter-Geschäftsführer ohne Anstellungsvertrag (owner_manager; Betriebsausgabe, nur tatsächliche Übernachtungskosten). Im " +
      "Zweifel beim Nutzer erfragen. Ohne BuchhaltungsButler-Zugriff; zum Hochladen generate_and_upload_travel_expense_report nutzen. Reisende " +
      "Person, Reisezweck, Rechnungsempfänger und Zahler (paid_by) der Belege sowie ownership bei Kilometerfahrten beim Nutzer erfragen, nie " +
      "ableiten; erst nach Bestätigung der reisenden Person traveller_confirmed setzen. Zwei Steuersätze = zwei Positionen mit derselben " +
      "receipt_id (z. B. 7 % Übernachtung + 19 % Getränke; jede Position trägt einen vat_rate/vat_amount; vat_rate ist Pflicht und nur 7 oder 19, " +
      "wenn vat_amount größer 0 ist, ausländische Umsatzsteuer mit foreign_vat). Vom Unternehmen gezahlte Positionen (paid_by company) stehen " +
      "in der Abrechnung, zählen aber nicht zum Gesamtbetrag (totals.companyPaid nachrichtlich). Flug oder Schiff ab der zweiten Station über " +
      "mehrere Kalendertage: departs_at angeben. Die Antwort nennt nights (aus den Zeiten abgeleitet, informativ) und lodging_flat (die " +
      "gezahlten Pauschalnächte, Summe totals.lodgingFlat; mit lodging_nights korrigierbar). Der Konnektor bucht nicht selbst. Beim Hochladen ist der Belegbetrag der Gesamtbetrag, nicht der Erstattungsbetrag nach Vorschuss. Die rechtlichen Aussagen sind vor Produktivbetrieb vom Steuerberater gegenzulesen (docs/reisekosten-faq.md).",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: generateShape,
    async handler(args) {
      const built = await buildTravelReport(args, { fetchImpl: options.fetchImpl });
      return ok({ pdf_base64: Buffer.from(built.pdfBytes).toString("base64"), ...summary(built) });
    },
  });

  const generateAndUpload = defineTool({
    name: "generate_and_upload_travel_expense_report",
    description:
      "Erzeugt die Reisekostenabrechnung (siehe generate_travel_expense_report) und lädt sie in einem Aufruf nach BuchhaltungsButler hoch, " +
      "statt das Base64-PDF zweimal durch das Modell zu schicken. Liefert id_by_customer des neuen Belegs, nicht das PDF. " +
      "Fehlt die BMF-Auslandstabelle des Reisejahrs, gilt dasselbe wie beim Erzeugen: Online-Abruf, sonst vorläufig markiert (rates_provisional); " +
      "eine vorläufige Abrechnung erst nach Rückfrage hochladen. " +
      "BuchhaltungsButler erkennt Duplikate nicht: bei einem erneuten Upload vorher list_receipts prüfen. Der Belegbetrag ist der " +
      "Gesamtbetrag (ohne vom Unternehmen gezahlte Positionen), nicht der Erstattungsbetrag nach Vorschuss. traveller_type: employee = " +
      "Angestellte UND Gesellschafter-Geschäftsführer mit Anstellungsvertrag; self_employed = Selbstständige, Einzelunternehmer und " +
      "Gesellschafter-Geschäftsführer ohne Anstellungsvertrag (owner_manager); im Zweifel beim Nutzer erfragen. Reisende Person, Reisezweck, " +
      "Rechnungsempfänger und Zahler (paid_by) der Belege beim Nutzer erfragen, nie ableiten; traveller_confirmed erst nach Bestätigung der reisenden Person setzen. " +
      "Eingaben wie bei generate_travel_expense_report, siehe die Feldbeschreibungen: stops[].departs_at bei Flug/Schiff ab der zweiten Station " +
      "über mehrere Kalendertage, km_trips[].ownership (Pflicht), expenses[].receipt_id (zwei Steuersätze = ein Beleg) und expenses[].paid_by. Der Buchungshinweis nennt bei " +
      "erkanntem SKR03 die Konten. Der Konnektor bucht nicht selbst; Buchungen legst du nach Rückfrage selbst an.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: uploadShape,
    async handler(args) {
      const built = await buildTravelReport(args, { chart: () => getChart(client).catch(() => "unknown" as const), fetchImpl: options.fetchImpl });
      const provisional = built.trip.rateTables.some((t) => t.origin === "provisional");
      let id: string | number | null = null;
      try {
        const result = await client.call<{ success?: boolean; message?: string; id_by_customer?: string | number; data?: { id_by_customer?: string | number } }>(
          "receiptsUpload",
          {
            file: Buffer.from(built.pdfBytes).toString("base64"),
            type: "invoice inbound",
            file_name: `Reisekostenabrechnung_${args.return.slice(0, 10)}${provisional ? "_vorlaeufig" : ""}.pdf`,
            account: args.account,
            creditor_debtor: args.creditor_debtor,
            counterparty: built.data.travellerName,
            invoice_number: args.report_number,
            date: args.return.slice(0, 10),
            amount: built.totals.total,
            currency: "EUR",
          }
        );
        if (result?.success === false) throw new Error(result.message || "BuchhaltungsButler meldet success: false");
        id = result?.id_by_customer ?? result?.data?.id_by_customer ?? null;
      } catch (error) {
        throw new Error(
          `Upload fehlgeschlagen (${error instanceof Error ? error.message : String(error)}). Der Beleg kann trotzdem angelegt worden sein. ` +
            "Nicht automatisch wiederholt (BuchhaltungsButler erkennt keine Duplikate, das Upload-Kontingent wird nicht erstattet). Vor einem " +
            `erneuten Versuch per list_receipts (Gegenpartei ${built.data.travellerName}, Datum ${args.return.slice(0, 10)}) prüfen.`
        );
      }
      const summed = summary(built);
      if (provisional) {
        summed.warnings = [
          ...(summed.warnings ?? []),
          "Vorläufiger Beleg hochgeladen: nach Veröffentlichung der BMF-Tabelle neu berechnen, den neuen Beleg hochladen und diesen mit set_receipt_deleted entfernen, bevor gebucht wird.",
        ];
      }
      if (built.totals.total === 0) {
        summed.warnings = [
          ...(summed.warnings ?? []),
          "Upload mit Betrag 0 €: der Beleg dokumentiert die Reise, es gibt nichts zu erstatten und nichts über die Reisekostenabrechnung zu buchen.",
        ];
      }
      if (id === null) {
        summed.warnings = [...(summed.warnings ?? []), "Upload ohne ID quittiert: per list_receipts prüfen, nicht erneut hochladen."];
      }
      return ok({ id_by_customer: id, ...summed });
    },
  });

  return [generate, generateAndUpload];
}
