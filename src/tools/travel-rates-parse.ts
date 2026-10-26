// Parser for the BMF table of foreign per-diem rates (LStH Anhang 25 I, "Übersicht über die ab 1. Januar <year>
// geltenden Pauschbeträge ..."). Shared by scripts/generate-travel-rates.ts and the online lookup
// (travel-rates-online.ts). The HTML is treated strictly as data.

export interface ParsedRate {
  country: string;
  place: string | null;
  full: number;
  partial: number;
  night: number;
}

function decode(cell: string): string {
  return cell
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "’")
    .replace(/&ndash;/g, "–")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

// The table is anchored on its first country (alphabetical: "Ägypten"). A row with empty value cells opens a
// city block for the country; the block ends with its "im Übrigen" row. Header rows have fewer than four cells.
export function parseRatesHtml(html: string): ParsedRate[] {
  const anchor = html.indexOf("Ägypten");
  if (anchor < 0) throw new Error('Tabelle nicht gefunden: "Ägypten" fehlt im HTML.');
  const table = html.slice(html.lastIndexOf("<table", anchor), html.indexOf("</table>", anchor));
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => decode(cell[1]))
  );
  const entries: ParsedRate[] = [];
  let blockCountry: string | null = null;
  for (const cells of rows) {
    if (cells.length !== 4) continue;
    const [name, ...values] = cells;
    if (!name || name === "Land") continue;
    if (values.every((v) => v === "")) {
      blockCountry = name;
      continue;
    }
    if (!values.every((v) => /^\d+$/.test(v))) continue;
    const [full, partial, night] = values.map(Number);
    if (blockCountry) {
      entries.push({ country: blockCountry, place: name, full, partial, night });
      if (name === "im Übrigen") blockCountry = null;
    } else {
      entries.push({ country: name, place: null, full, partial, night });
    }
  }
  return entries;
}
