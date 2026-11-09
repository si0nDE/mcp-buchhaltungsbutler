import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests lesen nie die echte Policy-Datei des Entwicklers (~/.mcp-buchhaltungsbutler/policy.json): Tools wie create_invoice,
// add_*_postings und audit_vat_period laden sie mit dem Standardpfad. Eine nicht vorhandene Datei ergibt die Standard-Policy.
// Tests, die die Policy selbst prüfen, setzen BHB_POLICY_FILE auf ihre eigene Datei.
process.env.BHB_POLICY_FILE = join(tmpdir(), `mcp-bhb-test-policy-${process.pid}-does-not-exist.json`);
