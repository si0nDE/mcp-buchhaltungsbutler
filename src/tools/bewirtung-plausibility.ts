// Pure plausibility checks for Bewirtung receipts. No API calls.
const ISO = /^(\d{4})-(\d{2})-(\d{2})/;
const GERMAN = /^(\d{2})\.(\d{2})\.(\d{4})/;

// "2026-07-29", "2026-07-29 00:00:00" or "29.07.2026" -> UTC day number, otherwise undefined.
export function parseFlexibleDate(text: string): number | undefined {
  const trimmed = text.trim();
  const iso = ISO.exec(trimmed);
  const de = iso ? null : GERMAN.exec(trimmed);
  const parts = iso ? [iso[1], iso[2], iso[3]] : de ? [de[3], de[2], de[1]] : undefined;
  if (!parts) return undefined;
  const [y, m, d] = parts.map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  // Reject impossible dates such as 31.02. instead of silently rolling them over.
  if (Number.isNaN(ms) || check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return undefined;
  }
  return Math.floor(ms / 86_400_000);
}

export function daysBetween(a: string, b: string): number | undefined {
  const da = parseFlexibleDate(a);
  const db = parseFlexibleDate(b);
  return da === undefined || db === undefined ? undefined : Math.abs(da - db);
}

export const TRANSACTION_DATE_TOLERANCE_DAYS = 3;

export function transactionDateWarnings(bewirtungDate: string, transactionDate: string | undefined): string[] {
  if (!transactionDate) return [];
  const days = daysBetween(bewirtungDate, transactionDate);
  if (days === undefined || days <= TRANSACTION_DATE_TOLERANCE_DAYS) return [];
  return [
    `Die Banktransaktion liegt ${days} Kalendertage vom Bewirtungsdatum entfernt (Kartenbuchungen laufen typischerweise 1–2 Tage nach): ` +
      "prüfen, ob es die richtige Zahlung ist.",
  ];
}

export const ZEITNAH_LIMIT_DAYS = 10;

// Not a legal deadline: GoBD Rz. 47 regards the recording of non-cash transactions within ten days as unobjectionable.
export function zeitnahWarning(bewirtungDate: string, now: Date = new Date()): string | undefined {
  const bewirtung = parseFlexibleDate(bewirtungDate);
  if (bewirtung === undefined) return undefined;
  const today = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000);
  const days = today - bewirtung;
  if (days <= ZEITNAH_LIMIT_DAYS) return undefined;
  return (
    `Die Bewirtungsangaben entstehen ${days} Tage nach der Bewirtung. Der BMF-Erlass vom 19.11.2025 verlangt zeitnahe Angaben ` +
    `(Rn. 1 und 22). Orientierung an GoBD Rz. 47 (10 Tage), keine Frist speziell für Bewirtungsbelege.`
  );
}

const KNOWN_RATES = [0, 5, 7, 16, 19];
function snapRate(net: number, vat: number): number | undefined {
  if (net <= 0) return undefined;
  const raw = (vat / net) * 100;
  const nearest = KNOWN_RATES.reduce((best, r) => (Math.abs(r - raw) < Math.abs(best - raw) ? r : best));
  return Math.abs(nearest - raw) <= 0.5 ? nearest : undefined;
}

// Two levels: a conflict warning only for rates that can never be right; a soft hint for 7 % on food in 2024/2025
// (takeaway food is a delivery, UStAE 3.6, and was taxed at 7 % throughout). Drinks are not checked.
export function vatRatePlausibility(input: {
  date: string;
  foodNet: number;
  foodVat: number;
  drinksNet: number;
  drinksVat: number;
}): { warnings: string[]; hints: string[] } {
  const warnings: string[] = [];
  const hints: string[] = [];
  const day = parseFlexibleDate(input.date);
  const rate = snapRate(input.foodNet, input.foodVat);
  if (day === undefined || rate === undefined) return { warnings, hints };
  const from = (iso: string) => parseFlexibleDate(iso)!;
  if (rate === 19 && day >= from("2026-01-01")) {
    warnings.push(
      "Speisen mit 19 % ab 01.01.2026: Restaurationsleistungen (Speisen) unterliegen seit 01.01.2026 7 % (§ 12 Abs. 2 Nr. 15 UStG), " +
        "Abgabe zum Mitnehmen ohnehin 7 %. Rechnung korrigieren lassen, sonst selbst aufteilen (Dennerlein Q31)."
    );
  }
  if (rate === 7 && day >= from("2020-07-01") && day <= from("2020-12-31")) {
    warnings.push("Speisen mit 7 % im 2. Halbjahr 2020: in diesem Zeitraum galten 5 % (§ 28 Abs. 2 UStG).");
  }
  if (rate === 7 && day >= from("2024-01-01") && day <= from("2025-12-31")) {
    hints.push("7 % auf Speisen ist bei Abgabe zum Mitnehmen korrekt (Lieferung, UStAE 3.6); bei Verzehr vor Ort wären 19 % zu erwarten.");
  }
  return { warnings, hints };
}

export function largeAmountNotice(grossInclTip: number): string | undefined {
  if (grossInclTip <= 250) return undefined;
  return (
    "Gesamtbetrag inklusive Trinkgeld über 250 €: die Rechnung braucht zusätzlich Steuernummer oder USt-IdNr., eine fortlaufende " +
    "Rechnungsnummer und den Namen des Bewirtenden als Leistungsempfänger (BMF 19.11.2025 Rn. 9 bis 12)."
  );
}

// Every date that appears in the text, as ISO, unique and sorted. A text layer can contain several legitimate dates
// (Rechnungsdatum, Fälligkeit); the caller only warns, never decides.
export function extractDateCandidates(text: string): string[] {
  const found = new Set<string>();
  const add = (y: number, m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    found.add(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  };
  for (const m of text.matchAll(/(?<!\d)(\d{2})\.(\d{2})\.(\d{4})(?!\d)/g)) add(Number(m[3]), Number(m[2]), Number(m[1]));
  for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) add(Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(/(?<![\d.])(\d{2})\.(\d{2})\.(\d{2})(?![\d.])/g)) add(2000 + Number(m[3]), Number(m[2]), Number(m[1]));
  return [...found].sort();
}
