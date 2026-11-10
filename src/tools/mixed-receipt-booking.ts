import type { BBClient } from "../bb-client/client.js";
import { toId } from "./entertainment-receipt.js";
import { formatEuro } from "./entertainment-receipt-pdf.js";
import type { Auslagenkonto } from "./mixed-receipt-account.js";
import { nameWords } from "./mixed-receipt-account.js";
import type { BusinessPosition, MixedReceiptAmounts } from "./mixed-receipt-calc.js";
import { findMerchantCreditor, KREDITOR_MAX, KREDITOR_MIN } from "./mixed-receipt-creditor.js";
import { loadPolicy, type DebitorenKreditoren } from "./policy.js";
import { attachPostingStatus } from "./posting-status.js";

// Read-only booking proposal for the Auslagenbeleg that generate_and_upload_mixed_receipt has just uploaded. It books, assigns and
// creates nothing: it reads the new receipt, its assigned payments, their booking state, the receipt's postings and the Kreditor of the
// merchant (derived from earlier bookings, never by name), and returns the way to book it plus ready-to-use tool parameters where they can
// be filled completely. The way follows the house rule debitoren_kreditoren: "aktiv" books the receipt on the Kreditor and the payment only
// settles it (BuchhaltungsButler: with Debitoren/Kreditoren on, the EÜR evaluation does not exist and you book the receipt); "aus" books the
// payment; not set decides nothing. It never throws: any failure gives "unavailable".

export type ProposalStatus = "ready" | "no_payment_exists" | "already_booked" | "needs_decision" | "unavailable";

export interface AssignedTransaction {
  id_by_customer: unknown;
  amount: unknown;
  to_from: unknown;
  booking_date: unknown;
}

