import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createPostingsTools } from "./postings.js";
import {
  KU_HINWEIS_VORSCHLAG,
  kleinunternehmerInvoiceCheck,
  kleinunternehmerPostingWarnings,
  kleinunternehmerStatus,
} from "./kleinunternehmer.js";
import { DEFAULT_POLICY, type Policy } from "./policy.js";

const policy = (kleinunternehmer: boolean | null): Policy => ({ ...structuredClone(DEFAULT_POLICY), tax_profile: { kleinunternehmer, gewinnermittlung: null } });

describe("kleinunternehmerStatus", () => {
  it("liest den Status aus der Policy, null wenn nicht festgelegt", async () => {
    expect(await kleinunternehmerStatus(async () => policy(true))).toEqual({ status: true, warnings: [] });
    expect(await kleinunternehmerStatus(async () => policy(null))).toEqual({ status: null, warnings: [] });
  });
  it("eine kaputte Policy-Datei blockiert nichts, sondern wird gemeldet", async () => {
    const r = await kleinunternehmerStatus(async () => {
      throw new Error("kein gültiges JSON");
    });
    expect(r.status).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/Policy.*kein gültiges JSON/);
  });
});

describe("kleinunternehmerInvoiceCheck (§ 19 UStG, § 34a UStDV, § 14c UStG)", () => {
  it("lehnt eine Rechnung mit Steuersatz ab, weil ausgewiesene Steuer nach § 14c geschuldet wird", () => {
    const r = kleinunternehmerInvoiceCheck({ type: "invoice", items: [{ vat: "19" }], final_provisions: KU_HINWEIS_VORSCHLAG });
    expect(r.error).toMatch(/§ 14c UStG/);
    expect(r.error).toMatch(/set_policy/);
  });
  it("lehnt auch tax_type S bei der E-Rechnung ab", () => {
    expect(kleinunternehmerInvoiceCheck({ type: "invoice", items: [{ vat: "0", tax_type: "S" }], e_invoice: true }).error).toMatch(/§ 14c/);
  });
  it("ein Angebot mit Steuersatz ist keine Rechnung: nur Warnung", () => {
    const r = kleinunternehmerInvoiceCheck({ type: "offer", items: [{ vat: "19" }], final_provisions: KU_HINWEIS_VORSCHLAG });
    expect(r.error).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/Angebot/);
  });
  it("ohne Hinweis auf die Steuerbefreiung: Warnung mit Textvorschlag (§ 34a Satz 1 Nr. 5 UStDV)", () => {
    const r = kleinunternehmerInvoiceCheck({ type: "invoice", items: [{ vat: "0" }] });
    expect(r.error).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/§ 34a/);
    expect(r.warnings.join(" ")).toContain(KU_HINWEIS_VORSCHLAG);
  });
  it("Hinweis in final_provisions oder correspondence genügt, auch umgangssprachlich", () => {
    expect(kleinunternehmerInvoiceCheck({ type: "invoice", items: [{ vat: "0" }], final_provisions: "Gemäß § 19 UStG steuerfrei." }).warnings).toEqual([]);
    expect(kleinunternehmerInvoiceCheck({ type: "invoice", items: [{ vat: "0" }], correspondence: "steuerfreier Kleinunternehmer" }).warnings).toEqual([]);
  });
  it("E-Rechnung ist für Kleinunternehmer keine Pflicht (§ 34a Satz 3 UStDV): Hinweis", () => {
    const r = kleinunternehmerInvoiceCheck({ type: "invoice", items: [{ vat: "0", tax_type: "E" }], e_invoice: true, final_provisions: KU_HINWEIS_VORSCHLAG });
    expect(r.error).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/keine Pflicht/);
  });
});

