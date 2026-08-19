# mcp-buchhaltungsbutler

**[Deutsch](README.de.md) | English**

An MCP (Model Context Protocol) server that exposes the [BuchhaltungsButler](https://www.buchhaltungsbutler.de/) API (v1) — a German bookkeeping/accounting SaaS — as a set of curated, token-efficient tools for LLM agents.

> Unofficial, community project. Not affiliated with or endorsed by BuchhaltungsButler.

## Built for agents, not just wrapped from the API

- **30 tools covering all 48 endpoints** — batch, list, and singular variants of the same action are merged into one tool, so your context window isn't full of near-duplicate tool definitions.
- **Lean by default** — list tools return trimmed, LLM-friendly fields out of the box; pass `full: true` whenever you need the complete record.
- **No array-juggling** — invoice line items, posting splits, and other API quirks are exposed as clean, ordinary objects. No more keeping five parallel arrays in sync by hand.
- **Always in sync with the spec** — endpoint definitions are generated straight from BuchhaltungsButler's official API spec, not hand-maintained.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `BB_API_CLIENT`, `BB_API_SECRET`, `BB_API_KEY` (BuchhaltungsButler → Settings → API).
3. `npm test` — runs against mocked HTTP responses, no live credentials needed.
4. `npm run build && npm start` — or `npm run dev` for a quick local run without building first.

`npm run generate` regenerates `src/bb-client/generated/endpoints.ts` from the vendored spec (`spec/buchhaltungsbutler-v1.json`); the output is already committed, so this is only needed after updating the spec file itself.

## Using with an MCP client

`.env` only covers local `npm run dev`/`npm start` runs. A real MCP client (e.g. Claude Desktop) launches the server itself and won't read `.env` — pass credentials via the client's own `env` config instead. Example `claude_desktop_config.json` entry:

```json
{
  "mcpServers": {
    "buchhaltungsbutler": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-buchhaltungsbutler/dist/index.js"],
      "env": {
        "BB_API_CLIENT": "your-api-client",
        "BB_API_SECRET": "your-api-secret",
        "BB_API_KEY": "your-customer-api-key"
      }
    }
  }
}
```

Run `npm run build` first so `dist/index.js` exists.

## Tools

| Category | Tools |
|---|---|
| Accounts | `list_accounts`, `create_account` |
| Comments | `add_comment` |
| Cost Locations | `list_cost_locations`, `manage_cost_location` |
| Contacts (Debtors/Creditors) | `list_contacts`, `create_contacts`, `update_contact` |
| Posting Accounts | `list_posting_accounts`, `manage_posting_account` |
| Receipts | `list_receipts`, `get_receipt`, `create_receipts`, `upload_receipt`, `set_receipt_deleted`, `get_receipt_transactions` |
| Transactions | `list_transactions`, `get_transaction`, `create_transactions`, `assign_receipts_to_transactions`, `unassign_receipt`, `get_transaction_receipts` |
| Postings | `list_postings`, `add_receipt_postings`, `add_transaction_postings`, `add_free_postings`, `unconfirm_posting`, `assign_receipt_to_free_posting` |
| Invoices | `create_invoice`, `create_einvoice` |

## Architecture

```
src/
  config.ts              # env var loading, fail-fast validation
  bb-client/
    generated/            # spec-derived endpoint metadata (regenerate with npm run generate)
    client.ts              # generic HTTP client: auth, api_key injection, error mapping
  formatting/trim.ts       # trims list responses to LLM-friendly fields
  tools/                   # one file per category, curated MCP tools on top of the client
  server.ts, index.ts      # MCP server bootstrap (stdio)
scripts/generate-client.ts # parses spec/buchhaltungsbutler-v1.json into src/bb-client/generated/
```

Single-tenant, local stdio transport only — no remote hosting, no multi-tenant support, no OAuth. Credentials never reach the model; they're injected into requests by the client layer from env vars.

## Status

All 48 BuchhaltungsButler endpoints are covered by the 30 tools above, tested against mocked HTTP responses. Not yet verified against a live account — if you hit an unexpected error, especially on the four `*_id_by_customer`-suffixed endpoints (`get_receipt`, `set_receipt_deleted`, `get_transaction`) or on `add_receipt_postings`/`add_transaction_postings` with a mixed-presence cost-location batch, please open an issue.

## Development

```bash
git clone https://github.com/si0nDE/mcp-buchhaltungsbutler.git && cd mcp-buchhaltungsbutler
npm install
npm test           # vitest run
npm run build       # tsc, strict mode
```

## License

[MIT](LICENSE) + [Commons Clause](https://commonsclause.com/) — free to use (including commercially, e.g. for your own bookkeeping), modify, and contribute to. The one thing it doesn't permit is reselling this software or offering it as a paid hosted/managed service. If you find it useful, consider [supporting development](https://ko-fi.com/simonfieber) instead of building a rival funding page around it.
