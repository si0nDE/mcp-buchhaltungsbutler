// BuchhaltungsButler-specific bookkeeping rules that the API does not enforce or document in its schema,
// taken from BHB's Wissensdatenbank (Steuerschlüssel/§13b, abweichendes Leistungsdatum, Ist/Soll,
// Anfangsbestände, Saldovortrag USt/VSt, Zahlungszuordnung am Beleg). See docs/bhb-systematik.md.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const VAT_CODE_GUIDE =
  "VAT code, not a percentage. 0_none = keine USt./VSt. - also for foreign VAT you cannot claim in Germany " +
  "(e.g. 19% Irish VAT on a Google invoice) and for neutral postings (payments, opening balances, VAT account balances). " +
  "19_vat/7_vat = Umsatzsteuer (Erlöskonten); 19_pre/7_pre = Vorsteuer (Aufwandskonten) - Aufwandskonten only take " +
  "Vorsteuer, Ertragskonten only Umsatzsteuer. Reverse charge: *_both_2 / 7_both = i.g.E. (innergemeinschaftlicher " +
  "Erwerb) - ONLY for goods bought in the EU, never for services; 19_both_1 / 19_both_506 = §13b sonstige Leistung of an " +
  "EU business (Sachverhalt 7), 19_both_511 = §13b \"Andere Leistungen\" (u. a. Drittland, § 13b Abs. 2 Nr. 1; USt-VA Kz 84/85 + Vorsteuer Kz 67, im Entwurf bestätigt; 19_both_506 landet in Kz 46/47, 19_both_1 nicht geprüft; get_booking_guide reverse_charge_drittland); suffix _no_pre / 65xx = Umsatzsteuer without Vorsteuer; " +
  "suffix _app / *_pre_app = aufzuteilende Vorsteuer (parked on a receivables account, reclassified to Abziehbare " +
  "Vorsteuer at year end). Other §13b cases (e.g. Bauleistungen, Gebäudereinigung) are NOT reachable via the code - " +
  "book them on the matching DATEV Automatikkonto (find it via list_posting_accounts search). For 2020 bookings " +
  "see get_booking_guide topic mwst_senkung_2020 (whether the 19_*/7_* codes follow the date is not documented). Codes 57-59 (i.g.E./§13b with " +
  "aufzuteilende Vorsteuer) are BHB-defined; the Steuerberater must create them in their software before import. " +
  "OSS (One-Stop-Shop) codes vat_oss_deli_deeu/_eueu/_eude/_eude_19 and vat_oss_serv_deeu/_eueu need OSS activated in " +
  "the tax settings and the fields oss_origin_country + oss_destination_country (ISO alpha-2, EU, not identical) plus " +
  "oss_vat_rate (the rate of the destination country on the delivery date); vat_oss_deli_eude_19 has a fixed 19% and " +
  "needs no rate.";

export const OSS_VAT_CODES = [
  "vat_oss_deli_deeu",
  "vat_oss_deli_eueu",
  "vat_oss_serv_deeu",
  "vat_oss_serv_eueu",
  "vat_oss_deli_eude",
  "vat_oss_deli_eude_19",
] as const;

// BHB answers a missing/invalid OSS field with error codes 47/49 only after the round trip; fail early and plain.
export function assertOssFields(
  vat: string,
  oss: { oss_origin_country?: string | null; oss_destination_country?: string | null; oss_vat_rate?: string | null },
  label: string
): void {
  const isOss = (OSS_VAT_CODES as readonly string[]).includes(vat);
  const filled = (v: string | null | undefined) => v !== undefined && v !== null && v !== "";
  if (!isOss) return;
  if (!filled(oss.oss_origin_country) || !filled(oss.oss_destination_country)) {
    throw new Error(`${label}: ${vat} braucht oss_origin_country und oss_destination_country (ISO-Alpha-2, z. B. "DE", "FR").`);
  }
  if (oss.oss_origin_country === oss.oss_destination_country) {
    throw new Error(
      `${label}: Ursprungs- und Bestimmungsland sind identisch ("${oss.oss_origin_country}") - ein Umsatz im Abgangsland wird dort ` +
        "besteuert und nicht über den One-Stop-Shop gemeldet."
    );
  }
  if (vat !== "vat_oss_deli_eude_19" && !filled(oss.oss_vat_rate)) {
    throw new Error(`${label}: ${vat} braucht oss_vat_rate (Steuersatz des Bestimmungslandes zum Lieferdatum, z. B. "20.00").`);
  }
}

