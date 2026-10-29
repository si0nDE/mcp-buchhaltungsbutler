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
  // Tags until nothing changes: a single pass leaves "<script>" behind in "<scr<b>ipt>".
  // [^<>] keeps the scan linear on hostile input (with [^>] every "<" would rescan to the end).
  let text = cell.replace(/<br\s*\/?>/gi, " ");
  for (let prev = ""; prev !== text; ) {
    prev = text;
    text = text.replace(/<[^<>]+>/g, "");
  }
  return (
    text
      .replace(/&nbsp;/g, " ")
      .replace(/&rsquo;/g, "’")
      .replace(/&ndash;/g, "–")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      // Last, so that "&amp;#65;" stays the literal text "&#65;" instead of being decoded twice.
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// Contents of <tag ...>...</tag> in order, with indexOf instead of lazy regexes: linear even when closing tags or the
// ">" of an opening tag are missing (a lazy [\s\S]*? pattern retries from every "<tag" and becomes quadratic).
function elements(html: string, tag: string): string[] {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const contents: string[] = [];
  let pos = 0;
  for (;;) {
    const start = html.indexOf(open, pos);
    if (start < 0) break;
    const gt = html.indexOf(">", start + open.length);
    if (gt < 0) break;
    const end = html.indexOf(close, gt + 1);
    if (end < 0) break;
    contents.push(html.slice(gt + 1, end));
    pos = end + close.length;
  }
  return contents;
}

// The table is anchored on its first country (alphabetical: "Ägypten"). A row with empty value cells opens a
// city block for the country; the block ends with its "im Übrigen" row. Header rows have fewer than four cells.
export function parseRatesHtml(html: string): ParsedRate[] {
  const anchor = html.indexOf("Ägypten");
  if (anchor < 0) throw new Error('Tabelle nicht gefunden: "Ägypten" fehlt im HTML.');
  const table = html.slice(html.lastIndexOf("<table", anchor), html.indexOf("</table>", anchor));
  const rows = elements(table, "tr").map((row) => elements(row, "td").map(decode));
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
