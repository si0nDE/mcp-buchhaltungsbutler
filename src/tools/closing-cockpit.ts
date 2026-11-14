import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";
import { cents, collectMonthEnd, readAll, type Result as MonthEndCheck } from "./month-end.js";
import { loadPolicy, type Policy } from "./policy.js";

// Abbild der Monatsabschluss-Checkliste im Abschluss-Cockpit von BuchhaltungsButler (Beta, Menü "Abschluss-Cockpit"):
// 11 Abschnitte, 54 Aufgaben, Kennungen wie im Cockpit (gelesen am 14.11.2026 am EÜR-Konto Fieber IT, alle Aufgaben
// standardmäßig aktiv). Die Texte unten sind eigene Kurzfassungen, nicht BHBs Hilfetexte. Das Cockpit selbst hat keine
// API: Speichern, Monat abschließen und Salden laufen über Endpunkte der Weboberfläche, die nur mit einer Browser-Sitzung
// antworten. Dieses Tool liest deshalb nur und urteilt über das, was die API hergibt; das Abhaken dort bleibt Handarbeit.

export type Pruefart = "auto" | "teilweise" | "manuell" | "oberflaeche";
export type Bedingung = "bilanz" | "lohn" | "anlagen" | "waren" | "eu" | "oss" | "import";
export type TaskStatus = "geprueft_ok" | "auffaellig" | "offen" | "nur_oberflaeche" | "nicht_zutreffend" | "ausgeblendet";

interface TaskDef {
  id: string;
  titel: string;
  art: Pruefart;
  // Name der Prüfung aus check_month_end, aus der der Status kommt.
  check?: "duplikatsverdacht_belege" | "zahlungen_ohne_buchung" | "belege_ohne_buchung" | "festschreibung" | "geldtransit_und_interimskonto_saldo";
  saldo?: boolean;
  werkzeug?: string;
  hinweis: string;
  bedingung?: Bedingung;
}

interface SectionDef {
  nr: number;
  gruppe: "Vorbereitung" | "Buchhaltung" | "Erweiterte Buchhaltung" | "Abschluss";
  titel: string;
  aufgaben: TaskDef[];
}

