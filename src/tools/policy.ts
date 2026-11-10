import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// Hausregeln der Geschäftsführung für Rechtsfragen ohne eindeutige Antwort. Sie werden einmal festgelegt und vom Audit respektiert,
// statt in jeder Prüfung neu diskutiert zu werden. Bewusst nicht in den allgemeinen Server-Instruktionen: die Regel gilt je Mandant.
// Gespeichert als JSON-Datei (BHB_POLICY_FILE, Standard ~/.mcp-buchhaltungsbutler/policy.json); im Container ein Volume einhängen,
// sonst ist sie nach einem Neustart weg.

export const FOREIGN_SUPPLIER_RULES = ["ask", "as_invoiced", "reverse_charge_strict"] as const;
export type ForeignSupplierRule = (typeof FOREIGN_SUPPLIER_RULES)[number];

export const GEWINNERMITTLUNG_VALUES = ["euer", "bilanz"] as const;
export type Gewinnermittlung = (typeof GEWINNERMITTLUNG_VALUES)[number];

export interface Policy {
  vat_policy: { foreign_supplier_domestic_vat_no_rc_hint: ForeignSupplierRule };
  // Kleinunternehmer nach § 19 UStG: true, false oder null (nicht festgelegt). Die BHB-API liefert den Status nicht.
  // Gewinnermittlung: "euer" (Einnahmenüberschussrechnung), "bilanz" oder null (nicht festgelegt). Wird nie aus Buchungen abgeleitet.
  tax_profile: { kleinunternehmer: boolean | null; gewinnermittlung: Gewinnermittlung | null };
  history: Array<{ at: string; change: Record<string, unknown>; reason: string }>;
}

export const DEFAULT_POLICY: Policy = {
  vat_policy: { foreign_supplier_domestic_vat_no_rc_hint: "ask" },
  tax_profile: { kleinunternehmer: null, gewinnermittlung: null },
  history: [],
};

export const policyFilePath = () => process.env.BHB_POLICY_FILE?.trim() || join(homedir(), ".mcp-buchhaltungsbutler", "policy.json");

