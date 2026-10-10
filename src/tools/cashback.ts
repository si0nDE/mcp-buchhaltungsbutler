// PayPal Business Debit Mastercard: das Cashback kommt als eigene Zahlung auf dem PayPal-Konto, beobachtet am 10.10.2026 mit
// to_from "PayPal Inc Debit Card", type "Cash Back Bonus", positivem Betrag und der PayPal-Transaktions-ID als purpose.
// Einordnung: nicht steuerbar (kein Leistungsaustausch, keine Entgeltminderung nach § 17 UStG, PayPal steht nicht in der
// Lieferkette), ertragsteuerlich Betriebseinnahme. Quellen und offene Punkte: docs/rechtsgrundlagen-paypal-cashback.md,
// Buchungsmuster: get_booking_guide paypal_cashback. Erkannt wird nur über type und to_from, nie über den Betrag.
// transactionsGet (Liste) liefert type NICHT, nur transactionsGetIdByCustomer (live geprüft 10.10.2026): Listenzeilen sind deshalb
// nur Kandidaten (positive Zahlung von "PayPal ... Debit Card") und werden einzeln nachgeschlagen.

import type { BBClient, BBListResult } from "../bb-client/client.js";

export const CASHBACK_POSTINGTEXT = "PayPal Business Debit Cashback";
export const CASHBACK_ACCOUNT = { SKR03: 2700, SKR04: 4830 } as const;
const CASHBACK_ACCOUNTS = new Set<number>(Object.values(CASHBACK_ACCOUNT));

const TYPE_RE = /cash\s*-?\s*back/i;
const COUNTERPARTY_RE = /paypal/i;
const CANDIDATE_RE = /paypal.*debit\s*card/i;
// Höchstens so viele Einzelabfragen je Toolaufruf; darüber bleiben Kandidaten unbestätigt (im Hinweis genannt).
const MAX_LOOKUPS = 25;

export function isPayPalCashback(tx: Record<string, unknown>): boolean {
  return (
    typeof tx.type === "string" &&
    TYPE_RE.test(tx.type) &&
    typeof tx.to_from === "string" &&
    COUNTERPARTY_RE.test(tx.to_from) &&
    Number(tx.amount) > 0
  );
}

function accountText(chart: "SKR03" | "unknown"): string {
  return chart === "SKR03"
    ? `${CASHBACK_ACCOUNT.SKR03} (Sonstige Erträge)`
    : `SKR03 ${CASHBACK_ACCOUNT.SKR03} | SKR04 ${CASHBACK_ACCOUNT.SKR04} (Sonstige (betriebliche) Erträge)`;
}

export function cashbackHint(ids: unknown[], chart: "SKR03" | "unknown"): Record<string, unknown> {
  return {
    kind: "paypal_cashback",
    transaction_ids: ids,
    buchung: {
      postingaccount: chart === "SKR03" ? CASHBACK_ACCOUNT.SKR03 : CASHBACK_ACCOUNT,
      vat: "0_none",
      postingtext: CASHBACK_POSTINGTEXT,
      receipt: "keiner (Nachweis ist die Zahlung selbst)",
    },
    begruendung:
      "Nicht steuerbar: kein Leistungsaustausch, keine Entgeltminderung des Einkaufs (§ 17 UStG), PayPal steht nicht in der Lieferkette; " +
      "Vorsteuer der Einkäufe bleibt. Ertragsteuerlich Betriebseinnahme (EÜR: bei Gutschrift, § 11 EStG).",
    guide: "get_booking_guide paypal_cashback",
  };
}

export function cashbackUnconfirmedText(ids: unknown[]): string {
  return (
    `${ids.length} weitere positive Zahlung(en) von PayPal Debit Card nicht geprüft (IDs ${ids.join(", ")}): ` +
    "die Liste liefert die Zahlungsart nicht. Mit get_transaction nachsehen, ob type \"Cash Back Bonus\" ist."
  );
}

export function cashbackHintText(ids: unknown[], chart: "SKR03" | "unknown"): string {
  return (
    `${ids.length} Zahlung(en) als PayPal-Business-Debit-Cashback erkannt (type "Cash Back Bonus", IDs ${ids.join(", ")}). ` +
    `Buchen mit add_transaction_postings: ein Split, Konto ${accountText(chart)}, vat 0_none, postingtext "${CASHBACK_POSTINGTEXT}", ` +
    "kein Beleg. Nicht gegen den Aufwand des Einkaufs verrechnen, keine Vorsteuerkorrektur. Begründung und Quellen: get_booking_guide paypal_cashback."
  );
}

