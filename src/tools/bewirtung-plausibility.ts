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
