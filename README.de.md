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

## Remote-Deployment (Docker)

Für Clients, die keinen lokalen Prozess starten können (z. B. Claude auf dem Handy), läuft der Server
alternativ als Streamable-HTTP-Dienst statt über stdio, container-fertig.

1. Veröffentlichtes Image ziehen: `ghcr.io/<owner>/mcp-buchhaltungsbutler:latest` (automatisch aus `main`
   gebaut via `.github/workflows/docker-publish.yml`), oder lokal bauen mit `docker build -t mcp-buchhaltungsbutler .`.
2. Starten mit den üblichen `BB_API_CLIENT`/`BB_API_SECRET`/`BB_API_KEY`, plus:
   - `MCP_AUTH_TOKEN` (Pflicht) — ein langes Zufalls-Secret; jeder Request braucht `Authorization: Bearer <token>`.
   - `MCP_ALLOWED_HOSTS` (empfohlen) — kommagetrennte Hostnamen, unter denen der Server erreichbar ist (z. B. deine Reverse-Proxy-Domain), für DNS-Rebinding-Schutz.
   - `PORT` (optional, Standard `3000`).

   ```bash
   docker run -d --name mcp-buchhaltungsbutler \
     -e BB_API_CLIENT=... -e BB_API_SECRET=... -e BB_API_KEY=... \
     -e MCP_AUTH_TOKEN=... -e MCP_ALLOWED_HOSTS=mcp.deine-domain.example \
     -p 3000:3000 \
     ghcr.io/<owner>/mcp-buchhaltungsbutler:latest
   ```
3. Reverse-Proxy davor (Caddy, nginx, Traefik, ...) für TLS — der Container selbst spricht nur reines
   HTTP. `GET /health` liefert `200 {"status":"ok"}` ohne Auth, für Health-Checks; der MCP-Endpoint ist
   `POST /mcp` und braucht den Bearer-Token.
4. In Claude als Remote-/Custom-Connector eintragen mit `https://mcp.deine-domain.example/mcp` und
   `Authorization: Bearer <token>` — dadurch auch von Claude auf iOS/iPadOS erreichbar, nicht nur Desktop.

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
  http-server.ts           # MCP-Server-Bootstrap (Streamable HTTP, Bearer-Auth) — für Remote-/Docker-Deployment
scripts/generate-client.ts # parst spec/buchhaltungsbutler-v1.json nach src/bb-client/generated/
```

Nur Single-Tenant, kein Multi-Tenant-Betrieb, kein OAuth. Zugangsdaten erreichen nie das Modell; der
Client-Layer injiziert sie aus Env-Variablen direkt in die Requests. Läuft lokal über stdio (Claude
Desktop) oder als Streamable-HTTP-Dienst hinter eigenem Reverse-Proxy und Bearer-Token (siehe
"Remote-Deployment" oben) für Clients, die einen netzwerkerreichbaren Server brauchen.

## Status

Alle 48 BuchhaltungsButler-Endpoints sind über die 30 Tools oben abgedeckt. Gegen einen echten Account
verifiziert (sowohl ein Lese-Aufruf als auch ein Create+Delete-Roundtrip).

## Entwicklung

```bash
git clone https://github.com/si0nDE/mcp-buchhaltungsbutler.git && cd mcp-buchhaltungsbutler
npm install
npm test           # vitest run
npm run build       # tsc, strict mode
```

## Lizenz

[MIT](LICENSE) + [Commons Clause](https://commonsclause.com/) — frei nutzbar (auch geschäftlich, z. B. für die eigene Buchhaltung), frei änderbar, Beiträge willkommen. Nicht erlaubt ist lediglich der Weiterverkauf dieser Software oder das Anbieten als bezahlter Hosting-/Managed-Service. Wenn's dir hilft, unterstütz gerne [die Entwicklung](https://ko-fi.com/simonfieber), statt eine eigene Spendenseite drumherum zu bauen.
