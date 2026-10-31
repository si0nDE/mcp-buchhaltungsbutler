import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { BuchhaltungsButlerApiError } from "../bb-client/errors.js";
import { averageDaysToPay, balancesFromSums, cashflowByMonth, createLiquidityTools, openByParty, openReceiptKpis, openReceiptRows, topPersonenkonten, zweifelhaftAmpel } from "./liquidity.js";

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

describe("zweifelhaftAmpel", () => {
  it("grün bis 33 %, gelb bis 66 %, darüber rot, ohne Forderungen keine Ampel", () => {
    expect([0, 32.99, 33, 65.99, 66, 100].map(zweifelhaftAmpel)).toEqual(["gruen", "gruen", "gelb", "gelb", "rot", "rot"]);
    expect(zweifelhaftAmpel(null)).toBeNull();
  });
});

describe("Bilanzierer: Personenkonten, Working Capital, Top nach Volumen", () => {
  const b = balancesFromSums(
    sums([
      ["Finanzkonto", 1200, 100, "debit"],
      ["Vorsteuer", 1576, 40, "debit"],
      ["Umsatzsteuer", 1776, 90, "credit"],
      ["Verbindlichkeiten", 1600, 300, "credit"],
      ["Forderungen", 1566, 5, "debit"],
      ["Rückstellung", 1766, 8, "credit"],
      ["Debitorenkonto", 10001, 70, "debit"],
      ["Kreditorenkonto", 70001, 280, "credit"],
      ["Kreditorenkonto", 70002, 20, "credit"],
    ])
  );
  it("Salden der Debitoren- und Kreditorenkonten und das Merkmal 'hat Personenkonten'", () => {
    expect(b.debitoren).toBe(70);
    expect(b.kreditoren).toBe(-300);
    expect(b.hatPersonenkonten).toBe(true);
    expect(balancesFromSums(sums([["Finanzkonto", 1200, 1, "debit"]])).hatPersonenkonten).toBe(false);
  });
  it("Working Capital enthält auch Forderungen (aufzuteilende Vorsteuer) und Rückstellungen", () => {
    // 100 - 40 + 90 - 300 + 5 - 8
    expect(b.workingCapital).toBe(-153);
  });
  it("Top 3: je Personenkonto der Umsatz auf der Rechnungsseite (Debitoren Soll, Kreditoren Haben), je Konto statt je Name", () => {
    const konto = (nr: number, cls: string, name: string, soll: number | null, haben: number | null) => ({
      postingaccount: { class: cls, postingaccount_number: nr, name },
      sumPeriodDebit: soll,
      sumPeriodCredit: haben,
    });
    const jahr = {
      sums: {
        "10001": konto(10001, "Debitorenkonto", "Alpha GmbH", 900, 900),
        "10002": konto(10002, "Debitorenkonto", "Beta AG", 400, 300),
        "10003": konto(10003, "Debitorenkonto", "Gamma KG", null, 50), // nur Zahlung, keine Rechnung im Zeitraum
        "70001": konto(70001, "Kreditorenkonto", "Delta GmbH", 600, 700),
        "70002": konto(70002, "Kreditorenkonto", "Delta GmbH", 80, 80), // zweites Konto derselben Firma
        "70003": konto(70003, "Kreditorenkonto", "Epsilon e.K.", 200, 150),
        "70004": konto(70004, "Kreditorenkonto", "Zeta UG", 10, 10),
        "1200": konto(1200, "Finanzkonto", "Bank", 5000, 4000),
      },
    };
    expect(topPersonenkonten(jahr, "Debitorenkonto")).toEqual([
      { name: "Alpha GmbH", betrag: 900 },
      { name: "Beta AG", betrag: 400 },
    ]);
    expect(topPersonenkonten(jahr, "Kreditorenkonto")).toEqual([
      { name: "Delta GmbH", betrag: 700 },
      { name: "Epsilon e.K.", betrag: 150 },
      { name: "Delta GmbH", betrag: 80 },
    ]);
  });
});

