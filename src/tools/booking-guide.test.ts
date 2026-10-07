import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { anlagenWarnings, SERVER_INSTRUCTIONS, personenkontoWarnings, unbookableRateWarnings } from "./bhb-systematik.js";
import { BOOKING_GUIDE, createBookingGuideTools, findBookingGuide } from "./booking-guide.js";
import { createAllTools } from "./index.js";
import { createInvoicesTools } from "./invoices.js";
import { createPostingsTools } from "./postings.js";

// Die 31 Wissensdatenbank-Artikel, die der Leitfaden abdecken soll (22 Sonderfälle/Kontierungstipps, 9 Best Practices).
const ARTICLE_IDS = [
  "11259650218013", "11278472921117", "11278919655965", "11279492940061", "11279998187293", "11281029665309",
  "11281149705885", "11281267173277", "11281526395037", "11281694063005", "11281833740189", "11281936719005",
  "11282126009373", "11282286368541", "11282864819357", "11320416257693", "11320758964381", "11321777612957",
  "11322803594269", "11407622675485", "11407902754333", "20068054846237",
  "11419668183709", "11421251511965", "32110192691357", "11421107352989", "11420828181277", "11421057914781",
  "21062365037981", "16331667205917", "11419453337373",
  // Kategorien Fehlerbehebung, Administratives, Funktionen & Einstellungen
  "11422252682781", "11432424987037", "11467646903069", "11443147763101", "11443781087389", "11443312093725",
  "11444714286621", "11443881408285", "11422121017757", "11421494594077", "11421652514845", "11421952068125",
  "11421829670045", "20227969805853", "20426914295453", "11451892160797", "11452107588893", "11451725464477",
  "11473240647965", "11473312092445", "11469981205277", "11473051798941", "11432104747677", "11472964130461",
  "11431990158365", "11474039285405", "11473653935005", "11474193643293", "11474253173021", "38676182512029",
  "11465983139101", "11454526317085", "11465877273757", "11454462250909", "23423191873565", "23423036141213",
  "11444878256413", "11445000762781", "11454209365661", "11454359040925", "11445076569885", "11441670785949",
  "11441898777757", "11468075328797", "13110056377245", "11431862574109", "11423965528605", "11423365749149",
  "11423251653149", "11448205191197",
];

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const [tool] = createBookingGuideTools();

describe("booking guide data", () => {
  it("covers every source article, and every entry cites at least one", () => {
    const sources = BOOKING_GUIDE.map((e) => e.quelle).join(" ");
    for (const id of ARTICLE_IDS) expect(sources, `article ${id} is not covered`).toContain(id);
    for (const e of BOOKING_GUIDE) expect(ARTICLE_IDS.some((id) => e.quelle.includes(id)) || e.quelle.startsWith("Übergabe")).toBe(true);
    // Several articles share one entry (e.g. Lexware export in the Wechsel entry), so there are fewer entries than articles.
    expect(BOOKING_GUIDE.length).toBeGreaterThanOrEqual(40);
    expect(BOOKING_GUIDE.length).toBeLessThan(ARTICLE_IDS.length);
  });

  it("has unique ids and non-empty rules for every entry", () => {
    expect(new Set(BOOKING_GUIDE.map((e) => e.id)).size).toBe(BOOKING_GUIDE.length);
    for (const e of BOOKING_GUIDE) {
      expect(e.titel.length).toBeGreaterThan(5);
      expect(e.regeln.length).toBeGreaterThan(0);
    }
  });

  it("only names tools that exist (connector tools from the real registry, plus the browser tools of the Anlagen handover)", () => {
    const connector = new Set(createAllTools({ call: vi.fn() } as unknown as BBClient).map((t) => t.name));
    const browser = new Set(["get_page_text", "resize_window", "read_page", "javascript_tool", "form_input", "triple_click"]);
    const mentioned = new Set(
      BOOKING_GUIDE.flatMap((e) =>
        [...e.regeln, ...(e.ablauf ?? []), ...(e.konnektor ?? []), ...(e.achtung ?? [])].join(" ").match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []
      )
    );
    const toolLike = [...mentioned].filter((m) =>
      /^(add|create|list|manage|get|confirm|cancel|upload|assign|unassign|delete|update|set|generate|check|resize|read|form|triple)_/.test(m)
    );
    for (const t of toolLike) expect(connector.has(t) || browser.has(t), `${t} is not a known tool`).toBe(true);
    expect(toolLike).toContain("cancel_posting");
  });
});

