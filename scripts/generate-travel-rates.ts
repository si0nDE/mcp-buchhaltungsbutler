// Generates src/tools/travel-rates-<year>.ts from the BMF table of foreign per-diem rates
// (LStH Anhang 25 I, "Übersicht über die ab 1. Januar <year> geltenden Pauschbeträge ...").
// Usage: npx tsx scripts/generate-travel-rates.ts <year> <html-file> "<source label>" <retrieved YYYY-MM-DD>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

function main(): void {
  const [year, htmlFile, source, retrievedAt] = process.argv.slice(2);
  if (!year || !htmlFile || !source || !retrievedAt) {
    console.error('Usage: npx tsx scripts/generate-travel-rates.ts <year> <html-file> "<source>" <YYYY-MM-DD>');
    process.exit(1);
  }
  const entries = parseRatesHtml(readFileSync(htmlFile, "utf-8"));
  const body = entries.map((entry) => `    ${JSON.stringify(entry)},`).join("\n");
  const output =
    `// GENERIERT von scripts/generate-travel-rates.ts - nicht von Hand ändern.\n` +
    `// Quelle: ${source}, abgerufen am ${retrievedAt}.\n` +
    `import type { RateTable } from "./travel-rates.js";\n\n` +
    `export const RATES_${year}: RateTable = {\n` +
    `  year: ${year},\n` +
    `  source: ${JSON.stringify(source)},\n` +
    `  retrievedAt: ${JSON.stringify(retrievedAt)},\n` +
    `  entries: [\n${body}\n  ],\n};\n`;
  writeFileSync(new URL(`../src/tools/travel-rates-${year}.ts`, import.meta.url), output);
  console.log(`${new Set(entries.map((e) => e.country)).size} Länder, ${entries.length} Einträge geschrieben.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
