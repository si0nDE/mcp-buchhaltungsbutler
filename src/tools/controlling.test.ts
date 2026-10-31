import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { BuchhaltungsButlerApiError } from "../bb-client/errors.js";
import { capitalAt, capitalFromSums, createControllingTools, kapitalSkala, kpisFromBwa, previousRange, returnOnCapital, seriesMonths, type Sums } from "./controlling.js";

// Erfundene Zahlen. Aufbau wie die BWA von reportsGetBwa (SKR03).
function bwa(o: {
  umsatz: number;
  sonstErtrag?: number;
  waren?: number;
  personal?: number;
  abschreibung?: number;
  sonstige?: number;
  zins?: number;
  neutralErtrag?: number;
  uncompleted?: number;
}) {
  const sonstErtrag = o.sonstErtrag ?? 0;
  const personal = -(o.personal ?? 0);
  const abschreibung = -(o.abschreibung ?? 0);
  const sonstige = -(o.sonstige ?? 0);
  const zins = -(o.zins ?? 0);
  const waren = -(o.waren ?? 0);
  const leistung = o.umsatz + sonstErtrag;
  const kosten = personal + abschreibung + sonstige;
  const neutralErtrag = o.neutralErtrag ?? 0;
  const betriebsergebnis = leistung + waren + kosten;
  return {
    integrityError: false,
    uncompletedPostingsCount: o.uncompleted ?? 0,
    groups: {
      Gesamtleistung: {
        amountsSum: leistung,
        classes: {
          Umsatzerlöse: { amountsSum: o.umsatz, postingaccounts: o.umsatz ? { "8400": { amountsSum: o.umsatz, name: "Erlöse" } } : [] },
          "Sonstige betriebliche Erträge": { amountsSum: sonstErtrag },
        },
      },
      "Waren/Material/Leistungen": { amountsSum: waren, classes: { Wareneinkauf: { amountsSum: waren } } },
      Gesamtkosten: {
        amountsSum: kosten,
        classes: {
          Personalkosten: { amountsSum: personal, postingaccounts: personal ? { "4120": { amountsSum: personal, name: "Gehälter" } } : [] },
          Abschreibungen: { amountsSum: abschreibung },
          // Zwei Konten im Verhältnis 3:1, damit Anteil und Sortierung prüfbar sind.
          "Sonstige Kosten": {
            amountsSum: sonstige,
            postingaccounts: sonstige
              ? { "4950": { amountsSum: sonstige * 0.75, name: "Beratung" }, "4964": { amountsSum: sonstige * 0.25, name: "Software" } }
              : [],
          },
        },
      },
      "Neutraler Aufwand": { amountsSum: zins, classes: { Zinsaufwand: { amountsSum: zins } } },
      "Neutraler Ertrag": { amountsSum: neutralErtrag, classes: { "Sonst. neutraler Ertrag": { amountsSum: neutralErtrag } } },
    },
    totals: {
      Betriebsergebnis: { amountsSum: betriebsergebnis },
      Ergebnis: { amountsSum: betriebsergebnis + zins + neutralErtrag },
    },
  };
}

