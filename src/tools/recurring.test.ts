import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createServer } from "../server.js";

async function connect() {
  const call = vi.fn().mockResolvedValue({ success: true, id_by_customer: "1" });
  const server = createServer({ call } as unknown as BBClient);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  await client.listTools();
  return { client, call };
}

const base = (net: string, extra: Record<string, unknown>) => ({
  type: "invoice",
  show_prices_type: "net",
  company_name: "Muster Transport GmbH",
  date: "2026-12-31",
  items: [{ name: "Betreuung", amount: "1", unit: "Monat", vat: "19", single_price: net }],
  ...extra,
});

const text = (res: unknown) => (res as { content: Array<{ text: string }> }).content[0].text;

describe("Wiederholungsrechnungen", () => {
  it("bricht ohne confirm_creates_first_invoice ab und ruft BHB nicht auf", async () => {
    const { client, call } = await connect();
    const res = await client.callTool({
      name: "create_invoice",
      arguments: base("40.00", { recurring_interval: "monthly", recurring_date_next: "2027-01-01", allow_open_ended: true }),
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("confirm_creates_first_invoice");
    expect(text(res)).not.toContain("allow_open_ended: true (");
    expect(call).not.toHaveBeenCalled();
  });

  it("bricht ohne allow_open_ended ab (kein Enddatum in BHB)", async () => {
    const { client, call } = await connect();
    const res = await client.callTool({
      name: "create_invoice",
      arguments: base("40.00", { recurring_interval: "monthly", recurring_date_next: "2027-01-01", confirm_creates_first_invoice: true }),
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("allow_open_ended");
    expect(call).not.toHaveBeenCalled();
  });

  it("legt mit beiden Bestätigungen an und schickt die Bestätigungsfelder nicht an BHB", async () => {
    const { client, call } = await connect();
    const res = await client.callTool({
      name: "create_invoice",
      arguments: base("1.00", {
        recurring_interval: "monthly",
        recurring_date_next: "2027-01-01",
        confirm_creates_first_invoice: true,
        allow_open_ended: true,
      }),
    });
    expect(res.isError).toBeFalsy();
    expect(call).toHaveBeenCalledTimes(1);
    const payload = call.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.recurring_interval).toBe("monthly");
    expect(payload).not.toHaveProperty("confirm_creates_first_invoice");
    expect(payload).not.toHaveProperty("allow_open_ended");
    expect(payload).not.toHaveProperty("dry_run");
  });

  it("echter Aufruf mit Wiederholung warnt vor offenem Plan, ohne Wiederholung nicht", async () => {
    const { client } = await connect();
    const withPlan = await client.callTool({
      name: "create_invoice",
      arguments: base("1.00", {
        recurring_interval: "monthly",
        recurring_date_next: "2027-01-01",
        confirm_creates_first_invoice: true,
        allow_open_ended: true,
      }),
    });
    expect(text(withPlan)).toContain("Wiederkehrende Rechnungen");
    expect(text(withPlan)).toContain("nicht selbst per Browser");
    const single = await client.callTool({ name: "create_invoice", arguments: base("1.00", {}) });
    expect(text(single)).not.toContain("Wiederholungsplan");
  });

  it("Server-Instruktionen und Guide nennen die Grenze", async () => {
    const { SERVER_INSTRUCTIONS } = await import("./bhb-systematik.js");
    const { BOOKING_GUIDE } = await import("./booking-guide.js");
    expect(SERVER_INSTRUCTIONS).toMatch(/NO stop and NO list/);
    expect(SERVER_INSTRUCTIONS).toContain("recurring_date_end");
    const entry = BOOKING_GUIDE.find((e) => e.id === "wiederkehrende_rechnungen");
    expect(entry?.regeln.join(" ")).toMatch(/keinen Stopp/);
    expect(entry?.regeln.join(" ")).toContain("recurring_date_end");
  });

  it("Rechnung ohne Wiederholung braucht keine Bestätigung", async () => {
    const { client, call } = await connect();
    const res = await client.callTool({ name: "create_invoice", arguments: base("40.00", {}) });
    expect(res.isError).toBeFalsy();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("create_einvoice bricht mit Wiederholung ohne Bestätigung ab", async () => {
    const { client, call } = await connect();
    const res = await client.callTool({
      name: "create_einvoice",
      arguments: {
        type: "invoice",
        show_prices_type: "net",
        company_name: "Muster Transport GmbH",
        date: "2026-12-31",
        street: "Musterweg 1",
        zip: "12345",
        city: "Musterstadt",
        country: "Deutschland",
        email: "x@example.invalid",
        e_invoice_id: "0",
        items: [{ name: "Betreuung", amount: "1", unit: "Monat", tax_type: "19", tax_amount: "7.60", single_price: "40.00" }],
        recurring_interval: "monthly",
        recurring_date_next: "2027-01-01",
      },
    });
    expect(res.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("dry_run legt nichts an, zeigt Termine und Summe (monatlich, 40,00 netto)", async () => {
    const { client, call } = await connect();
    const res = await client.callTool({
      name: "create_invoice",
      arguments: base("40.00", { recurring_interval: "monthly", recurring_date_next: "2027-01-01", dry_run: true }),
    });
    expect(res.isError).toBeFalsy();
    expect(call).not.toHaveBeenCalled();
    const data = (res.structuredContent as { data: Record<string, unknown> }).data as {
      created: boolean;
      totals_per_invoice: { net: number; gross: number };
      invoices: Array<{ date: string }>;
      warnings: string[];
    };
    expect(data.created).toBe(false);
    expect(data.totals_per_invoice).toEqual({ net: 40, gross: 47.6 });
    expect(data.invoices.map((i) => i.date).slice(0, 4)).toEqual(["2026-12-31", "2027-01-01", "2027-02-01", "2027-03-01"]);
    expect(data.invoices).toHaveLength(13);
    expect(data.warnings.join(" ")).toContain("Kein Enddatum");
  });

  it("dry_run: quartalsweise, jährlich, wöchentlich und Monatsende", async () => {
    const { client } = await connect();
    const dates = async (interval: string, next: string) => {
      const res = await client.callTool({
        name: "create_invoice",
        arguments: base("20.00", { recurring_interval: interval, recurring_date_next: next, dry_run: true }),
      });
      return (res.structuredContent as { data: { invoices: Array<{ date: string }> } }).data.invoices.slice(1, 5).map((i) => i.date);
    };
    expect(await dates("quarterly", "2027-01-01")).toEqual(["2027-01-01", "2027-04-01", "2027-07-01", "2027-10-01"]);
    expect(await dates("yearly", "2027-01-01")).toEqual(["2027-01-01", "2028-01-01", "2029-01-01", "2030-01-01"]);
    expect(await dates("weekly", "2027-01-03")).toEqual(["2027-01-03", "2027-01-10", "2027-01-17", "2027-01-24"]);
    expect(await dates("monthly", "2027-01-31")).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  });

  it("dry_run lehnt ungültige Intervalle und Daten ab", async () => {
    const { client } = await connect();
    const bad = await client.callTool({
      name: "create_invoice",
      arguments: base("20.00", { recurring_interval: "daily", recurring_date_next: "2027-01-01", dry_run: true }),
    });
    expect(bad.isError).toBe(true);
    const missing = await client.callTool({
      name: "create_invoice",
      arguments: base("20.00", { recurring_interval: "monthly", dry_run: true }),
    });
    expect(missing.isError).toBe(true);
    const badDate = await client.callTool({
      name: "create_invoice",
      arguments: base("20.00", { recurring_interval: "monthly", recurring_date_next: "2027-02-30", dry_run: true }),
    });
    expect(badDate.isError).toBe(true);
  });
});

describe("Enddatum (recurring_date_end)", () => {
  const withEnd = (net: string, extra: Record<string, unknown>) => base(net, { recurring_date_end: "2027-02-01", ...extra });

  it("mit Enddatum und Bestätigung braucht es kein allow_open_ended und geht an BHB", async () => {
    const { client, call } = await connect();
    const res = await client.callTool({
      name: "create_invoice",
      arguments: withEnd("1.00", { recurring_interval: "monthly", recurring_date_next: "2027-01-01", confirm_creates_first_invoice: true }),
    });
    expect(res.isError).toBeFalsy();
    const payload = call.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.recurring_date_end).toBe("2027-02-01");
    expect(payload).not.toHaveProperty("allow_open_ended");
    expect(text(res)).toContain("Letzte Rechnung 2027-02-01");
  });

  it("mit Enddatum fehlt trotzdem die Bestätigung der ersten Rechnung", async () => {
    const { client, call } = await connect();
    const res = await client.callTool({
      name: "create_invoice",
      arguments: withEnd("1.00", { recurring_interval: "monthly", recurring_date_next: "2027-01-01" }),
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("confirm_creates_first_invoice");
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ["ungültiges Datum", { recurring_interval: "monthly", recurring_date_next: "2027-01-01", recurring_date_end: "2027-13-45" }],
    ["Ende vor dem nächsten Termin", { recurring_interval: "monthly", recurring_date_next: "2027-01-01", recurring_date_end: "2026-12-31" }],
    ["Enddatum ohne Intervall", { recurring_date_end: "2027-02-01" }],
    ["Enddatum bei Entwurf", { recurring_interval: "monthly", recurring_date_next: "2027-01-01", recurring_date_end: "2027-02-01", draft: true }],
  ])("lehnt ab, bevor BHB eine Rechnung anlegt: %s", async (_name, extra) => {
    const { client, call } = await connect();
    const res = await client.callTool({
      name: "create_invoice",
      arguments: base("1.00", { confirm_creates_first_invoice: true, allow_open_ended: true, ...extra }),
    });
    expect(res.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("ein BHB-Fehler bei einer Wiederholung nennt, dass die Rechnung trotzdem entstanden sein kann", async () => {
    const call = vi.fn().mockRejectedValue(new Error("HTTP 500 — error while processing the request"));
    const server = createServer({ call } as unknown as BBClient);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.listTools();
    const res = await client.callTool({
      name: "create_invoice",
      arguments: withEnd("1.00", { recurring_interval: "monthly", recurring_date_next: "2027-01-01", confirm_creates_first_invoice: true }),
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("HTTP 500");
    expect(text(res)).toContain("list_receipts");
  });

  // Fiktive Beispieldaten; der Starttag der ersten Rechnung ist der Starttermin.
  it.each([
    ["monthly", "2027-01-01", "2027-08-31", 8],
    ["monthly", "2027-01-01", "2027-06-11", 6],
    ["monthly", "2027-01-03", "2027-07-02", 6], // 03.07. liegt nach dem Ende: 6 Läufe, nicht 7
    ["monthly", "2027-01-03", "2027-07-03", 7],
    ["quarterly", "2027-01-01", "2027-12-31", 4],
  ])("dry_run %s ab %s bis %s: %i Termine, nichts angelegt", async (interval, next, end, count) => {
    const { client, call } = await connect();
    const res = await client.callTool({
      name: "create_invoice",
      arguments: base("20.00", { recurring_interval: interval, recurring_date_next: next, recurring_date_end: end, dry_run: true }),
    });
    expect(res.isError).toBeFalsy();
    expect(call).not.toHaveBeenCalled();
    const data = (res.structuredContent as { data: { invoices: Array<{ date: string }>; shown_repeats: number; warnings: string[] } }).data;
    expect(data.shown_repeats).toBe(count);
    expect(data.invoices).toHaveLength(count + 1);
    expect(data.invoices.at(-1)!.date <= end).toBe(true);
    expect(data.warnings.join(" ")).not.toContain("Kein Enddatum");
  });
});