describe("get_booking_guide", () => {
  it("is read-only and makes no API call", () => {
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(tool.name).toBe("get_booking_guide");
  });

  it("lists all topics when no topic is given", async () => {
    const res = parse(await tool.handler({}));
    expect(res.themen).toHaveLength(BOOKING_GUIDE.length);
    expect(res.themen[0]).toEqual({ topic: BOOKING_GUIDE[0].id, titel: BOOKING_GUIDE[0].titel });
  });

  it("returns the full entry for a topic", async () => {
    const res = parse(await tool.handler({ topic: "skonto" }));
    expect(res.id).toBe("skonto");
    expect(res.regeln.join(" ")).toMatch(/NEGATIVEM Betrag/);
    expect(res.regeln.join(" ")).toMatch(/3736 \| 5736/);
  });

  it("covers the account numbers documented in the articles", () => {
    expect(JSON.stringify(findBookingGuide("geldtransit"))).toMatch(/1360 \| 1460/);
    expect(JSON.stringify(findBookingGuide("lohn"))).toMatch(/1755 \| 3790/);
    expect(JSON.stringify(findBookingGuide("iab"))).toMatch(/9970.*9971/);
    expect(JSON.stringify(findBookingGuide("dreiecksgeschaeft"))).toMatch(/3260 \| 5260/);
    expect(JSON.stringify(findBookingGuide("eu_neufahrzeug"))).toMatch(/3250 \| 5250/);
    expect(JSON.stringify(findBookingGuide("ausland_ust"))).toMatch(/1767/);
  });

  it("states what the articles could not confirm instead of guessing", () => {
    expect(JSON.stringify(findBookingGuide("abschreibung"))).toMatch(/list_posting_accounts/);
    expect(JSON.stringify(findBookingGuide("dreiecksgeschaeft"))).toMatch(/vertauschtem Soll\/Haben/);
    expect(JSON.stringify(findBookingGuide("mwst_senkung_2020"))).toMatch(/nicht dokumentiert/);
  });

  it("holds the best-practice topics with their key rules", () => {
    expect(JSON.stringify(findBookingGuide("wechsel_zu_bhb"))).toMatch(/ZUERST importieren, DANACH die Bank verbinden/);
    expect(JSON.stringify(findBookingGuide("wechsel_zu_bhb"))).toMatch(/9000/);
    expect(JSON.stringify(findBookingGuide("monatsabschluss"))).toMatch(/Nuller-Saldo/);
    expect(JSON.stringify(findBookingGuide("monatsabschluss"))).toMatch(/check_month_end/);
    expect(JSON.stringify(findBookingGuide("automatisierungsregeln"))).toMatch(/nicht dokumentiert/);
    expect(JSON.stringify(findBookingGuide("ausgangsrechnung_kasse"))).toMatch(/nur für Eingangsbelege/);
    expect(JSON.stringify(findBookingGuide("buchungsvormerkung_eur"))).toMatch(/exakt übereinstimmen/);
    expect(JSON.stringify(findBookingGuide("buchungsvormerkung_eur"))).toMatch(/postings-reservations/);
    expect(JSON.stringify(findBookingGuide("buchungsvormerkung_eur"))).toMatch(/insufficient privileges/);
    expect(JSON.stringify(findBookingGuide("erste_schritte"))).toMatch(/Kontenrahmen und Länge der Sachkonten/);
  });

  it("documents that receipt review is browser-only, with the Debitoren alternative and its limits", () => {
    const entry = findBookingGuide("belegpruefung");
    const e = JSON.stringify(entry);
    expect(entry?.quelle).toMatch(/Übergabe des Teams/);
    expect(e).toMatch(/confirmationStatus/);
    expect(e).toMatch(/editReceipt/);
    expect(e).toMatch(/Browser-Sitzung/);
    expect(e).toMatch(/date_since_last_modified/);
    expect(e).toMatch(/debtor posting is not activated/);
    expect(e).toMatch(/Per API nicht verifiziert/);
    expect(e).toMatch(/korrigiert keine falschen Felder/);
    expect(JSON.stringify(findBookingGuide("belege_upload_matching"))).toMatch(/belegpruefung/);
  });

  it("holds the Anlagen browser handover with its key facts and caveats", () => {
    const e = JSON.stringify(findBookingGuide("anlagen_browser"));
    expect(findBookingGuide("anlagen_browser")?.quelle).toMatch(/Übergabe des Teams/);
    expect(e).toMatch(/asset-management/);
    expect(e).toMatch(/NICHT die Restmonate/);
    expect(e).toMatch(/depreciation_months_total/);
    expect(e).toMatch(/ArrowDown und Return/);
    expect(e).toMatch(/Doppelanlagen/);
    expect(e).toMatch(/Nicht geprüft/);
    expect(e).toMatch(/4832/);
    expect(e).toMatch(/kein MCP-Tool/);
  });

  it("points the Anlagen warning and the instructions to the browser topic", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/anlagen_browser/);
    expect(anlagenWarnings([420])[0]).toMatch(/anlagen_browser/);
  });

  it("holds the topics from the Fehlerbehebung/Administratives/Funktionen categories with their key rules", () => {
    const e = (id: string) => JSON.stringify(findBookingGuide(id));
    expect(e("festgeschriebene_loeschen")).toMatch(/nie physisch gelöscht/);
    expect(e("belege_upload_matching")).toMatch(/90 Tage vor bis 30 Tage nach/);
    expect(e("belege_upload_matching")).toMatch(/Referenz: 123456abc/);
    expect(e("eigenbeleg")).toMatch(/3200 \| 5200/);
    expect(e("debitoren_kreditoren_logik")).toMatch(/IMMER ohne Steuer/);
    expect(e("debitoren_kreditoren_logik")).toMatch(/Keine Doppelerfassung/);
    expect(e("ust_va_zm")).toMatch(/Übermittlungsprotokoll wird NICHT gespeichert/);
    expect(e("auswertungen")).toMatch(/NUR bestätigte Buchungen/);
    expect(e("konten_einrichtung")).toMatch(/4 bis 8 Stellen/);
    expect(e("konten_einrichtung")).toMatch(/1371 \| 1486/);
    expect(e("rechnungen_erstellen")).toMatch(/Leitweg-ID/);
    expect(e("kostenstellen")).toMatch(/DATEV-Export, nicht in BWA/);
    expect(e("paket_und_limits")).toMatch(/500 Belege pro Monat/);
    expect(e("bilanz_integritaet")).toMatch(/9000/);
    expect(e("zahlungen_probleme")).toMatch(/NICHT erneut abgerufen/);
  });

  it("corrects the Kennziffer note for the EU new-vehicle workaround from the assignment table", () => {
    const e = JSON.stringify(findBookingGuide("eu_neufahrzeug"));
    expect(e).toMatch(/Kz 96/);
    expect(e).toMatch(/prüfen/);
  });

  it("is announced in the server instructions", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/get_booking_guide/);
    expect(SERVER_INSTRUCTIONS).toMatch(/Geldtransit/);
  });
});

