import { describe, expect, it } from "vitest";
import { trimList } from "./trim.js";

describe("trimList", () => {
  const records = [
    { id_by_customer: "1", date: "2026-01-01", amount: "10.00", counterparty: "ACME", internal_note: "x" },
    { id_by_customer: "2", date: "2026-01-02", amount: "20.00", counterparty: "Foo GmbH", internal_note: "y" },
  ];
  const fields = ["id_by_customer", "date", "amount", "counterparty"] as const;

  it("trims to the given fields when full is false", () => {
    expect(trimList(records, fields, false)).toEqual([
      { id_by_customer: "1", date: "2026-01-01", amount: "10.00", counterparty: "ACME" },
      { id_by_customer: "2", date: "2026-01-02", amount: "20.00", counterparty: "Foo GmbH" },
    ]);
  });

  it("returns records unchanged when full is true", () => {
    expect(trimList(records, fields, true)).toEqual(records);
  });

  it("returns an empty array for an empty input", () => {
    expect(trimList([], fields, false)).toEqual([]);
  });
});