describe("get_liquidity bei Konten mit Debitoren und Kreditoren", () => {
  it("Forderungen und Verbindlichkeiten sind die Salden der Personenkonten; Quick Ratio und Future Cash-Inflow folgen daraus", async () => {
    const { client } = fakeClient();
    const call = vi.fn(async (op: string, params: Record<string, unknown>) => {
      const r = await client.call(op as never, params);
      if (op === "reportsGetSums") {
        const rep = (r as { report: { sums: Record<string, unknown> } }).report;
        rep.sums["10001"] = { postingaccount: { class: "Debitorenkonto", postingaccount_number: 10001, name: "Kunde A" }, balanceAfterAbsolute: 50, balanceAfterSide: "debit", sumPeriodDebit: 900, sumPeriodCredit: 850 };
        rep.sums["70001"] = { postingaccount: { class: "Kreditorenkonto", postingaccount_number: 70001 }, balanceAfterAbsolute: 200, balanceAfterSide: "credit" };
      }
      return r;
    });
    const [tool] = createLiquidityTools({ call } as unknown as BBClient, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-10-30", months: 3 }));
    // Nach den drei Monatsenden eine SuSa über zwölf Monate für die Top 3, alle nach Leistungsdatum.
    const sums = call.mock.calls.filter(([op]) => op === "reportsCreateSums").map(([, p]) => `${p.date_from}..${p.date_to} ${p.base}`);
    expect(sums.at(-1)).toBe("2025-11-01..2026-10-30 date_delivery_else_date");
    expect(res.forderungen.summe).toBe(50);
    expect(res.verbindlichkeiten.summe).toBe(200);
    expect(res.kennzahlen.future_cash_inflow).toBe(-150);
    // (1000 + 50) / 200
    expect(res.kennzahlen.quick_ratio).toBe(5.25);
    // Top 3 aus dem Soll-Umsatz des Debitorenkontos, nicht aus den Belegen
    expect(res.forderungen.top).toEqual([{ name: "Kunde A", betrag: 900 }]);
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

  it("zählt negative Splits einer Zahlung nach Soll und Haben, nicht nach dem Vorzeichen", () => {
    // Zahlungseingang 600 = Verkauf 1000 - Provision 150 - Geldtransit 250. BHB liefert die Abzüge als negative Beträge,
    // Soll und Haben zeigen schon die Richtung (Provision: Soll Aufwand, Haben Bank).
    const s = cashflowByMonth(
      [
        p("2026-06-24", "1000.00", "1200", "8820"),
        p("2026-06-24", "-150.00", "4760", "1200"),
        p("2026-06-24", "-250.00", "1360", "1200"),
        p("2026-06-25", "-15.00", "1200", "4920"), // Gutschrift innerhalb einer Lastschrift
      ],
      fin,
      skip,
      ["2026-06"]
    );
    expect(s.get("2026-06")).toEqual({ ein: 1015, aus: 150 });
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

describe("averageDaysToPay", () => {
  it("einfaches Mittel aus Zahlungsdatum minus Belegdatum, negative Tage (Vorauszahlung) zählen mit", () => {
    const r = averageDaysToPay([
      { date: "2026-05-01", payment_date: "2026-05-11" }, // 10
      { date: "2026-06-01", payment_date: "2026-06-21" }, // 20
      { date: "2026-07-10", payment_date: "2026-07-08" }, // -2
    ]);
    expect(r).toEqual({ tage: 9.33, anzahl: 3 });
  });
  it("Belege ohne Zahlungsdatum zählen nicht, ohne Belege gibt es keine Laufzeit", () => {
    expect(averageDaysToPay([{ date: "2026-05-01", payment_date: null }, { date: "2026-05-01" }])).toEqual({ tage: null, anzahl: 0 });
    expect(averageDaysToPay([])).toEqual({ tage: null, anzahl: 0 });
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
    if (op === "receiptsGet" && params.payment_status === "paid") {
      return params.list_direction === "outbound"
        ? { data: [{ date: "2026-05-01", payment_date: "2026-05-11" }, { date: "2026-06-01", payment_date: "2026-06-21" }] }
        : { data: [{ date: "2026-05-01", payment_date: "2026-05-05" }] };
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
    expect(sumCreates[0][1]).toEqual({ date_from: "2026-01-01", date_to: "2026-08-31", base: "date_delivery_else_date" });
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
    expect(res.forderungen.debitorenlaufzeit_tage).toBe(15);
    expect(res.verbindlichkeiten.kreditorenlaufzeit_tage).toBe(4);
    expect(res.forderungen.parteien.map((p: { name: string }) => p.name)).toEqual(["Kunde A", "Kunde B"]);
    expect(res.forderungen.belege).toHaveLength(2);
    expect(res.verbindlichkeiten.belege[0]).toMatchObject({ gegenpartei: "Lieferant X", betrag: 250 });
    expect(res.forderungen.zweifelhaft_ampel).toBe(zweifelhaftAmpel(res.forderungen.zweifelhaft.anteil_pct));
    expect(res.forderungen.zweifelhaft_ampel).not.toBeNull();
    expect(Object.keys(res.erklaerungen)).toEqual(expect.arrayContaining(["cash_bestand", "burn_rate", "cash_runway", "quick_ratio", "zweifelhaft"]));
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
    // Cash 1000 positiv, Burn Rate negativ (es kommt mehr herein): BHB zeigt "unbegrenzt", nicht eine negative Zahl
    expect(res.cash.cash_runway).toBeNull();
    expect(res.cash.cash_runway_unbegrenzt).toBe(true);
  });

  it("Runway bleibt eine Zahl, wenn Cash und Burn Rate beide negativ sind (wie BHB)", async () => {
    // Cash -1000, Burn Rate -60: Quotient positiv
    const { client } = fakeClient();
    const [tool] = createLiquidityTools(
      { call: vi.fn(async (op: string, params: Record<string, unknown>) => {
          const r = await client.call(op as never, params);
          if (op === "reportsGetSums") { const rep = (r as { report: { sums: Record<string, { balanceAfterSide?: string }> } }).report; rep.sums["1200"].balanceAfterSide = "credit"; }
          return r;
        }) } as unknown as BBClient,
      { sleep, pollMs: 1 }
    );
    const res = parse(await tool.handler({ as_of: "2026-10-30", months: 3 }));
    expect(res.cash.bestand).toBe(-1000);
    expect(res.cash.cash_runway).toBe(16.67);
    expect(res.cash.cash_runway_unbegrenzt).toBe(false);
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
