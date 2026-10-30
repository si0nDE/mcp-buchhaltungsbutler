import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactArrays, exportFileName, finishWithExport } from "./export-file.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bhb-export-"));
  process.env.BHB_EXPORT_DIR = dir;
});
afterEach(() => {
  delete process.env.BHB_EXPORT_DIR;
});

describe("exportFileName", () => {
  it("lässt nur einen reinen Dateinamen zu: kein Pfad, keine Verzeichnisse, immer .json", () => {
    expect(exportFileName("controlling-q2")).toBe("controlling-q2.json");
    expect(exportFileName("controlling-q2.json")).toBe("controlling-q2.json");
    expect(exportFileName("../../etc/passwd")).toBe("passwd.json");
    expect(exportFileName("/tmp/x/y.json")).toBe("y.json");
    expect(exportFileName("a b$c")).toBe("a_b_c.json");
    expect(() => exportFileName("..")).toThrow(/gültigen Dateinamen/);
    expect(() => exportFileName("")).toThrow(/gültigen Dateinamen/);
  });
});

describe("compactArrays", () => {
  it("ersetzt lange Listen an beliebiger Stelle durch ihre Anzahl, kurze bleiben", () => {
    const long = Array.from({ length: 26 }, (_, i) => i);
    expect(compactArrays({ a: long, b: { c: long }, d: [1, 2], e: "x" })).toEqual({
      a: { anzahl: 26, in_datei: true },
      b: { c: { anzahl: 26, in_datei: true } },
      d: [1, 2],
      e: "x",
    });
  });
});

describe("finishWithExport", () => {
  const data = { kpi: 1, buchungen: Array.from({ length: 30 }, (_, i) => ({ id: i })) };

  it("ohne save_as kommt das volle Ergebnis zurück und es wird nichts geschrieben", () => {
    const r = finishWithExport(undefined, data);
    expect(JSON.parse(r.content[0].text).buchungen).toHaveLength(30);
  });

  it("mit save_as steht das volle Ergebnis in der Datei und die Antwort ist die Kurzfassung mit Pfad", () => {
    const r = finishWithExport("test-lauf", data);
    const out = JSON.parse(r.content[0].text);
    expect(out.gespeichert.datei).toBe(join(dir, "test-lauf.json"));
    expect(out.kpi).toBe(1);
    expect(out.buchungen).toEqual({ anzahl: 30, in_datei: true });
    expect(existsSync(out.gespeichert.datei)).toBe(true);
    expect(JSON.parse(readFileSync(out.gespeichert.datei, "utf8")).buchungen).toHaveLength(30);
  });

  it("ein Pfad in save_as landet trotzdem nur im Export-Verzeichnis", () => {
    const r = finishWithExport("../../ausserhalb", data);
    expect(JSON.parse(r.content[0].text).gespeichert.datei).toBe(join(dir, "ausserhalb.json"));
  });
});
