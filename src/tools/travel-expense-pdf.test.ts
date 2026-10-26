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
    },
  ],
  kmLines: [],
  totals: { allowances: 85.4, lodgingFlat: 0, km: 0, fares: 0, lodging: 107, incidentals: 0, total: 192.4, advance: 50, reimbursement: 142.4 },
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
