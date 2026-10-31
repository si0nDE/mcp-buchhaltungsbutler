import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createTaxPositionTools, cumulativeInput, monthsFromCumulative, taxArea, taxLines } from "./tax-position.js";

// Erfundene Zahlen. Saldo Soll positiv.
const e = (cls: string, nr: number, name: string, abs: number, side: "debit" | "credit") => ({
  postingaccount: { class: cls, name, postingaccount_number: nr },
  balanceAfterAbsolute: abs,
  balanceAfterSide: side,
  sumPeriodDebit: abs,
  sumPeriodCredit: 0,
});
const report = {
  integrityError: false,
  sums: Object.fromEntries(
    [
      e("Umsatzsteuer", 1776, "Umsatzsteuer 19%", 1000, "credit"),
      e("Umsatzsteuer", 1780, "Umsatzsteuer - Vorauszahlungen / Erstattungen", 300, "debit"),
      e("Vorsteuer", 1576, "Abziehbare Vorsteuer 19%", 400, "debit"),
      e("Verbindlichkeiten", 1791, "Umsatzsteuer frühere Jahre", 50, "debit"),
      e("Verbindlichkeiten", 1741, "Verbindlichkeiten aus Lohn- und Kirchensteuer", 80, "credit"),
      e("Rückstellung", 957, "Steuerrückstellung Gewerbesteuer", 600, "credit"),
      e("Betriebsausgabe", 4320, "Gewerbesteuer", 600, "debit"),
      e("Betriebsausgabe", 4950, "Rechts- und Beratungskosten", 999, "debit"),
      e("Privat", 1810, "Privatsteuern", 10, "debit"),
      e("Einnahmen", 8400, "Umsätze / Erlöse 19/16% Umsatzsteuer", 5000, "credit"),
    ].map((x) => [String(x.postingaccount.postingaccount_number), x])
  ),
};

describe("taxArea", () => {
  it("erkennt Umsatzsteuer auch unter Verbindlichkeiten, Lohnsteuer, Ertragsteuern und sonstige", () => {
    expect(taxArea("Verbindlichkeiten", "Umsatzsteuer frühere Jahre")).toBe("umsatzsteuer");
    expect(taxArea("Vorsteuer", "Abziehbare Vorsteuer 19%")).toBe("umsatzsteuer");
    expect(taxArea("Verbindlichkeiten", "Verbindlichkeiten aus Lohn- und Kirchensteuer")).toBe("lohnsteuer");
    expect(taxArea("Betriebsausgabe", "Gewerbesteuer")).toBe("ertragsteuern");
    expect(taxArea("Betriebsausgabe", "Körperschaftsteuer")).toBe("ertragsteuern");
    expect(taxArea("Betriebsausgabe", "Solidaritätszuschlag")).toBe("ertragsteuern");
    expect(taxArea("Betriebsausgabe", "Grundsteuer")).toBe("sonstige");
    expect(taxArea("Betriebsausgabe", "Rechts- und Beratungskosten")).toBeNull();
    // Namen mit Steuerwörtern, die keine Steuerkonten sind
    expect(taxArea("Einnahmen", "Umsätze / Erlöse 19/16% Umsatzsteuer")).toBeNull();
    expect(taxArea("Betriebsausgabe", "Freiwillige soziale Aufwendungen - lohnsteuerfrei")).toBeNull();
    expect(taxArea("Einnahmen", "Sonstige steuerfreie Betriebseinnahmen")).toBeNull();
    expect(taxArea("Betriebsausgabe", "Nicht abzugsf. Verspätungszuschlag und Zwangsgelder")).toBeNull();
  });
});

describe("taxLines", () => {
  it("nur Steuerkonten, ohne Privat- und Anlagenkonten, Saldo Soll positiv", () => {
    const l = taxLines(report);
    expect(l.map((x) => x.nummer).sort((a, b) => a - b)).toEqual([957, 1576, 1741, 1776, 1780, 1791, 4320]);
    expect(l.find((x) => x.nummer === 1776)).toMatchObject({ bereich: "umsatzsteuer", saldo: -1000 });
    expect(l.find((x) => x.nummer === 1576)?.saldo).toBe(400);
    expect(l.find((x) => x.nummer === 4950)).toBeUndefined();
    expect(l.find((x) => x.nummer === 1810)).toBeUndefined();
  });
});

