// Warnungen beim Buchen von Zahlungen/freien Buchungen mit Beleg, die ohne Beleg-Volltext und Lieferantenland auskommen:
//  W4: § 13b-Schlüssel, aber Leistungs-/Belegdatum und Zahlungsdatum liegen in verschiedenen Quartalen oder Jahren. BHB bucht nach
//      Zahlungsdatum, die Steuer entsteht nach § 13b Abs. 1/2 mit Leistung bzw. Rechnung (spätestens Folgemonat): die Meldeperiode weicht ab.
//  W3: Fremdwährungsbeleg, dessen Umrechnungskurs mehr als 5 % vom Median der zeitlich nächsten Belege desselben Lieferanten abweicht.
// Beides sind nur Hinweise: nichts wird geändert oder blockiert, Abruffehler werden verschluckt (dann gibt es keine Warnung).
// Hintergrund und Grenzen: get_booking_guide reverse_charge_drittland und lieferantenportal_abgleich.

import type { BBClient, BBListResult } from "../bb-client/client.js";

// §13b-Schlüssel der vat-Liste (Sachverhalt 7, Drittland/Andere Leistungen, jeweils auch mit Vorsteueraufteilung).
const REVERSE_CHARGE_VATS = new Set([
  "19_both_1",
  "19_both_506",
  "19_both_6506",
  "19_both_511",
  "19_both_6511",
  "19_both_6501",
  "19_both_1_no_pre",
  "19_both_app_1",
  "19_both_app_506",
  "19_both_app_511",
]);

export const RATE_OUTLIER_THRESHOLD = 0.05;
const MIN_NEIGHBOURS = 3;
const MAX_NEIGHBOURS = 5;
// Höchstens so viele Beleg-Abrufe je Toolaufruf (Belege selbst plus Nachbarn).
const MAX_RECEIPT_LOOKUPS = 24;

export interface CheckSplit {
  vat: string;
  receipt_id_by_customer?: number;
}

export interface CheckItem {
  label: string;
  // Zahlungsdatum, wenn bekannt (freie Buchung); sonst wird die Transaktion nachgeschlagen.
  paymentDate?: string;
  transactionId?: number;
  splits: CheckSplit[];
}

interface ReceiptData {
  date?: string;
  delivery_date?: string | null;
  date_delivery?: string | null;
  counterparty?: string;
  amount?: string;
  amount_original?: string | null;
  currency_original?: string | null;
  exchangerate?: string | number | null;
}

export function isReverseChargeVat(vat: string): boolean {
  return REVERSE_CHARGE_VATS.has(vat);
}

