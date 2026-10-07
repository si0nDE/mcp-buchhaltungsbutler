import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createPostingsTools } from "./postings.js";

// Fiktive Beispieldaten (Beispiel Gastronomie GmbH) — keine echten Mandantendaten.
const P3001 = {
  id_by_customer: "3001",
  date: "2026-09-30 00:00:00",
  postingtext: "Bewirtung EX-2026-0001",
  amount: "60.00",
  vat: "7.00",
  debit_postingaccount_number: "4650",
  credit_postingaccount_number: "1201",
  fixed: "0",
  receipt_id_by_customer: "1001",
  transaction_id_by_customer: "2001",
};
const P3002 = { ...P3001, id_by_customer: "3002", amount: "40.00", vat: "19.00" };
const P3003 = {
  id_by_customer: "3003",
  date: "2026-09-30 00:00:00",
  postingtext: "Umbuchung 30% nicht abziehbar",
  amount: "25.00",
  vat: "0.00",
  debit_postingaccount_number: "4654",
  credit_postingaccount_number: "4650",
  fixed: "0",
  receipt_id_by_customer: "",
  transaction_id_by_customer: "",
};
const RANGE = { date_from: "2026-09-01", date_to: "2026-09-30" };

function postingsPage(...data: unknown[]) {
  return { success: true, rows: data.length, data };
}

// postingsGet answers come from a queue, postingsCancel calls from `cancel`.
function setup(pages: unknown[], cancel: unknown = { success: true }) {
  const queue = [...pages];
  const call = vi.fn((key: string) => {
    if (key === "postingsGet") return Promise.resolve(queue.shift() ?? postingsPage());
    if (key === "postingsCancel") {
      return cancel instanceof Error ? Promise.reject(cancel) : Promise.resolve(cancel);
    }
    throw new Error(`unexpected call: ${key}`);
  });
  const client = { call } as unknown as BBClient;
  const cancelPosting = createPostingsTools(client)[7];
  const writes = () => call.mock.calls.filter(([k]) => String(k).startsWith("postingsCancel"));
  return { call, cancelPosting, writes };
}

const data = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent!.data as Record<string, any>;
const FIXED_3001 = { ...P3001, fixed: "1" };
const REVERSAL = { ...P3001, id_by_customer: "3101", amount: "-60.00", fixed: "1" };