export interface BookingProposal {
  status: ProposalStatus;
  debitoren_kreditoren: DebitorenKreditoren | null;
  auslagenkonto: Auslagenkonto | null;
  // Kreditor of the merchant (rule aktiv): given, derived from earlier bookings, or none.
  creditor?: { number: number | null; source: "given" | "derived" | "receipt" | "none"; evidence: string[] };
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
  // The original receipt (excluded when deriving the Kreditor), the merchant, an explicit Kreditor and "now" (window of the posting reads).
  sourceId?: number;
  merchantName: string;
  creditor?: number;
  now?: Date;
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
const AUS_SENTENCE = "Debitoren/Kreditoren sind aus: es gibt keine Beleg-Buchung, gebucht wird die Zahlung.";
const NO_PAYMENT_SENTENCE =
  "Zu diesem Beleg gibt es in BuchhaltungsButler keine Zahlung, die man buchen könnte; das ist normal, wenn nur Geschäftskonten angelegt sind und privat bezahlt wurde.";
const DK_ACCOUNT_NOTE =
  "Liegt der Beleg auf einem Konto mit 'Beleg erzeugt Zahlung', ist eine kreditorische Buchung nicht möglich; dann erst die Zuordnung zum Konto lösen (unassign_receipt). Nur in Ausnahmefällen 'via Zahlung' buchen.";
const DEBTOR_NOTE = "debtor: 10000 ist das Debitoren-Sammelkonto und wird vom Schema von add_receipt_postings verlangt; gebucht wird auf den Kreditor.";
const SETTLE_TEXT = "Ausgleich Beleg";

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

function baseSplits(input: BookingInput) {
  return input.amounts.rates.map((r) => {
    const names = input.positions.filter((p) => p.vat_rate === r.vat_rate).map((p) => p.description);
    return {
      amount: r.gross.toFixed(2),
      postingaccount: BOOKING_ACCOUNT,
      postingtext: bookingTextFor(names, input.bookingText).value,
      vat: r.vat_rate === 0 ? "0_none" : `${r.vat_rate}_pre`,
    };
  });
}

type Split = ReturnType<typeof baseSplits>[number];

// Splits of a payment or free posting carry the receipt; the splits of add_receipt_postings do not (the receipt is the posting's key).
const withReceipt = (splits: Split[], receiptId: number) => splits.map((s) => ({ ...s, receipt_id_by_customer: receiptId }));

function splitNote(splits: Split[]): string {
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
  return [
    `${AUS_SENTENCE} ${NO_PAYMENT_SENTENCE}`,
    "Wege weiter:",
    "(1) Ein Auslagenkonto anlegen (create_account, type other, 'Beleg erzeugt Zahlung'; Verbindlichkeiten gegenüber Gesellschaftern 730 | 3510 bzw. Privateinlagen 1890 | 2180), den Beleg diesem Konto zuweisen und dann die erzeugte Zahlung buchen (add_transaction_postings, Splits wie in den Hinweisen).",
    `(2) Ohne Konto: add_free_postings Soll ${BOOKING_ACCOUNT} an Haben Privateinlagen (Einzelunternehmen 1890 | 2180; GmbH/UG 730 | 3510${hasAuslagenkonto ? ", hier das Auslagenkonto der Person" : " bzw. das Auslagenkonto der Person"}) mit dem Beleg. Eine freie Buchung mit Beleg zählt nicht als Zahlung in BuchhaltungsButler (der Beleg bleibt dort offen).`,
    "(3) Die Erstattung abwarten, dann die Zahlung dem Beleg zuordnen (assign_receipts_to_transactions) und buchen (add_transaction_postings).",
  ];
}

interface Ctx {
  client: BBClient;
  input: BookingInput;
  id: number;
  notes: string[];
  account: string | null;
  assignedRows: Row[];
  assigned: AssignedTransaction[];
  baseSplits: Split[];
  result: (status: ProposalStatus, steps: string[], extra?: Partial<BookingProposal>) => BookingProposal;
}

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === "";

// All postings of the new receipt itself (receipt bookings, not payment bookings): tied to the receipt, no transaction.
async function readReceiptPostings(client: BBClient, id: number, receiptDate: string, now: Date): Promise<Row[]> {
  const today = now.toISOString().slice(0, 10);
  const date_to = today > receiptDate ? today : addDays(receiptDate, 1);
  const found: Row[] = [];
  for (let page = 0; page < TX_MAX_PAGES; page++) {
    const res = await client.call<{ data?: Row[] }>("postingsGet", { date_from: receiptDate, date_to, posting_status: "all", limit: 1000, offset: page * 1000 });
    const batch = res.data ?? [];
    found.push(...batch.filter((p) => String(p.receipt_id_by_customer) === String(id) && blank(p.transaction_id_by_customer)));
    if (batch.length < 1000) break;
  }
  return found;
}

// Debitoren/Kreditoren off: nothing is booked on the receipt, the payment is booked.
async function buildAus(c: Ctx): Promise<BookingProposal> {
  const { client, input, id, notes, assignedRows, assigned, result } = c;
  const splits = withReceipt(c.baseSplits, id);
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
            `${AUS_SENTENCE} Zahlung ${t.id_by_customer} (${formatEuro(num(t.amount))}) ist dem Beleg zugeordnet; so buchen: add_transaction_postings mit den Splits unten. Die Buchungsrichtung folgt der Zahlung.`,
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
  notes.push(...noPaymentFromAccount);
  const candidates = await findReimbursementCandidates(client, input);
  if (candidates.length > 0) {
    notes.push(splitNote(splits));
    const steps = [
      `${AUS_SENTENCE} Zahlung gefunden: ${candidates.map(describeTx).join("; ")}. Welche zum Beleg gehört, entscheidet der Nutzer; diese Zahlung dem Beleg zuordnen (assign_receipts_to_transactions) und dann buchen (add_transaction_postings, Splits wie in den Hinweisen).`,
    ];
    return result("needs_decision", steps, { payment_candidates: candidates });
  }
  const steps = euerBlock(input, input.auslagenkonto !== null);
  notes.push(splitNote(splits));
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

// House rule not set: nothing is proposed, both ways are described. A cheap read hints at active Debitoren/Kreditoren.
async function buildUnset(c: Ctx): Promise<BookingProposal> {
  const { client, notes, result } = c;
  notes.push(splitNote(withReceipt(c.baseSplits, c.id)));
  const steps = [
    "Hausregel Debitoren/Kreditoren nicht gesetzt (set_policy debitoren_kreditoren: aktiv oder aus). Das entscheidet der Nutzer nach der BuchhaltungsButler-Einstellung 'Debitoren und Kreditoren aktivieren'; solange bucht der Connector nichts vor und gibt keinen fertigen Aufruf.",
    `Debitoren/Kreditoren aktiv: den Beleg auf den kreditorischen Händler buchen (add_receipt_postings: Soll ${BOOKING_ACCOUNT}, Haben Kreditor des Händlers, Splits wie in den Hinweisen), die Zahlung gleicht ihn nur aus (add_transaction_postings auf den Kreditor, vat 0_none).`,
    `${AUS_SENTENCE} Dann die Zahlung buchen (add_transaction_postings auf ${BOOKING_ACCOUNT} mit den Splits wie in den Hinweisen); gibt es keine Zahlung, gibt es nichts zu buchen.`,
  ];
  try {
    const res = await client.call<{ data?: Row[] }>("settingsGetCreditors", { limit: 1, offset: 0 });
    if ((res.data ?? []).length > 0) steps.push("Es gibt Kreditoren in dieser Instanz: Debitoren/Kreditoren sind vermutlich aktiv.");
  } catch {
    // the hint is optional
  }
  return result("needs_decision", steps);
}

// Debitoren/Kreditoren on: book the receipt on the merchant's Kreditor, the payment only settles it (vat 0_none).
async function buildAktiv(c: Ctx): Promise<BookingProposal> {
  const { client, input, id, notes, assignedRows, assigned, result } = c;
  const now = input.now ?? new Date();
  const receiptPostings = await readReceiptPostings(client, id, input.receiptDate, now);
  const receiptBooked = receiptPostings.length > 0;
  const posted = [
    ...new Set(
      receiptPostings.map((p) => Number(p.credit_postingaccount_number)).filter((n) => Number.isInteger(n) && n >= KREDITOR_MIN && n <= KREDITOR_MAX)
    ),
  ];
  let booked: Array<boolean | null> = [];
  if (assignedRows.length > 0) {
    const status = await attachPostingStatus(client, assignedRows);
    booked = status.rows.map((r) => (r.posting_status as { booked: boolean | null } | undefined)?.booked ?? null);
  }
  const payBooked = assigned.length > 0 && booked.every((b) => b === true);
  notes.push(DK_ACCOUNT_NOTE);

  // Kreditor: the one the receipt already sits on, else the given one, else derived from earlier bookings of the merchant.
  let creditor: number | null = null;
  let creditorView: NonNullable<BookingProposal["creditor"]> = { number: null, source: "none", evidence: [] };
  let unknownSteps: string[] = [];
  if (receiptBooked) {
    if (posted.length === 1) {
      creditor = posted[0];
      creditorView = { number: creditor, source: "receipt", evidence: ["der Beleg ist selbst schon auf diesem Kreditor gebucht"] };
      if (input.creditor !== undefined && input.creditor !== creditor) {
        return result("needs_decision", [`Der Beleg ist schon auf Kreditor ${creditor} gebucht, angegeben wurde ${input.creditor}. Nicht automatisch buchen; mit dem Nutzer klären, welcher gilt.`], { creditor: creditorView });
      }
    } else {
      return result(
        "needs_decision",
        [
          "Der Beleg ist schon gebucht (list_postings prüfen), aber nicht auf genau einem Kreditor (Personenkonto ab 70000); es kann auch eine freie Buchung mit Beleg sein. Deshalb kein Ausgleich vorgeschlagen; die Buchung mit dem Nutzer klären.",
        ]
      );
    }
  } else if (input.creditor !== undefined) {
    creditor = input.creditor;
    creditorView = { number: creditor, source: "given", evidence: [] };
  } else {
    const found = await findMerchantCreditor(client, input.merchantName, { excludeIds: [id, ...(input.sourceId === undefined ? [] : [input.sourceId])], now });
    if ("creditor" in found) {
      creditor = found.creditor;
      creditorView = { number: creditor, source: "derived", evidence: found.evidence };
    } else if ("candidates" in found) {
      unknownSteps = [
        `Kreditor des Händlers nicht eindeutig: frühere Belege liegen auf ${found.candidates.map((x) => `${x.creditor} (${x.evidence.join(", ")})`).join("; ")}. Den richtigen mit \`creditor\` angeben.`,
      ];
    } else {
      unknownSteps = [`Kreditor des Händlers nicht ermittelbar: mit \`creditor\` angeben. ${found.none}`];
    }
  }
  if (creditor === null) {
    notes.push(splitNote(c.baseSplits));
    return result(
      "needs_decision",
      [
        ...unknownSteps,
        "Gebucht wird der Beleg auf den Kreditor des Händlers (add_receipt_postings), die Zahlung gleicht ihn danach aus; ohne Kreditor-Nummer gibt es keinen fertigen Aufruf. Kreditoren listet list_contacts (creditor).",
      ],
      { creditor: creditorView }
    );
  }

  const splits = c.baseSplits;
  const calls: BookingProposal["calls"] = [];
  const steps: string[] = [];
  const reimbursement = input.amounts.reimbursement.toFixed(2);
  const receiptCall = () => ({
    tool: "add_receipt_postings",
    arguments: { receipts: [{ receipt_id_by_customer: id, creditor: creditor!, debtor: 10000, splits }] },
  });
  const settleCall = (t: AssignedTransaction) => ({
    tool: "add_transaction_postings",
    arguments: {
      transactions: [
        {
          transaction_id_by_customer: Number(t.id_by_customer),
          splits: [{ amount: reimbursement, postingaccount: creditor!, postingtext: SETTLE_TEXT, vat: "0_none", receipt_id_by_customer: id }],
        },
      ],
    },
  });
  const settleDescription = `add_transaction_postings auf der Zahlung, ein Split über ${formatEuro(input.amounts.reimbursement)} auf Kreditor ${creditor}, vat 0_none, Text "${SETTLE_TEXT}", receipt_id_by_customer ${id}`;
  const withCreditor = (status: ProposalStatus, st: string[], extra: Partial<BookingProposal> = {}) => result(status, st, { creditor: creditorView, ...extra });

  if (!receiptBooked) {
    calls.push(receiptCall());
    notes.push(DEBTOR_NOTE, splitNote(splits));
    if (c.account !== null) {
      steps.push(`Der Beleg liegt auf Konto ${c.account}. Lehnt BuchhaltungsButler die kreditorische Buchung ab (Konto mit 'Beleg erzeugt Zahlung'), erst die Zuordnung lösen (unassign_receipt) und den Beleg dann buchen.`);
    }
  }
  if (receiptBooked && (assigned.length === 0 || payBooked)) {
    return withCreditor(
      "already_booked",
      payBooked
        ? [`Der Beleg ist auf Kreditor ${creditor} gebucht und die zugeordnete Zahlung ${assigned.map(describeTx).join("; ")} gleicht ihn aus. Nichts mehr zu tun; bei Bedarf mit list_postings prüfen.`]
        : [`Der Beleg ist schon auf Kreditor ${creditor} gebucht. Eine Zahlung gibt es noch nicht: sobald sie da ist, dem Beleg zuordnen (assign_receipts_to_transactions) und den Ausgleich buchen (${settleDescription}).`]
    );
  }
  if (assigned.length === 0) {
    steps.push(
      `Den Beleg auf Kreditor ${creditor} buchen (add_receipt_postings, Aufruf unten).`,
      `Eine Zahlung zum Beleg gibt es noch nicht, deshalb kein Ausgleich-Aufruf. Sobald die Erstattung da ist: Zahlung dem Beleg zuordnen (assign_receipts_to_transactions), dann den Ausgleich buchen (${settleDescription}).`
    );
    return withCreditor("ready", steps, { calls });
  }
  // a payment is assigned
  const exact = assigned.length === 1 && booked[0] === false && Math.round(Math.abs(num(assigned[0].amount)) * 100) === Math.round(input.amounts.reimbursement * 100);
  if (exact) {
    calls.push(settleCall(assigned[0]));
    steps.push(
      receiptBooked
        ? `Der Beleg ist schon auf Kreditor ${creditor} gebucht; die Zahlung ${assigned[0].id_by_customer} (${formatEuro(num(assigned[0].amount))}) gleicht ihn aus (Aufruf unten).`
        : `Erst den Beleg buchen, dann den Ausgleich auf der Zahlung: 1. add_receipt_postings auf Kreditor ${creditor}, 2. add_transaction_postings mit Zahlung ${assigned[0].id_by_customer} (${formatEuro(num(assigned[0].amount))}), vat 0_none gegen den Kreditor. Die Reihenfolge ist wichtig.`
    );
    return withCreditor("ready", steps, { calls });
  }
  const listed = assigned.map(describeTx).join("; ");
  let reason: string;
  if (assigned.length === 1 && booked[0] === true) {
    reason = `Die zugeordnete Zahlung ${listed} ist schon gebucht (vermutlich "via Zahlung" auf das Aufwandskonto), der Beleg aber nicht auf dem Kreditor. Beides zusammen geht in BuchhaltungsButler nicht; die Buchung der Zahlung prüfen (list_postings) und mit dem Nutzer klären, ob sie gelöst werden soll.`;
  } else if (booked.some((b) => b === null)) {
    reason = `Der Buchungsstatus der Zahlung(en) ist nicht sicher bekannt (Abfrage der Buchungen unvollständig). Zugeordnet: ${listed}.`;
  } else if (assigned.length > 1) {
    reason = `Mehrere Zahlungen sind dem Beleg zugeordnet: ${listed}.`;
  } else {
    reason = `Der Betrag der zugeordneten Zahlung weicht von der Erstattung ${formatEuro(input.amounts.reimbursement)} ab: ${listed}.`;
  }
  // every needs_decision comes without calls: the receipt booking that would follow is only described
  calls.length = 0;
  if (!receiptBooked) steps.push(`Danach folgt die Buchung des Beleges auf Kreditor ${creditor} (add_receipt_postings, Splits wie in den Hinweisen, debtor 10000); sie wird erst vorgeschlagen, wenn die Zahlung geklärt ist.`);
  steps.unshift(`${reason} Nicht automatisch ausgleichen; mit dem Nutzer klären, was die Zahlung abdeckt (Ausgleich wäre: ${settleDescription}).`);
  return withCreditor("needs_decision", steps, { calls });
}

async function build(client: BBClient, input: BookingInput, policyLoader: typeof loadPolicy): Promise<BookingProposal> {
  const id = toId(input.newId);
  const base = (dk: DebitorenKreditoren | null): Pick<BookingProposal, "debitoren_kreditoren" | "auslagenkonto"> => ({ debitoren_kreditoren: dk, auslagenkonto: input.auslagenkonto });
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
  const dk = (await policyLoader()).tax_profile.debitoren_kreditoren;
  const row = await readReceipt(client, id);
  const account = row.account === undefined || row.account === null || String(row.account).trim() === "" ? null : String(row.account);
  const assignedRes = await client.call<{ data?: Row[] }>("receiptsAssignedTransactionsGet", { receipt_id_by_customer: id });
  const assignedRows = assignedRes.data ?? [];
  const assigned = assignedRows.map(view);
  const notes = [KONTENRAHMEN_NOTE, INHABER_NOTE];
  const result = (status: ProposalStatus, steps: string[], extra: Partial<BookingProposal> = {}): BookingProposal => ({
    ...base(dk),
    status,
    receipt: { id_by_customer: id, account, assigned_transactions: assigned },
    steps,
    calls: [],
    notes,
    ...extra,
  });
  const ctx: Ctx = { client, input, id, notes, account, assignedRows, assigned, baseSplits: baseSplits(input), result };
  if (dk === "aktiv") return buildAktiv(ctx);
  if (dk === "aus") return buildAus(ctx);
  return buildUnset(ctx);
}

export async function buildBookingProposal(client: BBClient, input: BookingInput, policyLoader: typeof loadPolicy = loadPolicy): Promise<BookingProposal> {
  try {
    return await build(client, input, policyLoader);
  } catch (error) {
    return {
      status: "unavailable",
      debitoren_kreditoren: null,
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
