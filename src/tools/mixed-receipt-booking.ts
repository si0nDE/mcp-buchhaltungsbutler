import type { BBClient } from "../bb-client/client.js";
import { toId } from "./entertainment-receipt.js";
import { formatEuro } from "./entertainment-receipt-pdf.js";
import type { Auslagenkonto } from "./mixed-receipt-account.js";
import { nameWords } from "./mixed-receipt-account.js";
import type { BusinessPosition, MixedReceiptAmounts } from "./mixed-receipt-calc.js";
import { loadPolicy, type Gewinnermittlung } from "./policy.js";
import { attachPostingStatus } from "./posting-status.js";

// Read-only booking proposal for the Auslagenbeleg that generate_and_upload_mixed_receipt has just uploaded. It books, assigns and
// creates nothing: it reads the new receipt, its assigned payments, their booking state and (EÜR) the payment list, and returns the
// way to book it plus ready-to-use tool parameters where they can be filled completely. It never throws: any failure gives "unavailable".

export type ProposalStatus = "ready" | "no_payment_exists" | "already_booked" | "needs_decision" | "unavailable";

export interface AssignedTransaction {
  id_by_customer: unknown;
  amount: unknown;
  to_from: unknown;
  booking_date: unknown;
}

export interface BookingProposal {
  status: ProposalStatus;
  gewinnermittlung: Gewinnermittlung | null;
  auslagenkonto: Auslagenkonto | null;
  receipt: { id_by_customer: number | string | null; account: string | null; assigned_transactions: AssignedTransaction[] };
  steps: string[];
  calls: Array<{ tool: string; arguments: Record<string, unknown> }>;
  notes: string[];
  payment_candidates?: AssignedTransaction[];
}

export interface BookingInput {
  newId: string | number | undefined;
  amounts: MixedReceiptAmounts;
  positions: BusinessPosition[];
  paidBy: string;
  // Explicit neutral posting text from the caller; without it a neutral text is derived from the position descriptions.
  bookingText?: string;
  receiptDate: string; // YYYY-MM-DD
  auslagenkonto: Auslagenkonto | null;
  // The upload passed this Auslagenkonto as `account` (so BuchhaltungsButler was asked to create the payment).
  accountPassedOnUpload: boolean;
}

type Row = Record<string, unknown>;

const BOOKING_ACCOUNT = 4653;
const TOLERANCE = 0.01;
const WINDOW_DAYS = 60;
const TX_PAGE = 500;
const TX_MAX_PAGES = 5;
const MAX_CANDIDATES = 5;

const KONTENRAHMEN_NOTE = "4653 (SKR03); SKR04: 6643; alternativ 4980 | 6850 Sonstiger Betriebsbedarf; das Konto legt der Steuerberater fest.";
const INHABER_NOTE =
  "Hat der Inhaber eines Einzelunternehmens selbst ausgelegt, ist das keine Erstattung, sondern eine Privateinlage (get_booking_guide auslagen).";
const NO_GEWINNERMITTLUNG_NOTE = "Gewinnermittlung nicht festgelegt (set_policy gewinnermittlung); beide Wege unten";
const NO_PAYMENT_SENTENCE =
  "Zu diesem Beleg gibt es in BuchhaltungsButler keine Zahlung, die man buchen könnte. Eine EÜR bucht nur Zahlungen; das ist normal, wenn nur Geschäftskonten angelegt sind und privat bezahlt wurde.";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const num = (v: unknown) => Number(String(v ?? "").replace(",", "."));
const nameMatches = (words: string[], ...texts: unknown[]) => {
  const hay = texts.map((t) => String(t ?? "").toLowerCase()).join(" ");
  return words.some((w) => w.length >= 3 && hay.includes(w));
};
const view = (r: Row): AssignedTransaction => ({ id_by_customer: r.id_by_customer, amount: r.amount, to_from: r.to_from, booking_date: r.booking_date });
const describeTx = (t: AssignedTransaction) => `${t.id_by_customer} (${formatEuro(num(t.amount))}, ${t.to_from ?? "?"}, ${t.booking_date ?? "?"})`;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const MAX_POSTING_TEXT = 40;

