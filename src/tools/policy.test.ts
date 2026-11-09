import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPolicyTools, loadPolicy } from "./policy.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bhb-policy-"));
  process.env.BHB_POLICY_FILE = join(dir, "sub", "policy.json");
});
afterEach(() => {
  delete process.env.BHB_POLICY_FILE;
});

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("policy tools", () => {
  it("defaults to ask when no file exists and get_policy is read-only", async () => {
    const [get] = createPolicyTools();
    expect(get.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    const res = parse(await get.handler({} as never));
    expect(res.vat_policy.foreign_supplier_domestic_vat_no_rc_hint).toBe("ask");
    expect(res.history).toEqual([]);
  });

  it("set_policy refuses without confirm: true and writes nothing", async () => {
    const [, set] = createPolicyTools();
    await expect(set.handler({ foreign_supplier_domestic_vat_no_rc_hint: "as_invoiced", reason: "GF-Entscheidung", confirm: false } as never)).rejects.toThrow(/confirm: true/);
    await expect(readFile(process.env.BHB_POLICY_FILE!, "utf8")).rejects.toThrow();
  });

  it("set_policy persists the rule and appends to the history", async () => {
    const [get, set] = createPolicyTools();
    await set.handler({ foreign_supplier_domestic_vat_no_rc_hint: "as_invoiced", reason: "GF 11.10.: wie ausgewiesen", confirm: true } as never);
    await set.handler({ foreign_supplier_domestic_vat_no_rc_hint: "ask", reason: "GF: wieder offen", confirm: true } as never);
    const p = await loadPolicy();
    expect(p.vat_policy.foreign_supplier_domestic_vat_no_rc_hint).toBe("ask");
    expect(p.history.map((h) => h.change)).toEqual([
      { foreign_supplier_domestic_vat_no_rc_hint: { from: "ask", to: "as_invoiced" } },
      { foreign_supplier_domestic_vat_no_rc_hint: { from: "as_invoiced", to: "ask" } },
    ]);
    expect(parse(await get.handler({} as never)).history).toHaveLength(2);
  });

  it("a broken policy file is an error and is not overwritten", async () => {
    await writeFile(join(dir, "policy.json"), "{kaputt");
    process.env.BHB_POLICY_FILE = join(dir, "policy.json");
    await expect(loadPolicy()).rejects.toThrow(/kein gültiges JSON/);
    const [, set] = createPolicyTools();
    await expect(set.handler({ foreign_supplier_domestic_vat_no_rc_hint: "as_invoiced", reason: "GF-Entscheidung", confirm: true } as never)).rejects.toThrow();
    expect(await readFile(join(dir, "policy.json"), "utf8")).toBe("{kaputt");
  });

  it("kleinunternehmer: default null, set_policy setzt ihn einzeln, ohne die Regel für ausländische Anbieter zu ändern", async () => {
    const [get, set] = createPolicyTools();
    expect(parse(await get.handler({} as never)).tax_profile).toEqual({ kleinunternehmer: null });
    await set.handler({ foreign_supplier_domestic_vat_no_rc_hint: "as_invoiced", reason: "GF 11.10.: wie ausgewiesen", confirm: true } as never);
    await set.handler({ kleinunternehmer: true, reason: "GF 09.11.: Kleinunternehmer nach § 19 UStG, Vorjahr 18.000 €", confirm: true } as never);
    const p = await loadPolicy();
    expect(p.tax_profile.kleinunternehmer).toBe(true);
    expect(p.vat_policy.foreign_supplier_domestic_vat_no_rc_hint).toBe("as_invoiced");
    expect(p.history.at(-1)!.change).toEqual({ kleinunternehmer: { from: null, to: true } });
    const res = parse(await get.handler({} as never));
    expect(res.tax_profile_meaning).toMatch(/§ 19 UStG/);
  });

  it("set_policy ohne zu ändernden Wert ist ein Fehler", async () => {
    const [, set] = createPolicyTools();
    await expect(set.handler({ reason: "GF-Entscheidung", confirm: true } as never)).rejects.toThrow(/mindestens/);
  });

  it("alte Policy-Dateien ohne tax_profile laden mit kleinunternehmer null; ein falscher Typ ist ein Fehler", async () => {
    await writeFile(join(dir, "alt.json"), JSON.stringify({ vat_policy: { foreign_supplier_domestic_vat_no_rc_hint: "ask" }, history: [] }));
    expect((await loadPolicy(join(dir, "alt.json"))).tax_profile).toEqual({ kleinunternehmer: null });
    await writeFile(join(dir, "falsch.json"), JSON.stringify({ tax_profile: { kleinunternehmer: "ja" } }));
    await expect(loadPolicy(join(dir, "falsch.json"))).rejects.toThrow(/kleinunternehmer/);
  });

  it("rejects an unknown rule value in the file", async () => {
    await writeFile(join(dir, "p.json"), JSON.stringify({ vat_policy: { foreign_supplier_domestic_vat_no_rc_hint: "egal" } }));
    await expect(loadPolicy(join(dir, "p.json"))).rejects.toThrow(/unbekannter Wert/);
  });
});
