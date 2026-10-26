// Generates src/tools/travel-rates-<year>.ts from the BMF table of foreign per-diem rates
// (LStH Anhang 25 I, "Übersicht über die ab 1. Januar <year> geltenden Pauschbeträge ...").
// Usage: npx tsx scripts/generate-travel-rates.ts <year> <html-file> "<source label>" <retrieved YYYY-MM-DD>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRatesHtml } from "../src/tools/travel-rates-parse.js";

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