export const DATE_DELIVERY_GUIDE =
  "Abweichendes Leistungsdatum, YYYY-MM-DD. Must NOT be after the receipt date (DATEV compatibility) - otherwise " +
  "use the Leistungsdatum as receipt date. Only honoured for receipts booked on a Debitor/Kreditor; without a " +
  "deviating date the receipt date counts everywhere. Effects: BWA by Leistungsdatum; USt in the UStVA by " +
  "Leistungsdatum (outgoing, Debitor only); Vorsteuer always by receipt date; Zusammenfassende Meldung and " +
  "Kontenblätter/SuSa by receipt date unless evaluated with base=date_delivery_else_date (get_account_ledger/" +
  "create_report) - otherwise SuSa can differ from the UStVA, and the UStVA is the correct one. " +
  "For a ZM-relevant service in another EU state set the receipt date to the date of the service.";

const isIso = (v: string | undefined): v is string => v !== undefined && ISO_DATE.test(v);

// BHB rejects such a receipt with "invalid date delivery"; failing here gives a precise message
// before anything is sent.
export function assertDeliveryDate(
  entry: { date?: string; date_delivery?: string },
  label: string
): void {
  if (!isIso(entry.date) || !isIso(entry.date_delivery)) return;
  if (entry.date_delivery > entry.date) {
    throw new Error(
      `${label}: date_delivery (${entry.date_delivery}) liegt nach dem Belegdatum (${entry.date}). BuchhaltungsButler ` +
        "akzeptiert das aus DATEV-Kompatibilität nicht - das Leistungsdatum als Belegdatum verwenden."
    );
  }
}

// /invoices/create* silently ignores a date_of_supply after the invoice date and does not copy a period
// ("01.-31.03.") into the receipt's date_delivery. Silently means the UStVA would use the invoice date,
// so report it instead of letting it pass unnoticed.
export function supplyDateWarnings(entry: { date: string; date_of_supply?: string }): string[] {
  const supply = entry.date_of_supply;
  if (supply === undefined || supply.trim() === "") return [];
  if (!ISO_DATE.test(supply)) {
    return [
      `date_of_supply "${supply}" ist kein Datum YYYY-MM-DD: wird nur auf dem PDF angezeigt, aber nicht als ` +
        "Leistungsdatum (date_delivery) am Beleg übernommen - die USt wird dann zum Rechnungsdatum berechnet.",
    ];
  }
  if (ISO_DATE.test(entry.date) && supply > entry.date) {
    return [
      `date_of_supply (${supply}) liegt nach dem Rechnungsdatum (${entry.date}) und wird von BuchhaltungsButler ` +
        "ignoriert (DATEV-Kompatibilität) - die USt wird zum Rechnungsdatum berechnet.",
    ];
  }
  return [];
}

// Anlagenverwaltung (Anlagegüter, GWG, Sammelposten): exists in the BHB UI only - the API has no endpoint for it.
// There the asset is captured in a dialog right after confirming a booking on an Anlagenkonto, and BHB then books
// the monthly depreciation itself. A booking made through the API skips that dialog, so no asset exists and no
// depreciation is generated. Anlagevermögen sits in class 0 of SKR03 (0001-0599) and SKR04 (from 0001); the range
// stops at 0599 so SKR03's Verbindlichkeiten/Kapital (06xx-09xx) are not flagged.
export const ANLAGEN_ACCOUNT_MAX = 599;

export const ANLAGEN_GUIDE =
  "Anlagenverwaltung (Anlagegüter, GWG, Sammelposten) is a BuchhaltungsButler UI feature without API endpoints: " +
  "assets are captured in a dialog after confirming a booking on an Anlagenkonto, and BuchhaltungsButler then books " +
  "the monthly Abschreibung itself (also backdated to the purchase month; Grundstücke/Gebäude via 'nicht abschreiben'; " +
  "GWG as Sammelposten over 5 years or Sofortabschreibung). Ausbuchen works the same way on the sale booking (Buchgewinn/" +
  "-verlust is derived there). 'Anlage löschen' stops further depreciation but keeps booked ones. Via API a booking on an " +
  "Anlagenkonto creates NO asset and NO depreciation - do not book Abschreibung manually for assets that are or will " +
  "be in the Anlagenverwaltung (double depreciation); tell the user to capture the asset in the UI. The browser " +
  "route (also for taking over existing assets) is in get_booking_guide topic anlagen_browser.";

