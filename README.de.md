# mcp-buchhaltungsbutler

**Deutsch | [English](README.md)**

Ein MCP-Server (Model Context Protocol), der die [BuchhaltungsButler](https://www.buchhaltungsbutler.de/)-API (v1) als kuratierte, token-effiziente Tools für LLM-Agenten bereitstellt.

> Inoffizielles Community-Projekt. Nicht verbunden mit oder unterstützt von BuchhaltungsButler.

## Für Agenten gebaut, nicht nur aus der API gewrappt

- **30 Tools decken alle 48 Endpoints ab** — Batch-, List- und Einzel-Varianten derselben Aktion sind zu einem Tool zusammengeführt, damit dein Context-Window nicht mit Beinahe-Duplikaten vollläuft.
- **Schlank per Default** — List-Tools liefern von Haus aus getrimmte, LLM-freundliche Felder; mit `full: true` gibt's bei Bedarf den kompletten Datensatz.
- **Kein Array-Jonglieren** — Rechnungspositionen, Buchungs-Splits und andere API-Eigenheiten kommen als saubere, ganz normale Objekte an. Kein manuelles Synchronhalten von fünf parallelen Arrays mehr.
- **Immer synchron mit der Spec** — Endpoint-Definitionen werden direkt aus BuchhaltungsButlers offizieller API-Spec generiert, nicht von Hand gepflegt.

## Einrichtung

1. `npm install`
2. `.env.example` nach `.env` kopieren und `BB_API_CLIENT`, `BB_API_SECRET`, `BB_API_KEY` eintragen (BuchhaltungsButler → Einstellungen → API).
3. `npm test` — läuft gegen gemockte HTTP-Antworten, keine echten Zugangsdaten nötig.
4. `npm run build && npm start` — oder `npm run dev` für einen schnellen lokalen Lauf ohne vorherigen Build.

`npm run generate` erzeugt `src/bb-client/generated/endpoints.ts` neu aus der vendorten Spec (`spec/buchhaltungsbutler-v1.json`); die Ausgabe ist bereits committed, der Befehl ist also nur nach einem Update der Spec-Datei selbst nötig.

## Mit einem MCP-Client nutzen

`.env` deckt nur lokale `npm run dev`/`npm start`-Läufe ab. Ein echter MCP-Client (z. B. Claude Desktop) startet den Server selbst und liest kein `.env` — Zugangsdaten stattdessen über die `env`-Konfiguration des Clients übergeben. Beispiel für einen `claude_desktop_config.json`-Eintrag:

```json
{
  "mcpServers": {
    "buchhaltungsbutler": {
      "command": "node",
      "args": ["/absoluter/pfad/zu/mcp-buchhaltungsbutler/dist/index.js"],
      "env": {
        "BB_API_CLIENT": "dein-api-client",
        "BB_API_SECRET": "dein-api-secret",
        "BB_API_KEY": "dein-kunden-api-key"
      }
    }
  }
}
```

Vorher `npm run build` ausführen, damit `dist/index.js` existiert.

## Tools

| Kategorie | Tools |
|---|---|
| Konten | `list_accounts`, `create_account` |
| Kommentare | `add_comment` |
| Kostenstellen | `list_cost_locations`, `manage_cost_location` |
| Kontakte (Debitoren/Kreditoren) | `list_contacts`, `create_contacts`, `update_contact` |
| Buchungskonten | `list_posting_accounts`, `manage_posting_account` |
| Belege | `list_receipts`, `get_receipt`, `create_receipts`, `upload_receipt`, `set_receipt_deleted`, `get_receipt_transactions` |
| Transaktionen | `list_transactions`, `get_transaction`, `create_transactions`, `assign_receipts_to_transactions`, `unassign_receipt`, `get_transaction_receipts` |
| Buchungen | `list_postings`, `add_receipt_postings`, `add_transaction_postings`, `add_free_postings`, `unconfirm_posting`, `assign_receipt_to_free_posting` |
| Rechnungen | `create_invoice`, `create_einvoice` |

## Architektur

```
src/
  config.ts              # Env-Var-Laden, Fail-Fast-Validierung
  bb-client/
    generated/            # aus der Spec generierte Endpoint-Metadaten (npm run generate)
    client.ts              # generischer HTTP-Client: Auth, api_key-Injektion, Fehler-Mapping
  formatting/trim.ts       # trimmt List-Antworten auf LLM-freundliche Felder
  tools/                   # eine Datei pro Kategorie, kuratierte MCP-Tools auf dem Client
  server.ts, index.ts      # MCP-Server-Bootstrap (stdio)
scripts/generate-client.ts # parst spec/buchhaltungsbutler-v1.json nach src/bb-client/generated/
```

Nur Single-Tenant, lokaler stdio-Transport — kein Remote-Hosting, kein Multi-Tenant-Betrieb, kein OAuth. Zugangsdaten erreichen nie das Modell; der Client-Layer injiziert sie aus Env-Variablen direkt in die Requests.

## Status

Alle 48 BuchhaltungsButler-Endpoints sind über die 30 Tools oben abgedeckt, getestet gegen gemockte HTTP-Antworten. Noch nicht gegen einen echten Account verifiziert — bei unerwarteten Fehlern, besonders bei den vier `*_id_by_customer`-Endpoints (`get_receipt`, `set_receipt_deleted`, `get_transaction`) oder bei `add_receipt_postings`/`add_transaction_postings` mit gemischt befüllten Kostenstellen im Batch, bitte ein Issue öffnen.

## Entwicklung

```bash
git clone https://github.com/si0nDE/mcp-buchhaltungsbutler.git && cd mcp-buchhaltungsbutler
npm install
npm test           # vitest run
npm run build       # tsc, strict mode
```
