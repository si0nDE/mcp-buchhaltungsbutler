import type { BBClient } from "../bb-client/client.js";

const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

export interface PostingStatus {
  booked: boolean;
  posting_ids: string[];
  splits: number;
  fixed: boolean;
}

type Row = Record<string, unknown>;

const day = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : undefined);

// The API has no booking flag on transactions. Postings carry transaction_id_by_customer and the date of
// the transaction (checked live), so the status comes from one sweep of postingsGet over the rows' date span.
export async function attachPostingStatus(
  client: BBClient,
  rows: Row[]
): Promise<{ rows: Row[]; truncated: boolean; scanned: number }> {
  const days = rows.map((r) => day(r.booking_date)).filter((d): d is string => !!d).sort();
  if (days.length === 0) return { rows, truncated: false, scanned: 0 };
  const range = { date_from: days[0], date_to: days[days.length - 1] };
  const byTx = new Map<string, Row[]>();
  let scanned = 0;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.call<{ data?: Row[] }>("postingsGet", {
      ...range,
      posting_status: "all",
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });
    const batch = res.data ?? [];
    scanned += batch.length;
    for (const p of batch) {
      const tx = p.transaction_id_by_customer;
      if (tx === null || tx === undefined || tx === "") continue;
      const key = String(tx);
      byTx.set(key, [...(byTx.get(key) ?? []), p]);
    }
    if (batch.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return {
    rows: rows.map((r) => {
      const ps = byTx.get(String(r.id_by_customer)) ?? [];
      const posting_status: PostingStatus = {
        booked: ps.length > 0,
        posting_ids: ps.map((p) => String(p.id_by_customer)),
        splits: ps.length,
        fixed: ps.length > 0 && ps.every((p) => String(p.fixed) === "1"),
      };
      return { ...r, posting_status };
    }),
    truncated,
    scanned,
  };
}

export function postingStatusNote(scanned: number, truncated: boolean): string {
  return (
    `posting_status: ${scanned} postings scanned over the transactions' date span` +
    (truncated ? `; sweep stopped after ${MAX_PAGES} pages, "booked": false may be wrong - narrow the date window.` : ".")
  );
}
