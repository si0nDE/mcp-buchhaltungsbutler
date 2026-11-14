import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { CHECKLIST, TASK_IDS, createClosingCockpitTools } from "./closing-cockpit.js";
import { DEFAULT_POLICY, type Policy } from "./policy.js";
import { findBookingGuide } from "./booking-guide.js";

// Fiktive Beispieldaten.
const RANGE = { date_from: "2026-10-01", date_to: "2026-10-31" };
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const policy = (dk: "aktiv" | "aus" | null): Policy => ({ ...DEFAULT_POLICY, tax_profile: { kleinunternehmer: null, debitoren_kreditoren: dk } });

const TX = (id: number, amount: string) => ({ id_by_customer: String(id), to_from: "Bank", amount, booking_date: "2026-10-12" });
const P = (over: Record<string, unknown>) => ({
  id_by_customer: "1",
  amount: "10.00",
  fixed: "0",
  debit_postingaccount_number: "4930",
  credit_postingaccount_number: "1200",
  receipt_id_by_customer: "",
  transaction_id_by_customer: "",
  receipts_assigned_ids_by_customer: "",
  ...over,
});

function setup(
  data: { transactions?: unknown[]; postings?: unknown[]; accounts?: unknown[]; receipts?: unknown[]; outboundReceipts?: unknown[]; byAccount?: Record<string, unknown[]> },
  dk: "aktiv" | "aus" | null = "aus"
) {
  const call = vi.fn((key: string, params: Record<string, unknown>) => {
    if (key === "receiptsGet") return Promise.resolve({ data: params.list_direction === "inbound" ? (data.receipts ?? []) : (data.outboundReceipts ?? []) });
    if (key === "transactionsGet") {
      if (params.account !== undefined) return Promise.resolve({ data: data.byAccount?.[String(params.account)] ?? [] });
      return Promise.resolve({ data: data.transactions ?? [] });
    }
    if (key === "postingsGet") return Promise.resolve({ data: data.postings ?? [] });
    if (key === "settingsGetPostingaccounts") return Promise.resolve({ data: [] });
    if (key === "accountsGet") return Promise.resolve({ data: data.accounts ?? [] });
    throw new Error(`unexpected call ${key}`);
  });
  const [tool] = createClosingCockpitTools({ call } as unknown as BBClient, async () => policy(dk));
  return { call, tool };
}

const find = (out: ReturnType<typeof parse>, id: string) => out.abschnitte.flatMap((s: { aufgaben: Array<{ id: string }> }) => s.aufgaben).find((a: { id: string }) => a.id === id);

describe("catalog", () => {
  it("has the 11 sections and 54 uniquely named tasks of the Abschluss-Cockpit", () => {
    expect(CHECKLIST).toHaveLength(11);
    expect(TASK_IDS).toHaveLength(54);
    expect(new Set(TASK_IDS).size).toBe(54);
    for (const id of ["A1", "A3", "D1", "D2–D3", "D4–D7", "F1–F3", "I1-6", "J0", "J4", "I2-5", "I2-6", "I2-7"]) expect(TASK_IDS).toContain(id);
  });

  it("is read-only, offers the choice up front and has a guide topic", () => {
    const { tool } = setup({});
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(tool.description).toMatch(/selbst abarbeiten/);
    expect(tool.description).toMatch(/abschluss_cockpit/);
    expect(JSON.stringify(findBookingGuide("abschluss_cockpit"))).toMatch(/nie 'sicher'/i);
  });
});