export function anlagenWarnings(accountNumbers: number[]): string[] {
  const hit = [...new Set(accountNumbers.filter((n) => n >= 1 && n <= ANLAGEN_ACCOUNT_MAX))];
  if (hit.length === 0) return [];
  return [
    `Konto ${hit.join(", ")} gehört zum Anlagevermögen. Per API wird dadurch KEIN Anlagegut in der Anlagenverwaltung ` +
      "angelegt und es entstehen keine automatischen Abschreibungsbuchungen. Den Nutzer bitten, das Anlagegut in " +
      "BuchhaltungsButler zu erfassen (Dialog „Erfassen\" nach Bestätigung der Buchung bzw. „Bestehendes Anlagegut " +
      "übernehmen\"; Ablauf: get_booking_guide anlagen_browser), und keine Abschreibung manuell nachbuchen, solange die Anlage " +
      "dort geführt wird (Doppelabschreibung).",
  ];
}

// Ausgangsrechnungen mit 5,5 % / 10,7 % USt lassen sich in BuchhaltungsButler nicht verbuchen (nur Eingangsrechnungen
// über einen Split-Workaround). The invoice itself can still be created, so warn instead of blocking.
const UNBOOKABLE_RATES = [5.5, 10.7];
export function unbookableRateWarnings(items: Array<{ vat: string }>): string[] {
  const hit = [...new Set(items.map((i) => Number(String(i.vat).replace(",", "."))).filter((v) => UNBOOKABLE_RATES.includes(v)))];
  if (hit.length === 0) return [];
  return [
    `Steuersatz ${hit.join(" / ")} %: Ausgangsrechnungen mit diesem Satz lassen sich in BuchhaltungsButler derzeit nicht verbuchen ` +
      "(nur Eingangsrechnungen über einen Split-Workaround, siehe get_booking_guide steuersatz_5_5_10_7). Rechnung nur erstellen, " +
      "wenn die Verbuchung anderweitig geklärt ist.",
  ];
}

// Debitoren/Kreditoren-Personenkonten liegen bei DATEV/BHB ab 10000. Ein Ausgleich über das erweiterte Buchen löst unter
// Ist-Versteuerung keine Umbuchung der USt nicht fällig -> fällig aus und gleicht den Beleg nicht aus.
export const PERSONENKONTO_MIN = 10000;
export function personenkontoWarnings(accountNumbers: number[]): string[] {
  const hit = [...new Set(accountNumbers.filter((n) => n >= PERSONENKONTO_MIN))];
  if (hit.length === 0) return [];
  return [
    `Konto ${hit.join(", ")} ist ein Debitoren-/Kreditorenkonto. Eine freie Buchung darauf gleicht keinen Beleg aus und löst ` +
      "unter Ist-Versteuerung keine Umbuchung der Umsatzsteuer (nicht fällig -> fällig) aus. Zum Ausgleich einer " +
      "debitorisch/kreditorisch gebuchten Rechnung die Zahlung buchen (add_transaction_postings, confirm_payment); für " +
      "Anfangsbestände ist es in Ordnung (siehe get_booking_guide ist_versteuerer_debitoren).",
  ];
}

// Kontonummern, die für individuelle Sachkonten gesperrt sind (BHB-Artikel "Individuelle Sachkonten anlegen"): die Konten
// existieren schon und werden nur sichtbar, wenn ein Geschäftsvorfall sie berührt (Steuerkonten), oder der Kontenrahmen
// sperrt sie für andere Funktionen. Die Kontenrahmen überschneiden sich in den Nummern, deshalb sperrt der Konnektor
// nicht vorab, sondern ergänzt den Hinweis erst, wenn BuchhaltungsButler das Anlegen ablehnt.
export const LOCKED_SACHKONTEN = {
  SKR03: [1400, 1512, 1517, 1572, 1574, 1577, 1578, 1579, 1589, 1600, 1712, 1717, 1763, 1765, 1771, 1772, 1773, 1774, 1775, 1776, 1777, 1778, 1779, 1785, 1786, 1787, 3089, 3151, 3152, 3154, 3155, 3440, 3553, 3732, 3735, 3737, 3739, 3740, 3742, 3747, 3749, 3792, 3793, 8333, 8340, 8732, 8735, 8747, 8749, 9303, 9313, 9314, 9333, 9334, 9336],
  SKR04: [1200, 1182, 1184, 1402, 1404, 1407, 1408, 1409, 3261, 3270, 3300, 3801, 3802, 3803, 3804, 3805, 3806, 3807, 3808, 3809, 3813, 3815, 3835, 3836, 3837, 3838, 4333, 4340, 4732, 4735, 4747, 4749, 5189, 5440, 5553, 5732, 5735, 5737, 5739, 5740, 5742, 5747, 5749, 5792, 5793, 5951, 5952, 5954, 5955, 9303, 9304, 9313, 9314, 9333, 9334, 9336],
} as const;