export const CHECKLIST: SectionDef[] = [
  {
    nr: 1, gruppe: "Vorbereitung", titel: "Belege & Daten bereitstellen",
    aufgaben: [
      { id: "A1", titel: "Belege aus allen Quellen sammeln und hochladen", art: "manuell", hinweis: "Postfach, Cloud, Papier und Kassenbons durchgehen und hochladen. Ob etwas fehlt, weiß nur der Nutzer; vor dem Upload list_receipts auf Doppelte prüfen." },
      { id: "A4", titel: "Transaktionen per Schnittstelle abrufen", art: "oberflaeche", hinweis: "Abruf und Zeitstempel je Konto stehen nur in der Oberfläche (Abschluss-Cockpit, Verbundene Konten). Ohne frischen Abruf sind Salden und ungebuchte Zahlungen unvollständig." },
      { id: "A5", titel: "Daten aus Vorsystemen und Zahlungsdiensten ohne Schnittstelle importieren", art: "manuell", hinweis: "CSV-Import von Marktplätzen, Kassen und Zahlungsdiensten ohne Anbindung; create_transactions legt Zahlungen an.", werkzeug: "create_transactions" },
      { id: "A2", titel: "Fehlende Belege identifizieren, anfordern, nachreichen", art: "teilweise", werkzeug: "get_receipt_overview, list_transactions", hinweis: "Zahlungen ohne Beleg lassen sich lesen; ob ein Beleg beschaffbar ist, entscheidet der Nutzer. Dauerhaft fehlende Belege mit Kommentar auf das Klärungskonto." },
      { id: "A3", titel: "Doppelte Belege identifizieren und löschen", art: "auto", check: "duplikatsverdacht_belege", werkzeug: "set_receipt_deleted", hinweis: "Duplikatsverdacht nach Rechnungssteller und Nummer (oder Datum und Betrag). Verdacht, kein Beweis: Korrekturrechnungen tragen oft dieselbe Nummer." },
    ],
  },
  {
    nr: 2, gruppe: "Vorbereitung", titel: "Banken & Finanzkonten abgleichen",
    aufgaben: [
      { id: "E1", titel: "Kontoauszüge aller Bankkonten herunterladen", art: "manuell", hinweis: "Schlusssalden aller Konten notieren, auch Tagesgeld, Kreditkarte, PayPal. Die Salden braucht E2." },
      { id: "E2", titel: "Kontoendstände eintragen und mit Salden in BHB abgleichen", art: "auto", saldo: true, werkzeug: "calculate_account_balance", hinweis: "Berechneter Kontostand je Konto gegen den Saldo laut Auszug. Ohne Auszugssaldo kein Urteil." },
      { id: "E5", titel: "Unklare Bank- oder Kassenbewegungen dokumentieren", art: "teilweise", werkzeug: "get_bank_overview, add_comment", hinweis: "get_bank_overview zeigt offene Bewegungen; den Zweck unklarer Zahlungen klärt der Nutzer." },
    ],
  },
  {
    nr: 3, gruppe: "Vorbereitung", titel: "Belegerfassung",
    aufgaben: [
      { id: "X1", titel: "Ungebuchte Eingangsbelege prüfen und verbuchen", art: "teilweise", check: "belege_ohne_buchung", hinweis: "Bei EÜR ohne Debitoren/Kreditoren ist ein unbezahlter Beleg ohne Buchung normal; dort zählt die Zahlung (D1). Nur Bilanzierer buchen Belege." },
      { id: "X3", titel: "Offene Aufgaben zu Eingangsbelegen abarbeiten", art: "oberflaeche", hinweis: "Aufgaben und Kommentare an Belegen sind in der Oberfläche; die API hat Kommentare (add_comment), aber keine Aufgabenliste." },
      { id: "X7", titel: "Ungebuchte Ausgangsbelege prüfen und verbuchen", art: "teilweise", check: "belege_ohne_buchung", hinweis: "Wie X1: bei EÜR zählt die Zahlung. Ausgangsrechnungen ohne Zahlungseingang sind offene Forderungen, keine Buchungslücke." },
      { id: "X9", titel: "Erlösminderungen wie Rabatte, Erstattungen, Chargebacks prüfen", art: "manuell", werkzeug: "get_account_ledger", hinweis: "Erlösminderungskonten im Kontenblatt ansehen; ob ein Posten richtig ist, beurteilt der Nutzer." },
      { id: "X4", titel: "Lieferantengutschriften, Korrekturen und Stornos prüfen", art: "manuell", werkzeug: "get_booking_guide storno_ruecklastschrift", hinweis: "Gutschriften und Stornos gegen Ausgangsbelege abgleichen." },
      { id: "X5", titel: "Fehlerhafte Buchungen bei Ausgaben korrigieren", art: "manuell", werkzeug: "get_account_ledger, cancel_posting", hinweis: "Kontierung und Steuerschlüssel stichprobenhaft im Kontenblatt prüfen. Festgeschriebenes geht nur per Storno." },
      { id: "X6", titel: "Einfuhrumsatzsteuer, Zollbescheide, Importbelege prüfen", art: "manuell", bedingung: "import", hinweis: "Nur bei Warenimporten aus dem Drittland." },
    ],
  },
  {
    nr: 4, gruppe: "Buchhaltung", titel: "Zahlungen zuordnen & verbuchen",
    aufgaben: [
      { id: "D1", titel: "Ungebuchte Zahlungen prüfen und verbuchen", art: "auto", check: "zahlungen_ohne_buchung", werkzeug: "list_transactions, add_transaction_postings", hinweis: "Alle Konten gemeinsam, ungebucht im Monat. 'Gebucht' wird aus den Buchungen abgeleitet (Näherung)." },
      { id: "D2–D3", titel: "Automatisches Matching anstoßen", art: "oberflaeche", hinweis: "Die Bulk-Aktion 'Aktualisieren' für das Belegmatching gibt es nur in der Oberfläche." },
      { id: "D4–D7", titel: "Zahlungen Belegen zuweisen, Sammel-, Teil- und Fremdwährungszahlungen klären", art: "manuell", werkzeug: "assign_receipts_to_transactions", hinweis: "Zuordnung per Tool möglich; die Auswahl des richtigen Belegs trifft der Nutzer." },
      { id: "D9", titel: "Rücklastschriften und Chargebacks verbuchen", art: "manuell", werkzeug: "get_booking_guide storno_ruecklastschrift", hinweis: "Negative Zahlungen mit Chargeback oder Rücklastschrift im Verwendungszweck suchen." },
      { id: "D14", titel: "Bankgebühren, Zinsen, sonstige Finanztransaktionen verbuchen", art: "teilweise", werkzeug: "list_transactions, add_transaction_postings", hinweis: "Beleglose Zahlungen der Bank direkt buchen; Kontierung nach Rücksprache." },
      { id: "D15", titel: "Steuerzahlungen und -erstattungen klären und verbuchen", art: "teilweise", werkzeug: "list_transactions, get_tax_position", hinweis: "Zahlungen an und vom Finanzamt; Steuerart und Zeitraum stehen im Verwendungszweck." },
      { id: "I1-6", titel: "Leasing- und Darlehensraten erfassen", art: "manuell", hinweis: "Tilgung und Zins trennen; nur wenn es Leasing oder Darlehen gibt." },
    ],
  },
  {
    nr: 5, gruppe: "Erweiterte Buchhaltung", titel: "Lohndaten übernehmen & Gehaltszahlungen buchen",
    aufgaben: [
      { id: "F1–F3", titel: "Lohnbuchungsstapel importieren", art: "oberflaeche", bedingung: "lohn", hinweis: "CSV-Import der Lohnbuchungssätze nur in der Oberfläche (Einstellungen, Datenimport)." },
      { id: "F2", titel: "Lohn- und Gehaltszahlungen mit Bankbewegungen abgleichen", art: "manuell", bedingung: "lohn", hinweis: "Nur mit Beschäftigten." },
      { id: "F3", titel: "Lohnaufwandskonten abstimmen", art: "manuell", bedingung: "lohn", hinweis: "Summen gegen das Lohnjournal; nur mit Beschäftigten." },
      { id: "F4", titel: "Lohnverrechnungs- und Verbindlichkeitskonten abstimmen", art: "manuell", bedingung: "lohn", hinweis: "Konten 1740 bis 1759 (SKR03) müssen nach den Zahlungen 0 sein." },
    ],
  },
  {
    nr: 6, gruppe: "Erweiterte Buchhaltung", titel: "Anlagenbuchhaltung",
    aufgaben: [
      { id: "I1-2", titel: "Anlagenzugänge und -abgänge prüfen", art: "manuell", bedingung: "anlagen", hinweis: "Die Anlagenverwaltung gibt es nur in der Oberfläche (get_booking_guide anlagen_browser)." },
      { id: "I1-5", titel: "GWG- und Sammelposten-Grenzen prüfen", art: "manuell", bedingung: "anlagen", hinweis: "Anschaffungen des Monats nach Nettowert einordnen; das Wahlrecht GWG oder Sammelposten gilt je Wirtschaftsjahr einheitlich." },
      { id: "I1-3", titel: "Manuelle Abschreibungen kontrollieren", art: "manuell", bedingung: "anlagen", hinweis: "Nie AfA von Hand buchen für Güter in der Anlagenverwaltung." },
      { id: "I1-4", titel: "Anlagenverzeichnis mit Buchhaltungssalden abstimmen", art: "manuell", bedingung: "anlagen", hinweis: "Abgleich der Anlagenverwaltung mit den Anlagekonten." },
    ],
  },
  {
    nr: 7, gruppe: "Erweiterte Buchhaltung", titel: "Bestandsveränderungen & EU-Warenverbringung",
    aufgaben: [
      { id: "K1", titel: "Bestandsveränderungen buchen", art: "manuell", bedingung: "bilanz", hinweis: "Nur Bilanzierer mit Warenlager (Konten Bestand Waren und Roh-, Hilfs- und Betriebsstoffe)." },
      { id: "K2", titel: "Innergemeinschaftliche Warenverbringung erfassen", art: "manuell", bedingung: "eu", hinweis: "Nur bei eigenen Lagern im EU-Ausland (z. B. FBA)." },
    ],
  },
  {
    nr: 8, gruppe: "Erweiterte Buchhaltung", titel: "Offene Forderungen & Forderungsausfälle",
    aufgaben: [
      { id: "H0", titel: "Offene Forderungen prüfen, überfällige Posten erkennen", art: "manuell", bedingung: "bilanz", hinweis: "Offene-Posten-Liste der Debitoren; gibt es nur mit Debitoren/Kreditoren." },
      { id: "H0b", titel: "Zahlungserinnerungen versenden", art: "oberflaeche", bedingung: "bilanz", hinweis: "Zahlungserinnerung aus der Rechnungsstellung; kein Tool, und Versand nur auf Wunsch des Nutzers." },
      { id: "H5", titel: "Überzahlungen, Chargebacks und ungeklärte Forderungsposten klären", art: "manuell", bedingung: "bilanz", hinweis: "Verwaiste Haben-Salden auf Personenkonten verrechnen oder erstatten." },
      { id: "H6", titel: "Payouts von Zahlungsdienstleistern abstimmen", art: "manuell", bedingung: "bilanz", hinweis: "Payout-Übersicht des Anbieters gegen die Zahlungen in BHB." },
      { id: "H1", titel: "Zweifelhafte Forderungen prüfen und Wertberichtigung berechnen", art: "manuell", bedingung: "bilanz", hinweis: "Nur das Delta zum Vormonat buchen; Berechnung dokumentieren." },
      { id: "H2", titel: "Wertberichtigungen oder Forderungsausfälle buchen", art: "manuell", bedingung: "bilanz", hinweis: "Pauschalwertberichtigung als manuelle Buchung; Konten 996 und 998 (SKR03)." },
    ],
  },
  {
    nr: 9, gruppe: "Erweiterte Buchhaltung", titel: "Periodengerechte Abgrenzung",
    aufgaben: [
      { id: "G2", titel: "Aktive Rechnungsabgrenzung buchen und auflösen", art: "manuell", bedingung: "bilanz", werkzeug: "get_booking_guide rap", hinweis: "Bei EÜR gibt es keine Rechnungsabgrenzung; Konto 980 (SKR03)." },
      { id: "G3", titel: "Passive Rechnungsabgrenzung buchen und auflösen", art: "manuell", bedingung: "bilanz", werkzeug: "get_booking_guide rap", hinweis: "Konto 990 (SKR03); nur Bilanzierer." },
      { id: "G4", titel: "Sonstige Vermögensgegenstände prüfen und buchen", art: "manuell", bedingung: "bilanz", hinweis: "Antizipative Erträge; nur Bilanzierer." },
      { id: "G6", titel: "Sonstige Verbindlichkeiten prüfen und buchen", art: "manuell", bedingung: "bilanz", hinweis: "Antizipative Aufwendungen; nur Bilanzierer." },
    ],
  },
  {
    nr: 10, gruppe: "Abschluss", titel: "Finale Konten- & Saldenabstimmung",
    aufgaben: [
      { id: "J6", titel: "Unbestätigte erweiterte Buchungen prüfen und bestätigen", art: "oberflaeche", hinweis: "Bestätigen (grüner Haken) in der Oberfläche; unbestätigte Buchungen fehlen in Berichten und der SuSa." },
      { id: "J0", titel: "Banksalden final prüfen", art: "auto", saldo: true, werkzeug: "calculate_account_balance", hinweis: "Wie E2, nach dem letzten Buchen: berechneter Stand gegen Kontoauszug zum Stichtag." },
      { id: "J4", titel: "Verrechnungskonten abstimmen", art: "auto", check: "geldtransit_und_interimskonto_saldo", werkzeug: "get_account_ledger", hinweis: "Geldtransit und Interimskonto müssen 0 sein; mit balance_from auf den Beginn des Wirtschaftsjahres. Weitere Verrechnungskonten prüft der Nutzer." },
      { id: "J1", titel: "Nachträgliche Buchungen in abgeschlossenen Perioden prüfen", art: "manuell", werkzeug: "get_report, list_postings", hinweis: "Vormonatssalden gegen die archivierten Werte des letzten Abschlusses; die liegen beim Nutzer." },
      { id: "J5", titel: "BWA, SuSa und offene Posten auf Auffälligkeiten prüfen", art: "teilweise", werkzeug: "get_report, get_controlling", hinweis: "Vergleich mit Vormonaten und ungewöhnliche Salden lassen sich lesen; die Einordnung bleibt beim Nutzer." },
    ],
  },
  {
    nr: 11, gruppe: "Abschluss", titel: "Monatsabschluss & Steuerliche Meldung",
    aufgaben: [
      { id: "I2-4", titel: "Manuell gebuchte Vorsteuer prüfen", art: "teilweise", werkzeug: "audit_vat_period, list_postings", hinweis: "Direktbuchungen auf Vorsteuerkonten ohne Aufwandskonto mit Steuerschlüssel; jede braucht einen Beleg mit ausgewiesener Steuer." },
      { id: "I2-1", titel: "Umsatzsteuer-Voranmeldung auf Plausibilität prüfen", art: "teilweise", werkzeug: "get_ustva_position, audit_vat_period, preview_vat_impact", hinweis: "Kennziffern und Warnhinweise der USt-VA stehen nur in der Oberfläche; audit_vat_period und get_ustva_position liefern Anhaltspunkte, keine Gewissheit." },
      { id: "I2-2", titel: "Zusammenfassende Meldung prüfen, USt-IdNrn. eintragen", art: "manuell", bedingung: "eu", hinweis: "Nur bei steuerfreien EU-Lieferungen und -Leistungen." },
      { id: "I2-3", titel: "OSS-Umsätze nach Land und Steuersatz abstimmen", art: "manuell", bedingung: "oss", hinweis: "Nur bei Umsätzen im One-Stop-Shop (get_booking_guide oss)." },
      { id: "I2-5", titel: "Buchungen festschreiben", art: "oberflaeche", check: "festschreibung", hinweis: "Festschreiben nur in der Oberfläche (Abschluss). Danach nur noch Storno. Das Tool zeigt, ob schon festgeschrieben ist." },
      { id: "I2-6", titel: "Umsatzsteuer-Voranmeldung übermitteln", art: "oberflaeche", hinweis: "Übermittlung an das Finanzamt (ELSTER) macht der Nutzer selbst, nach Festschreiben. Übermittlungsprotokoll ablegen." },
      { id: "I2-7", titel: "Zusammenfassende Meldung übermitteln", art: "oberflaeche", bedingung: "eu", hinweis: "Übermittlung an das BZSt macht der Nutzer selbst, bis zum 25. Tag nach Meldezeitraum." },
    ],
  },
];

