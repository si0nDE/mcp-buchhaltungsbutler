import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { BuchhaltungsButlerApiError } from "../bb-client/errors.js";
import { averagePaymentDays, balancesFromSums, cashflowByMonth, createLiquidityTools, openByParty, openReceiptKpis, openReceiptRows } from "./liquidity.js";

// Erfundene Zahlen. Aufbau wie die Summen- und Saldenliste von reportsGetSums.
const entry = (cls: string, nr: number, abs: number, side: "debit" | "credit") => ({
  postingaccount: { class: cls, postingaccount_number: nr, name: `Konto ${nr}` },
  balanceAfterAbsolute: abs,
  balanceAfterSide: side,
});
const sums = (list: Array<[string, number, number, "debit" | "credit"]>) => ({
  integrityError: false,
  sums: Object.fromEntries(list.map(([c, nr, a, s]) => [String(nr), entry(c, nr, a, s)])),
});

describe("balancesFromSums", () => {
  const b = balancesFromSums(
    sums([
      ["Finanzkonto", 1200, 100, "debit"],
      ["Finanzkonto", 1000, 20, "credit"],
      ["Finanzkonto", 1705, 500, "credit"],
      ["Vorsteuer", 1576, 40, "debit"],
      ["Umsatzsteuer", 1776, 90, "credit"],
      ["Verbindlichkeiten", 1741, 7, "debit"],
      ["Interimskonto", 1590, 3, "debit"],
      ["Saldovortrag", 9000, 0, "debit"],
      ["Betriebsausgabe", 4950, 999, "debit"],
    ])
  );
  it("Cash-Bestand ist die Summe aller Finanzkonten mit Vorzeichen, auch Darlehenskonten dieser Klasse", () => {
    expect(b.cash).toBe(-420);
    expect(b.finanzkonten.sort()).toEqual(["1000", "1200", "1705"]);
  });
  it("Working Capital: Cash - Vorsteuer - Umsatzsteuer + Verbindlichkeiten (Soll positiv)", () => {
    // -420 - 40 - (-90) + 7
    expect(b.workingCapital).toBe(-363);
  });
  it("Interims- und Saldenvortragskonten werden für den Cashflow gemerkt, Aufwandskonten ignoriert", () => {
    expect(b.interimskonten).toEqual(["1590", "9000"]);
  });
});

describe("cashflowByMonth", () => {
  const fin = new Set(["1200", "1000"]);
  const skip = new Set(["1590", "1360", "9000"]);
  const p = (date: string, amount: string, db: string, cr: string) => ({ date: `${date} 00:00:00`, amount, debit_postingaccount_number: db, credit_postingaccount_number: cr });
  const r = cashflowByMonth(
    [
      p("2026-03-02", "100.00", "1200", "8400"),
      p("2026-03-05", "40.50", "4950", "1200"),
      p("2026-03-06", "500.00", "1200", "1590"), // zurückgebuchte Lastschrift: zählt nicht
      p("2026-03-07", "500.00", "1590", "1200"),
      p("2026-03-08", "70.00", "1200", "1000"), // zwischen Finanzkonten: zählt nicht
      p("2026-03-09", "25.00", "1360", "1000"), // Geldtransit: zählt nicht
      p("2026-03-10", "900.00", "1200", "9000"), // Anfangssaldo (Saldenvortrag): zählt nicht
      p("2026-04-01", "10.00", "1000", "8400"),
      p("2025-12-31", "99.00", "1200", "8400"), // außerhalb der Monate
    ],
    fin,
    skip,
    ["2026-03", "2026-04"]
  );
  it("zählt Einzahlungen und Auszahlungen je Monat ohne Interims-, Geldtransit- und Eigenüberweisungen", () => {
    expect(r.get("2026-03")).toEqual({ ein: 100, aus: 40.5 });
    expect(r.get("2026-04")).toEqual({ ein: 10, aus: 0 });
  });
});