export function lockedAccountHint(account: number): string | undefined {
  const charts = (Object.keys(LOCKED_SACHKONTEN) as Array<keyof typeof LOCKED_SACHKONTEN>).filter((k) =>
    (LOCKED_SACHKONTEN[k] as readonly number[]).includes(account)
  );
  if (charts.length === 0) return undefined;
  return (
    `Die Nummer ${account} steht in BuchhaltungsButlers Liste gesperrter Kontonummern für individuelle Sachkonten (${charts.join(" und ")}): ` +
    "diese Konten existieren bereits oder sind für andere Funktionen reserviert (z. B. Umsatzsteuerkonten, die über den " +
    "Steuerschlüssel mitgebucht werden). Eine freie Nummer im selben Nummernkreis wie das Vorlagekonto wählen."
  );
}

// BuchhaltungsButler nimmt keine Zahlungen über 0,00 EUR an (buchhalterisch nicht relevant, nicht buchbar) und begrenzt den
// Verwendungszweck auf 500 Zeichen (Artikel "Kontoauszüge manuell importieren").
export const PURPOSE_MAX = 500;
export function assertTransactionEntry(
  entry: { amount: number; purpose?: string; to_from?: string },
  label: string
): void {
  if (entry.amount === 0) {
    throw new Error(
      `${label}${entry.to_from ? ` (${entry.to_from})` : ""}: Betrag 0,00 - BuchhaltungsButler kann Zahlungen ohne Betrag nicht verbuchen; weglassen.`
    );
  }
  if (entry.purpose !== undefined && entry.purpose.length > PURPOSE_MAX) {
    throw new Error(`${label}: purpose hat ${entry.purpose.length} Zeichen, erlaubt sind höchstens ${PURPOSE_MAX}.`);
  }
}

// BHB's booking errors name the problem but not the fix. These hints turn the known ones into a concrete
// correction, so a retry works at once instead of after guessing (a wrong vat code in a parallel batch
// otherwise fails every call the same way).
const BOOKING_ERROR_HINTS: Array<[RegExp, string]> = [
  [
    /pre tax/i,
    "Hinweis: Aufwandskonten verlangen Vorsteuer - vat \"19_pre\" oder \"7_pre\" (bzw. \"0_none\"). \"19_vat\"/\"7_vat\" gilt nur für Erlöskonten.",
  ],
  [
    /invalid vat/i,
    "Hinweis: vat ist ein Code, keine Prozentzahl. Aufwand: 19_pre, 7_pre; Erlös: 19_vat, 7_vat; steuerfrei/neutral: 0_none (nicht \"19_pre_tax\" oder \"19\").",
  ],
  [
    /sum.*(does not|doesn't) match|does not match.*transaction amount/i,
    "Hinweis: Die Summe der Splits muss dem Zahlungsbetrag entsprechen (Beträge positiv angeben).",
  ],
];

export function bookingErrorHint(message: string): string | undefined {
  return BOOKING_ERROR_HINTS.find(([re]) => re.test(message))?.[1];
}

// Runs a booking call and appends the matching hint to a BHB error message. Other errors pass through.
export async function withBookingHints<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Error) {
      const hint = bookingErrorHint(error.message);
      if (hint && !error.message.includes(hint)) error.message = `${error.message} ${hint}`;
    }
    throw error;
  }
}

export function withWarnings(result: unknown, warnings: string[]): unknown {
  if (warnings.length === 0) return result;
  return { ...(result as Record<string, unknown>), warnings };
}

