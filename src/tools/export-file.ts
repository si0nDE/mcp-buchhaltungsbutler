import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ok, type CallToolResult } from "./types.js";

// Auswertungen für Artefakte und Berichte sind groß (hunderte Buchungszeilen). Mit save_as schreibt ein Tool das volle Ergebnis
// als JSON-Datei und liefert nur eine Kurzfassung zurück: so landet nichts Großes im Gespräch und das Modell kann die Datei
// direkt weiterverarbeiten. Geschrieben wird nur unter BHB_EXPORT_DIR (Standard ~/.mcp-buchhaltungsbutler/exports), und der
// Name wird auf einen reinen Dateinamen begrenzt: kein Pfad, keine Verzeichnisse.

export function exportDir(): string {
  return process.env.BHB_EXPORT_DIR?.trim() || join(homedir(), ".mcp-buchhaltungsbutler", "exports");
}

export function exportFileName(saveAs: string): string {
  const base = basename(saveAs).replace(/\.json$/i, "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (!base) throw new Error(`save_as "${saveAs}" ergibt keinen gültigen Dateinamen (erlaubt: Buchstaben, Ziffern, . _ -).`);
  return `${base}.json`;
}

export function writeExport(saveAs: string, data: unknown): { datei: string; bytes: number } {
  const dir = exportDir();
  mkdirSync(dir, { recursive: true });
  const datei = join(dir, exportFileName(saveAs));
  const text = JSON.stringify(data, null, 1);
  writeFileSync(datei, text, "utf8");
  return { datei, bytes: Buffer.byteLength(text) };
}

const LONG = 25;

// Lange Listen (an beliebiger Stelle) durch ihre Anzahl ersetzen; die Daten stehen vollständig in der Datei.
export function compactArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length > LONG ? { anzahl: value.length, in_datei: true } : value.map(compactArrays);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, compactArrays(v)]));
  }
  return value;
}

export function finishWithExport(saveAs: string | undefined, data: Record<string, unknown>): CallToolResult {
  if (saveAs === undefined || saveAs === "") return ok(data);
  const saved = writeExport(saveAs, data);
  return ok({ gespeichert: saved, ...(compactArrays(data) as Record<string, unknown>) });
}
