import { describe, expect, it } from "vitest";
import { buildPeriods, estimateTaxes, gewerbesteuer, incomeTax2026, normalizeRechtsform } from "./tax-estimate.js";

describe("normalizeRechtsform", () => {
  it("ordnet die Unternehmensformen aus BHB den drei Gruppen zu", () => {
    expect(normalizeRechtsform("Einzelunternehmen")).toBe("einzelunternehmen");
    expect(normalizeRechtsform("Freiberufler")).toBe("einzelunternehmen");
    expect(normalizeRechtsform("GmbH")).toBe("kapitalgesellschaft");
    expect(normalizeRechtsform("UG (haftungsbeschränkt)")).toBe("kapitalgesellschaft");
    expect(normalizeRechtsform("GbR")).toBe("personengesellschaft");
    expect(normalizeRechtsform("KG")).toBe("personengesellschaft");
    expect(normalizeRechtsform("Verein")).toBeNull();
  });
});

describe("incomeTax2026 (§ 32a EStG, Grundtarif ab 2026)", () => {
  it("Werte je Zone, unabhängig nachgerechnet", () => {
    expect(incomeTax2026(12348)).toBe(0);
    expect(incomeTax2026(17799)).toBe(1034);
    expect(incomeTax2026(20000)).toBe(1570);
    expect(incomeTax2026(50000)).toBe(10548);
    expect(incomeTax2026(70000)).toBe(18264);
    expect(incomeTax2026(300000)).toBe(115529);
  });
  it("die Zonen schließen stetig aneinander an (Konstanten stimmen)", () => {
    expect(incomeTax2026(69879) - incomeTax2026(69878)).toBeLessThanOrEqual(1);
    expect(incomeTax2026(277826) - incomeTax2026(277825)).toBeLessThanOrEqual(1);
    expect(incomeTax2026(17800) - incomeTax2026(17799)).toBeLessThanOrEqual(1);
  });
  it("negatives oder kleines Einkommen ergibt 0, Cent-Beträge werden abgerundet", () => {
    expect(incomeTax2026(-500)).toBe(0);
    expect(incomeTax2026(12348.99)).toBe(0);
    expect(incomeTax2026(50000.99)).toBe(10548);
  });
});

describe("gewerbesteuer", () => {
  it("Personenunternehmen: Freibetrag 24.500, Messzahl 3,5 %, Messbetrag abgerundet", () => {
    expect(gewerbesteuer(50000, "einzelunternehmen", 380)).toEqual({ gewerbeertrag: 50000, freibetrag: 24500, messbetrag: 892, steuer: 3389.6 });
  });
  it("Kapitalgesellschaft ohne Freibetrag", () => {
    expect(gewerbesteuer(50000, "kapitalgesellschaft", 380)).toMatchObject({ freibetrag: 0, messbetrag: 1750, steuer: 6650 });
  });
  it("unter dem Freibetrag und bei Verlust keine Steuer; Gewerbeertrag auf volle 100 € abgerundet", () => {
    expect(gewerbesteuer(10000, "einzelunternehmen", 380).steuer).toBe(0);
    expect(gewerbesteuer(-4000, "einzelunternehmen", 380).steuer).toBe(0);
    expect(gewerbesteuer(24599.99, "einzelunternehmen", 380).gewerbeertrag).toBe(24500);
  });
});

describe("estimateTaxes", () => {
  it("Einzelunternehmen: Einkommensteuer nach Anrechnung der Gewerbesteuer, keine KSt, kein Soli, keine KapESt", () => {
    const e = estimateTaxes(50000, "einzelunternehmen", 380);
    expect(e).toEqual({ gewerbesteuer: 3389.6, einkommensteuer: 7158.4, koerperschaftsteuer: null, soli: null, kapitalertragsteuer: null });
  });
  it("Kapitalgesellschaft: KSt 15 %, Soli 5,5 % auf die KSt, KapESt 25 % plus Soli auf eine Ausschüttung", () => {
    const e = estimateTaxes(10000, "kapitalgesellschaft", 380, 10000);
    expect(e).toMatchObject({ koerperschaftsteuer: 1500, soli: 82.5, kapitalertragsteuer: 2637.5, einkommensteuer: null });
  });
  it("ohne Ausschüttung keine Kapitalertragsteuer, bei Verlust keine Ertragsteuern", () => {
    expect(estimateTaxes(10000, "kapitalgesellschaft", 380).kapitalertragsteuer).toBeNull();
    expect(estimateTaxes(-3000, "kapitalgesellschaft", 380)).toMatchObject({ gewerbesteuer: 0, koerperschaftsteuer: 0, soli: 0 });
  });
});

