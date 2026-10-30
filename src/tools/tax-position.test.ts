import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createTaxPositionTools, taxArea, taxLines } from "./tax-position.js";

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

  it("weitere Steuern nur wie gebucht, ohne Schätzung", async () => {
    const { client } = fakeClient();
    const [tool] = createTaxPositionTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-10-30" }));
    expect(res.weitere_steuern.lohnsteuer).toBe(-80);
    // Rückstellung -600 (Haben) + Aufwand +600 (Soll)
    expect(res.weitere_steuern.ertragsteuern_gebucht).toBe(0);
    expect(res.hinweise.join(" ")).toMatch(/nicht geschätzt/);
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
