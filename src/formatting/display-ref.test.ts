import { describe, expect, it } from "vitest";
import { receiptDisplayRef } from "./display-ref.js";

describe("receiptDisplayRef", () => {
  it("formats invoice number, counterparty, German date and amount", () => {
    expect(receiptDisplayRef({ invoicenumber: "88469", counterparty: "Beispiel GmbH", date: "2026-07-28 00:00:00", amount: 22.7 })).toBe(
      "Rg. 88469 · Beispiel GmbH · 28.07.2026 · 22,70 €"
    );
  });

  it("falls back to the id when there is no invoice number and skips missing parts", () => {
    expect(receiptDisplayRef({ id_by_customer: 353, amount: "-5,5" })).toBe("Beleg #353 (ohne Rechnungsnummer) · -5,50 €");
    expect(receiptDisplayRef({})).toBe("");
  });
});
