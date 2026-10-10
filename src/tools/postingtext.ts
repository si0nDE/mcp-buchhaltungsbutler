// BHB macht aus jedem unterschiedlichen Buchungstext einen dauerhaften Buchungsvorschlag (Beobachtung des Mandanten,
// in der Oberfläche nicht geprüft). Texte mit Rechnungsnummer, Datum oder Klammerzusatz blähen die Vorschläge auf.
// Das hier ist eine Warnung mit Vorschlag, kein Umschreiben: der Text wird nie stillschweigend geändert.

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "Datum", re: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})\b(?:\s+[-–—:]\s+)?/g },
  // Zahlungsstatus im Klammerzusatz ist legitim und kommt auch in Banktexten vor.
  { kind: "Klammerzusatz", re: /\s*\((?!\s*(?:Teil|An|Schluss|Rest)zahlung\s*\)|\s*(?:Abschlag|Storno|Gutschrift)\s*\))[^)]*\)/g },
  // RE-0001, AB-2026-123, RE/2026/17, RG2026123; "Q3" und "M365" bleiben unbeanstandet.
  { kind: "Rechnungs-/Belegnummer", re: /\b[A-Z]{1,5}(?:[-/]\d{2,}|\d{4,})(?:[-/]\d+)*\b(?:\s+[-–—:]\s+)?/g },
  // 2026-12345, 4711/2026
  { kind: "Rechnungs-/Belegnummer", re: /\b\d{2,}[-/]\d{2,}(?:[-/]\d+)*\b(?:\s+[-–—:]\s+)?/g },
];

// Monat/Jahr (07/2026, 2026/07) ist ein Zeitraum, keine Nummer: vor dem Prüfen maskieren, danach zurücksetzen.
const PERIOD = /\b(?:0?[1-9]|1[0-2])([/-])(?:19|20)\d{2}\b|\b(?:19|20)\d{2}([/-])(?:0?[1-9]|1[0-2])\b(?![-/]\d)/g;
const mask = (t: string) => t.replace(PERIOD, (m) => m.replace(/\//g, "\u0001").replace(/-/g, "\u0002"));
const unmask = (t: string) => t.replace(/\u0001/g, "/").replace(/\u0002/g, "-");

export interface PostingtextIssue {
  text: string;
  kinds: string[];
  found: string[];
  suggestion: string;
}

export function checkPostingtext(text: string): PostingtextIssue | undefined {
  let rest = mask(text);
  const kinds: string[] = [];
  const found: string[] = [];
  for (const { kind, re } of PATTERNS) {
    for (const m of rest.matchAll(re)) {
      if (!kinds.includes(kind)) kinds.push(kind);
      found.push(unmask(m[0]).trim());
    }
    rest = rest.replace(re, " ");
  }
  if (found.length === 0) return undefined;
  const suggestion = unmask(rest).replace(/\s+/g, " ").replace(/^[\s\-–—:,;]+|[\s\-–—:,;]+$/g, "").trim();
  return { text, kinds, found, suggestion };
}

const MAX_LISTED = 5;

export function postingtextWarnings(texts: Array<string | undefined>): string[] {
  const issues = new Map<string, PostingtextIssue>();
  for (const t of texts) {
    if (!t || issues.has(t)) continue;
    const issue = checkPostingtext(t);
    if (issue) issues.set(t, issue);
  }
  if (issues.size === 0) return [];
  const list = [...issues.values()].slice(0, MAX_LISTED).map(
    (i) => `"${i.text}" enthält ${i.kinds.join(", ")} (${i.found.map((f) => `"${f}"`).join(", ")}); Vorschlag: "${i.suggestion}"`
  );
  const more = issues.size > MAX_LISTED ? ` (und ${issues.size - MAX_LISTED} weitere)` : "";
  return [
    `Buchungstext: ${list.join(" | ")}${more}. BHB macht aus jedem unterschiedlichen Text einen dauerhaften Buchungsvorschlag ` +
      "(Beobachtung, nicht geprüft). Konstanten Text je Fallart verwenden; die Nummer steckt im angehängten Beleg " +
      "(get_booking_guide buchungstexte). Bei Transaktionsbuchungen hängt BHB den Gegenpartner selbst an, bei freien Buchungen nicht. " +
      "Der Text wurde nicht geändert.",
  ];
}
