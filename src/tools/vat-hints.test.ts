import { describe, expect, it } from "vitest";
import { detectChart, vatHint } from "./vat-hints.js";

describe("vat hints", () => {
  it("Aufwand gets Vorsteuer codes, Erlös Umsatzsteuer codes", () => {
    expect(vatHint(4950, "Rechts- und Beratungskosten", "SKR03")?.vat).toEqual(["19_pre", "7_pre", "0_none"]);
    expect(vatHint(8400, "Erlöse 19 % USt", "SKR03")?.vat).toEqual(["19_vat", "7_vat", "0_none"]);
  });
  it("exceptions inside the Aufwand range win", () => {
    expect(vatHint(4830, "Abschreibungen auf Sachanlagen", "SKR03")?.vat).toEqual(["0_none"]);
    expect(vatHint(4120, "Gehälter", "SKR03")?.vat).toEqual(["0_none"]);
    expect(vatHint(1890, "Privateinlagen", "SKR03")?.vat).toEqual(["0_none"]);
  });
  it("no hint outside the clear classes or for other charts", () => {
    expect(vatHint(1200, "Bank", "SKR03")).toBeUndefined();
    expect(vatHint(4950, "x", "unknown")).toBeUndefined();
  });
  it("flags an Automatikkonto by the rate in the name", () => {
    expect(vatHint(8400, "Erlöse 19 % USt", "SKR03")?.note).toMatch(/Automatikkonto/);
  });
  it("detects SKR03 via 8400 Erlöse", () => {
    expect(detectChart([{ postingaccount_number: "8400", name: "Erlöse 19 % USt" }])).toBe("SKR03");
    expect(detectChart([{ postingaccount_number: "4400", name: "Erlöse 19 % USt" }])).toBe("unknown");
  });
});
