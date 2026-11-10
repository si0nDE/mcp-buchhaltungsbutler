import type { BBClient } from "../bb-client/client.js";
import { toId } from "./entertainment-receipt.js";
import type { DebitorenKreditoren } from "./policy.js";

// Finds the Kreditor (Personenkonto, 70000-79999) a merchant is booked on, from the earlier bookings of that merchant. Read-only and
// deliberately never by name: the merchant's name on a receipt rarely equals the Kreditor's name in BuchhaltungsButler. Never throws.

export type CreditorLookup =
  | { creditor: number; source: "derived"; evidence: string[] }
  | { candidates: Array<{ creditor: number; evidence: string[] }> }
  | { none: string };

export const KREDITOR_MIN = 70000;
export const KREDITOR_MAX = 79999;

const MAX_RECEIPTS = 10;
const WINDOW_MONTHS = 24;
const POSTING_PAGE = 1000;
const POSTING_MAX_PAGES = 5;

type Row = Record<string, unknown>;

const isDeleted = (r: Row) => r.deleted === "1" || r.deleted === 1 || r.deleted === true;
const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === "";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const day = (d: Date) => d.toISOString().slice(0, 10);

export async function findMerchantCreditor(client: BBClient, merchantName: string, opts: { excludeIds: number[]; now: Date }): Promise<CreditorLookup> {
  try {
    const needle = merchantName.trim().toLowerCase();
    const list = await client.call<{ data?: Row[] }>("receiptsGet", {
      list_direction: "inbound",
      counterparty: merchantName,
      order: { date: "DESC" },
      limit: 50,
      offset: 0,
    });
    // the filter is exact and the API may ignore parts of it: check again locally (exact name of the merchant, active, not the new/original receipt)
    const receipts = (list.data ?? [])
      .filter((r) => String(r.counterparty ?? "").trim().toLowerCase() === needle && !isDeleted(r) && !opts.excludeIds.includes(toId(r.id_by_customer) as number))
      .slice(0, MAX_RECEIPTS);
    if (receipts.length === 0) return { none: `Keine früheren Belege von "${merchantName}" gefunden, aus denen sich ein Kreditor ableiten ließe.` };

    const from = new Date(opts.now);
    from.setUTCMonth(from.getUTCMonth() - WINDOW_MONTHS);
    const postings: Row[] = [];
    for (let page = 0; page < POSTING_MAX_PAGES; page++) {
      const res = await client.call<{ data?: Row[] }>("postingsGet", {
        date_from: day(from),
        date_to: day(opts.now),
        posting_status: "all",
        limit: POSTING_PAGE,
        offset: page * POSTING_PAGE,
      });
      const batch = res.data ?? [];
      postings.push(...batch);
      if (batch.length < POSTING_PAGE) break;
    }

    const byCreditor = new Map<number, string[]>();
    for (const r of receipts) {
      const id = String(r.id_by_customer);
      const accounts = new Set<number>();
      for (const p of postings) {
        // a receipt posting: tied to the receipt, not to a transaction
        if (String(p.receipt_id_by_customer) !== id || !blank(p.transaction_id_by_customer)) continue;
        const credit = Number(p.credit_postingaccount_number);
        if (Number.isInteger(credit) && credit >= KREDITOR_MIN && credit <= KREDITOR_MAX) accounts.add(credit);
      }
      const label = `Beleg ${id}${blank(r.invoicenumber) ? "" : ` (${String(r.invoicenumber)})`}`;
      for (const a of accounts) byCreditor.set(a, [...(byCreditor.get(a) ?? []), label]);
    }
    if (byCreditor.size === 0) {
      return { none: `Die früheren Belege von "${merchantName}" (${receipts.length}) haben keine Beleg-Buchung auf einem Kreditor (Personenkonto ab 70000).` };
    }
    if (byCreditor.size === 1) {
      const [[creditor, evidence]] = [...byCreditor];
      return { creditor, source: "derived", evidence };
    }
    return { candidates: [...byCreditor].sort((a, b) => a[0] - b[0]).map(([creditor, evidence]) => ({ creditor, evidence })) };
  } catch (error) {
    return { none: `Kreditor nicht ermittelt (${message(error)}).` };
  }
}

export interface CreditorInfo {
  number: number | null;
  source: "derived" | "given" | "none";
  evidence: string[];
  effect: string;
}

// The preview's view of the Kreditor. Only meaningful with house rule "aktiv" or not set; with "aus" nothing is looked up.
export async function creditorInfo(
  client: BBClient,
  o: { rule: DebitorenKreditoren | null; given?: number; merchantName: string; excludeIds: number[]; now: Date }
): Promise<CreditorInfo> {
  if (o.rule === "aus") return { number: null, source: "none", evidence: [], effect: "nicht nötig (Debitoren/Kreditoren aus): gebucht wird die Zahlung, es gibt keine Beleg-Buchung." };
  const unsetNote = o.rule === null ? " (Hausregel Debitoren/Kreditoren nicht gesetzt: gilt erst, wenn sie auf aktiv steht)" : "";
  if (o.given !== undefined) {
    return { number: o.given, source: "given", evidence: [], effect: `Der Buchungsvorschlag bucht den Beleg auf diesen Kreditor (angegeben)${unsetNote}.` };
  }
  const found = await findMerchantCreditor(client, o.merchantName, { excludeIds: o.excludeIds, now: o.now });
  if ("creditor" in found) {
    return { number: found.creditor, source: "derived", evidence: found.evidence, effect: `Aus früheren Belegen des Händlers abgeleitet: der Buchungsvorschlag bucht den Beleg auf Kreditor ${found.creditor}${unsetNote}.` };
  }
  if ("candidates" in found) {
    return {
      number: null,
      source: "none",
      evidence: found.candidates.flatMap((c) => c.evidence),
      effect: `Mehrere mögliche Kreditoren (${found.candidates.map((c) => c.creditor).join(", ")}): mit creditor den richtigen angeben.`,
    };
  }
  return { number: null, source: "none", evidence: [], effect: `${found.none} Mit creditor die Kreditor-Nummer des Händlers angeben${unsetNote}.` };
}