describe("kpisFromBwa", () => {
  const k = kpisFromBwa(bwa({ umsatz: 8000, sonstErtrag: 2000, personal: 1000, abschreibung: 500, sonstige: 2500, zins: 100, neutralErtrag: 300 }));

  it("EBIT ist das Betriebsergebnis, EBITDA addiert die Abschreibungen", () => {
    expect(k.ebit).toBe(6000);
    expect(k.ebitda).toBe(6500);
  });

  it("Margen beziehen sich auf die Gesamtleistung, die Umsatzrentabilität auf den Umsatz", () => {
    expect(k.ebit_marge_pct).toBe(60);
    expect(k.ebitda_marge_pct).toBe(65);
    expect(k.umsatzrentabilitaet_pct).toBe(75);
  });

  it("Erträge und Kosten nach Dashboard-Definition: neutrale Posten zählen mit, Ergebnis geht auf", () => {
    expect(k.ertraege).toBe(10300);
    expect(k.kosten).toBe(4100);
    expect(k.gesamtergebnis).toBe(6200);
    expect(k.ertraege - k.kosten).toBe(k.gesamtergebnis);
  });

  it("Kostenarten enthalten Zinsaufwand und lassen leere Klassen weg", () => {
    expect(k.kostenarten).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Personalkosten", amount: 1000 }),
        expect.objectContaining({ name: "Zinsaufwand", amount: 100 }),
      ])
    );
    expect(k.kostenarten.find((c) => c.name === "Wareneinkauf")).toBeUndefined();
  });

  it("Kostenarten tragen ihre Konten, größtes zuerst; leere Klassen (als []) ergeben keine Konten", () => {
    const sonstige = k.kostenarten.find((c) => c.name === "Sonstige Kosten")!;
    expect(sonstige.konten).toEqual([
      { nummer: 4950, name: "Beratung", amount: 1875 },
      { nummer: 4964, name: "Software", amount: 625 },
    ]);
    expect(k.kostenarten.find((c) => c.name === "Abschreibungen")!.konten).toEqual([]);
  });

  it("Wareneinsatz zählt zu Kosten und COGS", () => {
    const w = kpisFromBwa(bwa({ umsatz: 1000, waren: 400, sonstige: 100 }));
    expect(w.kosten).toBe(500);
    expect(w.cogs).toBe(400);
    expect(w.ebit).toBe(500);
  });

  it("ohne Gesamtleistung gibt es keine Marge statt Division durch 0", () => {
    const z = kpisFromBwa(bwa({ umsatz: 0, sonstige: 50 }));
    expect(z.ebit_marge_pct).toBeNull();
    expect(z.umsatzrentabilitaet_pct).toBeNull();
  });

  it("rundet Gleitkommarauschen auf Cent", () => {
    expect(kpisFromBwa(bwa({ umsatz: 0.1 + 0.2 })).umsatzerloese).toBe(0.3);
  });
});