describe("kleinunternehmerPostingWarnings", () => {
  it("normale Eingangsrechnung brutto mit 0_none und § 13b ohne Vorsteuer: keine Warnung", () => {
    expect(kleinunternehmerPostingWarnings(["0_none", "19_both_1_no_pre", "19_both_6511", "7_both_no_pre"])).toEqual([]);
  });
  it("Vorsteuer-Codes: Warnung mit dem Weg über 0_none bzw. die Codes ohne Vorsteuer", () => {
    const w = kleinunternehmerPostingWarnings(["19_pre", "19_both_511"]).join(" ");
    expect(w).toMatch(/19_pre, 19_both_511/);
    expect(w).toMatch(/0_none/);
    expect(w).toMatch(/_no_pre/);
    expect(w).toMatch(/UStAE 19\.1/);
  });
  it("Umsatzsteuer auf Erlöse: Warnung, die Befreiung endet erst mit dem Überschreiten der Grenze", () => {
    const w = kleinunternehmerPostingWarnings(["19_vat"]).join(" ");
    expect(w).toMatch(/19_vat/);
    expect(w).toMatch(/100\.000 €/);
  });
});

describe("Buchungstools melden Vorsteuer bei Kleinunternehmern", () => {
  const free = (vat: string) => ({ date: "2026-11-09", postingtext: "Software", amount: "119.00", postingaccount_debit: 4964, postingaccount_credit: 1200, vat });
  const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

  it("add_free_postings: Warnung bei 19_pre, gebucht wird trotzdem", async () => {
    const client = { call: vi.fn().mockResolvedValue({ success: true }) } as unknown as BBClient;
    const tools = createPostingsTools(client, async () => policy(true));
    const addFree = tools.find((t) => t.name === "add_free_postings")!;
    const res = parse(await addFree.handler({ free_postings: [free("19_pre")] }));
    expect(client.call).toHaveBeenCalledWith("postingsAddBatchFree", expect.anything());
    expect(res.warnings.join(" ")).toMatch(/Kleinunternehmer laut Hausregel.*19_pre/);
  });

  it("add_free_postings: keine Warnung ohne Hausregel oder bei 0_none", async () => {
    for (const [p, vat] of [[policy(null), "19_pre"], [policy(false), "19_pre"], [policy(true), "0_none"]] as const) {
      const client = { call: vi.fn().mockResolvedValue({ success: true }) } as unknown as BBClient;
      const addFree = createPostingsTools(client, async () => p).find((t) => t.name === "add_free_postings")!;
      const res = parse(await addFree.handler({ free_postings: [free(vat)] }));
      expect(JSON.stringify(res.warnings ?? [])).not.toMatch(/Kleinunternehmer/);
    }
  });
});

describe("Bewirtungsbeleg übernimmt den Kleinunternehmer-Status aus der Hausregel", () => {
  const args = {
    date: "2026-11-05",
    location: "Gasthaus Muster, Musterstraße 1, 12345 Musterstadt",
    occasion: "Projektbesprechung Angebot Netzwerkumbau",
    host_name: "Erika Beispiel",
    participants: [{ name: "Max Muster", company: "Muster AG", relation: "customer" }],
    entertainment_type: "business_external",
    food_net: 100,
    food_vat: 7,
    drinks_net: 20,
    drinks_vat: 3.8,
    tip: 0,
  };
  it("ohne kleinunternehmer-Angabe: Hausregel true ergibt Bruttobuchung, null ergibt Regelbesteuerung", async () => {
    const { createEntertainmentReceiptTools } = await import("./entertainment-receipt.js");
    const client = { call: vi.fn() } as unknown as BBClient;
    const [genKu] = createEntertainmentReceiptTools(client, async () => policy(true));
    const [genRegel] = createEntertainmentReceiptTools(client, async () => policy(null));
    const ku = JSON.parse((await genKu.handler(args as never)).content[0].text);
    const regel = JSON.parse((await genRegel.handler(args as never)).content[0].text);
    expect(ku.deductible).not.toEqual(regel.deductible);
    const [genExplizit] = createEntertainmentReceiptTools(client, async () => policy(true));
    const explizit = JSON.parse((await genExplizit.handler({ ...args, kleinunternehmer: false } as never)).content[0].text);
    expect(explizit.deductible).toEqual(regel.deductible);
  });
});