export function cashbackPostingWarnings(
  entries: Array<{ transaction_id_by_customer: number; splits: Array<{ postingaccount: number; vat: string; postingtext: string }> }>,
  cashbackIds: Set<number>,
  chart: "SKR03" | "unknown"
): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (!cashbackIds.has(e.transaction_id_by_customer)) continue;
    const issues: string[] = [];
    if (e.splits.some((s) => s.vat !== "0_none")) issues.push("Steuerschlüssel nicht 0_none (Cashback ist nicht steuerbar)");
    const accounts = chart === "SKR03" ? new Set<number>([CASHBACK_ACCOUNT.SKR03]) : CASHBACK_ACCOUNTS;
    if (e.splits.some((s) => !accounts.has(s.postingaccount))) issues.push(`Konto nicht ${accountText(chart)}`);
    if (e.splits.some((s) => s.postingtext !== CASHBACK_POSTINGTEXT)) issues.push(`Buchungstext nicht "${CASHBACK_POSTINGTEXT}"`);
    if (issues.length === 0) continue;
    out.push(
      `Transaktion ${e.transaction_id_by_customer} ist PayPal-Business-Debit-Cashback: ${issues.join("; ")}. ` +
        "Üblich: ein Split, Sonstige Erträge, vat 0_none, konstanter Text (get_booking_guide paypal_cashback). Abweichung nur mit Grund des Nutzers."
    );
  }
  return out;
}

export function isCashbackCandidate(row: Record<string, unknown>): boolean {
  return typeof row.to_from === "string" && CANDIDATE_RE.test(row.to_from) && Number(row.amount) > 0;
}

export interface CashbackResolution {
  confirmed: unknown[];
  unconfirmed: unknown[];
}

// Zeilen mit type direkt prüfen, Kandidaten ohne type einzeln nachschlagen. Fehler beim Nachschlagen: Kandidat bleibt unbestätigt.
export async function resolveCashback(client: BBClient, rows: Record<string, unknown>[]): Promise<CashbackResolution> {
  const confirmed: unknown[] = [];
  const unconfirmed: unknown[] = [];
  const lookups: unknown[] = [];
  for (const r of rows) {
    if (typeof r.type === "string") {
      if (isPayPalCashback(r)) confirmed.push(r.id_by_customer);
    } else if (isCashbackCandidate(r)) {
      if (lookups.length < MAX_LOOKUPS) lookups.push(r.id_by_customer);
      else unconfirmed.push(r.id_by_customer);
    }
  }
  const results = await Promise.all(
    lookups.map((id) =>
      client
        .call<{ data?: Record<string, unknown> }>("transactionsGetIdByCustomer", {}, { idSuffix: Number(id) })
        .then((res) => (res?.data ? isPayPalCashback(res.data) : undefined))
        .catch(() => undefined)
    )
  );
  results.forEach((hit, i) => {
    if (hit === true) confirmed.push(lookups[i]);
    else if (hit === undefined) unconfirmed.push(lookups[i]);
  });
  return { confirmed, unconfirmed };
}

// Für die Prüfung beim Buchen: ein transactionsGet über den ID-Bereich des Batches, dann Einzelabfragen nur für Kandidaten.
// Liegen die IDs weiter als eine Seite auseinander oder schlägt der Abruf fehl, entfällt die Prüfung still (Warnung, kein Gate).
const RANGE_LIMIT = 500;

export async function fetchCashbackIds(client: BBClient, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const from = Math.min(...ids);
  const to = Math.max(...ids);
  if (to - from >= RANGE_LIMIT) return new Set();
  try {
    // BHB behandelt id_by_customer_from/_to exklusiv (live: 100..105 liefert 101..104, 103..103 nichts), daher ±1.
    const result = await client.call<BBListResult>("transactionsGet", {
      id_by_customer_from: from - 1,
      id_by_customer_to: to + 1,
      limit: RANGE_LIMIT,
      offset: 0,
    });
    const wanted = new Set(ids);
    const rows = (result?.data ?? []).filter((r) => wanted.has(Number(r.id_by_customer)));
    const { confirmed } = await resolveCashback(client, rows);
    return new Set(confirmed.map(Number));
  } catch {
    return new Set();
  }
}