export async function loadPolicy(path = policyFilePath()): Promise<Policy> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_POLICY);
    throw new Error(`Policy-Datei ${path} nicht lesbar: ${(e as Error).message}`);
  }
  let parsed: Partial<Policy>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Policy-Datei ${path} ist kein gültiges JSON. Nicht überschrieben; Datei prüfen oder löschen.`);
  }
  const rule = parsed.vat_policy?.foreign_supplier_domestic_vat_no_rc_hint;
  if (rule !== undefined && !FOREIGN_SUPPLIER_RULES.includes(rule)) {
    throw new Error(`Policy-Datei ${path}: unbekannter Wert "${String(rule)}" (erlaubt: ${FOREIGN_SUPPLIER_RULES.join(", ")}).`);
  }
  const ku = parsed.tax_profile?.kleinunternehmer;
  if (ku !== undefined && ku !== null && typeof ku !== "boolean") {
    throw new Error(`Policy-Datei ${path}: tax_profile.kleinunternehmer muss true, false oder null sein, ist "${String(ku)}".`);
  }
  const gw = parsed.tax_profile?.gewinnermittlung;
  if (gw !== undefined && gw !== null && !GEWINNERMITTLUNG_VALUES.includes(gw)) {
    throw new Error(`Policy-Datei ${path}: tax_profile.gewinnermittlung muss "euer", "bilanz" oder null sein, ist "${String(gw)}".`);
  }
  return {
    vat_policy: { foreign_supplier_domestic_vat_no_rc_hint: rule ?? "ask" },
    tax_profile: { kleinunternehmer: ku ?? null, gewinnermittlung: gw ?? null },
    history: Array.isArray(parsed.history) ? parsed.history : [],
  };
}

const kuText = (ku: boolean | null) =>
  ku === true
    ? "Kleinunternehmer nach § 19 UStG: create_invoice lehnt Steuerausweis ab (§ 14c UStG) und prüft den Hinweis auf die Steuerbefreiung, Buchungen mit Vorsteuer oder Umsatzsteuer werden gemeldet (get_booking_guide kleinunternehmer)."
    : ku === false
      ? "Regelbesteuerung (kein Kleinunternehmer)."
      : "Nicht festgelegt: keine Kleinunternehmer-Prüfung. Den Nutzer fragen, wenn es darauf ankommt.";

const gwText = (gw: Gewinnermittlung | null) =>
  gw === "euer"
    ? "EÜR: gebucht werden Zahlungen (add_transaction_postings); ohne angelegte Zahlung gibt es nichts zu buchen. Der Buchungsvorschlag für gemischte Belege richtet sich danach."
    : gw === "bilanz"
      ? "Bilanz: Belege werden gebucht (add_receipt_postings auf Kreditor/Debitor), die Zahlung danach. Der Buchungsvorschlag für gemischte Belege richtet sich danach."
      : "Nicht festgelegt: der Buchungsvorschlag für gemischte Belege zeigt beide Wege. Den Nutzer oder Steuerberater fragen, wenn es darauf ankommt.";

const RULE_TEXT: Record<ForeignSupplierRule, string> = {
  ask: "Jeder Fall wird als Entscheidung gemeldet.",
  as_invoiced: "Ausländischer Anbieter, deutsche USt ausgewiesen, kein Reverse-Charge-Hinweis: wie ausgewiesen buchen (Vorsteuer), kein § 13b.",
  reverse_charge_strict:
    "Ausländischer Anbieter, deutsche USt ausgewiesen, kein Hinweis: § 13b kraft Gesetzes anwenden, die ausgewiesene Steuer ist nicht als Vorsteuer abziehbar.",
};

export function createPolicyTools(): [ToolDef, ToolDef] {
  const getPolicy = defineTool({
    name: "get_policy",
    description:
      "Read the house rules (Hausregeln) of this client for legal questions without a clear answer, e.g. foreign suppliers that show German VAT without a " +
      "reverse-charge note (audit_vat_period respects it; default 'ask' = report every case as a decision), and the tax profile: kleinunternehmer " +
      "(§ 19 UStG; true, false or null = not set; the BHB API does not expose it) and gewinnermittlung ('euer', 'bilanz' or null = not set; steers the booking " +
      "proposal after a mixed receipt). Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {},
    async handler() {
      const policy = await loadPolicy();
      return ok({
        file: policyFilePath(),
        vat_policy: policy.vat_policy,
        meaning: RULE_TEXT[policy.vat_policy.foreign_supplier_domestic_vat_no_rc_hint],
        tax_profile: policy.tax_profile,
        tax_profile_meaning: kuText(policy.tax_profile.kleinunternehmer),
        gewinnermittlung_meaning: gwText(policy.tax_profile.gewinnermittlung),
        allowed_values: {
          foreign_supplier_domestic_vat_no_rc_hint: FOREIGN_SUPPLIER_RULES,
          kleinunternehmer: [true, false, null],
          gewinnermittlung: [...GEWINNERMITTLUNG_VALUES, null],
        },
        history: policy.history.slice(-10),
      });
    },
  });

  const setPolicy = defineTool({
    name: "set_policy",
    description:
      "Change a house rule. Only after the user decided it explicitly, never on your own judgment: confirm must be true, reason says who decided what " +
      "(it goes into the change history). Give at least one of: foreign_supplier_domestic_vat_no_rc_hint: 'ask' (default), 'as_invoiced' (book as invoiced, " +
      "Vorsteuer, no § 13b) or 'reverse_charge_strict' (§ 13b by law, invoiced VAT not deductible); kleinunternehmer: true (§ 19 UStG applies), false " +
      "(Regelbesteuerung) or null (unknown). Set kleinunternehmer only from the user's or Steuerberater's statement, never from the bookings; when the limit " +
      "is exceeded mid-year or the user waived § 19 (Verzicht), set it to false. gewinnermittlung: 'euer', 'bilanz' or null; set it only from the user's or " +
      "Steuerberater's statement (GmbH/UG bilanzieren, a Einzelunternehmen often uses EÜR), never infer it from the bookings. Writes the policy file (BHB_POLICY_FILE); the file must persist (volume in a container).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      foreign_supplier_domestic_vat_no_rc_hint: z.enum(FOREIGN_SUPPLIER_RULES).optional(),
      kleinunternehmer: z.boolean().nullable().optional().describe("§ 19 UStG: true = Kleinunternehmer, false = Regelbesteuerung, null = nicht festgelegt."),
      gewinnermittlung: z.enum(GEWINNERMITTLUNG_VALUES).nullable().optional().describe("'euer' = Einnahmenüberschussrechnung, 'bilanz' = Bilanzierung, null = nicht festgelegt."),
      reason: z.string().min(5).describe("Who decided what and why, e.g. 'GF 11.10.2026: wie ausgewiesen buchen, Differenz ca. 12 € je Quartal'."),
      confirm: z.boolean().describe("Must be true: the user confirmed the change."),
    },
    async handler(args) {
      if (args.confirm !== true) throw new Error("set_policy ändert eine Hausregel nur mit confirm: true nach ausdrücklicher Entscheidung des Nutzers.");
      if (args.foreign_supplier_domestic_vat_no_rc_hint === undefined && args.kleinunternehmer === undefined && args.gewinnermittlung === undefined) {
        throw new Error("set_policy braucht mindestens einen Wert: foreign_supplier_domestic_vat_no_rc_hint, kleinunternehmer oder gewinnermittlung.");
      }
      const path = policyFilePath();
      const before = await loadPolicy(path);
      const change: Record<string, unknown> = {};
      const rule = args.foreign_supplier_domestic_vat_no_rc_hint ?? before.vat_policy.foreign_supplier_domestic_vat_no_rc_hint;
      if (args.foreign_supplier_domestic_vat_no_rc_hint !== undefined) {
        change.foreign_supplier_domestic_vat_no_rc_hint = { from: before.vat_policy.foreign_supplier_domestic_vat_no_rc_hint, to: rule };
      }
      const ku = args.kleinunternehmer === undefined ? before.tax_profile.kleinunternehmer : args.kleinunternehmer;
      if (args.kleinunternehmer !== undefined) change.kleinunternehmer = { from: before.tax_profile.kleinunternehmer, to: ku };
      const gw = args.gewinnermittlung === undefined ? before.tax_profile.gewinnermittlung : args.gewinnermittlung;
      if (args.gewinnermittlung !== undefined) change.gewinnermittlung = { from: before.tax_profile.gewinnermittlung, to: gw };
      const next: Policy = {
        vat_policy: { foreign_supplier_domestic_vat_no_rc_hint: rule },
        tax_profile: { kleinunternehmer: ku, gewinnermittlung: gw },
        history: [...before.history, { at: new Date().toISOString(), change, reason: args.reason }],
      };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
      return ok({
        file: path,
        vat_policy: next.vat_policy,
        tax_profile: next.tax_profile,
        previous: before.vat_policy.foreign_supplier_domestic_vat_no_rc_hint,
        change,
        meaning: RULE_TEXT[rule],
        tax_profile_meaning: kuText(ku),
        gewinnermittlung_meaning: gwText(gw),
      });
    },
  });

  return [getPolicy, setPolicy];
}