describe("openReceiptKpis", () => {
  const rows = [
    { amount: "1000.00", counterparty: "Kunde A", date: "2026-09-01", due_date: "2026-09-15" },
    { amount: "300.00", counterparty: "Kunde B", date: "2026-02-01", due_date: "2026-02-15" }, // lange überfällig
    { amount: "-50.00", counterparty: "Kunde A", date: "2026-09-10", due_date: null }, // Gutschrift
    { amount: "400.00", counterparty: "Kunde C", date: "2024-01-01", due_date: "2024-01-15" }, // älter als 12 Monate
    { amount: "20.00", counterparty: "Kunde D", date: "2026-10-01", due_date: null },
    { amount: "10.00", counterparty: "Kunde E", date: "2026-10-02", due_date: null },
  ];
  const k = openReceiptKpis(rows, "2026-10-30");
  it("summiert alle offenen Belege, Gutschriften mindern", () => {
    expect(k.summe).toBe(1680);
    expect(k.anzahl).toBe(6);
  });
  it("Top 3 nur aus den letzten zwölf Monaten, nach offenem Betrag", () => {
    expect(k.top).toEqual([
      { name: "Kunde A", betrag: 950 },
      { name: "Kunde B", betrag: 300 },
      { name: "Kunde D", betrag: 20 },
    ]);
  });
  it("zweifelhaft: mindestens 90 Tage überfällig (ohne Fälligkeit nach Belegdatum)", () => {
    // B (Feb) und C (2024) sind überfällig; A und D, E nicht
    expect(k.zweifelhaft).toEqual({ betrag: 700, anteil_pct: 41.67 });
  });
  it("ohne offene Belege kein Anteil statt Division durch 0", () => {
    expect(openReceiptKpis([], "2026-10-30").zweifelhaft.anteil_pct).toBeNull();
  });
});

describe("offene Belege einzeln und je Firma", () => {
  const rows = [
    { id_by_customer: "7", amount: "300.00", counterparty: "Kunde B", date: "2026-02-01", due_date: "2026-02-15", invoicenumber: "B-1" },
    { id_by_customer: "5", amount: "1000.00", counterparty: "Kunde A", date: "2026-09-01", due_date: "2026-09-15", invoicenumber: "A-2" },
    { id_by_customer: "4", amount: "-50.00", counterparty: "Kunde A", date: "2026-09-10", due_date: null, invoicenumber: "A-G" },
    { id_by_customer: "9", amount: "20.00", counterparty: "Kunde A", date: "2026-02-03", due_date: "2026-02-20", invoicenumber: "A-1" },
  ];
  const list = openReceiptRows(rows, "2026-10-30");
  it("Zeilen mit Tagen seit Fälligkeit (ohne Fälligkeit seit Belegdatum), nach Firma und Datum sortiert", () => {
    expect(list.map((r) => r.nummer)).toEqual(["A-1", "A-2", "A-G", "B-1"]);
    expect(list.find((r) => r.nummer === "A-2")).toMatchObject({ id: 5, betrag: 1000, faellig: "2026-09-15", tage_ueberfaellig: 45 });
    expect(list.find((r) => r.nummer === "A-G")).toMatchObject({ faellig: null, tage_ueberfaellig: 50 });
  });
  it("je Firma: offene Summe, Anzahl, überfälliger Teil und älteste Fälligkeit; größte Summe zuerst", () => {
    const p = openByParty(list);
    expect(p[0]).toEqual({ name: "Kunde A", offen: 970, anzahl: 3, ueberfaellig_90: 20, aelteste_faelligkeit: "2026-02-20" });
    expect(p[1]).toEqual({ name: "Kunde B", offen: 300, anzahl: 1, ueberfaellig_90: 300, aelteste_faelligkeit: "2026-02-15" });
  });
  it("die Summe der Zeilen ist die Summe der offenen Belege", () => {
    expect(list.reduce((t, r) => t + r.betrag, 0)).toBe(openReceiptKpis(rows, "2026-10-30").summe);
  });
});

