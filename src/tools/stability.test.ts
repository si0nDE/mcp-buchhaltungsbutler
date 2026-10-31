import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { bilanzFromSums, createStabilityTools, stabilityFrom, topPositionen } from "./stability.js";

// Erfundene Zahlen. Aufbau wie die Summen- und Saldenliste von reportsGetSums (nur die genutzten Felder).
type Zeile = [klasse: string, betrag: number, seite: "debit" | "credit"];
const susa = (list: Zeile[]) => ({
  integrityError: false,
  sums: Object.fromEntries(
    list.map(([c, a, s], i) => [String(i), { postingaccount: { class: c }, balanceAfterAbsolute: a, balanceAfterSide: s }])
  ),
});

// Eine kleine GmbH mit Verlust: Debitoren/Kreditoren, Gesellschafterkonto als Finanzkonto, Rückstellung.
const gmbh = (ergebnis: number): Zeile[] => [
  ["Finanzkonto", 900, "debit"], // Bank
  ["Finanzkonto", 4000, "credit"], // Verrechnungskonto Gesellschafter
  ["Debitorenkonto", 250, "debit"],
  ["Forderungen", 250, "debit"], // Sammelkonto der Debitoren
  ["Forderungen", 5, "debit"],
  ["Vorsteuer", 600, "debit"],
  ["Umsatzsteuer", 800, "credit"],
  ["Verbindlichkeiten", 1200, "credit"], // Sammelkonto der Kreditoren
  ["Verbindlichkeiten", 45, "debit"],
  ["Kreditorenkonto", 1200, "credit"],
  ["Interimskonto", 30, "credit"],
  ["Rückstellung", 20, "credit"],
  ["Kapital", 1000, "credit"], // gezeichnetes Kapital
  ["Kapital", 3000, "debit"], // Verlustvortrag
  ["Saldovortrag", 77, "debit"],
  ...(ergebnis < 0 ? ([["Betriebsausgabe", -ergebnis, "debit"]] as Zeile[]) : ([["Einnahmen", ergebnis, "credit"]] as Zeile[])),
  ["Abschreibungen", 0, "debit"],
];

describe("bilanzFromSums", () => {
  it("ordnet Salden den Bilanzposten zu wie BHB", () => {
    const b = bilanzFromSums(susa(gmbh(-500)));
    expect(b.kasse_bank).toBe(900);
    expect(b.forderungen_lul).toBe(250);
    // Forderungen ohne L+L (5) + Vorsteuer 600 + Soll-Saldo Verbindlichkeiten 45
    expect(b.sonstige_vermoegensgegenstaende).toBe(650);
    expect(b.rueckstellungen).toBe(20);
    // Gesellschafterkonto 4000 + Interim 30 + Sammelkonto Kreditoren 1200 + Umsatzsteuer 800; Kreditorenkonten nicht doppelt
    expect(b.verbindlichkeiten).toBe(6030);
    expect(b.fremdkapital).toBe(6050);
    expect(b.kapital_saldo).toBe(2000);
    expect(b.ergebnis_seit_jahresbeginn).toBe(-500);
    // 6050 - Finanzkonto (-3100) - Forderungen 255 + Vorsteuer 600 + Umsatzsteuer (-800) = 8695
    expect(b.effektivverschuldung).toBe(8695);
  });
});

describe("stabilityFrom", () => {
  it("negatives Eigenkapital steht als nicht gedeckter Fehlbetrag auf der Aktivseite, mit dem Ergebnis des Zeitraums", () => {
    const b = bilanzFromSums(susa(gmbh(-500)));
    // Zeitraum mit Gewinn 300 (auch wenn seit Jahresbeginn -500): -2000 + 300 = -1700
    const s = stabilityFrom("2026-09-30", b, 300, 0);
    expect(s.eigenkapital_rechnerisch).toBe(-1700);
    expect(s.aktiva).toEqual({ anlagevermoegen: 0, umlaufvermoegen: 1800, nicht_gedeckter_fehlbetrag: 1700, summe: 3500 });
    expect(s.passiva).toEqual({ eigenkapital: 0, rueckstellungen: 20, verbindlichkeiten: 6030, summe: 6050 });
    expect(s.verschuldungsgrad_pct).toBe(0);
    expect(s.goldene_bilanzregel).toBe(false);
    expect(topPositionen(s).map((p) => p.name)).toEqual([
      "Nicht gedeckter Fehlbetrag",
      "Kassenbestand, Guthaben bei Kreditinstituten",
      "Sonstige Vermögensgegenstände",
      "Forderungen aus Lieferungen und Leistungen",
    ]);
  });

  it("positives Eigenkapital: Verschuldungsgrad und goldene Bilanzregel", () => {
    const b = bilanzFromSums(susa(gmbh(-500)));
    const s = stabilityFrom("2026-12-31", b, 4420, 0);
    expect(s.eigenkapital_rechnerisch).toBe(2420);
    expect(s.aktiva.nicht_gedeckter_fehlbetrag).toBe(0);
    expect(s.verschuldungsgrad_pct).toBe(250);
    expect(s.goldene_bilanzregel).toBe(true);
  });
});