export function quarterOf(date: string): string | undefined {
  const m = /^(\d{4})-(\d{2})/.exec(date);
  if (!m) return undefined;
  return `${m[1]}-Q${Math.floor((Number(m[2]) - 1) / 3) + 1}`;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function rateOf(r: ReceiptData): number | undefined {
  const n = Number(r.exchangerate);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function isForeign(r: ReceiptData): boolean {
  return !!r.currency_original && r.currency_original !== "EUR" && rateOf(r) !== undefined;
}

export async function receiptCheckWarnings(client: BBClient, items: CheckItem[]): Promise<string[]> {
  try {
    return await run(client, items);
  } catch {
    return [];
  }
}

async function run(client: BBClient, items: CheckItem[]): Promise<string[]> {
  const warnings: string[] = [];
  let lookups = 0;
  const receipts = new Map<number, ReceiptData | undefined>();
  const getReceipt = async (id: number) => {
    if (receipts.has(id)) return receipts.get(id);
    if (lookups >= MAX_RECEIPT_LOOKUPS) return undefined;
    lookups++;
    const data = await client
      .call<{ data?: ReceiptData }>("receiptsGetIdByCustomer", {}, { idSuffix: id })
      .then((r) => r.data)
      .catch(() => undefined);
    receipts.set(id, data);
    return data;
  };

  const quarterShifts: string[] = [];
  const outliers: string[] = [];
  const checkedRates = new Set<number>();

  for (const item of items) {
    const withReceipt = item.splits.filter((s) => s.receipt_id_by_customer !== undefined);
    if (withReceipt.length === 0) continue;

    let paymentDate = item.paymentDate;
    const needsDate = withReceipt.some((s) => isReverseChargeVat(s.vat));
    if (paymentDate === undefined && needsDate && item.transactionId !== undefined) {
      paymentDate = await client
        .call<{ data?: { booking_date?: string } }>("transactionsGetIdByCustomer", {}, { idSuffix: item.transactionId })
        .then((r) => r.data?.booking_date)
        .catch(() => undefined);
    }

    for (const split of withReceipt) {
      const id = split.receipt_id_by_customer as number;
      const receipt = await getReceipt(id);
      if (!receipt) continue;

      if (isReverseChargeVat(split.vat) && paymentDate) {
        const serviceDate = receipt.delivery_date ?? receipt.date_delivery ?? receipt.date;
        const qs = serviceDate ? quarterOf(serviceDate) : undefined;
        const qp = quarterOf(paymentDate);
        if (qs && qp && qs !== qp) quarterShifts.push(`Beleg ${id} (${item.label}): Leistung/Beleg ${qs}, Zahlung ${qp}`);
      }

      if (isForeign(receipt) && !checkedRates.has(id)) {
        checkedRates.add(id);
        const message = await rateOutlier(client, id, receipt, getReceipt);
        if (message) outliers.push(message);
      }
    }
  }

  if (quarterShifts.length > 0) {
    warnings.push(
      `§ 13b: Meldeperiode weicht ab (${quarterShifts.join("; ")}). BHB bucht nach Zahlungsdatum, die Steuer entsteht nach § 13b Abs. 1 mit ` +
        "Ablauf des Voranmeldungszeitraums der Leistung, nach Abs. 2 Nr. 1 mit der Rechnung (spätestens im Folgemonat). Die Zahllast bleibt neutral, nur " +
        "der Meldezeitraum unterscheidet sich. Nicht umdatieren: Entscheidung beim Nutzer bzw. Steuerberater (get_booking_guide reverse_charge_drittland)."
    );
  }
  if (outliers.length > 0) {
    warnings.push(
      `Kurs auffällig (> ${RATE_OUTLIER_THRESHOLD * 100} % vom Median der Nachbarbelege): ${outliers.join("; ")}. ` +
        "Abbuchungsbetrag gegen den Bank-/Kartenumsatz prüfen, es kann ein echter Kartenumsatz mit Gebühren sein. Nichts wurde geändert."
    );
  }
  return warnings;
}

async function rateOutlier(
  client: BBClient,
  id: number,
  receipt: ReceiptData,
  getReceipt: (id: number) => Promise<ReceiptData | undefined>
): Promise<string | undefined> {
  if (!receipt.counterparty || !receipt.date) return undefined;
  const list = await client
    .call<BBListResult>("receiptsGet", { list_direction: "inbound", counterparty: receipt.counterparty, limit: 100, offset: 0 })
    .catch(() => undefined);
  if (!list) return undefined;
  const target = Date.parse(receipt.date);
  const candidates = list.data
    .filter((r) => Number(r.id_by_customer) !== id && typeof r.date === "string")
    .sort((a, b) => Math.abs(Date.parse(a.date as string) - target) - Math.abs(Date.parse(b.date as string) - target));
  const rates: number[] = [];
  for (const c of candidates) {
    if (rates.length >= MAX_NEIGHBOURS) break;
    const other = await getReceipt(Number(c.id_by_customer));
    if (other && other.currency_original === receipt.currency_original) {
      const rate = rateOf(other);
      if (rate !== undefined) rates.push(rate);
    }
  }
  if (rates.length < MIN_NEIGHBOURS) return undefined;
  const mid = median(rates);
  const own = rateOf(receipt) as number;
  const deviation = Math.abs(own / mid - 1);
  if (deviation <= RATE_OUTLIER_THRESHOLD) return undefined;
  return `Beleg ${id}: Kurs ${own} (${receipt.currency_original}), Median der ${rates.length} nächsten Belege ${mid.toFixed(4)}, Abweichung ${(deviation * 100).toFixed(1)} %`;
}
