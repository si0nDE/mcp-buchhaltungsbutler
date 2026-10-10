# mcp-buchhaltungsbutler

**Deutsch | [English](README.md)**

Ein MCP-Server (Model Context Protocol), der die [BuchhaltungsButler](https://www.buchhaltungsbutler.de/)-API (v1) als kuratierte, token-effiziente Tools für LLM-Agenten bereitstellt.

> Inoffizielles Community-Projekt. Nicht verbunden mit oder unterstützt von BuchhaltungsButler.

## Für Agenten gebaut, nicht nur aus der API gewrappt

- **47 Tools decken alle 58 Endpoints ab** — Batch-, List- und Einzel-Varianten derselben Aktion sind zu einem Tool zusammengeführt, damit dein Context-Window nicht mit Beinahe-Duplikaten vollläuft.
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

## Bewirtungsbeleg

`generate_entertainment_receipt` schließt die Lücke zwischen der Restaurant-Rechnung und einem
vollständigen Bewirtungsbeleg (§ 4 Abs. 5 Satz 1 Nr. 2 EStG). `generate_and_upload_entertainment_receipt`
macht dasselbe und lädt das Ergebnis direkt über denselben Endpoint hoch, den auch `upload_receipt`
nutzt - so muss das komplette Base64-PDF nicht zweimal durchs Modell laufen. Rechtlicher Hintergrund:
[docs/bewirtungsbeleg-faq.md](docs/bewirtungsbeleg-faq.md).

### Original aus BuchhaltungsButler anhängen (`source_receipt_id_by_customer`)

Liegt die Rechnung schon in BuchhaltungsButler, `generate_and_upload_entertainment_receipt` mit
`source_receipt_id_by_customer` aufrufen. Der Konnektor lädt das Original serverseitig (nur im Arbeitsspeicher),
hängt die Bewirtungsangaben als **letzte Seite** an und lädt **einen** neuen Beleg hoch (Original + Bewirtungsangaben).
Es läuft kein Base64 durchs Modell. `bill_file` nur für Dateien nutzen, die nicht in BuchhaltungsButler liegen.

| Parameter | Bedeutung |
|---|---|
| `source_receipt_id_by_customer` | id_by_customer des Originals. Schließt `bill_file` und `link_to_receipt_id_by_customer` aus. |
| `include_original_hash` (Default `true`) | SHA-256 des Originals in der Fußzeile der Bewirtungsseite. |
| `keep_original_metadata` (Default `true`) | Datum, Rechnungsnummer, Betrag, Gegenpartei, Konto, Typ des Originals für den neuen Beleg (`counterparty`/`bill_reference`/`account` überschreiben, wenn angegeben). `vat_rate` wird wie bisher aus den Beträgen berechnet. |

Ablauf: validieren → Original laden → Typ prüfen (PDF/JPEG/PNG, max. 15 MB) → Betragsprüfung (Summe der
Teilbeträge = Betrag des Originals, Toleranz 0,01 €) → zusammenführen → Prüfung (Seitenzahl, Text, eingebettete
Dateien) → **ein** Upload → Duplikatprüfung per Belegliste. Bei jedem Fehler vor dem Upload wird nichts hochgeladen;
ein fehlgeschlagener Upload wird nie automatisch wiederholt. Das Original wird **nie** verändert oder gelöscht -
nach Bestätigung per `set_receipt_deleted` (wiederherstellbar), danach auf den neuen Beleg buchen.

Rückgabe: `status`, `new_receipt_id_by_customer`, `original_receipt_id_by_customer`, `original_deleted` (immer
`false`), `pages_before`/`pages_after`, `original_sha256`, `duplicates_found`, `checks`, `amounts`, `warnings`,
`next_step_hint`. `new_receipt_id_by_customer` stammt aus der Upload-Antwort (Fallback: Ermittlung über den internen Dateinamen per Belegliste; sonst `null` mit Warnung). `duplicates_found` listet nur andere Belege mit gleichem Datum, gleicher Gegenpartei und gleichem Betrag (die Rechnungsnummer allein zählt nicht) oder mit Verknüpfung zum Original, je Eintrag mit `matches` und `linked_to_original` - so sind alte Fall-B-Seiten erkennbar; Original und neuer Beleg erscheinen nie. Die Fälle A (`bill_file`) und B (`link_to_receipt_id_by_customer`) funktionieren unverändert.

## Remote-Deployment (Docker)

Für Clients, die keinen lokalen Prozess starten können (z. B. Claude auf dem Handy), läuft der Server
alternativ als Streamable-HTTP-Dienst statt über stdio, container-fertig.

1. Veröffentlichtes Image ziehen: `ghcr.io/si0nde/mcp-buchhaltungsbutler:latest` (automatisch aus `main`
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
     ghcr.io/si0nde/mcp-buchhaltungsbutler:latest
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
| Belege | `list_receipts`, `get_receipt`, `create_receipts`, `upload_receipt`, `set_receipt_deleted`, `get_receipt_transactions`, `pair_receipt_family` |
| Transaktionen | `list_transactions`, `get_transaction`, `create_transactions`, `assign_receipts_to_transactions`, `unassign_receipt`, `get_transaction_receipts` |
| Buchungen | `list_postings`, `add_receipt_postings`, `add_transaction_postings`, `add_free_postings`, `unconfirm_posting`, `cancel_posting`, `assign_receipt_to_free_posting`, `confirm_payment` |
| Rechnungen | `create_invoice`, `create_einvoice` |
| Bewirtungsbeleg | `generate_entertainment_receipt`, `generate_and_upload_entertainment_receipt` |

## Falsche Buchungen korrigieren (`cancel_posting`)

BuchhaltungsButler hat keinen echten Lösch-Endpunkt für Buchungen; `unconfirm` entfernt Buchungen, die **nicht festgeschrieben** sind.
`cancel_posting` kapselt das mit Sicherheitsgeländer — Details in [docs/buchungen-korrigieren-faq.md](docs/buchungen-korrigieren-faq.md):

1. **Erst Vorschau** (`confirm: false`, Standard): zeigt die betroffenen Buchungen (Konten, Betrag, `fixed`, Beleg/Zahlung). Es wird nichts geändert.
2. **Ausführen** (`confirm: true`): nur, wenn nichts festgeschrieben ist. Festgeschriebene Buchungen werden abgelehnt, nie automatisch entfestgeschrieben. Danach werden die Buchungen erneut abgefragt und `gelöscht: true/false` gemeldet.
3. `type=transaction`/`receipt` entfernt **alle** Buchungen dieser Zahlung bzw. dieses Belegs, nur `type=free` eine einzelne Buchung.
4. Empfohlene Buchungsreihenfolge: Beleg prüfen → Beleg buchen → Zahlung zuweisen → Zahlung buchen.

Nicht für Zeiträume, die bereits in einer USt-Voranmeldung oder einem Jahresabschluss verarbeitet sind; festgeschriebene Buchungen werden per Stornobuchung korrigiert (GoBD).

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

Alle 58 BuchhaltungsButler-Endpoints sind über 40 dieser Tools abgedeckt (`get_booking_guide` und `get_ustva_position` machen keinen API-Aufruf, `check_month_end` und `calculate_account_balance` kombinieren nur Lese-Aufrufe); `generate_entertainment_receipt` ist ein client-seitiger PDF-Generator ohne eigene BuchhaltungsButler-API-Aufrufe, während `generate_and_upload_entertainment_receipt` denselben `receiptsUpload`-Endpoint wie `upload_receipt` mitnutzt statt einen 59. hinzuzufügen (siehe [docs/bewirtungsbeleg-faq.md](docs/bewirtungsbeleg-faq.md)). Gegen einen echten Account verifiziert (sowohl ein Lese-Aufruf als auch ein Create+Delete-Roundtrip). Die Endpoints aus dem Spec-Update vom Oktober 2026 (`/postings/cancel`, Berichte, `transactions/delete`, `accounts/update|delete`, `invoice_correction`, OSS-Felder) sind nur per Unit-Tests abgedeckt und noch nicht live verifiziert.

## Entwicklung

```bash
git clone https://github.com/si0nDE/mcp-buchhaltungsbutler.git && cd mcp-buchhaltungsbutler
npm install
npm test           # vitest run
npm run build       # tsc, strict mode
```

## Lizenz

[MIT](LICENSE) + [Commons Clause](https://commonsclause.com/) — frei nutzbar (auch geschäftlich, z. B. für die eigene Buchhaltung), frei änderbar, Beiträge willkommen. Nicht erlaubt ist lediglich der Weiterverkauf dieser Software oder das Anbieten als bezahlter Hosting-/Managed-Service. Wenn's dir hilft, unterstütz gerne [die Entwicklung](https://ko-fi.com/simonfieber), statt eine eigene Spendenseite drumherum zu bauen.