describe("averagePaymentDays", () => {
  const fin = new Set(["1200"]);
  const p = (date: string, types: string, dates: string, db = "1200", cr = "1400") => ({
    date: `${date} 00:00:00`,
    receipts_assigned_types: types,
    receipts_assigned_dates: dates,
    debit_postingaccount_number: db,
    credit_postingaccount_number: cr,
  });
  it("mittelt Tage vom Belegdatum bis zur Zahlung, nur Belege der letzten zwölf Monate, nur Zahlungen auf Finanzkonten", () => {
    const r = averagePaymentDays(
      [
        p("2026-05-11", "invoice outbound", "2026-05-01 00:00:00"), // 10
        p("2026-06-21", "invoice outbound", "2026-06-01 00:00:00"), // 20
        p("2026-06-21", "invoice outbound", "2024-06-01 00:00:00"), // zu alt
        p("2026-06-21", "invoice inbound", "2026-06-01 00:00:00"), // andere Richtung
        p("2026-06-21", "invoice outbound", "2026-06-01 00:00:00", "4950", "8400"), // kein Finanzkonto
      ],
      "invoice outbound",
      fin,
      "2026-10-30"
    );
    expect(r).toEqual({ tage: 15, anzahl: 2 });
  });
  it("Sammelzahlung auf mehrere Belege zählt nicht", () => {
    const r = averagePaymentDays(
      [p("2026-06-11", "invoice inbound, invoice inbound", "2026-06-01 00:00:00, 2026-05-22 00:00:00")],
      "invoice inbound",
      fin,
      "2026-10-30"
    );
    expect(r).toEqual({ tage: null, anzahl: 0 });
  });
  it("ohne Zahlungen gibt es keine Laufzeit", () => {
    expect(averagePaymentDays([], "invoice outbound", fin, "2026-10-30")).toEqual({ tage: null, anzahl: 0 });
  });
});

// Client mit festen Antworten; die erste Abfrage jedes Reports ist "noch nicht fertig".
function fakeClient() {
  let next = 1;
  const ranges = new Map<number, [string, string]>();
  const polls = new Map<number, number>();
  const created: string[] = [];
  const call = vi.fn(async (op: string, params: Record<string, unknown>) => {
    if (op === "reportsCreateSums") {
      const id = next++;
      ranges.set(id, [String(params.date_from), String(params.date_to)]);
      created.push(String(params.date_to));
      return { success: true, id_by_customer: String(id) };
    }
    if (op === "reportsGetSums") {
      const id = Number(params.report_id_by_customer);
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      if (n === 1) throw new BuchhaltungsButlerApiError("HTTP 400 — report generation has not been finished yet", 400, "reportsGetSums", {});
      const [, to] = ranges.get(id)!;
      // Cash wächst mit dem Monat: Oktober 1000, September 800, August 600
      const cash = to.startsWith("2026-10") ? 1000 : to.startsWith("2026-09") ? 800 : 600;
      return {
        success: true,
        report: sums([
          ["Finanzkonto", 1200, cash, "debit"],
          ["Vorsteuer", 1576, 10, "debit"],
          ["Umsatzsteuer", 1776, 30, "credit"],
          ["Interimskonto", 1590, 0, "debit"],
        ]),
      };
    }
    if (op === "receiptsGet") {
      const out = params.list_direction === "outbound";
      return {
        data: out
          ? [
              { amount: "900.00", counterparty: "Kunde A", date: "2026-09-01", due_date: "2026-09-15" },
              { amount: "100.00", counterparty: "Kunde B", date: "2026-01-10", due_date: "2026-01-24" },
            ]
          : [{ amount: "250.00", counterparty: "Lieferant X", date: "2026-10-01", due_date: null }],
      };
    }
    if (op === "postingsGet") {
      return {
        data: [
          { date: "2026-09-05 00:00:00", amount: "300.00", debit_postingaccount_number: "1200", credit_postingaccount_number: "8400" },
          { date: "2026-10-05 00:00:00", amount: "120.00", debit_postingaccount_number: "4950", credit_postingaccount_number: "1200" },
        ],
      };
    }
    throw new Error(`unexpected ${op}`);
  });
  return { client: { call } as unknown as BBClient, call, created };
}