describe("get_closing_checklist", () => {
  const accounts = [{ postingaccount_number: "1200", name: "Girokonto" }];

  it("is not ready without a statement balance and says so", async () => {
    const { tool } = setup({ accounts, byAccount: { "1200": [TX(1, "100.00")] }, transactions: [TX(1, "100.00")], postings: [P({ transaction_id_by_customer: "1" })] });
    const out = parse(await tool.handler(RANGE));
    expect(out.bereit_fuer_festschreibung).toBe(false);
    expect(find(out, "E2").status).toBe("offen");
    expect(out.gruende_gegen_festschreibung.join(" ")).toMatch(/E2/);
    expect(out.konten[0]).toMatchObject({ konto: 1200, berechnet: 100, status: "auszugssaldo_fehlt" });
  });

  it("flags a balance that differs from the statement and an unbooked payment", async () => {
    const { tool } = setup({ accounts, byAccount: { "1200": [TX(1, "100.00")] }, transactions: [TX(1, "100.00"), TX(2, "-5.00")], postings: [P({ transaction_id_by_customer: "1" })] });
    const out = parse(await tool.handler({ ...RANGE, statement_balances: { "1200": 90 } }));
    expect(find(out, "J0").status).toBe("auffaellig");
    expect(find(out, "D1").status).toBe("auffaellig");
    expect(out.konten[0]).toMatchObject({ differenz: -10, status: "abweichung" });
    expect(out.bereit_fuer_festschreibung).toBe(false);
  });

  it("is ready for Festschreiben when all automatic checks pass, but still leaves the submission to the user", async () => {
    const { tool } = setup({ accounts, byAccount: { "1200": [TX(1, "100.00")] }, transactions: [TX(1, "100.00")], postings: [P({ transaction_id_by_customer: "1", fixed: "0" })] });
    const out = parse(await tool.handler({ ...RANGE, statement_balances: { "1200": 100 } }));
    expect(find(out, "D1").status).toBe("geprueft_ok");
    expect(find(out, "E2").status).toBe("geprueft_ok");
    expect(find(out, "A3").status).toBe("geprueft_ok");
    expect(find(out, "I2-5").status).toBe("nur_oberflaeche");
    expect(out.bereit_fuer_festschreibung).toBe(true);
    expect(out.nur_nutzer.join(" ")).toMatch(/Voranmeldung/);
    expect(out.rueckfrage_an_nutzer).toMatch(/Artefakt/);
    expect(find(out, "I2-6").status).toBe("nur_oberflaeche");
  });

  it("treats Forderungen, Abgrenzung and Bestand as not applicable for EÜR, and Belege ohne Buchung as information", async () => {
    const receipts = [{ id_by_customer: "7", type: "invoice inbound", date: "2026-10-05", counterparty: "Muster GmbH", invoicenumber: "RE-1", amount: "10.00" }];
    const { tool } = setup({ accounts, receipts, byAccount: { "1200": [] } }, "aus");
    const out = parse(await tool.handler(RANGE));
    for (const id of ["H0", "H1", "G2", "G6", "K1"]) expect(find(out, id).status).toBe("nicht_zutreffend");
    expect(find(out, "X1").status).toBe("offen");
    expect(find(out, "X1").detail.belege_ohne_buchung).toBe(1);
    expect(out.profil.gewinnermittlung_abgeleitet).toBe("EÜR");
  });

  it("splits X1 (Eingang) and X7 (Ausgang) and does not count receipts booked later or on other days", async () => {
    const inb = { id_by_customer: "7", type: "invoice inbound", date: "2026-10-05", counterparty: "Muster GmbH", invoicenumber: "RE-1", amount: "10.00" };
    const out = { id_by_customer: "8", type: "invoice outbound", date: "2026-10-05", counterparty: "Kunde", invoicenumber: "A-1", amount: "20.00" };
    const later = { id_by_customer: "9", type: "invoice inbound", date: "2026-10-06", counterparty: "Beispiel Netz GmbH", invoicenumber: "T-1", amount: "30.00" };
    const { tool } = setup({
      accounts,
      receipts: [inb, later],
      outboundReceipts: [out],
      byAccount: { "1200": [] },
      postings: [P({ receipt_id_by_customer: "9", date: "2026-11-02 01:00:00" })],
    });
    const out1 = parse(await tool.handler(RANGE));
    expect(find(out1, "X1").detail.belege.map((r: { id_by_customer: string }) => r.id_by_customer)).toEqual(["7"]);
    expect(find(out1, "X7").detail.belege.map((r: { id_by_customer: string }) => r.id_by_customer)).toEqual(["8"]);
  });

  it("compares only Kasse and Bank accounts with the statement, and honours payment_accounts", async () => {
    const accs = [
      { postingaccount_number: "1200", name: "Girokonto" },
      { postingaccount_number: "1705", name: "Darlehen" },
      { postingaccount_number: "1371", name: "EÜR Verrechnungskonto" },
    ];
    const { tool } = setup({ accounts: accs, byAccount: { "1200": [TX(1, "10.00")], "1705": [TX(2, "-5.00")] } });
    const out1 = parse(await tool.handler({ ...RANGE, statement_balances: { "1200": 10 } }));
    expect(out1.konten.map((k: { konto: number }) => k.konto)).toEqual([1200]);
    expect(out1.weitere_konten_nicht_abgestimmt.map((k: { konto: number }) => k.konto)).toEqual([1705, 1371]);
    const out2 = parse(await tool.handler({ ...RANGE, payment_accounts: [1200, 1705], statement_balances: { "1200": 10 } }));
    expect(out2.konten.map((k: { konto: number }) => k.konto)).toEqual([1200, 1705]);
    expect(find(out2, "E2").status).toBe("offen");
  });

  it("keeps the Bilanz tasks open and warns when debitoren_kreditoren is not set", async () => {
    const { tool } = setup({ accounts, byAccount: { "1200": [] } }, null);
    const out = parse(await tool.handler(RANGE));
    expect(find(out, "H0").status).toBe("offen");
    expect(out.gruende_gegen_festschreibung.join(" ")).toMatch(/debitoren_kreditoren nicht gesetzt/);
  });

  it("hides tasks the user turned off in the Cockpit and excludes conditions that do not apply", async () => {
    const { tool } = setup({ accounts, byAccount: { "1200": [] } });
    const out = parse(await tool.handler({ ...RANGE, hidden_tasks: ["A5"], conditions: ["eu"] }));
    expect(find(out, "A5").status).toBe("ausgeblendet");
    expect(find(out, "F2").status).toBe("nicht_zutreffend");
    expect(find(out, "I2-2").status).toBe("offen");
    expect(find(out, "I2-3").status).toBe("nicht_zutreffend");
  });

  it("is not ready when a page limit was hit", async () => {
    const full = Array.from({ length: 500 }, (_, i) => TX(i + 1, "1.00"));
    const { tool } = setup({ accounts, byAccount: { "1200": [] }, transactions: full, postings: [] });
    const out = parse(await tool.handler({ ...RANGE, statement_balances: { "1200": 0 } }));
    expect(out.bereit_fuer_festschreibung).toBe(false);
    expect(out.gruende_gegen_festschreibung.join(" ")).toMatch(/Seitenlimit/);
  });
});