describe("get_stability", () => {
  const sleep = vi.fn(async () => {});
  const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
  // Ergebnis seit Jahresbeginn je Stichtag; Bestände gleich, nur die Bank wächst mit dem Ergebnis.
  const erg: Record<string, number> = { "2026-03-31": -900, "2026-06-30": -1200, "2026-09-30": -500 };
  function fakeClient() {
    let next = 1;
    const to = new Map<number, string>();
    const call = vi.fn(async (op: string, params: Record<string, unknown>) => {
      if (op === "reportsCreateSums") {
        const id = next++;
        to.set(id, String(params.date_to));
        return { success: true, id_by_customer: String(id) };
      }
      if (op === "reportsGetSums") {
        const date = to.get(Number(params.report_id_by_customer))!;
        return { success: true, report: susa(gmbh(erg[date] ?? -100)) };
      }
      throw new Error(`unexpected ${op}`);
    });
    return { client: { call } as unknown as BBClient, call };
  }

  it("Q3 gegen Q2: Periodenergebnis aus der Differenz seit Jahresbeginn, Stichtagswerte, eine SuSa je Stichtag nach Leistungsdatum", async () => {
    const { client, call } = fakeClient();
    const [tool] = createStabilityTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-07-01", period_to: "2026-09-30", history: false }));
    const calls = call.mock.calls.filter(([op]) => op === "reportsCreateSums");
    expect(calls.map(([, p]) => `${p.date_from}..${p.date_to}`)).toEqual(["2026-01-01..2026-09-30", "2026-01-01..2026-06-30", "2026-01-01..2026-03-31"]);
    expect(calls.every(([, p]) => p.base === "date_delivery_else_date")).toBe(true);
    // Q3: -500 - (-1200) = 700 -> Eigenkapital -2000 + 700 = -1300; Q2: -1200 - (-900) = -300 -> -2300
    expect(res.zeitraum.ergebnis_zeitraum).toBe(700);
    expect(res.bilanzstruktur.aktiva.nicht_gedeckter_fehlbetrag).toBe(1300);
    expect(res.vergleichszeitraum.aktiva.nicht_gedeckter_fehlbetrag).toBe(2300);
    expect(res.verschuldung.effektivverschuldung).toBe(8695);
    expect(res.verschuldung.effektivverschuldung_veraenderung_pct).toBe(0);
    expect(res.vermoegensanalyse.anlagevermoegen.veraenderung_pct).toBe(0);
    expect(res.anlagenkennzahlen.aktive_anlagegueter).toBeNull();
    expect(res.kapitalstruktur.monate).toEqual([]);
  });

  it("Zeitraum über den Jahreswechsel und Zwölfmonatsverlauf", async () => {
    const { client, call } = fakeClient();
    const [tool] = createStabilityTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2025-12-01", period_to: "2026-01-31", comparison_from: "2025-10-01", comparison_to: "2025-11-30" }));
    const ranges = call.mock.calls.filter(([op]) => op === "reportsCreateSums").map(([, p]) => `${p.date_from}..${p.date_to}`);
    // Erst der Stichtag (Bilanz-Prüfung), dann Dezember 2025 (Stand 31.12. minus 30.11.) plus Januar 2026;
    // jedes Ergebnis ist hier -100: -100 - (-100) + (-100) = -100
    expect(ranges.slice(0, 3)).toEqual(["2026-01-01..2026-01-31", "2025-01-01..2025-12-31", "2025-01-01..2025-11-30"]);
    expect(res.zeitraum.ergebnis_zeitraum).toBe(-100);
    expect(res.kapitalstruktur.monate).toHaveLength(12);
    expect(res.kapitalstruktur.monate[11]).toBe("Jan 2026");
    expect(res.kapitalstruktur.fremdkapital_verlauf.every((v: number) => v === 6050)).toBe(true);
    expect(res.kapitalstruktur.eigenkapital_verlauf.every((v: number) => v === 0)).toBe(true);
  });

  it("bricht bei EÜR (keine Kapital- und Personenkonten) mit Hinweis ab, nach nur einer SuSa", async () => {
    const call = vi.fn(async (op: string) => {
      if (op === "reportsCreateSums") return { success: true, id_by_customer: "1" };
      if (op === "reportsGetSums") {
        return {
          success: true,
          report: susa([
            ["Finanzkonto", 500, "debit"],
            ["Anlagevermögen", 900, "credit"], // Anlagenabgang in der EÜR
            ["Privat", 200, "debit"],
            ["Einnahmen", 3000, "credit"],
          ]),
        };
      }
      throw new Error(`unexpected ${op}`);
    });
    const [tool] = createStabilityTools({ call } as unknown as BBClient, { sleep, pollMs: 1 });
    await expect(tool.handler({ period_from: "2026-07-01", period_to: "2026-09-30" })).rejects.toThrow(/EÜR/);
    expect(call.mock.calls.filter(([op]) => op === "reportsCreateSums")).toHaveLength(1);
  });

  it("lehnt verdrehte Zeiträume ab", async () => {
    const { client } = fakeClient();
    const [tool] = createStabilityTools(client, { sleep, pollMs: 1 });
    await expect(tool.handler({ period_from: "2026-09-30", period_to: "2026-07-01" })).rejects.toThrow(/period_from/);
  });
});
