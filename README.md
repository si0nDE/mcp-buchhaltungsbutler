# mcp-buchhaltungsbutler

MCP server exposing the BuchhaltungsButler API (v1) as curated, token-efficient tools for LLM agents.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `BB_API_CLIENT`, `BB_API_SECRET`, `BB_API_KEY` (see BuchhaltungsButler's account settings for API access).
3. `npm run generate` (regenerates `src/bb-client/generated/endpoints.ts` from `spec/buchhaltungsbutler-v1.json`; only needed after updating the vendored spec).
4. `npm test`
5. `npm run build && npm start` — or `npm run dev` for a quick local run without building.

## Tools

**Accounts:** `list_accounts`, `create_account`
**Comments:** `add_comment`
**Cost Locations:** `list_cost_locations`, `manage_cost_location`
**Contacts (Debtors/Creditors):** `list_contacts`, `create_contacts`, `update_contact`
**Posting Accounts:** `list_posting_accounts`, `manage_posting_account`
**Receipts:** `list_receipts`, `get_receipt`, `create_receipts`, `upload_receipt`, `set_receipt_deleted`, `get_receipt_transactions`
**Transactions:** `list_transactions`, `get_transaction`, `create_transactions`, `assign_receipts_to_transactions`, `unassign_receipt`, `get_transaction_receipts`
**Postings:** `list_postings`, `add_receipt_postings`, `add_transaction_postings`, `add_free_postings`, `unconfirm_posting`, `assign_receipt_to_free_posting`
**Invoices:** `create_invoice`, `create_einvoice`

## Design

See `docs/superpowers/specs/2026-08-18-buchhaltungsbutler-mcp-design.md`.