const sleep = vi.fn(async () => {});
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("get_liquidity", () => {
  it("holt je Monat eine Summen- und Saldenliste, nacheinander, ab Jahresanfang bis Monatsende", async () => {
    const { client, call, created } = fakeClient();
    const [tool] = createLiquidityTools(client, { sleep, pollMs: 1 });
    await tool.handler({ as_of: "2026-10-30", months: 3 });
    expect(created).toEqual(["2026-08-31", "2026-09-30", "2026-10-30"]);
    const sumCreates = call.mock.calls.filter(([op]) => op === "reportsCreateSums");
    expect(sumCreates[0][1]).toEqual({ date_from: "2026-01-01", date_to: "2026-08-31" });
    expect(sleep).toHaveBeenCalled();
  });

  it("rechnet Cash, Working Capital, Quick Ratio und Future Cash-Inflow", async () => {
    const { client } = fakeClient();
    const [tool] = createLiquidityTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-10-30", months: 3 }));
    expect(res.cash.bestand).toBe(1000);
    // 1000 - 10 + 30
    expect(res.cash.working_capital).toBe(1020);
    expect(res.zeitreihe.cash_bestand).toEqual([600, 800, 1000]);
    expect(res.forderungen.summe).toBe(1000);
    expect(res.verbindlichkeiten.summe).toBe(250);
    expect(res.kennzahlen.future_cash_inflow).toBe(750);
    // (1000 + 1000) / 250
    expect(res.kennzahlen.quick_ratio).toBe(8);
    expect(res.forderungen.top[0]).toEqual({ name: "Kunde A", betrag: 900 });
    expect(res.forderungen.parteien.map((p: { name: string }) => p.name)).toEqual(["Kunde A", "Kunde B"]);
    expect(res.forderungen.belege).toHaveLength(2);
    expect(res.verbindlichkeiten.belege[0]).toMatchObject({ gegenpartei: "Lieferant X", betrag: 250 });
  });

  it("Cashflow aus Buchungen, Burn Rate als Mittel (Auszahlungen - Einzahlungen), Runway = Cash durch Burn Rate", async () => {
    const { client } = fakeClient();
    const [tool] = createLiquidityTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-10-30", months: 3 }));
    expect(res.zeitreihe.einzahlungen).toEqual([0, 300, 0]);
    expect(res.zeitreihe.auszahlungen).toEqual([0, 0, 120]);
    expect(res.zeitreihe.cashflow).toEqual([0, 300, -120]);
    // (120 - 300) / 3
    expect(res.cash.burn_rate).toBe(-60);
    expect(res.cash.cash_runway).toBe(-16.67);
  });

  it("ohne Burn Rate gibt es keinen Runway", async () => {
    const { client } = fakeClient();
    const [tool] = createLiquidityTools(
      {
        call: vi.fn(async (op: string, params: Record<string, unknown>) => (op === "postingsGet" ? { data: [] } : client.call(op as never, params))),
      } as unknown as BBClient,
      { sleep, pollMs: 1 }
    );
    const res = parse(await tool.handler({ as_of: "2026-10-30", months: 1 }));
    expect(res.cash.cash_runway).toBeNull();
  });

  it("wartet, wenn BHB schon eine andere Summen- und Saldenliste rechnet", async () => {
    const inner = fakeClient();
    let busy = 2;
    const call = vi.fn(async (op: string, params: Record<string, unknown>) => {
      if (op === "reportsCreateSums" && busy-- > 0) throw new BuchhaltungsButlerApiError("HTTP 400 — report generation already in progress", 400, "reportsCreateSums", {});
      return inner.client.call(op as never, params);
    });
    const [tool] = createLiquidityTools({ call } as unknown as BBClient, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-10-30", months: 1 }));
    expect(res.cash.bestand).toBe(1000);
  });

  it("weist falsche Eingaben ab, bevor BHB einen Aufruf sieht", async () => {
    const { client, call } = fakeClient();
    const [tool] = createLiquidityTools(client, { sleep, pollMs: 1 });
    await expect(tool.handler({ as_of: "30.10.2026" })).rejects.toThrow(/YYYY-MM-DD/);
    expect(call).not.toHaveBeenCalled();
  });
});
