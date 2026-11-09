import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { SERVER_INSTRUCTIONS } from "./bhb-systematik.js";
import { findBookingGuide } from "./booking-guide.js";
import {
  GIG_HINWEIS_VORSCHLAG,
  geschaeftsveraeusserungInvoiceWarnings,
  geschaeftsveraeusserungPostingWarnings,
  geschaeftsveraeusserungTransactionHint,
  mayNeedGigCheck,
} from "./geschaeftsveraeusserung.js";
import { createInvoicesTools } from "./invoices.js";
import { createPostingsTools } from "./postings.js";
import { createTransactionsTools } from "./transactions.js";
import { createUstVaTools } from "./ustva-mapping.js";

// Alle Konten, Texte und Zahlen sind erfunden; der Fall ist allgemein beschrieben (docs/rechtsgrundlagen-geschaeftsveraeusserung-earn-out.md).

describe("Leitfaden-Thema geschaeftsveraeusserung", () => {
  const e = JSON.stringify(findBookingGuide("geschaeftsveraeusserung"));
  it("beschreibt beide Fälle: nicht steuerbare Geschäftsveräußerung und steuerpflichtige Kundenstamm-Provision", () => {
    expect(e).toMatch(/§ 1 Abs\. 1a UStG/);
    expect(e).toMatch(/Kundenstamm/);
    expect(e).toMatch(/19_vat/);
    expect(e).toMatch(/0_none/);
  });
  it("nennt die Konten, die Automatikkonten und die Anlagenverwaltung", () => {
    expect(e).toMatch(/8829/);
    expect(e).toMatch(/8837/);
    expect(e).toMatch(/8820/);
    expect(e).toMatch(/2315/);
    expect(e).toMatch(/Anlagenverwaltung/);
  });
  it("nennt die Ertragsteuer-Folgen und die Quellen", () => {
    expect(e).toMatch(/IV R 9\/21/);
    expect(e).toMatch(/§ 24 Nr\. 2 EStG/);
    expect(e).toMatch(/R 7\.1 Abs\. 3 GewStR/);
    expect(e).toMatch(/§ 14c/);
    expect(findBookingGuide("geschaeftsveraeusserung")?.quelle).toMatch(/^Übergabe/);
  });
  it("steht in den Server-Anweisungen", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/geschaeftsveraeusserung/);
  });
});

