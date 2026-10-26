import { describe, expect, it } from "vitest";
import { PDFDocument, PageSizes } from "pdf-lib";
import { extractReceiptText } from "./receipt-text-extraction.js";
import {
  mergeAttachments,
  renderTravelExpenseReport,
  toWinAnsi,
  type TravelReportData,
} from "./travel-expense-pdf.js";

const textOf = async (bytes: Uint8Array) => (await extractReceiptText(Buffer.from(bytes).toString("base64"))) ?? "";

const data = (overrides: Partial<TravelReportData> = {}): TravelReportData => ({
  companyName: "Beispiel GmbH",
  companyAddress: "Musterweg 1, 12345 Musterstadt",
  travellerName: "Erika Mustermann",
  travellerType: "employee",
  purpose: "Kundentermin Einführung Backup-Konzept bei Muster AG",
  departure: "2026-03-09T07:00",
  returnTime: "2026-03-11T18:00",
  route: ["Frankreich (Paris), Ankunft 09.03.2026 10:00"],
  days: [
    { date: "2026-03-09", hours: 17, country: "Frankreich", place: "Paris", kind: "partial", baseAmount: 39, reduction: 0, amount: 39, meals: [], fullRate: 58 },
    { date: "2026-03-10", hours: 24, country: "Frankreich", place: "Paris", kind: "full", baseAmount: 58, reduction: 11.6, amount: 46.4, meals: ["breakfast"], fullRate: 58 },
  ],
  lodgingFlat: [],
  costs: [
    {
      category: "lodging", description: "Hotel Musterstadt", date: "2026-03-09", currency: "EUR", fxRate: 1, grossEur: 107, vatEur: 7, netEur: 100,
      vatRate: 7, vorsteuer: true, recipient: "company", receiptMissing: false, foreignVat: false, breakfastDeductedEur: 0,
      paidBy: "traveller",
    },
  ],
  kmLines: [],
  totals: { allowances: 85.4, lodgingFlat: 0, km: 0, fares: 0, lodging: 107, incidentals: 0, companyPaid: 0, total: 192.4, advance: 50, reimbursement: 142.4 },
  warnings: ["Dreimonatsfrist nicht geprüft (same_location_since fehlt)."],
  sources: ["BMF 05.12.2025, IV C 5 - S 2353/00094/007/012"],
  ...overrides,
});