describe("warnings added for documented BHB limits", () => {
  it("unbookableRateWarnings flags 5.5 and 10.7 percent, incl. a decimal comma", () => {
    expect(unbookableRateWarnings([{ vat: "19" }, { vat: "7" }])).toEqual([]);
    expect(unbookableRateWarnings([{ vat: "5.5" }])[0]).toMatch(/5.5 %/);
    expect(unbookableRateWarnings([{ vat: "10,7" }, { vat: "10.7" }])[0]).toMatch(/10.7 %/);
  });

  it("create_invoice still creates the invoice and warns for a 5.5 percent item", async () => {
    const client: BBClient = { call: vi.fn().mockResolvedValue({ success: true }) };
    const [createInvoice] = createInvoicesTools(client);
    const res = parse(
      await createInvoice.handler({
        type: "invoice",
        show_prices_type: "net",
        company_name: "Hof GmbH",
        date: "2026-03-10",
        items: [{ name: "Ware", amount: "1", unit: "Stk.", vat: "5.5", single_price: "100.00" }],
      })
    );
    expect(client.call).toHaveBeenCalledWith("invoicesCreate", expect.objectContaining({ item_vat: ["5.5"] }));
    expect(res.warnings[0]).toMatch(/nicht verbuchen/);
  });

  it("personenkontoWarnings flags accounts from 10000 and ignores normal accounts", () => {
    expect(personenkontoWarnings([1200, 4830, 9000])).toEqual([]);
    expect(personenkontoWarnings([10000, 1200, 70011])[0]).toMatch(/Konto 10000, 70011/);
  });

  it("add_free_postings books and warns for a Debitor account, without blocking opening balances", async () => {
    const client: BBClient = { call: vi.fn().mockResolvedValue({ success: true }) };
    const [, , , addFreePostings] = createPostingsTools(client);
    const res = parse(
      await addFreePostings.handler({
        free_postings: [
          { date: "2025-12-31", postingtext: "EB", amount: "100.00", postingaccount_debit: 10000, postingaccount_credit: 9000, vat: "0_none" },
        ],
      })
    );
    expect(client.call).toHaveBeenCalledWith("postingsAddBatchFree", expect.anything());
    expect(res.warnings.join(" ")).toMatch(/Debitoren-\/Kreditorenkonto/);
  });
});
