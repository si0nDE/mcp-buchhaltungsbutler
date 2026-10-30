import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { BuchhaltungsButlerApiError } from "../bb-client/errors.js";
import { createBankOverviewTools, pairOff } from "./bank-overview.js";

// Erfundene Zahlen. Zwei Konten: Giro (bank) mit einer ungebuchten Zahlung, Kasse (cash). Zahlungen: id, Datum, Betrag.
const TX: Record<number, Array<{ id_by_customer: string; booking_date: string; amount: string; to_from: string; purpose: string | null }>> = {
  1200: [
    { id_by_customer: "1", booking_date: "2026-01-05 00:00:00", amount: "1000.00", to_from: "Anfangsbestand", purpose: null },
    { id_by_customer: "2", booking_date: "2026-03-10 00:00:00", amount: "-200.00", to_from: "Lieferant X", purpose: "Rechnung 17\nzweite Zeile" },
    { id_by_customer: "3", booking_date: "2026-03-12 00:00:00", amount: "150.00", to_from: "Kunde Y", purpose: "Zahlung" },
  ],
  1000: [{ id_by_customer: "4", booking_date: "2026-02-01 00:00:00", amount: "50.00", to_from: "Kasse", purpose: null }],
};

const sums = {
  integrityError: false,
  sums: {
    "1200": { postingaccount: { class: "Finanzkonto", type: "bank/institution", name: "Giro" }, balanceAfterAbsolute: 800, balanceAfterSide: "debit" },
    "1000": { postingaccount: { class: "Finanzkonto", type: "cash", name: "Kasse" }, balanceAfterAbsolute: 50, balanceAfterSide: "debit" },
    "1590": { postingaccount: { class: "Interimskonto", type: "postingaccount", name: "Interimskonto / Kontierung nicht bekannt" }, balanceAfterAbsolute: 30, balanceAfterSide: "debit" },
    "1360": { postingaccount: { class: "Interimskonto", type: "postingaccount", name: "Geldtransit" }, balanceAfterAbsolute: 0, balanceAfterSide: "debit" },
  },
};

function fakeClient() {
  const call = vi.fn(async (op: string, params: Record<string, unknown>) => {
    if (op === "accountsGet") return { data: [{ name: "Giro", postingaccount_number: "1200" }, { name: "Kasse", postingaccount_number: "1000" }] };
    if (op === "reportsCreateSums") return { id_by_customer: "9" };
    if (op === "reportsGetSums") return { report: sums };
    if (op === "transactionsGet") return { data: TX[Number(params.account)] ?? [] };
    // Zahlungen 1 und 3 sind gebucht, 2 nicht, 4 ist gebucht
    if (op === "postingsGet") {
      return {
        data: [
          { id_by_customer: "11", transaction_id_by_customer: "1", fixed: "0" },
          { id_by_customer: "12", transaction_id_by_customer: "3", fixed: "0" },
          { id_by_customer: "13", transaction_id_by_customer: "4", fixed: "0" },
        ],
      };
    }
    if (op === "reportsGetSumsLedger") {
      // Interimskonto 1590: Rücklastschrift 30 im Soll und im Haben (gepaart), dazu 20 im Soll ohne Gegenbuchung. Geldtransit 1360: leer.
      const row = (id: number, side: string, amount: string, datum: string) => ({ id_by_customer: id, date: `${datum} 00:00:00`, record_side: side, record_amount: amount, counterRecordPostingaccountNumber: 1200, postingTextFull: `Buchung ${id}`, receipts_id_by_customer: null });
      return {
        report_sums_postingaccount_ledger: {
          postingaccountLedger: Number(params.postingaccount_number) === 1590 ? [row(21, "debit", "30.00", "2026-03-11"), row(22, "credit", "30.00", "2026-03-13"), row(23, "debit", "20.00", "2026-03-20")] : [],
        },
      };
    }
    throw new Error(`unexpected ${op}`);
  });
  return { client: { call } as unknown as BBClient, call };
}
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const sleep = vi.fn(async () => {});

