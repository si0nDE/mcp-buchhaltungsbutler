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

export interface Policy {
  vat_policy: { foreign_supplier_domestic_vat_no_rc_hint: ForeignSupplierRule };
  history: Array<{ at: string; change: Record<string, unknown>; reason: string }>;
}

export const DEFAULT_POLICY: Policy = {
  vat_policy: { foreign_supplier_domestic_vat_no_rc_hint: "ask" },
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
  return {
    vat_policy: { foreign_supplier_domestic_vat_no_rc_hint: rule ?? "ask" },
    history: Array.isArray(parsed.history) ? parsed.history : [],
  };
}

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
      "reverse-charge note. audit_vat_period respects them. Default 'ask' = report every case as a decision. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {},
    async handler() {
      const policy = await loadPolicy();
      return ok({
        file: policyFilePath(),
        vat_policy: policy.vat_policy,
        meaning: RULE_TEXT[policy.vat_policy.foreign_supplier_domestic_vat_no_rc_hint],
        allowed_values: { foreign_supplier_domestic_vat_no_rc_hint: FOREIGN_SUPPLIER_RULES },
        history: policy.history.slice(-10),
      });
    },
  });

  const setPolicy = defineTool({
    name: "set_policy",
    description:
      "Change a house rule. Only after the user decided it explicitly, never on your own judgment: confirm must be true, reason says who decided what " +
      "(it goes into the change history). foreign_supplier_domestic_vat_no_rc_hint: 'ask' (default), 'as_invoiced' (book as invoiced, Vorsteuer, no § 13b) or " +
      "'reverse_charge_strict' (§ 13b by law, invoiced VAT not deductible). Writes the policy file (BHB_POLICY_FILE); the file must persist (volume in a container).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      foreign_supplier_domestic_vat_no_rc_hint: z.enum(FOREIGN_SUPPLIER_RULES),
      reason: z.string().min(5).describe("Who decided what and why, e.g. 'GF 11.10.2026: wie ausgewiesen buchen, Differenz ca. 12 € je Quartal'."),
      confirm: z.boolean().describe("Must be true: the user confirmed the change."),
    },
    async handler(args) {
      if (args.confirm !== true) throw new Error("set_policy ändert eine Hausregel nur mit confirm: true nach ausdrücklicher Entscheidung des Nutzers.");
      const path = policyFilePath();
      const before = await loadPolicy(path);
      const previous = before.vat_policy.foreign_supplier_domestic_vat_no_rc_hint;
      const next: Policy = {
        vat_policy: { foreign_supplier_domestic_vat_no_rc_hint: args.foreign_supplier_domestic_vat_no_rc_hint },
        history: [
          ...before.history,
          {
            at: new Date().toISOString(),
            change: { foreign_supplier_domestic_vat_no_rc_hint: { from: previous, to: args.foreign_supplier_domestic_vat_no_rc_hint } },
            reason: args.reason,
          },
        ],
      };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
      return ok({ file: path, vat_policy: next.vat_policy, previous, meaning: RULE_TEXT[args.foreign_supplier_domestic_vat_no_rc_hint] });
    },
  });

  return [getPolicy, setPolicy];
}