export const TASK_IDS = CHECKLIST.flatMap((s) => s.aufgaben.map((t) => t.id));

const NUR_NUTZER = [
  "Buchungen festschreiben (Abschluss)",
  "Umsatzsteuer-Voranmeldung an das Finanzamt übermitteln",
  "Zusammenfassende Meldung übermitteln (falls nötig)",
  "Monat im Abschluss-Cockpit abschließen",
];

export interface KontoStand {
  konto: number;
  name: string;
  berechnet: number;
  auszug: number | null;
  differenz: number | null;
  status: "stimmt" | "abweichung" | "auszugssaldo_fehlt";
}

// Bedingungen, die ohne Debitoren/Kreditoren (EÜR) wegfallen.
const NUR_BILANZ: Bedingung[] = ["bilanz"];

function statusOf(t: TaskDef, ctx: { checks: Map<string, MonthEndCheck>; konten: KontoStand[]; unvollstaendig: boolean; euer: boolean }): { status: TaskStatus; detail?: unknown } {
  if (t.check) {
    const c = ctx.checks.get(t.check);
    if (!c) return { status: "offen" };
    if (t.check === "festschreibung") {
      return { status: c.status === "ok" ? "geprueft_ok" : "nur_oberflaeche", detail: { nicht_festgeschrieben: c.anzahl } };
    }
    if (t.check === "belege_ohne_buchung" && ctx.euer) {
      // Bei EÜR ist ein Beleg ohne Buchung kein Fehler; die Zahl bleibt als Information.
      return { status: "offen", detail: { belege_ohne_buchung: c.anzahl, hinweis: "bei EÜR kein Fehler, zählt über die Zahlung (D1)" } };
    }
    if (t.check === "geldtransit_und_interimskonto_saldo" && c.status === "nicht_pruefbar") return { status: "nicht_zutreffend", detail: c.hinweis };
    return { status: c.status === "ok" ? "geprueft_ok" : "auffaellig", detail: { anzahl: c.anzahl, ...(c.details !== undefined ? { details: c.details } : {}) } };
  }
  if (t.saldo) {
    if (ctx.konten.length === 0) return { status: "offen", detail: "keine Konten gefunden" };
    if (ctx.konten.some((k) => k.status === "abweichung")) return { status: "auffaellig", detail: ctx.konten };
    if (ctx.konten.some((k) => k.status === "auszugssaldo_fehlt")) return { status: "offen", detail: ctx.konten };
    return { status: "geprueft_ok", detail: ctx.konten };
  }
  return { status: t.art === "oberflaeche" ? "nur_oberflaeche" : "offen" };
}