describe("geschaeftsveraeusserungPostingWarnings", () => {
  const w = (splits: Array<{ postingaccount: number; vat: string; postingtext?: string }>, chart: "SKR03" | "unknown" = "SKR03") =>
    geschaeftsveraeusserungPostingWarnings(splits.map((s) => ({ ...s, label: "Transaktion 1" })), chart);

  it("Erlös mit Umsatzsteuer und Earn-Out im Text: Rückfrage mit beiden Richtungen, kein Verbot", () => {
    const out = w([{ postingaccount: 8837, vat: "19_vat", postingtext: "Earn-Out-Provision Q3" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/§ 1 Abs\. 1a UStG/);
    expect(out[0]).toMatch(/Kundenstamm/);
    expect(out[0]).toMatch(/get_booking_guide geschaeftsveraeusserung/);
  });
  it("Erlös ohne Steuer und Geschäftsveräußerung im Text: Rückfrage, ob wirklich ein Betrieb im Ganzen übergeht", () => {
    const out = w([{ postingaccount: 8837, vat: "0_none", postingtext: "Geschäftsveräußerung Kaufpreis fest" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/steuerpflichtig/);
    expect(out[0]).toMatch(/§ 14c/);
  });
  it("0_none auf einem Automatikkonto 19 % (8820, 8801, 8850): Hinweis auf 8829/8800/8837", () => {
    const out = w([{ postingaccount: 8820, vat: "0_none", postingtext: "Verkauf Server" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/Automatikkonto/);
    expect(out[0]).toMatch(/8829/);
  });
  it("Automatikkonto-Hinweis nur bei SKR03, Text-Hinweise unabhängig vom Kontenrahmen", () => {
    expect(w([{ postingaccount: 8820, vat: "0_none", postingtext: "Verkauf Server" }], "unknown")).toEqual([]);
    expect(w([{ postingaccount: 4400, vat: "19_vat", postingtext: "Earn-Out Q1" }], "unknown")).toHaveLength(1);
  });
  it("normale Buchungen bleiben still", () => {
    expect(w([{ postingaccount: 8400, vat: "19_vat", postingtext: "Wartung Server" }])).toEqual([]);
    expect(w([{ postingaccount: 8829, vat: "19_vat", postingtext: "Verkauf Drucker" }])).toEqual([]);
    expect(w([{ postingaccount: 4950, vat: "19_pre", postingtext: "Earn-Out Beratung" }])).toEqual([]);
    expect(w([{ postingaccount: 8400, vat: "19_vat" }])).toEqual([]);
  });
  it("meldet jeden Split nur einmal, auch wenn Text und Konto treffen", () => {
    expect(w([{ postingaccount: 8820, vat: "0_none", postingtext: "Earn-Out" }])).toHaveLength(2);
    expect(w([{ postingaccount: 8837, vat: "19_vat", postingtext: "Earn-Out" }, { postingaccount: 8837, vat: "19_vat", postingtext: "Earn-Out" }])).toHaveLength(2);
  });
});

describe("mayNeedGigCheck (Vorprüfung ohne API-Aufruf)", () => {
  it("normale Buchungen brauchen keinen Kontenrahmen-Abruf", () => {
    expect(mayNeedGigCheck([{ postingaccount: 8400, vat: "19_vat", postingtext: "Wartung" }, { postingaccount: 4950, vat: "19_pre" }])).toBe(false);
  });
  it("Text-Treffer oder 0_none auf einem Automatikkonto lösen die Prüfung aus", () => {
    expect(mayNeedGigCheck([{ postingaccount: 8400, vat: "19_vat", postingtext: "Earn-Out Q1" }])).toBe(true);
    expect(mayNeedGigCheck([{ postingaccount: 8820, vat: "0_none", postingtext: "Verkauf" }])).toBe(true);
    expect(mayNeedGigCheck([{ postingaccount: 8820, vat: "19_vat", postingtext: "Verkauf" }])).toBe(false);
  });
});

describe("geschaeftsveraeusserungInvoiceWarnings", () => {
  const item = (name: string, vat: string) => ({ name, vat, amount: "1", unit: "Pauschal", single_price: "100.00" });
  it("Provision mit Steuersatz: Hinweis mit den Prüffragen, keine Ablehnung", () => {
    const r = geschaeftsveraeusserungInvoiceWarnings({ items: [item("Earn-Out-Provision Q3 2026", "19")] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/§ 1 Abs\. 1a UStG/);
    expect(r[0]).toMatch(/Mitwirkung|Kundenstamm/);
  });
  it("Kaufpreis ohne Steuer und ohne Hinweis: Textvorschlag für final_provisions", () => {
    const r = geschaeftsveraeusserungInvoiceWarnings({ items: [item("Kaufpreis Geschäftsveräußerung", "0")] });
    expect(r.join(" ")).toContain(GIG_HINWEIS_VORSCHLAG);
    expect(r.join(" ")).toMatch(/§ 14c/);
  });
  it("Kaufpreis ohne Steuer mit Hinweis in final_provisions: nur die Rückfrage, kein Textvorschlag", () => {
    const r = geschaeftsveraeusserungInvoiceWarnings({
      items: [item("Kaufpreis Geschäftsveräußerung", "0")],
      final_provisions: "Nicht steuerbare Geschäftsveräußerung im Ganzen nach § 1 Abs. 1a UStG.",
    });
    expect(r.join(" ")).not.toContain(GIG_HINWEIS_VORSCHLAG);
    expect(r).toHaveLength(1);
  });
  it("Treffer auch über description oder correspondence", () => {
    expect(geschaeftsveraeusserungInvoiceWarnings({ items: [{ ...item("Pauschale", "19"), description: "Earn-Out nach Kaufvertrag" }] })).toHaveLength(1);
    expect(geschaeftsveraeusserungInvoiceWarnings({ items: [item("Pauschale", "19")], correspondence: "Abrechnung Earn-Out Q2" })).toHaveLength(1);
  });
  it("normale Rechnung bleibt still", () => {
    expect(geschaeftsveraeusserungInvoiceWarnings({ items: [item("Wartung Server", "19")] })).toEqual([]);
  });
});

describe("geschaeftsveraeusserungTransactionHint", () => {
  it("erkennt Zahlungen mit Earn-Out, Kundenstamm oder Geschäftsveräußerung im Verwendungszweck", () => {
    const hint = geschaeftsveraeusserungTransactionHint([
      { id_by_customer: "11", purpose: "Earn-Out Q3 2026", to_from: "Beispiel Erwerber GmbH" },
      { id_by_customer: "12", purpose: "Miete", to_from: "Vermieter" },
      { id_by_customer: "13", purpose: "Kaufpreis Kundenstamm Rate 1", to_from: "Beispiel Erwerber GmbH" },
    ]);
    expect(hint).toMatchObject({ kind: "geschaeftsveraeusserung", transaction_ids: [11, 13], guide: "get_booking_guide geschaeftsveraeusserung" });
  });
  it("ohne Treffer kein Hinweis", () => {
    expect(geschaeftsveraeusserungTransactionHint([{ id_by_customer: "12", purpose: "Miete" }])).toBeUndefined();
  });
});

describe("get_ustva_position für Erlöskonten aus Anlagenverkäufen", () => {
  const [tool] = createUstVaTools();
  const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
  it("8829 und 8837: keine feste Position, mit 0_none nicht in der USt-VA und nicht Kz 45", async () => {
    for (const account of [8800, 8817, 8829, 8837]) {
      const res = parse(await tool.handler({ account }));
      expect(res.treffer).toEqual([]);
      expect(res.hinweis).toMatch(/§ 1 Abs\. 1a UStG/);
      expect(res.hinweis).toMatch(/Kz 45/);
      expect(res.hinweis).toMatch(/Kz 81/);
    }
  });
  it("andere Konten ohne feste Position behalten den allgemeinen Hinweis", async () => {
    const res = parse(await tool.handler({ account: 8400 }));
    expect(res.hinweis).not.toMatch(/§ 1 Abs\. 1a/);
  });
});

describe("Einbindung in die Tools", () => {
  function dryClient() {
    const call = vi.fn((key: string) => {
      if (key === "settingsGetPostingaccounts") return Promise.resolve({ data: [{ postingaccount_number: "8400", name: "Umsätze / Erlöse 19/16% Umsatzsteuer" }] });
      if (key === "transactionsGet") return Promise.resolve({ data: [{ id_by_customer: "1", purpose: "Earn-Out Q3", to_from: "Beispiel Erwerber GmbH", amount: "1190.00", booking_date: "2026-10-15" }] });
      throw new Error(`unexpected write/read: ${key}`);
    });
    return { call } as unknown as BBClient;
  }

  it("add_transaction_postings (dry_run) warnt bei Earn-Out im Buchungstext", async () => {
    const [, , addTransactionPostings] = createPostingsTools(dryClient());
    const res = JSON.parse(
      (
        await addTransactionPostings.handler({
          transactions: [{ transaction_id_by_customer: 1, splits: [{ postingaccount: 8837, postingtext: "Earn-Out-Provision Q3", vat: "19_vat", amount: "1190.00" }] }],
          dry_run: true,
        })
      ).content[0].text
    );
    expect(res.warnings.join(" ")).toMatch(/get_booking_guide geschaeftsveraeusserung/);
  });

  it("eine normale Buchung löst keinen zusätzlichen Kontenrahmen-Abruf aus", async () => {
    const call = vi.fn(() => Promise.resolve({ success: true }));
    const [, , addTransactionPostings] = createPostingsTools({ call } as unknown as BBClient);
    await addTransactionPostings.handler({
      transactions: [{ transaction_id_by_customer: 1, splits: [{ postingaccount: 8400, postingtext: "Wartung", vat: "19_vat", amount: "119.00" }] }],
    });
    expect(call.mock.calls.map((c) => c[0])).not.toContain("settingsGetPostingaccounts");
  });

  it("add_free_postings (dry_run) warnt bei 0_none auf dem Automatikkonto 8820", async () => {
    const [, , , addFreePostings] = createPostingsTools(dryClient());
    const res = JSON.parse(
      (
        await addFreePostings.handler({
          free_postings: [{ date: "2026-07-01", postingtext: "Verkauf Server", amount: "500.00", postingaccount_debit: 1200, postingaccount_credit: 8820, vat: "0_none" }],
          dry_run: true,
        })
      ).content[0].text
    );
    expect(res.warnings.join(" ")).toMatch(/Automatikkonto/);
  });

  it("create_invoice (dry_run) gibt bei Earn-Out-Positionen die Prüffragen mit", async () => {
    const client = { call: vi.fn().mockResolvedValue({ success: true }) } as unknown as BBClient;
    const [createInvoice] = createInvoicesTools(client);
    const res = JSON.parse(
      (
        await createInvoice.handler({
          type: "invoice",
          show_prices_type: "net",
          company_name: "Beispiel Erwerber GmbH",
          date: "2026-11-09",
          draft: false,
          items: [{ name: "Earn-Out-Provision Q3 2026", amount: "1", unit: "Pauschal", vat: "19", single_price: "1000.00" }],
          dry_run: true,
        } as never)
      ).content[0].text
    );
    expect(res.warnings.join(" ")).toMatch(/§ 1 Abs\. 1a UStG/);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("list_transactions liefert booking_hints für Earn-Out-Zahlungen", async () => {
    const [listTransactions] = createTransactionsTools(dryClient());
    const res = await listTransactions.handler({ query: "earn-out" });
    expect((res.structuredContent!.booking_hints as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: "geschaeftsveraeusserung", transaction_ids: [1] });
  });
});