describe("get_bank_overview", () => {
  it("Buchsaldo aus der SuSa, Zahlungssaldo aus allen Zahlungen, Differenz = ungebuchte Zahlungen", async () => {
    const { client } = fakeClient();
    const [tool] = createBankOverviewTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-03-31" }));
    const giro = res.konten.find((k: { nummer: number }) => k.nummer === 1200);
    // Zahlungen 1000 - 200 + 150 = 950, gebucht 800, Differenz 150
    expect(giro).toMatchObject({ art: "bank", buchsaldo: 800, zahlungssaldo: 950, differenz: 150 });
    const kasse = res.konten.find((k: { nummer: number }) => k.nummer === 1000);
    expect(kasse).toMatchObject({ art: "kasse", buchsaldo: 50, zahlungssaldo: 50, differenz: 0 });
  });

  it("Umsätze im Zeitraum und nicht gebuchte Zahlungen einzeln", async () => {
    const { client } = fakeClient();
    const [tool] = createBankOverviewTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-03-31", date_from: "2026-03-01" }));
    const giro = res.konten.find((k: { nummer: number }) => k.nummer === 1200);
    expect(giro).toMatchObject({ einzahlungen: 150, auszahlungen: 200, anzahl_zahlungen: 2, nicht_gebucht_anzahl: 1, nicht_gebucht_summe: -200 });
    expect(res.nicht_gebuchte_zahlungen).toEqual([{ konto: 1200, id: 2, datum: "2026-03-10", betrag: -200, gegenpartei: "Lieferant X", zweck: "Rechnung 17" }]);
    expect(res.summe.nicht_gebucht_anzahl).toBe(1);
  });

  it("Durchlaufende Posten: gepaarte Buchungen gleichen sich aus, übrig bleibt die offene; leere Interimskonten fehlen", async () => {
    const { client, call } = fakeClient();
    const [tool] = createBankOverviewTools(client, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-03-31" }));
    expect(res.durchlaufende_posten).toHaveLength(1);
    const d = res.durchlaufende_posten[0];
    expect(d).toMatchObject({ konto: 1590, art: "durchlaufende_posten", saldo: 30, ausgeglichen: false, buchungen_anzahl: 3, paare: 1 });
    expect(d.offen).toEqual([expect.objectContaining({ id: 23, betrag: 20, datum: "2026-03-20" })]);
    expect(res.durchlaufende_ausgeglichen).toBe(false);
    // Geldtransit 1360 hat weder Saldo noch Buchungen und taucht nicht auf, wurde aber abgefragt
    expect(call.mock.calls.filter(([op]) => op === "reportsGetSumsLedger")).toHaveLength(2);
  });

  it("wartet auf eine gerade laufende Summen- und Saldenliste", async () => {
    const inner = fakeClient();
    let busy = 1;
    const call = vi.fn(async (op: string, params: Record<string, unknown>) => {
      if (op === "reportsCreateSums" && busy-- > 0) throw new BuchhaltungsButlerApiError("HTTP 400 — report generation already in progress", 400, "reportsCreateSums", {});
      return inner.client.call(op as never, params);
    });
    const [tool] = createBankOverviewTools({ call } as unknown as BBClient, { sleep, pollMs: 1 });
    const res = parse(await tool.handler({ as_of: "2026-03-31" }));
    expect(res.konten).toHaveLength(2);
  });

  it("weist falsche Eingaben ab, bevor BHB einen Aufruf sieht", async () => {
    const { client, call } = fakeClient();
    const [tool] = createBankOverviewTools(client, { sleep, pollMs: 1 });
    await expect(tool.handler({ as_of: "31.03.2026" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(tool.handler({ as_of: "2026-03-31", date_from: "2026-04-01" })).rejects.toThrow(/nach as_of/);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("pairOff", () => {
  const b = (id: number, datum: string, betrag: number) => ({ konto: 1590, id, datum, text: "", betrag, gegenkonto: null, beleg: false });
  it("paart Soll und Haben gleichen Betrags, die älteste zuerst; Gleiches im Soll paart sich nicht", () => {
    const r = pairOff([b(1, "2026-01-02", 100), b(2, "2026-01-09", -100), b(3, "2026-02-01", 50), b(4, "2026-02-02", 50), b(5, "2026-02-03", -50)]);
    expect(r.paare).toBe(2);
    expect(r.offen.map((x) => x.id)).toEqual([4]);
  });
  it("nichts offen, wenn alles Gegenbuchungen hat; Nullbuchungen werden ignoriert", () => {
    expect(pairOff([b(1, "2026-01-02", 10), b(2, "2026-01-03", -10), b(3, "2026-01-04", 0)])).toEqual({ paare: 1, offen: [] });
  });
  it("verschiedene Beträge bleiben offen, auch wenn die Summe passt", () => {
    expect(pairOff([b(1, "2026-01-02", 10), b(2, "2026-01-03", -4), b(3, "2026-01-04", -6)]).offen).toHaveLength(3);
  });
});