describe("Zeiträume", () => {
  it("previousRange: ganzes Quartal gibt das Quartal davor", () => {
    expect(previousRange({ from: "2026-04-01", to: "2026-06-30" })).toEqual({ from: "2026-01-01", to: "2026-03-31" });
  });
  it("previousRange: einzelner Monat über den Jahreswechsel", () => {
    expect(previousRange({ from: "2026-01-01", to: "2026-01-31" })).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("previousRange: Jahr gibt das Vorjahr", () => {
    expect(previousRange({ from: "2026-01-01", to: "2026-12-31" })).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });
  it("previousRange: krumme Zeiträume rücken um die gleiche Zahl Tage", () => {
    expect(previousRange({ from: "2026-03-10", to: "2026-03-19" })).toEqual({ from: "2026-02-28", to: "2026-03-09" });
  });
  it("seriesMonths: sechs Kalendermonate bis zum Monat des Zeitraumendes", () => {
    const m = seriesMonths("2026-06-30");
    expect(m).toHaveLength(6);
    expect(m[0]).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(m[5]).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  });
  it("seriesMonths: Schaltjahr und Jahreswechsel", () => {
    const m = seriesMonths("2028-02-10");
    expect(m[0]).toEqual({ from: "2027-09-01", to: "2027-09-30" });
    expect(m[5]).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});

// Client, der BWAs nach Zeitraum liefert; die erste Abfrage jeder BWA ist "noch nicht fertig".
function fakeClient(
  byRange: (from: string, to: string) => ReturnType<typeof bwa>,
  pendingTimes = 1,
  sumsAt: (to: string) => Sums = () => ({ integrityError: false, sums: {} })
) {
  let next = 100;
  const ranges = new Map<number, [string, string]>();
  const polls = new Map<number, number>();
  const order: string[] = [];
  const sumsRanges = new Map<number, string>();
  const call = vi.fn(async (op: string, params: Record<string, unknown>) => {
    if (op === "reportsCreateSums") {
      const id = next++;
      sumsRanges.set(id, String(params.date_to));
      return { success: true, id_by_customer: String(id) };
    }
    if (op === "reportsGetSums") return { success: true, report: sumsAt(sumsRanges.get(Number(params.report_id_by_customer))!) };
    if (op === "reportsCreateBwa") {
      const id = next++;
      ranges.set(id, [String(params.date_from), String(params.date_to)]);
      order.push(`create ${params.date_from}`);
      return { success: true, id_by_customer: String(id) };
    }
    if (op === "reportsGetBwa") {
      const id = Number(params.report_id_by_customer);
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      if (n <= pendingTimes) {
        throw new BuchhaltungsButlerApiError(
          "BuchhaltungsButler API error on reportsGetBwa: HTTP 400 — report generation has not been finished yet",
          400,
          "reportsGetBwa",
          {}
        );
      }
      const [from, to] = ranges.get(id)!;
      order.push(`get ${from}`);
      return { success: true, report: byRange(from, to) };
    }
    if (op === "reportsGetSumsLedger") {
      // Zwei Zeilen je Konto: 100 auf der normalen Seite eines Aufwandskontos (Soll), 40 auf der anderen (Storno, Gegenkonto Interim).
      const nr = Number(params.postingaccount_number);
      return {
        report_sums_postingaccount_ledger: {
          postingaccountLedger: [
            { id_by_customer: nr * 10 + 1, date: "2026-05-02 00:00:00", record_side: "debit", record_amount: "100.00", counterRecordPostingaccountNumber: 1200, postingTextFull: "Buchung A", receipts_id_by_customer: 5 },
            { id_by_customer: nr * 10 + 2, date: "2026-05-03 00:00:00", record_side: "credit", record_amount: "40.00", counterRecordPostingaccountNumber: 1590, postingTextFull: "Buchung B", receipts_id_by_customer: null },
          ],
        },
      };
    }
    throw new Error(`unexpected ${op}`);
  });
  return { client: { call } as unknown as BBClient, call, order };
}

const sleep = vi.fn(async () => {});
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("get_controlling", () => {
  const byRange = (from: string) => {
    // Zeitraum Q2 und Q1 ganz, Monate einzeln.
    if (from === "2026-04-01") return bwa({ umsatz: 9000, sonstErtrag: 1000, personal: 500, abschreibung: 200, sonstige: 3300, zins: 50 });
    if (from === "2026-01-01") return bwa({ umsatz: 6000, sonstErtrag: 0, personal: 1000, abschreibung: 0, sonstige: 3000, zins: 10 });
    return bwa({ umsatz: 100, sonstige: 40 });
  };

  it("wartet auf nicht fertige BWAs und holt sie nacheinander, nie parallel", async () => {
    const { client, order } = fakeClient(byRange, 2);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30" });
    // Jede BWA ist fertig geholt, bevor die nächste angelegt wird.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i].startsWith("create")).toBe(true);
      expect(order[i + 1].startsWith("get")).toBe(true);
    }
    expect(sleep).toHaveBeenCalled();
  });

  it("holt Zeitraum, Vergleichszeitraum (Standard: davor) und sechs Monate = 8 BWAs", async () => {
    const { client, call } = fakeClient(byRange, 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30" }));
    expect(call.mock.calls.filter(([op]) => op === "reportsCreateBwa")).toHaveLength(8);
    expect(res.comparison).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(res.zeitreihe.monate).toEqual(["Jan 2026", "Feb 2026", "Mär 2026", "Apr 2026", "Mai 2026", "Jun 2026"]);
  });

  it("series: false holt nur Zeitraum und Vergleich", async () => {
    const { client, call } = fakeClient(byRange, 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false }));
    expect(call.mock.calls.filter(([op]) => op === "reportsCreateBwa")).toHaveLength(2);
    expect(res.zeitreihe.monate).toEqual([]);
  });

  it("holt einen Zeitraum, der auch in der Zeitreihe liegt, nur einmal", async () => {
    const { client, call } = fakeClient(byRange, 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    // Juni 2026 ist Zeitraum und letzter Monat der Reihe; Vergleich Mai 2026 ebenfalls.
    await tool.handler({ period_from: "2026-06-01", period_to: "2026-06-30" });
    expect(call.mock.calls.filter(([op]) => op === "reportsCreateBwa")).toHaveLength(6);
  });

  it("rechnet Differenzen, Veränderung je Kostenart und Rule of BHB", async () => {
    const { client } = fakeClient(byRange, 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false }));
    const z = res.kpis.zeitraum;
    const v = res.kpis.vergleichszeitraum;
    expect(z.ebit).toBe(6000);
    expect(z.ebitda).toBe(6200);
    expect(v.ebit).toBe(2000);
    expect(res.kpis.differenz.ebit).toBe(4000);
    expect(res.kpis.differenz.umsatzerloese_pct).toBe(50);
    expect(res.kpis.differenz.ebit_marge_pp).toBe(26.67);
    // Umsatzwachstum 50 + EBIT/Umsatz 66,67
    expect(res.kpis.rule_of_bhb).toBe(116.67);
    const personal = res.kostenarten.find((c: { name: string }) => c.name === "Personalkosten");
    expect(personal).toMatchObject({ amount: 500, vergleich: 1000, veraenderung_pct: -50 });
    const zins = res.kostenarten.find((c: { name: string }) => c.name === "Zinsaufwand");
    expect(zins.veraenderung_pct).toBe(400);
  });

  it("drilldown: Konten je Kostenart mit Anteil, Vergleich und Veränderung; Konto nur im Vergleich bleibt sichtbar", async () => {
    const { client } = fakeClient(byRange, 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false, split_threshold_pct: 0 }));
    const sonstige = res.kostenarten.find((c: { name: string }) => c.name === "Sonstige Kosten");
    // Q2 3300 gegen Q1 3000: Beratung 2475 (Anteil 75 %) gegen 2250.
    expect(sonstige.konten[0]).toEqual({
      nummer: 4950,
      name: "Beratung",
      amount: 2475,
      anteil_an_kostenart_pct: 75,
      vergleich: 2250,
      veraenderung_pct: 10,
    });
    expect(sonstige.konten).toHaveLength(2);
  });

  it("ein Konto mit großem Anteil wird eigene Kostenart, 'Sonstige Kosten' steht am Ende", async () => {
    const { client } = fakeClient(byRange, 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false, split_threshold_pct: 30 }));
    const names = res.kostenarten.map((c: { name: string }) => c.name);
    // Beratung (2475 von 4050 Kosten = 61 %) wird herausgelöst, Software (825 = 20 %) bleibt im Sammelposten
    expect(names).toContain("Beratung");
    expect(names[names.length - 1]).toBe("Sonstige Kosten");
    const beratung = res.kostenarten.find((c: { name: string }) => c.name === "Beratung");
    expect(beratung).toMatchObject({ amount: 2475, aufgeteilt_aus: "Sonstige Kosten", vergleich: 2250 });
    expect(res.kostenarten.find((c: { name: string }) => c.name === "Sonstige Kosten").amount).toBe(825);
    // Die Summe bleibt die der BWA
    expect(res.kostenarten.reduce((t: number, c: { amount: number }) => t + c.amount, 0)).toBe(res.kpis.zeitraum.kosten);
  });

  it("split_threshold_pct 0 lässt die BWA-Klassen unverändert", async () => {
    const { client } = fakeClient(byRange, 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false, split_threshold_pct: 0 }));
    expect(res.kostenarten.map((c: { name: string }) => c.name)).not.toContain("Beratung");
    expect(res.kostenarten.find((c: { name: string }) => c.name === "Sonstige Kosten").amount).toBe(3300);
  });

  it("Buchungen je Konto aus dem Kontenblatt: normale Seite positiv, Storno negativ, Erträge im Haben", async () => {
    const { client, call } = fakeClient(byRange, 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false }));
    const of = (nr: number) => res.buchungen.filter((b: { konto: number }) => b.konto === nr);
    // Aufwandskonto 4950: Soll 100 -> +100, Haben 40 -> -40
    expect(of(4950).map((b: { betrag: number }) => b.betrag)).toEqual([100, -40]);
    // Ertragskonto 8400 (Gesamtleistung): Soll 100 -> -100, Haben 40 -> +40
    expect(of(8400).map((b: { betrag: number }) => b.betrag)).toEqual([-100, 40]);
    expect(of(4950)[0]).toMatchObject({ datum: "2026-05-02", text: "Buchung A", gegenkonto: 1200, beleg: true });
    expect(of(4950)[1]).toMatchObject({ gegenkonto: 1590, beleg: false });
    // Je Konto des Zeitraums ein Aufruf, nur für den Zeitraum (nicht den Vergleich)
    const ledgerCalls = call.mock.calls.filter(([op]) => op === "reportsGetSumsLedger");
    expect(ledgerCalls.length).toBeGreaterThan(0);
    for (const [, params] of ledgerCalls) expect(params).toMatchObject({ date_from: "2026-04-01", date_to: "2026-06-30" });
  });

  it("with_postings: false ruft keine Kontenblätter ab", async () => {
    const { client, call } = fakeClient(byRange, 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false, with_postings: false }));
    expect(res.buchungen).toEqual([]);
    expect(call.mock.calls.filter(([op]) => op === "reportsGetSumsLedger")).toHaveLength(0);
  });

  it("Prozentpunkte-Differenz aus ungerundeten Werten (wie das Dashboard), nicht aus gerundeten Margen", async () => {
    // 1/3 und 2/3: gerundet 33,33 und 66,67 (Differenz 33,34), ungerundet 33,33.
    const { client } = fakeClient((from) => (from === "2026-04-01" ? bwa({ umsatz: 300, sonstige: 200 }) : bwa({ umsatz: 300, sonstige: 100 })), 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false }));
    expect(res.kpis.zeitraum.ebit_marge_pct).toBe(33.33);
    expect(res.kpis.vergleichszeitraum.ebit_marge_pct).toBe(66.67);
    expect(res.kpis.differenz.ebit_marge_pp).toBe(-33.33);
  });

  it("Kostenart ohne Vergleichswert hat keine Veränderung in Prozent", async () => {
    const { client } = fakeClient((from) => (from === "2026-04-01" ? bwa({ umsatz: 100, personal: 10 }) : bwa({ umsatz: 100 })), 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false }));
    expect(res.kostenarten[0]).toMatchObject({ name: "Personalkosten", veraenderung_pct: null });
  });

  it("warnt bei unvollständigen Buchungen", async () => {
    const { client } = fakeClient(() => bwa({ umsatz: 100, uncompleted: 3 }), 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false }));
    expect(res.warnings.join(" ")).toMatch(/3 unvollständige Buchungen/);
  });

  it("gibt nach maxWaitMs auf, statt endlos zu warten", async () => {
    const { client } = fakeClient(byRange, 1_000_000);
    const [tool] = createControllingTools(client, { sleep, pollMs: 10, maxWaitMs: 30 });
    await expect(tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30" })).rejects.toThrow(/nicht fertig/);
  });

  it("wartet, wenn BHB schon eine andere BWA rechnet (z. B. die der Oberfläche), und legt dann an", async () => {
    let busy = 2;
    const inner = fakeClient(byRange, 0);
    const call = vi.fn(async (op: string, params: Record<string, unknown>) => {
      if (op === "reportsCreateBwa" && busy-- > 0) {
        throw new BuchhaltungsButlerApiError("HTTP 400 — report generation already in progress", 400, "reportsCreateBwa", {});
      }
      return inner.client.call(op as never, params);
    });
    const [tool] = createControllingTools({ call } as unknown as BBClient, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false }));
    expect(res.kpis.zeitraum.ebit).toBe(6000);
  });

  it("gibt auf, wenn die fremde BWA nicht endet", async () => {
    const call = vi.fn(async () => {
      throw new BuchhaltungsButlerApiError("HTTP 400 — report generation already in progress", 400, "reportsCreateBwa", {});
    });
    const [tool] = createControllingTools({ call } as unknown as BBClient, { sleep, pollMs: 10, maxWaitMs: 30 });
    await expect(tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30" })).rejects.toThrow(/andere BWA/);
  });

  it("andere BHB-Fehler werden nicht als 'noch nicht fertig' verschluckt", async () => {
    const call = vi.fn(async (op: string) => {
      if (op === "reportsCreateBwa") return { id_by_customer: "1" };
      throw new BuchhaltungsButlerApiError("HTTP 401", 401, "reportsGetBwa", {});
    });
    const [tool] = createControllingTools({ call } as unknown as BBClient, { sleep, pollMs: 1 });
    await expect(tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30" })).rejects.toThrow(/401/);
  });

  it("weist falsche Eingaben ab, bevor BHB einen Aufruf sieht", async () => {
    const { client, call } = fakeClient(byRange, 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    await expect(tool.handler({ period_from: "2026-06-30", period_to: "2026-04-01" })).rejects.toThrow(/nach period_to/);
    await expect(tool.handler({ period_from: "30.06.2026", period_to: "2026-06-30" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(tool.handler({ period_from: "2026-02-30", period_to: "2026-03-30" })).rejects.toThrow(/gibt es nicht/);
    await expect(tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", comparison_from: "2026-01-01" })).rejects.toThrow(/gehören zusammen/);
    expect(call).not.toHaveBeenCalled();
  });
});

// Erfundene Salden. Aufbau wie reportsGetSums.
const saldo = (cls: string, abs: number, side: "debit" | "credit") => ({ postingaccount: { class: cls }, balanceAfterAbsolute: abs, balanceAfterSide: side });
const susa = (list: Array<[string, number, "debit" | "credit"]>): Sums => ({
  integrityError: false,
  sums: Object.fromEntries(list.map(([c, a, s], i) => [String(i), saldo(c, a, s)])),
});

describe("Kapitalrentabilität", () => {
  it("Eigenkapital = Ergebnis seit Jahresbeginn - Saldo Privat, Fremdkapital = USt - VSt + Verbindlichkeiten (Haben positiv)", () => {
    const k = capitalFromSums(
      susa([
        ["Einnahmen", 5000, "credit"],
        ["Betriebsausgabe", 3000, "debit"],
        ["Abschreibungen", 500, "debit"],
        ["Privat", 400, "debit"], // Entnahmen
        ["Privat", 1000, "credit"], // Einlagen
        ["Umsatzsteuer", 900, "credit"],
        ["Vorsteuer", 300, "debit"],
        ["Verbindlichkeiten", 100, "debit"],
        ["Finanzkonto", 7000, "credit"], // Darlehen als Finanzkonto: weder Eigen- noch Fremdkapital
        ["Anlagevermögen", 800, "credit"],
      ])
    );
    // Ergebnis 1500, Privat netto 600 im Haben
    expect(k).toEqual({ ergebnis: 1500, privat: -600, fremdkapital: 500 });
  });

  it("Bilanzierer: Klasse Kapital zählt wie Privat gegen das Eigenkapital, Rückstellungen zum Fremdkapital", () => {
    const k = capitalFromSums(
      susa([
        ["Einnahmen", 2000, "credit"],
        ["Betriebsausgabe", 2600, "debit"],
        ["Kapital", 500, "credit"], // gezeichnetes Kapital
        ["Kapital", 1800, "debit"], // Verlustvortrag
        ["Umsatzsteuer", 300, "credit"],
        ["Vorsteuer", 120, "debit"],
        ["Rückstellung", 40, "credit"],
        ["Kreditorenkonto", 700, "credit"], // Personenkonten stecken schon im Sammelkonto der Klasse Verbindlichkeiten
      ])
    );
    // Ergebnis -600; Kapital netto 1300 im Soll: Eigenkapital -600 - 1300 = -1900; Fremdkapital 300 - 120 + 40 = 220
    expect(k).toEqual({ ergebnis: -600, privat: 1300, fremdkapital: 220 });
  });

  it("Anfang: Ergebnis bis einschließlich erstem Tag, Privat und Fremdkapital vom Vortag; Ende: alles bis zum letzten Tag", () => {
    const r = capitalAt(
      { tag: { ergebnis: 950, privat: -150, fremdkapital: 210 }, vortag: { ergebnis: 900, privat: -100, fremdkapital: 200 } },
      { ergebnis: 3000, privat: 0, fremdkapital: 300 }
    );
    expect(r.ek).toEqual({ anfang: 1050, ende: 3000, durchschnitt: 2025 });
    expect(r.fk).toEqual({ anfang: 200, ende: 300, durchschnitt: 250 });
    // Ohne Vortag (Zeitraum beginnt am 1.1.): Privat und Fremdkapital am Anfang 0
    expect(capitalAt({ tag: { ergebnis: 100, privat: 40, fremdkapital: 70 }, vortag: null }, { ergebnis: 0, privat: 0, fremdkapital: 0 }).ek.anfang).toBe(100);
  });

  it("Rentabilitäten aus Ergebnis, Zinsen und Durchschnittskapital", () => {
    const r = returnOnCapital(300, 20, { anfang: 1000, ende: 2000, durchschnitt: 1500 }, { anfang: 400, ende: 600, durchschnitt: 500 });
    expect(r.eigenkapital).toBeCloseTo(20, 10);
    expect(r.fremdkapital).toBeCloseTo(4, 10);
    expect(r.gesamtkapital).toBeCloseTo(16, 10);
    expect(returnOnCapital(300, 0, { anfang: 0, ende: 0, durchschnitt: 0 }, { anfang: 0, ende: 0, durchschnitt: 0 }).eigenkapital).toBeNull();
  });

  it("Skala der Tachos: bis 100 % fest ±100, darüber das 1,5-fache des größten Betrags", () => {
    expect(kapitalSkala(30)).toEqual({ min: -100, max: 100 });
    expect(kapitalSkala(99.5)).toEqual({ min: -100, max: 100 });
    expect(kapitalSkala(100)).toEqual({ min: -100, max: 100 });
    expect(kapitalSkala(120)).toEqual({ min: -180, max: 180 });
  });

  it("holt je Stichtag eine SuSa vom 1.1. bis einschließlich Stichtag und rechnet Zeitraum gegen Vergleich", async () => {
    // Q2 gegen Q1, je Stichtag Ergebnis, Privat (Soll positiv) und Fremdkapital.
    const erg: Record<string, number> = { "2026-01-01": 100, "2026-03-31": 900, "2026-04-01": 950, "2026-06-30": 3000 };
    const priv: Record<string, number> = { "2026-01-01": 0, "2026-03-31": -100, "2026-04-01": -150, "2026-06-30": 0 };
    const fk: Record<string, number> = { "2026-01-01": 50, "2026-03-31": 200, "2026-04-01": 210, "2026-06-30": 300 };
    const sumsAt = (to: string) =>
      susa([
        ["Einnahmen", erg[to], "credit"],
        ["Privat", Math.abs(priv[to]), priv[to] < 0 ? "credit" : "debit"],
        ["Umsatzsteuer", fk[to], "credit"],
      ]);
    const { client, call } = fakeClient(
      (from) => (from === "2026-04-01" ? bwa({ umsatz: 9000, sonstige: 7000, zins: 40 }) : bwa({ umsatz: 6000, sonstige: 5650, zins: 10 })),
      0,
      sumsAt
    );
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false }));
    const sumsCalls = call.mock.calls.filter(([op]) => op === "reportsCreateSums").map(([, p]) => `${p.date_from}..${p.date_to}`);
    // Q2: 1.4., Vortag 31.3., 30.6.; Q1 beginnt am 1.1. (kein Vortag), 31.3. ist schon geholt.
    expect(sumsCalls).toEqual(["2026-01-01..2026-04-01", "2026-01-01..2026-03-31", "2026-01-01..2026-06-30", "2026-01-01..2026-01-01"]);
    // Nach Leistungsdatum wie BHB (bei Bilanzierern verschiebt das Kapital und Fremdkapital).
    expect(call.mock.calls.filter(([op]) => op === "reportsCreateSums").every(([, p]) => p.base === "date_delivery_else_date")).toBe(true);
    const kr = res.kapitalrentabilitaet;
    // Anfang: Ergebnis 1.4. (950) - Privat 31.3. (-100) = 1050; Ende 3000 - 0
    expect(kr.zeitraum.eigenkapital).toEqual({ anfang: 1050, ende: 3000, durchschnitt: 2025 });
    expect(kr.zeitraum.fremdkapital).toEqual({ anfang: 200, ende: 300, durchschnitt: 250 });
    // Ergebnis Q2 = 9000 - 7000 - 40 = 1960; 1960 / 2025 = 96,79 %, Zinsen 40 / 250 = 16 %, 2000 / 2275 = 87,91 %
    expect(kr.eigenkapitalrentabilitaet_pct).toBe(96.79);
    expect(kr.fremdkapitalrentabilitaet_pct).toBe(16);
    expect(kr.gesamtkapitalrentabilitaet_pct).toBe(87.91);
    // Q1: Eigenkapital 100 -> 1000 (Ø 550), Ergebnis 6000 - 5650 - 10 = 340: 61,82 %
    expect(kr.vergleichszeitraum.eigenkapital).toEqual({ anfang: 100, ende: 1000, durchschnitt: 550 });
    expect(kr.vergleich.eigenkapitalrentabilitaet_pct).toBe(61.82);
    expect(kr.differenz_pp.eigenkapitalrentabilitaet).toBe(34.97);
    // Größter Wert 96,79 % liegt unter 100: Skala fest ±100
    expect(kr.skala).toEqual({ min: -100, max: 100 });
  });

  it("capital: false holt keine SuSa", async () => {
    const { client, call } = fakeClient(byRangeSimple, 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false, capital: false }));
    expect(call.mock.calls.filter(([op]) => op === "reportsCreateSums")).toHaveLength(0);
    expect(res.kapitalrentabilitaet).toBeNull();
  });

  it("year_comparison holt dieselben sechs Monate des Vorjahres für COGS und Personalkosten", async () => {
    const { client, call } = fakeClient((from) => (from.startsWith("2025") ? bwa({ umsatz: 100, personal: 7 }) : bwa({ umsatz: 100, personal: 9 })), 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", year_comparison: true, capital: false, with_postings: false }));
    const vorjahr = call.mock.calls.filter(([op, p]) => op === "reportsCreateBwa" && String(p.date_from).startsWith("2025-"));
    expect(vorjahr.map(([, p]) => `${p.date_from}..${p.date_to}`)).toEqual([
      "2025-01-01..2025-01-31",
      "2025-02-01..2025-02-28",
      "2025-03-01..2025-03-31",
      "2025-04-01..2025-04-30",
      "2025-05-01..2025-05-31",
      "2025-06-01..2025-06-30",
    ]);
    expect(res.zeitreihe.personalkosten_vorjahr).toEqual([7, 7, 7, 7, 7, 7]);
    expect(res.zeitreihe.personalkosten).toEqual([9, 9, 9, 9, 9, 9]);
  });

  it("liefert Erklärungen je Kennzahl", async () => {
    const { client } = fakeClient(byRangeSimple, 0);
    const [tool] = createControllingTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ period_from: "2026-04-01", period_to: "2026-06-30", series: false, capital: false }));
    expect(res.erklaerungen.ebit).toMatch(/Earnings Before Interest and Taxes/);
    expect(res.erklaerungen.cogs).toMatch(/Cost of Goods Sold/);
    expect(Object.keys(res.erklaerungen)).toEqual(expect.arrayContaining(["ebit", "rule_of_bhb", "eigenkapitalrentabilitaet", "kapitalrentabilitaet", "uebersicht", "umsatzkennzahlen", "kosten_fokus"]));
  });
});

function byRangeSimple() {
  return bwa({ umsatz: 100, sonstige: 40 });
}
