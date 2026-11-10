import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { findAuslagenkonto } from "./mixed-receipt-account.js";

const clientWith = (data: Array<Record<string, unknown>> | Error) =>
  ({
    call: vi.fn(async (key: string) => {
      if (key !== "accountsGet") throw new Error(`unexpected endpoint ${key}`);
      if (data instanceof Error) throw data;
      return { success: true, data };
    }),
  }) as unknown as BBClient;

const accounts = [
  { name: "Girokonto", postingaccount_number: "1200" },
  { name: "Verbindlichkeiten Gesellschafter Erika Beispiel", postingaccount_number: "730" },
  { name: "Verbindlichkeiten Gesellschafter Max Mustermann", postingaccount_number: "731" },
];

describe("findAuslagenkonto", () => {
  it("finds exactly one matching account by name and Gesellschafter/Auslage", async () => {
    expect(await findAuslagenkonto(clientWith(accounts), "Erika Beispiel")).toEqual({ found: { number: 730, name: "Verbindlichkeiten Gesellschafter Erika Beispiel" }, candidates: [] });
  });

  it("matches name words in any order, case-insensitive, with odd whitespace", async () => {
    const r = await findAuslagenkonto(clientWith([{ name: "Auslagen BEISPIEL,  Erika", postingaccount_number: 4711 }]), "  erika   beispiel ");
    expect(r.found).toEqual({ number: 4711, name: "Auslagen BEISPIEL,  Erika" });
  });

  it("returns none when no account matches (name without Gesellschafter/Auslage does not count)", async () => {
    const r = await findAuslagenkonto(clientWith([...accounts.slice(0, 1), { name: "Privat Erika Beispiel", postingaccount_number: "1800" }]), "Erika Beispiel");
    expect(r).toEqual({ found: null, candidates: [] });
  });

  it("returns none and lists the names when several accounts match", async () => {
    const r = await findAuslagenkonto(
      clientWith([...accounts, { name: "Auslagen Erika Beispiel", postingaccount_number: "732" }]),
      "Erika Beispiel"
    );
    expect(r.found).toBeNull();
    expect(r.candidates).toEqual(["Verbindlichkeiten Gesellschafter Erika Beispiel (730)", "Auslagen Erika Beispiel (732)"]);
  });

  it("throws on endpoint failure (caller turns it into a warning)", async () => {
    await expect(findAuslagenkonto(clientWith(new Error("HTTP 500")), "Erika Beispiel")).rejects.toThrow(/HTTP 500/);
  });
});
