import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, readOnlyFromEnv } from "./server.js";
import type { BBClient } from "./bb-client/client.js";
import { inkLines, makeFakeScanPdf } from "./tools/mixed-receipt-scan.fixture.js";

async function connectedClient(client: BBClient) {
  const server = createServer(client);
  const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return mcpClient;
}

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

const savedPolicyFile = process.env.BHB_POLICY_FILE;
afterEach(() => {
  if (savedPolicyFile === undefined) delete process.env.BHB_POLICY_FILE;
  else process.env.BHB_POLICY_FILE = savedPolicyFile;
});

describe("createServer", () => {
  it("registers exactly 61 tools", () => {
    const server = createServer(mockClient({}));
    const registeredTools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registeredTools)).toHaveLength(61);
  });

  it("registers only tools marked readOnlyHint in read-only mode", () => {
    const server = createServer(mockClient({}), { readOnly: true });
    const registeredTools = (
      server as unknown as { _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean } }> }
    )._registeredTools;
    const names = Object.keys(registeredTools);

    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThan(61);
    expect(Object.values(registeredTools).every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    for (const writer of ["add_receipt_postings", "create_invoice", "delete_transaction", "set_policy", "upload_receipt"]) {
      expect(names).not.toContain(writer);
    }
  });

  it("reads BHB_READ_ONLY", () => {
    expect(readOnlyFromEnv({})).toBe(false);
    expect(readOnlyFromEnv({ BHB_READ_ONLY: "0" })).toBe(false);
    expect(readOnlyFromEnv({ BHB_READ_ONLY: "1" })).toBe(true);
    expect(readOnlyFromEnv({ BHB_READ_ONLY: " TRUE " })).toBe(true);
  });

  it("wires list_accounts through to the given client", async () => {
    const client = mockClient({ success: true, rows: 1, data: [{ name: "Kasse", postingaccount_number: "1000" }] });
    const server = createServer(client);
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
      }
    )._registeredTools;

    const result = await registeredTools.list_accounts.handler({});

    expect(client.call).toHaveBeenCalledWith("accountsGet", {});
    expect(JSON.parse(result.content[0].text)).toEqual([{ name: "Kasse", postingaccount_number: "1000" }]);
  });

  it("every registered tool has explicit readOnlyHint and destructiveHint annotations", () => {
    const server = createServer(mockClient({}));
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
      }
    )._registeredTools;

    for (const [name, tool] of Object.entries(registeredTools)) {
      expect(typeof tool.annotations?.readOnlyHint, `${name} readOnlyHint`).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint, `${name} destructiveHint`).toBe("boolean");
    }
  });

  it("marks read tools as readOnlyHint and non-destructive", () => {
    const server = createServer(mockClient({}));
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
      }
    )._registeredTools;

    for (const name of ["list_accounts", "list_receipts", "get_receipt", "list_postings"]) {
      expect(registeredTools[name].annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it("marks non-additive-update tools as destructiveHint", () => {
    // destructiveHint means "non-additive update" per the MCP spec, not just
    // "deletes data" — overwriting existing fields or removing an existing
    // relationship both qualify, not only outright deletion.
    const server = createServer(mockClient({}));
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
      }
    )._registeredTools;

    for (const name of [
      "manage_cost_location", // can delete
      "set_receipt_deleted", // can delete
      "update_contact", // overwrites existing debtor/creditor fields
      "manage_posting_account", // update branch overwrites existing name
      "unassign_receipt", // removes an existing assignment
      "unconfirm_posting", // flips an existing posting's fixed/confirmed status
      "cancel_posting", // removes unfixed postings (guarded wrapper around unconfirm)
    ]) {
      expect(registeredTools[name].annotations, name).toEqual({ readOnlyHint: false, destructiveHint: true });
    }
  });

  it("passes the real MCP SDK's output-schema validation for a list tool", async () => {
    const client = mockClient({ success: true, rows: 1, data: [{ name: "Kasse", postingaccount_number: "1000" }] });
    const mcpClient = await connectedClient(client);

    const result = await mcpClient.callTool({ name: "list_accounts", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      data: [{ name: "Kasse", postingaccount_number: "1000" }],
    });
  });

  it("passes the real MCP SDK's output-schema validation for an object-returning tool", async () => {
    const client = mockClient({ success: true, message: "" });
    const mcpClient = await connectedClient(client);

    const result = await mcpClient.callTool({
      name: "add_comment",
      arguments: { comment_text: "note", receipt_id_by_customer: 1 },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ data: { success: true, message: "" } });
  });

  it("lists ignored top-level parameters as a warning instead of failing", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const mcp = await connectedClient(client);

    const res = (await mcp.callTool({ name: "list_receipts", arguments: { search: "Beispiel", list_direction: "inbound", limit: 5 } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent: { warnings?: string[] };
    };

    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(res.content.at(-1)?.text).toMatch(/unbekannte Parameter ignoriert: search/);
    expect(res.structuredContent.warnings?.[0]).toMatch(/search/);
    const clean = (await mcp.callTool({ name: "list_receipts", arguments: { list_direction: "inbound", limit: 5 } })) as { content: Array<{ text: string }> };
    expect(clean.content.map((c) => c.text).join(" ")).not.toMatch(/unbekannte Parameter/);
  });

  it("accepts a number for amount and sends it as a string", async () => {
    const client = mockClient({ success: true, data: [] });
    const mcp = await connectedClient(client);

    await mcp.callTool({
      name: "add_free_postings",
      arguments: {
        free_postings: [
          { date: "2026-03-18", postingtext: "t", amount: 52.33, postingaccount_debit: 4964, postingaccount_credit: 1890, vat: "19_both_511" },
        ],
      },
    });

    const sent = JSON.stringify((client.call as ReturnType<typeof vi.fn>).mock.calls);
    expect(sent).toContain('"amount":"52.33"');
  });

  it("returns prepare_mixed_receipt's preview as an MCP image block", async () => {
    const file = Buffer.from(await makeFakeScanPdf({ inkRows: inkLines(8) })).toString("base64");
    const client = mockClient({
      success: true,
      data: { id_by_customer: "42", invoicenumber: "BEISPIEL-0815", counterparty: "Beispielmarkt", date: "2026-10-01", amount: "23.45", deleted: "0", file_content: file },
    });
    const mcp = await connectedClient(client);
    const result = (await mcp.callTool({ name: "prepare_mixed_receipt", arguments: { source_receipt_id_by_customer: 42 } })) as {
      isError?: boolean;
      content: Array<{ type: string; mimeType?: string }>;
      structuredContent?: { data?: { line_count?: number } };
    };
    expect(result.isError).toBeFalsy();
    expect(result.content.some((c) => c.type === "image" && c.mimeType === "image/png")).toBe(true);
    expect(result.structuredContent?.data?.line_count).toBe(8);
  });

  it("passes generate_and_upload_mixed_receipt's output with booking_proposal through the MCP output-schema validation", async () => {
    const file = Buffer.from(await makeFakeScanPdf({ inkRows: inkLines(8, 30, 20, 20) })).toString("base64");
    process.env.BHB_POLICY_FILE = join(await mkdtemp(join(tmpdir(), "bhb-server-policy-")), "policy.json");
    await writeFile(process.env.BHB_POLICY_FILE, JSON.stringify({ tax_profile: { kleinunternehmer: false, debitoren_kreditoren: "aktiv" } }));
    let uploaded = false;
    const call = vi.fn(async (key: string, _params?: unknown, options?: { idSuffix?: number }) => {
      if (key === "receiptsGetIdByCustomer") {
        if (options?.idSuffix === 777) return { success: true, data: { id_by_customer: "777", account: "745", amount_paid: "-6.42" } };
        return { success: true, data: { id_by_customer: "42", invoicenumber: "BEISPIEL-0815", counterparty: "Beispielmarkt", date: "2026-10-01", amount: "23.45", deleted: "0", file_content: file } };
      }
      // earlier receipt of the merchant (the Kreditor is derived from its booking)
      if (key === "receiptsGet" && (_params as { counterparty?: string } | undefined)?.counterparty !== undefined) {
        return { success: true, data: [{ id_by_customer: "500", counterparty: "Beispielmarkt", invoicenumber: "BM-500", deleted: "0" }] };
      }
      if (key === "receiptsGet") return { success: true, data: uploaded ? [{ id_by_customer: "777", invoicenumber: "BEISPIEL-0815", deleted: "0", amount: "6.42" }] : [] };
      if (key === "receiptsUpload") {
        uploaded = true;
        return { success: true, data: { id_by_customer: 777 } };
      }
      if (key === "accountsGet") return { success: true, data: [{ name: "Verbindlichkeiten Gesellschafter Erika Beispiel", postingaccount_number: "745" }] };
      if (key === "receiptsAssignedTransactionsGet") return { success: true, data: [{ id_by_customer: "9001", amount: "-6.42", to_from: "Erika Beispiel", booking_date: "2026-10-01" }] };
      if (key === "postingsGet") {
        return { success: true, data: [{ id_by_customer: "p500", receipt_id_by_customer: "500", transaction_id_by_customer: "", debit_postingaccount_number: "4653", credit_postingaccount_number: "70555" }] };
      }
      if (key === "commentsAdd" || key === "receiptsDeleteIdByCustomer") return { success: true };
      throw new Error(`unexpected endpoint ${key}`);
    });
    const mcp = await connectedClient({ call } as unknown as BBClient);
    const result = (await mcp.callTool({
      name: "generate_and_upload_mixed_receipt",
      arguments: {
        source_receipt_id_by_customer: 42,
        redact_lines: ["3-5", 7],
        positions: [{ description: "Milch 1 l", gross: 1.98, vat_rate: 7 }, { description: "Mineralwasser", gross: 4.44, vat_rate: 19 }],
        receipt_total: 23.45,
        receipt_vat_lines: [{ vat_rate: 7, net: 15.0, vat: 1.05 }, { vat_rate: 19, net: 6.22, vat: 1.18 }],
        merchant: { name: "Beispielmarkt", address: "Musterstraße 1, 12345 Musterstadt" },
        receipt_number: "BEISPIEL-0815",
        receipt_datetime: "2026-10-01 10:15",
        paid_by: "Erika Beispiel",
        occasion: "Milch und Wasser für Kundenbesprechungen im Büro",
        company_name: "Beispiel GmbH",
        company_address: "Beispielweg 2, 12345 Musterstadt",
        confirm: true,
      },
    })) as { isError?: boolean; structuredContent?: { data?: { status?: string; booking_proposal?: { status?: string; calls?: unknown[] } } } };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.data?.status).toBe("uploaded");
    expect(result.structuredContent?.data?.booking_proposal?.status).toBe("ready");
    expect(result.structuredContent?.data?.booking_proposal?.calls?.map((c) => (c as { tool: string }).tool)).toEqual(["add_receipt_postings", "add_transaction_postings"]);
  });
});