function fakeClient() {
  const call = vi.fn(async (op: string, params: Record<string, unknown>) => {
    if (op === "reportsCreateSums") return { id_by_customer: "3" };
    if (op === "reportsGetSums") return { report };
    if (op === "receiptsGet") {
      return params.list_direction === "inbound"
        ? {
            data: [
              { id_by_customer: "1", amount: "-500.00", counterparty: "Finanzamt Beispielstadt", date: "2026-07-10", due_date: null, invoicenumber: "USt.-VA-Q2" },
              { id_by_customer: "2", amount: "20.00", counterparty: "Lieferant X", date: "2026-07-10", due_date: null, invoicenumber: "X-1" },
            ],
          }
        : { data: [] };
    }
    throw new Error(`unexpected ${op}`);
  });
  return { client: { call } as unknown as BBClient, call };
}
const sleep = vi.fn(async () => {});
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("get_tax_position", () => {
  it("Umsatzsteuer-Zahllast = -(Summe der Salden aller Umsatzsteuer-Konten), positiv heißt zu zahlen", async () => {
    const { client } = fakeClient();
    const [tool] = createTaxPositionTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-10-30" }));
    // Salden: -1000 (USt) + 300 (Vorauszahlung) + 400 (Vorsteuer) + 50 (frühere Jahre) = -250, Zahllast 250
    expect(res.umsatzsteuer.zahllast).toBe(250);
    expect(res.umsatzsteuer.konten.map((k: { nummer: number }) => k.nummer).sort()).toEqual([1576, 1776, 1780, 1791]);
  });

  it("weitere Steuern wie gebucht, die Schätzung ersetzt keine Steuererklärung", async () => {
    const { client } = fakeClient();
    const [tool] = createTaxPositionTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-10-30" }));
    expect(res.weitere_steuern.lohnsteuer).toBe(-80);
    // Rückstellung -600 (Haben) + Aufwand +600 (Soll)
    expect(res.weitere_steuern.ertragsteuern_gebucht).toBe(0);
    expect(res.hinweise.join(" ")).toMatch(/ersetzt keine Steuererklärung/);
  });

  it("offene Belege nur von Steuerbehörden, mit Richtung", async () => {
    const { client } = fakeClient();
    const [tool] = createTaxPositionTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-10-30" }));
    expect(res.offene_belege_steuerbehoerden).toHaveLength(1);
    expect(res.offene_belege_steuerbehoerden[0]).toMatchObject({ gegenpartei: "Finanzamt Beispielstadt", betrag: -500, richtung: "Eingangsrechnung" });
  });

  it("weist falsche Eingaben ab, bevor BHB einen Aufruf sieht", async () => {
    const { client, call } = fakeClient();
    const [tool] = createTaxPositionTools(client, { sleep, pollMs: 1 });
    await expect(tool.handler({ as_of: "30.10.2026" })).rejects.toThrow(/YYYY-MM-DD/);
    expect(call).not.toHaveBeenCalled();
  });
});

// Stand seit Jahresbeginn je Konto: [Klasse, Nummer, Name, Saldo (Soll positiv)]; Periodensummen bewusst anders (siehe unten)
const stand = (rows: Array<[string, number, string, number]>, periode: Record<number, [number, number]> = {}) => ({
  integrityError: false,
  sums: Object.fromEntries(
    rows.map(([cls, nr, name, saldo]) => [String(nr), { postingaccount: { class: cls, name, postingaccount_number: nr }, balanceAfterAbsolute: Math.abs(saldo), balanceAfterSide: saldo < 0 ? "credit" : "debit", sumPeriodDebit: periode[nr]?.[0] ?? 0, sumPeriodCredit: periode[nr]?.[1] ?? 0 }])
  ),
});

describe("cumulativeInput und monthsFromCumulative", () => {
  const r = cumulativeInput(
    stand([
      ["Umsatzsteuer", 1776, "Umsatzsteuer 19%", -200],
      ["Umsatzsteuer", 1787, "Umsatzsteuer nach § 13b UStG", -30], // hebt sich mit der Vorsteuer 13b auf
      ["Umsatzsteuer", 1780, "Umsatzsteuer - Vorauszahlungen / Erstattungen", 500], // Zahlung ans Finanzamt: zählt nicht
      ["Verbindlichkeiten", 1791, "Umsatzsteuer frühere Jahre", 80], // zählt nicht
      ["Vorsteuer", 1576, "Abziehbare Vorsteuer 19%", 100],
      ["Vorsteuer", 1577, "Abziehbare Vorsteuer § 13b UStG", 30],
      ["Einnahmen", 8400, "Erlöse", -1000],
      ["Betriebsausgabe", 4950, "Beratung", 400],
      ["Abschreibungen", 4832, "Abschreibung Kfz", 100],
      ["Privat", 1800, "Privatentnahmen", 900], // zählt nicht
    ])
  );
  it("Umsatzsteuer ohne Vorauszahlungen und Altjahre, Vorsteuer, Gewinn aus den Ergebniskonten ohne Privat, aus den Salden", () => {
    expect(r).toEqual({ ust: 230, vst: 130, gewinn: 500 });
  });
  it("Monatswerte sind die Differenz zum Vormonat, Januar gegen 0", () => {
    expect(monthsFromCumulative([{ schluessel: "2026-01", ust: 100, vst: 40, gewinn: 300 }, { schluessel: "2026-02", ust: 130, vst: 90, gewinn: 250 }])).toEqual([
      { schluessel: "2026-01", ust: 100, vst: 40, gewinn: 300 },
      { schluessel: "2026-02", ust: 30, vst: 50, gewinn: -50 },
    ]);
  });
  it("eine Umbuchung von 9000 auf ein Erlöskonto zählt, auch wenn BHB sie nicht in den Periodensummen führt", () => {
    // Stand Erlöse -1500 seit Jahresbeginn, die Periodensummen zeigen nur 1000 im Haben (500 kamen gegen 9000)
    expect(cumulativeInput(stand([["Einnahmen", 8400, "Erlöse", -1500]], { 8400: [0, 1000] })).gewinn).toBe(1500);
  });
});