describe("renderTravelExpenseReport", () => {
  it("renders title, traveller, purpose, sums and the confirmation", async () => {
    const bytes = await renderTravelExpenseReport(data(), { confirmedAt: new Date("2026-03-12T10:30:00Z") });
    const text = await textOf(bytes);
    expect(text).toContain("Reisekostenabrechnung");
    expect(text).toContain("Erika Mustermann");
    expect(text).toContain("Kundentermin Einführung Backup-Konzept");
    expect(text).toContain("Erstattungsbetrag");
    expect(text).toContain("142,40");
    expect(text).toContain("Elektronisch bestätigt");
    expect(text).toContain("12.03.2026, 11:30 Uhr");
  });

  it("states the electronic confirmation neutrally", async () => {
    const text = await textOf(await renderTravelExpenseReport(data()));
    expect(text).toContain("Die Angaben wurden elektronisch bestätigt (Name und Zeitstempel).");
    expect(text).not.toContain("Unterschrift");
    expect(text).not.toContain("undokumentiert");
  });

  it("marks lines paid by the company and shows their sum only when there are any", async () => {
    const plain = await textOf(await renderTravelExpenseReport(data()));
    expect(plain).not.toMatch(/vom\s+Unternehmen\s+gezahlt/);
    const company = data({
      costs: [{ ...data().costs[0], paidBy: "company" }],
      totals: { ...data().totals, lodging: 0, companyPaid: 107, total: 85.4, reimbursement: 35.4 },
    });
    const text = await textOf(await renderTravelExpenseReport(company));
    expect(text).toMatch(/vom\s+Unternehmen\s+gezahlt/);
    expect(text).toContain("nicht im Gesamtbetrag");
    expect(text).toContain("107,00 €");
  });

  it("shows a VORLÄUFIG banner on page 1 for provisional rates and lists the table source per year", async () => {
    const rateTables = [
      { year: 2026, origin: "builtin" as const, source: "BMF 05.12.2025 (Auslandsreisekosten ab 01.01.2026)", retrievedAt: "2026-10-26" },
      { year: 2027, origin: "provisional" as const, source: "Vorläufig: BMF-Auslandstabelle 2027 nicht verfügbar, Sätze der Tabelle 2026", retrievedAt: "2026-10-26", provisionalFrom: 2026 },
    ];
    const bytes = await renderTravelExpenseReport(data({ rateTables }));
    const doc = await PDFDocument.load(bytes);
    const first = await PDFDocument.create();
    first.addPage((await first.copyPages(doc, [0]))[0]);
    const page1 = await textOf(await first.save());
    expect(page1).toContain("VORLÄUFIG: Auslandssätze mit der Tabelle 2026 berechnet, BMF-Tabelle 2027 nicht verfügbar");
    const text = await textOf(bytes);
    expect(text).toContain("Auslandssätze 2026: BMF 05.12.2025");
    expect(text).toContain("Auslandssätze 2027: Vorläufig");
    const plain = await textOf(await renderTravelExpenseReport(data({ rateTables: [rateTables[0]] })));
    expect(plain).not.toContain("VORLÄUFIG");
  });

  it("banner for a year before 2025 says the rates are not those of the travel year", async () => {
    const rateTables = [{ year: 2024, origin: "provisional" as const, source: "Vorläufig", retrievedAt: "2026-10-26", provisionalFrom: 2026 }];
    const text = await textOf(await renderTravelExpenseReport(data({ rateTables })));
    expect(text).toContain("VORLÄUFIG: Auslandssätze mit der Tabelle 2026 berechnet, BMF-Tabelle 2024 nicht verfügbar");
    expect(text).toContain("NICHT die Sätze des Reisejahrs");
    expect(text).not.toContain("Nach Veröffentlichung neu berechnen");
  });

  it("puts all warnings and sources on a notes page", async () => {
    const bytes = await renderTravelExpenseReport(data());
    const text = await textOf(bytes);
    expect(text).toContain("Hinweise zur Prüfung");
    expect(text).toContain("Dreimonatsfrist nicht geprüft");
    expect(text).toContain("IV C 5 - S 2353/00094/007/012");
  });

  it("labels the legal basis by traveller type", async () => {
    const employee = await textOf(await renderTravelExpenseReport(data()));
    const self = await textOf(await renderTravelExpenseReport(data({ travellerType: "self_employed" })));
    expect(employee).toContain("§ 9 Abs. 4a EStG");
    expect(self).toContain("§ 4 Abs. 5 Satz 1 Nr. 5 EStG");
  });

  it("breaks a very long trip with many receipts across pages without overflow", async () => {
    const day = (i: number) => ({
      date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
      hours: 24, country: "Deutschland", place: null, kind: "full" as const, baseAmount: 28, reduction: 0, amount: 28, meals: [], fullRate: 28,
    });
    const many = data({
      days: Array.from({ length: 400 }, (_, i) => day(i)),
      costs: Array.from({ length: 120 }, (_, i) => ({ ...data().costs[0], description: `Hotel Nummer ${i} mit einem sehr langen Namen der umgebrochen werden muss` })),
    });
    const bytes = await renderTravelExpenseReport(many);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(5);
    const text = await textOf(bytes);
    expect(text).toMatch(/Seite \d+ von \d+/);
  });

  it("keeps the layout intact for empty purpose, route, days, costs and km lines", async () => {
    const bytes = await renderTravelExpenseReport(data({ purpose: "", route: [], days: [], costs: [], kmLines: [] }));
    const text = await textOf(bytes);
    expect(text).toContain("Abwesenheit");
    expect(text).toContain("Reiseweg");
    expect(text).toContain("Erstattungsbetrag");
    expect(text).not.toContain("Verpflegung");
    expect(text).not.toContain("Datum Land / Ort");
  });

  it("keeps the sum box and the confirmation on the same page", async () => {
    const day = (i: number) => ({
      date: `2026-01-${String(1 + i).padStart(2, "0")}`,
      hours: 24, country: "Deutschland", place: null, kind: "full" as const, baseAmount: 28, reduction: 0, amount: 28, meals: [], fullRate: 28,
    });
    for (let n = 17; n <= 23; n++) {
      const bytes = await renderTravelExpenseReport(data({ days: Array.from({ length: n }, (_, i) => day(i)), costs: [] }));
      const doc = await PDFDocument.load(bytes);
      const pageTexts: string[] = [];
      for (let i = 0; i < doc.getPageCount(); i++) {
        const single = await PDFDocument.create();
        const [copied] = await single.copyPages(doc, [i]);
        single.addPage(copied);
        pageTexts.push(await textOf(await single.save()));
      }
      const sumPage = pageTexts.find((t) => t.includes("Erstattungsbetrag"));
      expect(sumPage, `n=${n}`).toBeDefined();
      expect(sumPage, `n=${n}`).toContain("Elektronisch bestätigt");
    }
  });

  it("puts the legal basis in the footer without the traveller name", async () => {
    const employee = await textOf(await renderTravelExpenseReport(data()));
    const self = await textOf(await renderTravelExpenseReport(data({ travellerType: "self_employed" })));
    expect(employee).toContain("Rechtsgrundlagen: § 9 Abs. 4a EStG; BMF 25.11.2020 und 05.12.2025");
    expect(self).toContain("Rechtsgrundlagen: § 4 Abs. 5 Satz 1 Nr. 5, § 9 Abs. 4a EStG; BMF 25.11.2020 und 05.12.2025");
    expect(employee).not.toContain("Reisekostenabrechnung Erika Mustermann Seite");
  });

  it("leaves unparsable dates unchanged and handles date-only departure", async () => {
    const text = await textOf(await renderTravelExpenseReport(data({ departure: "2026-03-09", returnTime: "morgen" })));
    expect(text).toContain("09.03.2026 bis morgen");
  });

  it("does not crash on characters outside WinAnsi", async () => {
    const bytes = await renderTravelExpenseReport(data({ travellerName: "Łukasz Çelik", purpose: "Besuch 東京 Büro, Abstimmung Rahmenvertrag" }));
    expect(await textOf(bytes)).toContain("Çelik");
  });
});

