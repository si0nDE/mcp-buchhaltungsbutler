import { describe, expect, it } from "vitest";
import { checkReceiptFields } from "./receipt-fields.js";

const good = `Beispiel GmbH, Musterweg 1, 12345 Musterstadt
Steuernummer: 12/345/67890
Rechnung Nr. RE-1001 vom 28.11.2025
Leistungszeitraum: 01.11.2025 - 30.11.2025
Nettobetrag 200,00
USt 19 % 38,00
Gesamtbetrag 238,00`;

const codes = (t: string, ctx = {}) => checkReceiptFields(t, ctx).filter((f) => f.severity === "auffaellig").map((f) => f.code);

describe("checkReceiptFields", () => {
  it("reports nothing conspicuous for a complete invoice", () => {
    expect(codes(good, { invoicenumber: "RE-1001", amount: 238 })).toEqual([]);
  });

  it("flags a placeholder instead of the tax id", () => {
    expect(codes(good.replace("Steuernummer: 12/345/67890", "USt.-IdNr.: folgt"))).toContain("tax_id_placeholder");
    expect(codes(good.replace("Steuernummer: 12/345/67890", "Steuernummer: beantragt"))).toContain("tax_id_placeholder");
  });

  it("flags a missing tax id", () => {
    expect(codes(good.replace("Steuernummer: 12/345/67890\n", ""))).toContain("tax_id_missing");
  });

  it("flags a failed arithmetic check but allows 1 cent rounding", () => {
    expect(codes(good.replace("Gesamtbetrag 238,00", "Gesamtbetrag 240,00"))).toContain("arithmetic");
    expect(codes(good.replace("Gesamtbetrag 238,00", "Gesamtbetrag 238,01"))).not.toContain("arithmetic");
  });

  it("flags a gross amount that differs from BHB and a foreign invoice number", () => {
    const c = codes(good, { amount: 119, invoicenumber: "RE-9" });
    expect(c).toContain("amount_differs");
    expect(c).toContain("invoicenumber_differs");
  });

  it("flags a missing Leistungsdatum and missing tax rate", () => {
    expect(codes(good.replace(/Leistungszeitraum.*\n/, ""))).toContain("service_date_missing");
    expect(codes("Rechnung Nr. 1 vom 01.01.2026\n12345 Ort\nSteuernummer 12/345/67890\nLeistung am 01.01.2026\nSumme 10,00")).toContain("tax_rate_missing");
  });

  it("never returns an approval and marks what it could not check", () => {
    const f = checkReceiptFields("Rechnung Nr. 1 vom 01.01.2026\n12345 Ort\nSteuernummer 12/345/67890\nLeistung am 01.01.2026\n19 % USt");
    expect(f.some((x) => x.code === "arithmetic_unchecked")).toBe(true);
    expect(JSON.stringify(f)).not.toMatch(/in Ordnung|korrekt|freigegeben/i);
  });
});

import { vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createReceiptFieldsTools } from "./receipt-fields.js";

describe("check_receipt_fields tool", () => {
  it("says nothing was checked when no text is readable", async () => {
    const client = { call: vi.fn().mockResolvedValue({ data: { file_type: "jpg", amount: "10.00" } }) } as unknown as BBClient;
    const [tool] = createReceiptFieldsTools(client);
    const res = await tool.handler({ id_by_customer: 5 });
    const data = (res.structuredContent as { data: { text_available: boolean; findings: unknown[] } }).data;
    expect(data.text_available).toBe(false);
    expect(data.findings).toEqual([]);
    expect(res.content[0].text).toContain("nichts geprüft");
    expect(tool.annotations.readOnlyHint).toBe(true);
  });
});
