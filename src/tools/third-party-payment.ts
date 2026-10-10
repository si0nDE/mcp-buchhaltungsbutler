// "Dritter zahlt": Aufwand mit Vorsteuer, Gegenbuchung auf das Interimskonto (SKR03 1590, SKR04 1370), siehe get_booking_guide
// gegenertrag_interimskonto. Bei Ist-Versteuerung zählt der Zahlungszeitpunkt, nicht das Rechnungsdatum. Der Konnektor kann das
// Muster nur an Konto und Vorsteuercode erkennen und stellt deshalb eine Rückfrage statt eine Annahme zu treffen.

const INTERIM_ACCOUNTS = new Set([1590, 1370]);

export function thirdPartyPaymentWarnings(
  postings: Array<{ date: string; postingaccount_debit: number; postingaccount_credit: number; vat: string }>
): string[] {
  const hits = postings.filter(
    (p) => INTERIM_ACCOUNTS.has(p.postingaccount_credit) && !INTERIM_ACCOUNTS.has(p.postingaccount_debit) && /_pre$/.test(p.vat)
  );
  if (hits.length === 0) return [];
  const dates = [...new Set(hits.map((h) => h.date))].join(", ");
  return [
    `Frage vor dem Buchen: ${hits.length} Buchung(en) mit Vorsteuer über das Interimskonto (Datum ${dates}). Zahlt ein Dritter (Kostenübernahme, Forderungskauf)? ` +
      "Bei Ist-Versteuerung zählt das Zahlungsdatum, ein Rechnungsdatum nahe am Quartalsende kann die Vorsteuer ins falsche Quartal legen. " +
      "Zahlungsdatum erfragen. Ist es unbekannt, mit Rechnungsdatum buchen und am Beleg vermerken: add_comment, comment_text " +
      "'Datum = Rechnungsdatum, Zahlungsdatum Dritter unbekannt' (get_booking_guide gegenertrag_interimskonto). Ist es kein Dritter-zahlt-Fall, ignorieren.",
  ];
}