export function createClosingCockpitTools(client: BBClient, policyLoader: () => Promise<Policy> = loadPolicy): [ToolDef] {
  const getClosingChecklist = defineTool({
    name: "get_closing_checklist",
    description:
      "Read-only Monatsabschluss-Checkliste nach dem Abschluss-Cockpit von BuchhaltungsButler (11 Abschnitte, 54 Aufgaben mit den " +
      "Kennungen des Cockpits, z. B. A3, D1, J4, I2-5): je Aufgabe der Status aus API-Daten (geprueft_ok, auffaellig), offen " +
      "(nur der Nutzer kann es beurteilen), nur_oberflaeche (nur in BHB möglich), nicht_zutreffend oder ausgeblendet. Prüfbar " +
      "sind Duplikate, ungebuchte Zahlungen, Geldtransit/Interimskonto, Festschreibestand und Kontostände gegen den Kontoauszug " +
      "(statement_balances je Kontonummer, in Euro, sonst kein Urteil); Belege ohne Buchung zählen bei EÜR nur als Information. " +
      "bereit_fuer_festschreibung ist nur dann true, wenn keine automatische Prüfung auffällt, kein Konto abweicht und kein " +
      "Seitenlimit erreicht wurde; das ist keine Freigabe der Steuerübermittlung, die Liste vom_nutzer_zu_bestaetigen und " +
      "nur_nutzer bleiben. Festschreiben, USt-Voranmeldung, ZM und Monat abschließen kann dieses Tool und die BHB-API nicht. " +
      "Mit der Hausregel debitoren_kreditoren 'aus' (EÜR) sind Forderungen, Abgrenzung und Bestand nicht_zutreffend. " +
      "Das Abhaken im Cockpit hat keine API (Speichern je Abschnitt nur in der Oberfläche mit Browser-Sitzung) und ist ein " +
      "Vermerk des Menschen, kein Prüfergebnis. VOR dem Aufruf den Nutzer fragen, ob Claude die Checkliste selbst abarbeiten " +
      "und berichten soll oder sie zusätzlich als Artefakt bereitstellen soll; Aufbau des Artefakts: get_booking_guide " +
      "abschluss_cockpit. Ändert nichts; liest wie check_month_end viele Seiten (bis 10 je Abfrage). date_from/date_to als YYYY-MM-DD.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      date_from: z.string().describe("YYYY-MM-DD, Monatsanfang."),
      date_to: z.string().describe("YYYY-MM-DD, Monatsende (Stichtag für die Kontostände)."),
      balance_from: z.string().optional().describe("YYYY-MM-DD, Beginn des Wirtschaftsjahres für den Saldo von Geldtransit/Interimskonto."),
      statement_balances: z
        .record(z.string(), z.number())
        .optional()
        .describe("Kontostand laut Kontoauszug zum Stichtag je Buchungskontonummer des Zahlungskontos, z. B. {\"1200\": 4321.09}."),
      hidden_tasks: z
        .array(z.string())
        .optional()
        .describe("Kennungen der Aufgaben, die in BHB (Einstellungen im Cockpit) ausgeblendet sind, z. B. [\"F2\", \"K2\"]."),
      conditions: z
        .array(z.enum(["lohn", "anlagen", "waren", "eu", "oss", "import"]))
        .optional()
        .describe("Was im Unternehmen vorkommt; Aufgaben mit nicht genannter Bedingung gelten als nicht_zutreffend. Ohne Angabe bleiben sie sichtbar (offen)."),
    },
    async handler(args) {
      const policy = await policyLoader();
      const dk = policy.tax_profile.debitoren_kreditoren;
      const euer = dk === "aus";
      const base = await collectMonthEnd(client, args);
      const checks = new Map(base.ergebnisse.map((r) => [r.pruefung, r]));

      const accountsRes = await client.call<{ data?: Array<Record<string, unknown>> }>("accountsGet", {});
      const statements = args.statement_balances ?? {};
      const konten: KontoStand[] = [];
      let kontoUnvollstaendig = false;
      for (const a of accountsRes.data ?? []) {
        const nr = Number(a.postingaccount_number);
        if (!Number.isFinite(nr)) continue;
        const { rows, truncated } = await readAll(client, "transactionsGet", { account: nr, date_to: args.date_to }, 500);
        if (truncated) kontoUnvollstaendig = true;
        const berechnet = Math.round(rows.reduce((s, t) => s + cents(t.amount), 0)) / 100;
        const given = statements[String(nr)];
        konten.push({
          konto: nr,
          name: String(a.name ?? ""),
          berechnet,
          auszug: given ?? null,
          differenz: given === undefined ? null : Math.round((given - berechnet) * 100) / 100,
          status: given === undefined ? "auszugssaldo_fehlt" : Math.abs(given - berechnet) < 0.005 ? "stimmt" : "abweichung",
        });
      }

      const unvollstaendig = (base.unvollstaendig?.length ?? 0) > 0 || kontoUnvollstaendig;
      const hidden = new Set(args.hidden_tasks ?? []);
      const present = args.conditions ? new Set<string>(args.conditions) : undefined;
      const ctx = { checks, konten, unvollstaendig, euer };

      const abschnitte = CHECKLIST.map((s) => ({
        nr: s.nr,
        gruppe: s.gruppe,
        titel: s.titel,
        aufgaben: s.aufgaben.map((t) => {
          let status: TaskStatus;
          let detail: unknown;
          let grund: string | undefined;
          if (hidden.has(t.id)) {
            status = "ausgeblendet";
          } else if (t.bedingung && NUR_BILANZ.includes(t.bedingung) && euer) {
            status = "nicht_zutreffend";
            grund = "Debitoren/Kreditoren sind aus (EÜR): es gibt keine offenen Posten, Abgrenzung oder Bestandsbuchung.";
          } else if (t.bedingung && !NUR_BILANZ.includes(t.bedingung) && present && !present.has(t.bedingung)) {
            status = "nicht_zutreffend";
            grund = `Bedingung "${t.bedingung}" trifft laut Angabe nicht zu.`;
          } else {
            ({ status, detail } = statusOf(t, ctx));
          }
          return {
            id: t.id,
            titel: t.titel,
            art: t.art,
            status,
            ...(grund ? { grund } : {}),
            ...(t.bedingung ? { bedingung: t.bedingung } : {}),
            ...(t.werkzeug ? { werkzeug: t.werkzeug } : {}),
            hinweis: t.hinweis,
            ...(detail !== undefined ? { detail } : {}),
          };
        }),
      }));

      const aufgaben = abschnitte.flatMap((s) => s.aufgaben);
      const zaehlung: Record<string, number> = {};
      for (const a of aufgaben) zaehlung[a.status] = (zaehlung[a.status] ?? 0) + 1;
      const blockierend = aufgaben.filter((a) => a.status === "auffaellig").map((a) => a.id);
      const autoOffen = aufgaben.filter((a) => a.art === "auto" && a.status === "offen").map((a) => a.id);
      const gruende: string[] = [];
      if (blockierend.length > 0) gruende.push(`Auffällig: ${blockierend.join(", ")}`);
      if (autoOffen.length > 0) gruende.push(`Automatische Prüfung ohne Urteil (Kontoauszugssaldo oder Konten fehlen): ${autoOffen.join(", ")}`);
      if (unvollstaendig) gruende.push("Seitenlimit erreicht: Zeitraum verkleinern, sonst sind die Ergebnisse unvollständig.");
      if (dk === null) gruende.push("Hausregel debitoren_kreditoren nicht gesetzt: Aufgaben für Forderungen, Abgrenzung und Bestand sind nicht ausgeschlossen. Nur nach Aussage des Nutzers mit set_policy setzen.");
      const bereit = blockierend.length === 0 && autoOffen.length === 0 && !unvollstaendig;

      return ok({
        zeitraum: base.zeitraum,
        profil: { debitoren_kreditoren: dk, gewinnermittlung_abgeleitet: dk === "aus" ? "EÜR" : dk === "aktiv" ? "Bilanz" : "unbekannt" },
        bereit_fuer_festschreibung: bereit,
        gruende_gegen_festschreibung: gruende,
        vom_nutzer_zu_bestaetigen: aufgaben.filter((a) => a.status === "offen" && a.art !== "auto").map((a) => a.id),
        nur_nutzer: NUR_NUTZER,
        zaehlung,
        konten,
        abschnitte,
        rueckfrage_an_nutzer:
          "Soll ich die Checkliste selbst abarbeiten und dir berichten, oder zusätzlich als Artefakt bereitstellen? (Aufbau: get_booking_guide abschluss_cockpit)",
        hinweis:
          "geprueft_ok heißt nur: nichts Auffälliges in den abgerufenen Daten (Näherung, check_month_end). Die Liste ist ein Abbild des Cockpits (Stand 14.11.2026, Beta); ob BHB sie ändert, zeigt nur ein Blick ins Cockpit. Kein Ersatz für die Prüfung durch den Steuerberater.",
      });
    },
  });
  return [getClosingChecklist];
}
