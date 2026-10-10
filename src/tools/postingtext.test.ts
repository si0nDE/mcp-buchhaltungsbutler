import { describe, expect, it } from "vitest";
import { checkPostingtext, postingtextWarnings } from "./postingtext.js";

describe("checkPostingtext", () => {
  it("accepts constant texts", () => {
    for (const t of [
      "Kaufpartner Forderungskaufpreis Art. 82 DSGVO",
      "Kanzlei Muster Anwaltskosten Prozessfinanzierung",
      "Microsoft 365 Business Standard",
      "ISO 27001 Beratung Q3",
      "Vorsteuer § 13b",
      "USt auf Kontoführung 07/2026",
      "Kontoführung 2026/07",
      "CyberRisikoCheck (Teilzahlung)",
    ]) {
      expect(checkPostingtext(t), t).toBeUndefined();
    }
  });

  it("flags invoice numbers, dates and bracket additions and suggests a clean text", () => {
    const r = checkPostingtext("Kaufpartner 2026-12345 Forderungskaufpreis Art. 82 DSGVO (privat)")!;
    expect(r.kinds).toEqual(["Klammerzusatz", "Rechnungs-/Belegnummer"]);
    expect(r.suggestion).toBe("Kaufpartner Forderungskaufpreis Art. 82 DSGVO");
    expect(checkPostingtext("Plattform RE-0100 - Gutschrift")!.suggestion).toBe("Plattform Gutschrift");
    expect(checkPostingtext("Miete 01.10.2026")!.kinds).toEqual(["Datum"]);
    expect(checkPostingtext("Miete 2026-10-01")!.suggestion).toBe("Miete");
    expect(checkPostingtext("AB-2026-123 Beratung")!.suggestion).toBe("Beratung");
    expect(checkPostingtext("Lieferung RG2026123")!.suggestion).toBe("Lieferung");
  });
});

describe("Banktexte und Altbestand", () => {
  it("flags only the number in 'RE000001 CyberRisikoCheck (Teilzahlung)', not the Zahlungsstatus", () => {
    const r = checkPostingtext("RE000001 CyberRisikoCheck (Teilzahlung)")!;
    expect(r.kinds).toEqual(["Rechnungs-/Belegnummer"]);
    expect(r.suggestion).toBe("CyberRisikoCheck (Teilzahlung)");
  });
});

describe("postingtextWarnings", () => {
  it("returns nothing for clean or empty texts", () => {
    expect(postingtextWarnings(["Beratung", undefined, ""])).toEqual([]);
  });

  it("deduplicates, lists the suggestion and states the text was not changed", () => {
    const w = postingtextWarnings(["Beispiel RE-0001", "Beispiel RE-0001", "Beratung"]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('Vorschlag: "Beispiel"');
    expect(w[0]).toContain("nicht geändert");
    expect(w[0].match(/Vorschlag/g)).toHaveLength(1);
  });

  it("caps the list", () => {
    const w = postingtextWarnings(Array.from({ length: 8 }, (_, i) => `Text RE-000${i}`));
    expect(w[0]).toContain("und 3 weitere");
  });
});
