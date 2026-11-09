import { describe, expect, it } from "vitest";
import { buildPeriods, estimateTaxes, gewerbesteuer, incomeTax2026, koerperschaftsteuerSatz, mindestHebesatz, normalizeRechtsform, soliOnIncomeTax } from "./tax-estimate.js";

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

describe("soliOnIncomeTax (SolZG § 3 Abs. 3, § 4)", () => {
  it("bis zur Freigrenze 20.350 € nichts, danach höchstens 11,9 % des Betrags darüber, ab dort 5,5 %", () => {
    expect(soliOnIncomeTax(20350)).toBe(0);
    expect(soliOnIncomeTax(20351)).toBe(0.12);
    expect(soliOnIncomeTax(30000)).toBe(1148.35); // 11,9 % von 9.650 liegt unter 5,5 % von 30.000
    expect(soliOnIncomeTax(50000)).toBe(2750); // 5,5 % von 50.000 liegt unter 11,9 % von 29.650
  });
});

describe("estimateTaxes", () => {
  it("Einzelunternehmen: Einkommensteuer nach Anrechnung der Gewerbesteuer, Soli 0 unter der Freigrenze, keine KSt, keine KapESt", () => {
    const e = estimateTaxes(50000, "einzelunternehmen", 380);
    expect(e).toEqual({ gewerbesteuer: 3389.6, einkommensteuer: 7158.4, koerperschaftsteuer: null, soli: 0, kirchensteuer: null, kapitalertragsteuer: null });
  });
  it("Einzelunternehmen mit hohem Gewinn: Soli ab Freigrenze, Kirchensteuer nur mit angegebenem Satz", () => {
    const ohne = estimateTaxes(120000, "einzelunternehmen", 380);
    expect(ohne.soli).toBeGreaterThan(0);
    expect(ohne.kirchensteuer).toBeNull();
    const mit = estimateTaxes(120000, "einzelunternehmen", 380, 0, 8);
    expect(mit.kirchensteuer).toBe(Math.round((mit.einkommensteuer as number) * 8) / 100);
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

// § 23 Abs. 1 KStG und § 16 Abs. 4 Satz 2 GewStG mit § 36 Abs. 5b GewStG, amtlicher Text gelesen am 09.11.2026.
describe("Körperschaftsteuersatz nach Veranlagungszeitraum (§ 23 Abs. 1 KStG)", () => {
  it("15 % bis 2027, dann je Jahr ein Punkt weniger bis 10 % ab 2032", () => {
    expect([2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2040].map(koerperschaftsteuerSatz)).toEqual([0.15, 0.15, 0.15, 0.14, 0.13, 0.12, 0.11, 0.1, 0.1]);
  });
  it("estimateTaxes nimmt den Satz des Jahres, ohne Jahr 2026", () => {
    expect(estimateTaxes(10000, "kapitalgesellschaft", 400).koerperschaftsteuer).toBe(1500);
    expect(estimateTaxes(10000, "kapitalgesellschaft", 400, 0, 0, 2028)).toMatchObject({ koerperschaftsteuer: 1400, soli: 77 });
  });
  it("buildPeriods nimmt das Jahr aus den Monaten", () => {
    const m = [{ schluessel: "2028-01", ust: 0, vst: 0, gewinn: 10000 }];
    const jahr = buildPeriods(m, { rechtsform: "kapitalgesellschaft", hebesatzPct: 400, ausschuettung: 0 }).find((x) => x.typ === "jahr")!;
    expect(jahr.koerperschaftsteuer).toBe(1400);
  });
});

describe("Mindesthebesatz (§ 16 Abs. 4 Satz 2 GewStG)", () => {
  it("200 % bis Erhebungszeitraum 2026, 280 % ab 2027", () => {
    expect([2025, 2026, 2027, 2030].map(mindestHebesatz)).toEqual([200, 200, 280, 280]);
  });
  it("ab 2027 rechnet die Gewerbesteuer mit mindestens 280 %, auch wenn ein niedrigerer Hebesatz angegeben ist", () => {
    const m = [{ schluessel: "2027-01", ust: 0, vst: 0, gewinn: 100000 }];
    const mit200 = buildPeriods(m, { rechtsform: "kapitalgesellschaft", hebesatzPct: 200, ausschuettung: 0 }).find((x) => x.typ === "jahr")!;
    // Messbetrag 3.500 € x 280 % = 9.800 €
    expect(mit200.gewerbesteuer).toBe(9800);
    const m26 = [{ schluessel: "2026-01", ust: 0, vst: 0, gewinn: 100000 }];
    expect(buildPeriods(m26, { rechtsform: "kapitalgesellschaft", hebesatzPct: 200, ausschuettung: 0 }).find((x) => x.typ === "jahr")!.gewerbesteuer).toBe(7000);
  });
});