describe("buildPeriods", () => {
  const months = [
    { schluessel: "2026-01", ust: 100, vst: 40, gewinn: 10000 },
    { schluessel: "2026-02", ust: 50, vst: 80, gewinn: 20000 },
    { schluessel: "2026-03", ust: 10, vst: 0, gewinn: -5000 },
    { schluessel: "2026-04", ust: 5, vst: 5, gewinn: 1000 },
  ];
  const a = { rechtsform: "einzelunternehmen" as const, hebesatzPct: 380, ausschuettung: 0 };
  const rows = buildPeriods(months, a);
  const by = (k: string) => rows.find((r) => r.schluessel === k)!;

  it("Monate, Quartale und das Jahr; das angefangene Quartal und das Jahr gelten als teilweise", () => {
    expect(rows.filter((r) => r.typ === "monat")).toHaveLength(4);
    expect(rows.filter((r) => r.typ === "quartal").map((r) => [r.schluessel, r.teilweise])).toEqual([["2026-Q1", false], ["2026-Q2", true]]);
    expect(by("2026")).toMatchObject({ typ: "jahr", teilweise: true });
  });
  it("Umsatzsteuer, Vorsteuer, Zahllast und Gewinn summieren sich vom Monat über das Quartal zum Jahr", () => {
    expect(by("2026-Q1")).toMatchObject({ umsatzsteuer: 160, vorsteuer: 120, zahllast: 40, gewinn: 25000, gewinn_kum: 25000 });
    expect(by("2026-02").zahllast).toBe(-30);
    expect(by("2026")).toMatchObject({ umsatzsteuer: 165, vorsteuer: 125, zahllast: 40, gewinn: 26000, gewinn_kum: 26000 });
  });
  it("Gewerbesteuer als Zuwachs der kumulierten Schätzung: Freibetrag wirkt über Monate, ein Verlustmonat senkt sie", () => {
    // kumulierter Gewinn 10.000 / 30.000 / 25.000 / 26.000 -> Gewerbesteuer 0 / 729,60 / 64,60 / 197,60 (Messbetrag 52 mal 3,8)
    expect(by("2026-01").gewerbesteuer).toBe(0);
    expect(by("2026-02").gewerbesteuer).toBe(729.6);
    expect(by("2026-03").gewerbesteuer).toBe(-665);
    expect(by("2026-Q1").gewerbesteuer).toBe(64.6);
    expect(by("2026").gewerbesteuer).toBe(197.6);
  });
  it("ohne Rechtsform oder Hebesatz gibt es keine Schätzung, aber die Umsatzsteuer bleibt", () => {
    const r = buildPeriods(months, { rechtsform: null, hebesatzPct: null, ausschuettung: 0 });
    expect(r.every((x) => x.gewerbesteuer === null && x.einkommensteuer === null)).toBe(true);
    expect(r.find((x) => x.schluessel === "2026")!.zahllast).toBe(40);
  });
  it("Kapitalertragsteuer nur in der Jahreszeile", () => {
    const r = buildPeriods(months, { rechtsform: "kapitalgesellschaft", hebesatzPct: 380, ausschuettung: 1000 });
    expect(r.filter((x) => x.kapitalertragsteuer !== null).map((x) => x.typ)).toEqual(["jahr"]);
    expect(r.find((x) => x.typ === "jahr")!.kapitalertragsteuer).toBe(263.75);
  });
});