describe("get_tax_position: Perioden und Schätzung", () => {
  function monthsClient() {
    let next = 1;
    const ranges = new Map<number, string>();
    const call = vi.fn(async (op: string, params: Record<string, unknown>) => {
      if (op === "reportsCreateSums") {
        const id = next++;
        ranges.set(id, String(params.date_from));
        return { id_by_customer: String(id) };
      }
      if (op === "reportsGetSums") {
        const from = ranges.get(Number(params.report_id_by_customer))!;
        // Januar: Gewinn 30.000, Februar: Verlust 10.000
        // Stand seit Jahresbeginn: Januar Gewinn 30.000, bis Februar kumuliert 20.000 (Februar Verlust 10.000)
        return { report: from.startsWith("2026-01") ? stand([["Einnahmen", 8400, "Erlöse", -40000], ["Betriebsausgabe", 4950, "Beratung", 10000], ["Umsatzsteuer", 1776, "Umsatzsteuer 19%", -700], ["Vorsteuer", 1576, "Abziehbare Vorsteuer 19%", 200]]) : stand([["Einnahmen", 8400, "Erlöse", -45000], ["Betriebsausgabe", 4950, "Beratung", 25000], ["Umsatzsteuer", 1776, "Umsatzsteuer 19%", -700], ["Vorsteuer", 1576, "Abziehbare Vorsteuer 19%", 200]]) };
      }
      if (op === "receiptsGet") return { data: [] };
      throw new Error(`unexpected ${op}`);
    });
    return { client: { call } as unknown as BBClient, call };
  }

  it("je Monat eine Summen- und Saldenliste ab Januar und Zeilen für Monate, Quartal und Jahr", async () => {
    const { client, call } = monthsClient();
    const [tool] = createTaxPositionTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-02-15", rechtsform: "Einzelunternehmen", hebesatz_pct: 380 }));
    expect(call.mock.calls.filter(([op]) => op === "reportsCreateSums").map(([, p]) => (p as { date_from: string; date_to: string }).date_from + ".." + (p as { date_to: string }).date_to)).toEqual(["2026-01-01..2026-01-31", "2026-02-01..2026-02-15"]);
    // Nach Leistungsdatum wie die BWA und die Umsatzsteuer-Voranmeldung
    expect(call.mock.calls.filter(([op]) => op === "reportsCreateSums").every(([, p]) => (p as { base?: string }).base === "date_delivery_else_date")).toBe(true);
    expect(res.perioden.map((p: { schluessel: string }) => p.schluessel)).toEqual(["2026-01", "2026-02", "2026-Q1", "2026"]);
    expect(res.perioden[0]).toMatchObject({ umsatzsteuer: 700, vorsteuer: 200, zahllast: 500, gewinn: 30000, gewinn_kum: 30000 });
    expect(res.annahmen).toMatchObject({ rechtsform: "einzelunternehmen", hebesatz_pct: 380 });
  });

  it("Schätzung als Zuwachs der kumulierten Schätzung: Verlustmonat senkt sie, das angefangene Quartal ist teilweise", async () => {
    const { client } = monthsClient();
    const [tool] = createTaxPositionTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-02-15", rechtsform: "Einzelunternehmen", hebesatz_pct: 380 }));
    const by = (k: string) => res.perioden.find((p: { schluessel: string }) => p.schluessel === k);
    // kumuliert 30.000 -> Gewerbesteuer 729,60; kumuliert 20.000 (30.000 - 10.000) unter dem Freibetrag -> 0
    expect(by("2026-01").gewerbesteuer).toBe(729.6);
    expect(by("2026-02").gewerbesteuer).toBe(-729.6);
    expect(by("2026-Q1")).toMatchObject({ teilweise: true, gewerbesteuer: 0, gewinn: 20000 });
    expect(by("2026")).toMatchObject({ teilweise: true });
  });

  it("ohne Rechtsform und Hebesatz keine Schätzung, aber Umsatzsteuer und Gewinn", async () => {
    const { client } = monthsClient();
    const [tool] = createTaxPositionTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-02-15" }));
    expect(res.perioden[0].gewerbesteuer).toBeNull();
    expect(res.perioden[0].zahllast).toBe(500);
    expect(res.warnings.join(" ")).toMatch(/Keine Steuerschätzung/);
  });

  it("unbekannte Unternehmensform wird gemeldet statt geraten", async () => {
    const { client } = monthsClient();
    const [tool] = createTaxPositionTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-02-15", rechtsform: "Verein", hebesatz_pct: 380 }));
    expect(res.warnings.join(" ")).toMatch(/nicht erkannt/);
    expect(res.perioden[0].gewerbesteuer).toBeNull();
  });
});
