# mcp-buchhaltungsbutler

**[Deutsch](README.de.md) | English**

An MCP (Model Context Protocol) server that exposes the [BuchhaltungsButler](https://www.buchhaltungsbutler.de/) API (v1) — a German bookkeeping/accounting SaaS — as a set of curated, token-efficient tools for LLM agents.

> Unofficial, community project. Not affiliated with or endorsed by BuchhaltungsButler.

## Built for agents, not just wrapped from the API

- **49 tools covering all 58 endpoints** — batch, list, and singular variants of the same action are merged into one tool, so your context window isn't full of near-duplicate tool definitions.
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

## Bewirtungsbeleg (business entertainment receipts)

`generate_entertainment_receipt` fills the gap between a restaurant bill and a legally complete
Bewirtungsbeleg (§ 4 Abs. 5 Satz 1 Nr. 2 EStG). `generate_and_upload_entertainment_receipt` does the
same and uploads the result via the same endpoint `upload_receipt` calls, so the full base64 PDF
doesn't have to round-trip through the model twice. See
[docs/bewirtungsbeleg-faq.md](docs/bewirtungsbeleg-faq.md) for the legal background (German only, since
it documents German tax law).

### Appending the original from BuchhaltungsButler (`source_receipt_id_by_customer`)

If the bill already exists in BuchhaltungsButler, call `generate_and_upload_entertainment_receipt` with
`source_receipt_id_by_customer`. The connector loads the original server-side (memory only), appends the
Bewirtungsangaben page as the **last page** and uploads **one** new receipt (original + page). No base64 passes
through the model. Use `bill_file` only for files that are not in BuchhaltungsButler.

| Parameter | Meaning |
|---|---|
| `source_receipt_id_by_customer` | id_by_customer of the original. Mutually exclusive with `bill_file` and `link_to_receipt_id_by_customer`. |
| `include_original_hash` (default `true`) | SHA-256 of the original in the page footer. |
| `keep_original_metadata` (default `true`) | Reuse the original's date, invoice number, amount, counterparty, account and type (`counterparty`/`bill_reference`/`account` override if given). `vat_rate` is still derived from the amounts. |

Flow: validate → load original → check type (PDF/JPEG/PNG, max 15 MB) → amount check (parts sum = original's
amount, tolerance 0.01 EUR) → merge → dry check (page count, text, embedded files) → **one** upload → duplicate
check. Any failure before the upload uploads nothing; a failed upload is never retried automatically. The original
is **never** modified or deleted - after the user confirms, remove it with `set_receipt_deleted` (restorable), then
book on the new receipt.

Returns: `status`, `new_receipt_id_by_customer`, `original_receipt_id_by_customer`, `original_deleted` (always
`false`), `pages_before`/`pages_after`, `original_sha256`, `duplicates_found`, `checks`, `amounts`, `warnings`,
`next_step_hint`. `new_receipt_id_by_customer` comes from the upload response (fallback: resolved via the internal filename from the receipt list; otherwise `null` with a warning). `duplicates_found` lists only other receipts with the same date, counterparty and amount (invoice number alone does not count) or linked to the original, each with `matches` and `linked_to_original` so old Fall-B pages are recognisable; the original and the new receipt never appear. Fall A (`bill_file`) and Fall B (`link_to_receipt_id_by_customer`) behave as before.

## Remote deployment (Docker)

For clients that can't launch a local process (e.g. Claude on mobile), the server also runs as a
Streamable HTTP service instead of stdio, container-ready.

1. Pull the published image: `ghcr.io/si0nde/mcp-buchhaltungsbutler:latest` (built automatically from
   `main` by `.github/workflows/docker-publish.yml`), or build locally with `docker build -t mcp-buchhaltungsbutler .`.
2. Run it with the usual `BB_API_CLIENT`/`BB_API_SECRET`/`BB_API_KEY`, plus:
   - `MCP_AUTH_TOKEN` (required) — a long random secret; every request must send `Authorization: Bearer <token>`.
   - `MCP_ALLOWED_HOSTS` (recommended) — comma-separated hostnames this server is reachable as (e.g. your reverse proxy's domain), for DNS-rebinding protection.
   - `PORT` (optional, default `3000`).

   ```bash
   docker run -d --name mcp-buchhaltungsbutler \
     -e BB_API_CLIENT=... -e BB_API_SECRET=... -e BB_API_KEY=... \
     -e MCP_AUTH_TOKEN=... -e MCP_ALLOWED_HOSTS=mcp.your-domain.example \
     -p 3000:3000 \
     ghcr.io/si0nde/mcp-buchhaltungsbutler:latest
   ```
3. Put a reverse proxy (Caddy, nginx, Traefik, ...) in front for TLS — this container only speaks plain
   HTTP. `GET /health` returns `200 {"status":"ok"}` with no auth, for health checks; the MCP endpoint is
   `POST /mcp` and requires the bearer token.
4. Add it to Claude as a remote/custom connector using `https://mcp.your-domain.example/mcp` and an
   `Authorization: Bearer <token>` header — this is what makes it reachable from Claude on iOS/iPadOS,
   not just Desktop.

## Tools

| Category | Tools |
|---|---|
| Accounts | `list_accounts`, `create_account`, `manage_account` |
| Comments | `add_comment` |
| Cost Locations | `list_cost_locations`, `manage_cost_location` |
| Contacts (Debtors/Creditors) | `list_contacts`, `create_contacts`, `update_contact` |
| Posting Accounts | `list_posting_accounts`, `manage_posting_account` |
| Receipts | `list_receipts`, `get_receipt`, `create_receipts`, `upload_receipt`, `set_receipt_deleted`, `get_receipt_transactions`, `pair_receipt_family` |
| Transactions | `list_transactions`, `get_transaction`, `create_transactions`, `assign_receipts_to_transactions`, `unassign_receipt`, `get_transaction_receipts`, `delete_transaction` |
| Postings | `list_postings`, `add_receipt_postings`, `add_transaction_postings`, `add_free_postings`, `unconfirm_posting`, `cancel_posting`, `assign_receipt_to_free_posting`, `confirm_payment` |
| Invoices | `create_invoice`, `create_einvoice`, `create_invoice_correction` |
| Month-end | `check_month_end` (read-only closing checks), `calculate_account_balance` |
| USt-VA | `get_ustva_position` (which VAT-return field an account lands in), `preview_vat_impact` (sums of the tax accounts for a period, not the ELSTER figure) |
| Booking guide | `get_booking_guide` (documented BHB special cases: Skonto, Geldtransit, Auslagen, RAP, OSS, foreign currency, ...) |
| Reports | `create_report` (BWA, Summen- und Saldenliste), `get_report`, `get_account_ledger` |
| Bewirtungsbeleg | `generate_entertainment_receipt`, `generate_and_upload_entertainment_receipt` |

## Correcting wrong postings (`cancel_posting`)

`/postings/cancel` deletes postings that are **not fixed** and cancels **fixed** ones with a reversal posting.
`cancel_posting` wraps it per posting with guard rails — see [docs/buchungen-korrigieren-faq.md](docs/buchungen-korrigieren-faq.md):

1. **Preview first** (`confirm: false`, default): lists the affected postings (accounts, amount, `fixed`, receipt/transaction). Nothing is changed.
2. **Execute** (`confirm: true`): not fixed postings are deleted. Fixed postings are only reversed when their ids are passed in `reverse_posting_ids` (taken from the preview, approved by the user). Afterwards the postings are read again; `gelöscht: true/false` and the new reversal postings (`neu_angelegt`) are reported.
3. `type=transaction`/`receipt` removes **all** postings of that transaction/receipt, only `type=free` a single posting.
4. Recommended booking order: check receipt → book receipt → assign payment → book payment.

Not for periods already covered by a VAT pre-return or annual accounts without the Steuerberater.

## BuchhaltungsButler logic

The server sends BHB's bookkeeping rules (booking order, Ist/Soll, Leistungsdatum, tax codes, opening balances) as MCP
instructions and in the tool descriptions, and `get_booking_guide` returns the documented rule, accounts and example for a special case on demand; see [docs/bhb-systematik.md](docs/bhb-systematik.md).

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
  http-server.ts           # MCP server bootstrap (Streamable HTTP, bearer auth) — for remote/Docker deployment
scripts/generate-client.ts # parses spec/buchhaltungsbutler-v1.json into src/bb-client/generated/
```

Single-tenant, no multi-tenant support, no OAuth. Credentials never reach the model; they're injected
into requests by the client layer from env vars. Runs locally over stdio (Claude Desktop) or as a
Streamable HTTP service behind your own reverse proxy and bearer token (see "Remote deployment" above)
for clients that need a network-reachable server.

## Status

All 58 BuchhaltungsButler endpoints are covered by 40 of these tools (`get_booking_guide` and `get_ustva_position` make no API call, `check_month_end` and `calculate_account_balance` only combine read calls); `generate_entertainment_receipt` is a client-side PDF generator that makes no BuchhaltungsButler API calls of its own, while `generate_and_upload_entertainment_receipt` reuses the same `receiptsUpload` endpoint `upload_receipt` already covers rather than adding a 59th one (see [docs/bewirtungsbeleg-faq.md](docs/bewirtungsbeleg-faq.md)). Verified against a live account (both a read call and a create+delete round trip). The endpoints added in the October 2026 spec update (`/postings/cancel`, reports, `transactions/delete`, `accounts/update|delete`, `invoice_correction`, OSS fields) are covered by unit tests only and not yet verified live.

## Development

```bash
git clone https://github.com/si0nDE/mcp-buchhaltungsbutler.git && cd mcp-buchhaltungsbutler
npm install
npm test           # vitest run
npm run build       # tsc, strict mode
```

## License

[MIT](LICENSE) + [Commons Clause](https://commonsclause.com/) — free to use (including commercially, e.g. for your own bookkeeping), modify, and contribute to. The one thing it doesn't permit is reselling this software or offering it as a paid hosted/managed service. If you find it useful, consider [supporting development](https://ko-fi.com/simonfieber) instead of building a rival funding page around it.