describe("cancel_posting", () => {
  it("preview (confirm:false) lists the postings with their action and sends no write", async () => {
    const { cancelPosting, writes } = setup([postingsPage(P3001, P3002, P3003)]);

    const r = data(await cancelPosting.handler({ type: "transaction", id_by_customer: 2001, ...RANGE, confirm: false }));

    expect(r.mode).toBe("preview");
    expect(r.gelöscht).toBe(false);
    expect(r.postings.map((p: any) => p.id_by_customer)).toEqual(["3001", "3002"]);
    expect(r.postings[0]).toMatchObject({ amount: "60.00", fixed: "0", aktion: "löschen" });
    expect(r.hinweis).toMatch(/notier/i);
    expect(writes()).toHaveLength(0);
  });

  it("omitted confirm behaves like false", async () => {
    const { cancelPosting, writes } = setup([postingsPage(P3001, P3002)]);
    const r = data(await cancelPosting.handler({ type: "transaction", id_by_customer: 2001, ...RANGE }));
    expect(r.mode).toBe("preview");
    expect(writes()).toHaveLength(0);
  });

  it("confirm:true cancels every posting of the transaction one by one, re-reads and reports gelöscht:true", async () => {
    const { call, cancelPosting } = setup([postingsPage(P3001, P3002), postingsPage()]);

    const r = data(await cancelPosting.handler({ type: "transaction", id_by_customer: 2001, ...RANGE, confirm: true }));

    expect(call.mock.calls.map(([k]) => k)).toEqual(["postingsGet", "postingsCancel", "postingsCancel", "postingsGet"]);
    expect(call).toHaveBeenCalledWith("postingsCancel", { posting_id_by_customer: 3001 });
    expect(call).toHaveBeenCalledWith("postingsCancel", { posting_id_by_customer: 3002 });
    expect(r.mode).toBe("executed");
    expect(r.gelöscht).toBe(true);
    expect(r.cancelled.map((p: any) => p.id_by_customer)).toEqual(["3001", "3002"]);
    expect(r.neu_angelegt).toBeUndefined();
  });

  it("free posting is matched by its own id and cancelled alone", async () => {
    const { call, cancelPosting } = setup([postingsPage(P3001, P3003), postingsPage(P3001)]);

    const r = data(await cancelPosting.handler({ type: "free", id_by_customer: 3003, ...RANGE, confirm: true }));

    expect(call).toHaveBeenCalledWith("postingsCancel", { posting_id_by_customer: 3003 });
    expect(call.mock.calls.filter(([k]) => k === "postingsCancel")).toHaveLength(1);
    expect(r.gelöscht).toBe(true);
    expect(r.cancelled[0]).toMatchObject({ debit_postingaccount_number: "4654", credit_postingaccount_number: "4650" });
  });

  it("receipt type matches receipt_id_by_customer", async () => {
    const { call, cancelPosting } = setup([postingsPage(P3001, P3003), postingsPage()]);
    const r = data(await cancelPosting.handler({ type: "receipt", id_by_customer: 1001, ...RANGE, confirm: true }));
    expect(call).toHaveBeenCalledWith("postingsCancel", { posting_id_by_customer: 3001 });
    expect(r.gelöscht).toBe(true);
  });

  it("preview marks a fixed posting as reversal and names the ids to pass", async () => {
    const { cancelPosting, writes } = setup([postingsPage(FIXED_3001, P3002)]);
    const r = data(await cancelPosting.handler({ type: "transaction", id_by_customer: 2001, ...RANGE, confirm: false }));
    expect(r.postings.map((p: any) => p.aktion)).toEqual(["stornieren (Gegenbuchung)", "löschen"]);
    expect(r.hinweis).toMatch(/reverse_posting_ids=\[3001\]/);
    expect(writes()).toHaveLength(0);
  });

  it("confirm:true refuses fixed postings that were not explicitly approved; no write", async () => {
    const { cancelPosting, writes } = setup([postingsPage(FIXED_3001, P3002)]);
    await expect(
      cancelPosting.handler({ type: "transaction", id_by_customer: 2001, ...RANGE, confirm: true })
    ).rejects.toThrow(/festgeschrieben.*reverse_posting_ids/s);
    expect(writes()).toHaveLength(0);
  });

  it("approved fixed posting is reversed and the new reversal posting is reported", async () => {
    const { call, cancelPosting } = setup([postingsPage(FIXED_3001), postingsPage(FIXED_3001, REVERSAL)]);
    const r = data(
      await cancelPosting.handler({
        type: "transaction",
        id_by_customer: 2001,
        ...RANGE,
        reverse_posting_ids: [3001],
        confirm: true,
      })
    );
    expect(call).toHaveBeenCalledWith("postingsCancel", { posting_id_by_customer: 3001 });
    expect(r.gelöscht).toBe(true);
    expect(r.neu_angelegt.map((p: any) => p.id_by_customer)).toEqual(["3101"]);
    expect(r.warnings).toBeUndefined();
  });

  it("warns when a reversal was expected but no new posting shows up in the range", async () => {
    const { cancelPosting } = setup([postingsPage(FIXED_3001), postingsPage(FIXED_3001)]);
    const r = data(
      await cancelPosting.handler({ type: "transaction", id_by_customer: 2001, ...RANGE, reverse_posting_ids: [3001], confirm: true })
    ).warnings;
    expect(r.join(" ")).toMatch(/keine neue Buchung/);
  });

  it("rejects reverse_posting_ids that are not fixed postings of the target (e.g. an existing reversal)", async () => {
    const { cancelPosting, writes } = setup([postingsPage(FIXED_3001, P3002)]);
    await expect(
      cancelPosting.handler({
        type: "transaction",
        id_by_customer: 2001,
        ...RANGE,
        reverse_posting_ids: [3001, 3002],
        confirm: true,
      })
    ).rejects.toThrow(/gehören nicht zu den festgeschriebenen/);
    expect(writes()).toHaveLength(0);
  });

  it("unknown id gives a plain 'nicht gefunden' error and no write", async () => {
    const { cancelPosting, writes } = setup([postingsPage(P3001, P3002, P3003)]);
    await expect(
      cancelPosting.handler({ type: "free", id_by_customer: 9999, ...RANGE, confirm: true })
    ).rejects.toThrow(/nicht gefunden/);
    expect(writes()).toHaveLength(0);
  });

  it("free type does not match a transaction/receipt posting that happens to share the id", async () => {
    const { cancelPosting } = setup([postingsPage(P3001)]);
    await expect(
      cancelPosting.handler({ type: "free", id_by_customer: 3001, ...RANGE, confirm: false })
    ).rejects.toThrow(/nicht gefunden/);
  });

  it("API success but posting still present -> gelöscht:false with warning", async () => {
    const { cancelPosting } = setup([postingsPage(P3001, P3002), postingsPage(P3001, P3002)]);
    const r = data(await cancelPosting.handler({ type: "transaction", id_by_customer: 2001, ...RANGE, confirm: true }));
    expect(r.gelöscht).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/noch vorhanden/);
  });

  it("an API error aborts, names what was done and what is still open", async () => {
    const { cancelPosting } = setup([postingsPage(P3001, P3002)], new Error("BHB error 8"));
    await expect(
      cancelPosting.handler({ type: "transaction", id_by_customer: 2001, ...RANGE, confirm: true })
    ).rejects.toThrow(/Buchung 3001 konnte nicht storniert werden: BHB error 8.*noch offen: 3002/s);
  });

  it("pages through postingsGet when a page is full (1000 rows)", async () => {
    const filler = Array.from({ length: 1000 }, (_, i) => ({ ...P3003, id_by_customer: String(5000 + i) }));
    const { call, cancelPosting } = setup([postingsPage(...filler), postingsPage(P3003)]);
    const r = data(await cancelPosting.handler({ type: "free", id_by_customer: 3003, ...RANGE, confirm: false }));
    expect(r.postings).toHaveLength(1);
    expect(call).toHaveBeenNthCalledWith(2, "postingsGet", expect.objectContaining({ offset: 1000, limit: 1000 }));
  });

  it("queries postings with posting_status all over the given range", async () => {
    const { call, cancelPosting } = setup([postingsPage(P3001)]);
    await cancelPosting.handler({ type: "transaction", id_by_customer: 2001, ...RANGE });
    expect(call).toHaveBeenCalledWith("postingsGet", {
      ...RANGE,
      posting_status: "all",
      limit: 1000,
      offset: 0,
    });
  });

  it("is annotated destructive and describes the guard rails", () => {
    expect(cancelPosting_().annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(cancelPosting_().description).toMatch(/nicht umkehrbar|irreversible/i);
    expect(cancelPosting_().description).toMatch(/confirm/);
    expect(cancelPosting_().description).toMatch(/reverse_posting_ids/);
  });
});

function cancelPosting_() {
  return createPostingsTools({ call: vi.fn() } as unknown as BBClient)[7];
}
