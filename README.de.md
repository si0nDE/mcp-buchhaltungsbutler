# mcp-buchhaltungsbutler

**Deutsch | [English](README.md)**

Ein MCP-Server (Model Context Protocol), der die [BuchhaltungsButler](https://www.buchhaltungsbutler.de/)-API (v1) als kuratierte, token-effiziente Tools für LLM-Agenten bereitstellt.

> Inoffizielles Community-Projekt. Nicht verbunden mit oder unterstützt von BuchhaltungsButler.

## Warum kuratiert statt 1:1

Die BuchhaltungsButler-API hat 48 Endpoints. Jeden davon 1:1 als MCP-Tool zu spiegeln würde funktionieren, bläht aber die Tool-Liste jeder Konversation auf und verbrennt Tokens für redundante List-/Batch-/Einzel-Varianten. Dieser Server bündelt sie stattdessen in **30 Tools**:

- Batch-first: jedes anlegende Tool nimmt nativ ein Array — kein separates Paar aus Einzel- und Batch-Endpoint.
- Verwandte Aktionen teilen sich ein Tool mit `action`/`type`-Parameter (z. B. `manage_cost_location`, `unconfirm_posting`) statt ein Tool pro Verb.
- List-Tools liefern standardmäßig getrimmte, LLM-freundliche Felder; mit `full: true` gibt's den kompletten Datensatz.
- Die parallelen Arrays der API (z. B. Rechnungspositionen, Buchungs-Splits) werden zu normalen Objekt-Arrays normalisiert und intern wieder abgeflacht — das Modell muss nie mehrere Arrays synchron halten.

Die Endpoint-Metadaten selbst (Pfade, Pflicht-/optionale Felder) werden per `npm run generate` aus BuchhaltungsButlers offizieller Swagger-Spec generiert, statt von Hand gepflegt — bei einem Spec-Update reicht ein Neu-Lauf.

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
