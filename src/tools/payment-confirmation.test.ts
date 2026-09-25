import { describe, expect, it } from "vitest";
import { amountsMatch, buildSettlementPostingText } from "./payment-confirmation.js";

describe("amountsMatch", () => {
  it("matches equal positive amounts", () => {
    expect(amountsMatch("123.45", "123.45")).toBe(true);
  });

  it("matches a positive receipt amount against a negative (outgoing) transaction amount", () => {
    expect(amountsMatch("123.45", "-123.45")).toBe(true);
  });

  it("rejects amounts that differ beyond the rounding tolerance", () => {
    expect(amountsMatch("123.45", "-100.00")).toBe(false);
  });

  it("accepts a difference within the default rounding tolerance", () => {
    expect(amountsMatch("123.45", "-123.451")).toBe(true);
  });
});

describe("buildSettlementPostingText", () => {
  it("uses the invoice number and counterparty when both are present", () => {
    expect(buildSettlementPostingText({ invoicenumber: "RE-2026-0042", counterparty: "Musterfirma GmbH" }, 1111)).toBe(
      "Ausgleich Beleg RE-2026-0042 - Musterfirma GmbH"
    );
  });

  it("falls back to the receipt id when no invoice number is present", () => {
    expect(buildSettlementPostingText({ counterparty: "Musterfirma GmbH" }, 1111)).toBe(
      "Ausgleich Beleg 1111 - Musterfirma GmbH"
    );
  });

  it("omits the counterparty suffix when none is present", () => {
    expect(buildSettlementPostingText({ invoicenumber: "RE-2026-0042" }, 1111)).toBe("Ausgleich Beleg RE-2026-0042");
  });
});