// BuchhaltungsButler turns every distinct posting text into its own booking suggestion, so the text stays generic: no merchant,
// brand, size, quantity, percentage or price. Derived from the position descriptions; the caller can set booking_text instead.
export function neutralPostingText(descriptions: string[]): string {
  const cleaned = descriptions
    .map((d) =>
      d
        .replace(/\d+(?:[.,]\d+)?\s*(?:%|€|ml|cl|kg|mg|g|l|stk\.?|stück|x|×)?/gi, " ")
        .replace(/[()]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((d) => d !== "");
  const text = [...new Set(cleaned)].join(", ") || descriptions.join(", ");
  return text.slice(0, MAX_POSTING_TEXT).trim();
}

export function bookingTextFor(descriptions: string[], explicit?: string): { value: string; source: "given" | "derived" } {
  return explicit && explicit.trim() !== "" ? { value: explicit.trim(), source: "given" } : { value: neutralPostingText(descriptions), source: "derived" };
}

function splitsFor(input: BookingInput, receiptId: number) {
  return input.amounts.rates.map((r) => {
    const names = input.positions.filter((p) => p.vat_rate === r.vat_rate).map((p) => p.description);
    return {
      amount: r.gross.toFixed(2),
      postingaccount: BOOKING_ACCOUNT,
      postingtext: bookingTextFor(names, input.bookingText).value,
      vat: r.vat_rate === 0 ? "0_none" : `${r.vat_rate}_pre`,
      receipt_id_by_customer: receiptId,
    };
  });
}

function splitNote(splits: ReturnType<typeof splitsFor>): string {
  return "Vorschlag je Steuersatz: " + splits.map((s) => `${s.amount} € auf ${s.postingaccount} (vat ${s.vat}, Text "${s.postingtext}")`).join("; ") + ".";
}

async function readReceipt(client: BBClient, id: number): Promise<Row> {
  const res = await client.call<{ data?: Row }>("receiptsGetIdByCustomer", {}, { idSuffix: id });
  // The live API nests the record one level deeper than the spec; accept both (like get_receipt_overview).
  const raw = (res.data as { data?: Row } | undefined)?.data ?? res.data ?? {};
  return raw as Row;
}

async function findReimbursementCandidates(client: BBClient, input: BookingInput): Promise<AssignedTransaction[]> {
  const words = nameWords(input.paidBy);
  const date_from = input.receiptDate;
  const date_to = addDays(input.receiptDate, WINDOW_DAYS);
  const found: AssignedTransaction[] = [];
  for (let page = 0; page < TX_MAX_PAGES; page++) {
    const res = await client.call<{ data?: Row[] }>("transactionsGet", { date_from, date_to, limit: TX_PAGE, offset: page * TX_PAGE });
    const batch = res.data ?? [];
    for (const t of batch) {
      const amount = num(t.amount);
      if (!(amount < 0) || Math.abs(Math.abs(amount) - input.amounts.reimbursement) > TOLERANCE + 1e-9) continue;
      if (!nameMatches(words, t.to_from, t.purpose)) continue;
      found.push(view(t));
    }
    if (batch.length < TX_PAGE) break;
  }
  return found.slice(0, MAX_CANDIDATES);
}

function euerBlock(input: BookingInput, hasAuslagenkonto: boolean) {
  const steps = [
    NO_PAYMENT_SENTENCE,
    "Wege weiter:",
    "(1) Ein Auslagenkonto anlegen (create_account, type other, 'Beleg erzeugt Zahlung'; Verbindlichkeiten gegenüber Gesellschaftern 730 | 3510 bzw. Privateinlagen 1890 | 2180), den Beleg diesem Konto zuweisen und dann die erzeugte Zahlung buchen (add_transaction_postings, Splits wie in den Hinweisen).",
    `(2) Ohne Konto: add_free_postings Soll ${BOOKING_ACCOUNT} an Haben Privateinlagen (Einzelunternehmen 1890 | 2180; GmbH/UG 730 | 3510${hasAuslagenkonto ? ", hier das Auslagenkonto der Person" : " bzw. das Auslagenkonto der Person"}) mit dem Beleg. Eine freie Buchung mit Beleg zählt nicht als Zahlung in BuchhaltungsButler (der Beleg bleibt dort offen).`,
    "(3) Die Erstattung abwarten, dann die Zahlung dem Beleg zuordnen (assign_receipts_to_transactions) und buchen (add_transaction_postings).",
  ];
  return steps;
}

function bilanzBlock(input: BookingInput) {
  const steps = [
    `Bilanz: den Beleg selbst buchen, nicht die Zahlung: add_receipt_postings für den neuen Beleg mit den Splits aus den Hinweisen, creditor = Kreditor-Personenkonto von ${input.paidBy} (Verbindlichkeit gegenüber der Person). Diese Kontonummer kennt der Connector nicht (list_posting_accounts; ein Kreditor wird in BuchhaltungsButler angelegt), deshalb gibt es hier keinen fertigen Aufruf.`,
    "Die Erstattung später: Zahlung dem Beleg zuordnen und gegen den Kreditor ohne Steuer buchen (vat 0_none), siehe get_booking_guide auslagen.",
  ];
  const notes = input.accountPassedOnUpload
    ? ["Ein Beleg auf einem Konto mit 'Beleg erzeugt Zahlung' lässt sich nicht auf einen Kreditor buchen; dann stattdessen die erzeugte Zahlung buchen."]
    : [];
  return { steps, notes };
}

async function build(client: BBClient, input: BookingInput, policyLoader: typeof loadPolicy): Promise<BookingProposal> {
  const id = toId(input.newId);
  const base = (gw: Gewinnermittlung | null): Pick<BookingProposal, "gewinnermittlung" | "auslagenkonto"> => ({ gewinnermittlung: gw, auslagenkonto: input.auslagenkonto });
  if (typeof id !== "number") {
    return {
      ...base(null),
      status: "unavailable",
      receipt: { id_by_customer: id ?? null, account: null, assigned_transactions: [] },
      steps: ["Buchungsvorschlag nicht möglich: Die id_by_customer des neuen Belegs ist unbekannt. Den neuen Beleg per list_receipts (Bonnummer) suchen und dann get_receipt_overview verwenden."],
      calls: [],
      notes: [],
    };
  }
  const gw = (await policyLoader()).tax_profile.gewinnermittlung;
  const row = await readReceipt(client, id);
  const account = row.account === undefined || row.account === null || String(row.account).trim() === "" ? null : String(row.account);
  const assignedRes = await client.call<{ data?: Row[] }>("receiptsAssignedTransactionsGet", { receipt_id_by_customer: id });
  const assignedRows = assignedRes.data ?? [];
  const assigned = assignedRows.map(view);
  const splits = splitsFor(input, id);
  const notes = [KONTENRAHMEN_NOTE, INHABER_NOTE];
  const result = (status: ProposalStatus, steps: string[], extra: Partial<BookingProposal> = {}): BookingProposal => ({
    ...base(gw),
    status,
    receipt: { id_by_customer: id, account, assigned_transactions: assigned },
    steps,
    calls: [],
    notes,
    ...extra,
  });

  // Case 1: BuchhaltungsButler already created a payment for the receipt (Auslagenkonto with 'Beleg erzeugt Zahlung').
  if (assignedRows.length > 0) {
    const status = await attachPostingStatus(client, assignedRows);
    const booked = status.rows.map((r) => (r.posting_status as { booked: boolean | null } | undefined)?.booked ?? null);
    if (booked.every((b) => b === true)) {
      return result("already_booked", [`Die zugeordnete Zahlung ${assigned.map(describeTx).join("; ")} ist schon gebucht. Nichts mehr zu tun; Buchung bei Bedarf mit list_postings prüfen.`]);
    }
    const listed = assigned.map(describeTx).join("; ");
    if (assigned.length === 1 && booked[0] === false) {
      const t = assigned[0];
      // exact to the cent: the offered splits sum to the reimbursement and BuchhaltungsButler wants the sum to equal the payment
      if (Math.round(Math.abs(num(t.amount)) * 100) === Math.round(input.amounts.reimbursement * 100)) {
        notes.push(splitNote(splits));
        return result(
          "ready",
          [
            `Zahlung ${t.id_by_customer} (${formatEuro(num(t.amount))}) ist dem Beleg zugeordnet; so buchen: add_transaction_postings mit den Splits unten. Die Buchungsrichtung folgt der Zahlung.`,
          ],
          { calls: [{ tool: "add_transaction_postings", arguments: { transactions: [{ transaction_id_by_customer: Number(t.id_by_customer), splits }] } }] }
        );
      }
    }
    notes.push(splitNote(splits));
    const reason = booked.some((b) => b === null)
      ? "Der Buchungsstatus der Zahlung(en) ist nicht sicher bekannt (Abfrage der Buchungen unvollständig)."
      : assigned.length > 1
        ? "Mehrere Zahlungen sind dem Beleg zugeordnet."
        : `Der Betrag der zugeordneten Zahlung weicht von der Erstattung ${formatEuro(input.amounts.reimbursement)} ab.`;
    return result("needs_decision", [`${reason} Zugeordnet: ${listed}. Erstattung laut Auslagenbeleg: ${formatEuro(input.amounts.reimbursement)}. Nicht automatisch buchen; mit dem Nutzer klären, was die Zahlung abdeckt.`]);
  }

  // Case 2: no payment is assigned.
  const noPaymentFromAccount =
    input.accountPassedOnUpload && input.auslagenkonto
      ? [
          `Der Beleg wurde dem Auslagenkonto ${input.auslagenkonto.name} (${input.auslagenkonto.number}) zugewiesen, BuchhaltungsButler hat aber keine Zahlung angelegt: Das Konto nutzt vermutlich nicht 'Beleg erzeugt Zahlung' (manage_account, get_booking_guide auslagen).`,
        ]
      : [];
  if (gw === "bilanz") {
    notes.push(...noPaymentFromAccount);
    const b = bilanzBlock(input);
    notes.push(...b.notes, splitNote(splits));
    return result("needs_decision", b.steps);
  }
  if (gw === null) notes.push(NO_GEWINNERMITTLUNG_NOTE);
  notes.push(...noPaymentFromAccount);
  const candidates = await findReimbursementCandidates(client, input);
  if (candidates.length > 0) {
    notes.push(splitNote(splits));
    const steps = [
      `Zahlung gefunden: ${candidates.map(describeTx).join("; ")}. Welche zum Beleg gehört, entscheidet der Nutzer; diese Zahlung dem Beleg zuordnen (assign_receipts_to_transactions) und dann buchen (add_transaction_postings, Splits wie in den Hinweisen).`,
    ];
    if (gw === null) {
      const b = bilanzBlock(input);
      steps.push("Falls bilanziert wird:", ...b.steps);
    }
    return result("needs_decision", steps, { payment_candidates: candidates });
  }
  const steps = euerBlock(input, input.auslagenkonto !== null);
  notes.push(splitNote(splits));
  if (gw === null) {
    const b = bilanzBlock(input);
    steps.push("Falls bilanziert wird:", ...b.steps);
    notes.push(...b.notes);
    return result("needs_decision", steps);
  }
  const calls =
    input.auslagenkonto === null
      ? []
      : [
          {
            tool: "add_free_postings",
            arguments: {
              free_postings: splits.map((s) => ({
                date: input.receiptDate,
                postingtext: s.postingtext,
                amount: s.amount,
                postingaccount_debit: s.postingaccount,
                postingaccount_credit: input.auslagenkonto!.number,
                vat: s.vat,
                receipt_id_by_customer: s.receipt_id_by_customer,
              })),
            },
          },
        ];
  if (calls.length > 0) notes.push("Der Aufruf für Weg (2) ist mit dem Auslagenkonto als Gegenkonto vorbereitet; er zählt nicht als Zahlung und ersetzt Weg (1) oder (3) nicht, wenn die Erstattung gebucht werden soll.");
  return result("no_payment_exists", steps, { calls });
}

export async function buildBookingProposal(client: BBClient, input: BookingInput, policyLoader: typeof loadPolicy = loadPolicy): Promise<BookingProposal> {
  try {
    return await build(client, input, policyLoader);
  } catch (error) {
    return {
      status: "unavailable",
      gewinnermittlung: null,
      auslagenkonto: input.auslagenkonto,
      receipt: { id_by_customer: toId(input.newId) ?? null, account: null, assigned_transactions: [] },
      steps: [
        `Buchungsvorschlag konnte nicht erstellt werden (${message(error)}). Der Beleg ist hochgeladen; Stand mit get_receipt_overview prüfen und nach get_booking_guide auslagen buchen.`,
      ],
      calls: [],
      notes: [KONTENRAHMEN_NOTE],
    };
  }
}
