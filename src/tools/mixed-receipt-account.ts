import type { BBClient, BBListResult } from "../bb-client/client.js";

export interface Auslagenkonto {
  number: number;
  name: string;
}

const norm = (text: string) => text.toLowerCase().replace(/[,.;:]/g, " ").replace(/\s+/g, " ").trim();

export function nameWords(paidBy: string): string[] {
  return norm(paidBy).split(" ").filter(Boolean);
}

// Finds the personal Auslagenkonto of the paying person among the BuchhaltungsButler accounts: the name contains all words of the
// person's name (any order) and "Gesellschafter" or "Auslage". Exactly one match counts; none or several give found: null
// (several: candidates lists them for the note). Reads only; a failing accountsGet is thrown so the caller can add a warning.
export async function findAuslagenkonto(client: BBClient, paidBy: string): Promise<{ found: Auslagenkonto | null; candidates: string[] }> {
  const result = await client.call<BBListResult>("accountsGet", {});
  const words = nameWords(paidBy);
  if (words.length === 0) return { found: null, candidates: [] };
  const matches: Auslagenkonto[] = [];
  for (const row of result.data ?? []) {
    const name = String(row.name ?? "");
    const n = norm(name);
    const number = Number(row.postingaccount_number);
    if (!Number.isInteger(number)) continue;
    if (!words.every((w) => n.includes(w))) continue;
    if (!n.includes("gesellschafter") && !n.includes("auslage")) continue;
    matches.push({ number, name });
  }
  if (matches.length === 1) return { found: matches[0], candidates: [] };
  return { found: null, candidates: matches.length > 1 ? matches.map((m) => `${m.name} (${m.number})`) : [] };
}