describe("toWinAnsi", () => {
  it("keeps German characters and replaces unsupported ones", () => {
    expect(toWinAnsi("Größe € Çelik")).toBe("Größe € Çelik");
    expect(toWinAnsi("Łukasz")).toBe("?ukasz");
  });

  it("normalizes decomposed characters, turns control whitespace into spaces and maps an emoji to one ?", () => {
    expect(toWinAnsi("e\u0301")).toBe("é");
    expect(toWinAnsi("u\u0308")).toBe("ü");
    expect(toWinAnsi("a\nb\r\tc")).toBe("a b c");
    expect(toWinAnsi("x😀y")).toBe("x?y");
  });
});

describe("mergeAttachments", () => {
  it("appends PDF attachments after the report", async () => {
    const report = await renderTravelExpenseReport(data());
    const attachment = await PDFDocument.create();
    attachment.addPage(PageSizes.A4);
    attachment.addPage(PageSizes.A4);
    const attachmentBase64 = Buffer.from(await attachment.save()).toString("base64");
    const before = (await PDFDocument.load(report)).getPageCount();
    const merged = await mergeAttachments(report, [{ file: attachmentBase64, type: "pdf" }]);
    expect((await PDFDocument.load(merged)).getPageCount()).toBe(before + 2);
  });
});