// Sent as MCP server `instructions`, so an agent sees the system logic once instead of rediscovering it
// per tool failure. Keep it short; details live in the tool descriptions and docs/bhb-systematik.md.
export const SERVER_INSTRUCTIONS = [
  "BuchhaltungsButler (BHB) logic to respect:",
  "- Order per receipt: check receipt -> book receipt (Debitor/Kreditor) -> assign payment -> book payment. Assigning a " +
    "payment creates NO posting; only booking settles the Debitor/Kreditor. The display 'unter-/überzahlt' only compares " +
    "invoice and payment amount - Skonto, payment-provider fees or Sammelzahlung make it wrong; ignore it then.",
  "- Ist/Soll-Versteuerung is calculated at evaluation time, not booked. Switching changes past evaluations too " +
    "(UStVA, Kontenblätter): always evaluate a period with the Besteuerungsart that applied to it. Soll needs " +
    "Debitoren/Kreditoren.",
  "- Abweichendes Leistungsdatum (date_delivery) must not be after the receipt date and only counts for receipts booked " +
    "on Debitor/Kreditor.",
  "- vat is a code (see add_*_postings), not a percentage. Foreign VAT -> 0_none; i.g.E. only for goods; code §13b: " +
    "19_both_1/19_both_506 for EU services (Sachverhalt 7, Kz 46/47), 19_both_511 for \"Andere Leistungen\" incl. Drittland (Kz 84/85), other §13b cases need the DATEV Automatikkonto.",
  "- Year change: Erlös/Aufwand and all USt/VSt accounts start at 0; Bestandskonten, Basiskonten and Debitoren/Kreditoren " +
    "carry over. Opening balances (EB-Werte) go against 9000 (Saldenvortrag; 9090 for in-year totals) dated 31.12. of " +
    "the previous year; bank/cash opening balance = manual transaction on that day, posted against 9000. A USt/VSt " +
    "balance is NOT carried over automatically (see add_free_postings). Ask the Steuerberater before booking these.",
  "- Anlagenverwaltung exists only in the BHB UI (no API): bookings on Anlagenkonten create no asset and no automatic " +
    "monthly depreciation, so never book Abschreibung manually for such assets. Capturing assets works in the browser " +
    "(get_booking_guide anlagen_browser has the full procedure).",
  "- Bilanzierer book the receipt (add_receipt_postings on a Debitor/Kreditor) and then the settlement; EÜR users book only " +
    "payments (add_transaction_postings). A receipt counts as booked when its payment is booked, except a payment booked " +
    "only against a Debitor/Kreditor. check_month_end runs the monthly-close checks the API allows; fixing/UStVA are UI only.",
  "- Settling a Debitor/Kreditor receipt is always booked WITHOUT tax (0_none) against the personal account; BHB refuses " +
    "booking a payment on expense/revenue when its receipt sits on a Debitor/Kreditor. Reports (create_report) only contain " +
    "CONFIRMED postings. Deleting a receipt never gives upload quota back and BHB does not warn about duplicate uploads: check " +
    "list_receipts first. get_ustva_position tells which USt-VA field an account lands in; calculate_account_balance is " +
    "'Kontostand berechnen'.",
  "- Special cases (Skonto, Geldtransit between payment accounts, Auslagen, RAP, Differenzbesteuerung, OSS, foreign " +
    "currency, Lohn, Stornos, ...): call get_booking_guide first - it holds BHB's documented booking rules and accounts.",
  "- PayPal Business Debit cashback (to_from 'PayPal Inc Debit Card', type 'Cash Back Bonus'): one split on Sonstige Erträge " +
    "2700 | 4830, vat 0_none, no receipt, text 'PayPal Business Debit Cashback' - not steuerbar, no Vorsteuer correction " +
    "(get_booking_guide paypal_cashback). list_transactions/get_transaction flag it as booking_hints.",
  "- Transfers between Zahlungskonten are never booked directly: both sides go against Geldtransit 1360 | 1460. Skonto " +
    "is a negative split with the receipt's tax rate on the settling payment, never a reduced receipt.",
  "- Fixed (festgeschrieben) postings are corrected by a reversal posting (cancel_posting does this only for ids the user " +
    "approved), never silently removed.",
  "- Evaluations (create_report/get_report/get_account_ledger): generated asynchronously, a new report of a type replaces " +
    "the previous one; use base=date_delivery_else_date to follow the Leistungsdatum like the USt-Voranmeldung.",
].join("\n");
