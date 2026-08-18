# MCP-Server für BuchhaltungsButler — Design

**Datum:** 2026-08-18
**Status:** Genehmigt (Brainstorming-Phase abgeschlossen)

## Ziel

Ein MCP-Server, der die BuchhaltungsButler-API (v1) für LLM-Agenten nutzbar macht, um Buchhaltungsaufgaben (Belege, Buchungen, Rechnungen, Kontakte, Konten) zu automatisieren. Vollständige funktionale Abdeckung der API, aber mit einer bewusst schlanken, token-effizienten MCP-Oberfläche.

## Kontext / Ausgangslage

- Neues, leeres Projekt (Greenfield), kein bestehender Code.
- Offizielle API-Dokumentation: `https://app.buchhaltungsbutler.de/docs/api/v1/`. Die HTML-Seite selbst ist nur eine Ladehülle; die eigentliche Spezifikation liegt als Swagger-2.0-JSON unter `https://app.buchhaltungsbutler.de/docs/api/v1.de.json` (per iframe eingebunden). Diese Spec wurde geladen und ausgewertet (Stand: Spec-Version 1.9.1, 48 Endpoints).
- API-Zugangsdaten liegen aktuell noch nicht vor.

## Entscheidungen aus dem Brainstorming

| Frage | Entscheidung |
|---|---|
| Deployment | Lokal über stdio (Claude Desktop/Code), kein Remote-Hosting in Phase 1 |
| Mandantenfähigkeit | Single-Tenant — ein Satz Zugangsdaten via Env-Variablen |
| Tool-Granularität | Kuratierte High-Level-Tools statt 1:1-API-Wrapper |
| API-Zugangsdaten | Noch nicht vorhanden — Entwicklung zunächst gegen die Spec, Live-Test folgt später |

## API-Überblick

Alle 48 Endpoints sind `POST`-Requests mit Body-Parametern (kein REST-Routing über HTTP-Verben). Authentifizierung erfolgt zweistufig:

1. HTTP Basic Auth mit `<Api Client>:<Api Secret>` im `Authorization`-Header (identifiziert die aufrufende Anwendung).
2. Body-Feld `api_key` wählt den zu verwaltenden BuchhaltungsButler-Kunden/Mandanten aus.

Rate-Limit: maximal 100 Requests pro Kunde pro Minute. Pagination erfolgt über `limit`/`offset`, mit unterschiedlichen Defaults und Maxima je Endpoint (z. B. Receipts/Transactions: Default 500, Max 500; Postings: Max 1000; Debtors/Creditors: Default 25).

Kategorien laut Spec:

| Kategorie | Endpoints | Beispiele |
|---|---|---|
| Accounts | 2 | Konten abrufen, Basiskonto anlegen |
| Comments | 1 | Kommentar zu Buchung/Beleg hinzufügen |
| Cost Locations | 4 | Kostenstellen: get/add/update/delete |
| Invoices | 3 | Rechnung/Gutschrift/Angebot erstellen, E-Rechnung, Entwurf |
| Postings | 11 | Buchungen abrufen, Beleg-/Transaktions-/Freie Buchungen (einzeln + Batch), Stornieren, Beleg↔freie Buchung zuordnen |
| Receipts | 8 | Belege abrufen/anlegen/hochladen/löschen/wiederherstellen, zugeordnete Transaktionen |
| Settings | 11 | Debitoren/Kreditoren/Buchungskonten: get/add/add-batch/update |
| Transactions | 8 | Transaktionen abrufen/anlegen, Beleg-Zuordnung (einzeln + Batch) |

**Gesamt: 48 Endpoints.**

## Architektur

### Tech-Stack

TypeScript, `@modelcontextprotocol/sdk` (offizielles MCP-SDK), stdio-Transport. Zod für Input-Validierung — die Zod-Schemas dienen direkt als MCP-Tool-Input-Schema (kein doppelter Pflegeaufwand).

### Zwei Schichten

**1. Client-Layer (`src/bb-client/`)**

Ein dünner, vollständig typisierter HTTP-Client, der aus der offiziellen Swagger-Spec generiert wird:

- Ein Codegen-Skript (`scripts/generate-client.ts` o. ä.) lädt/liest die `v1.de.json`-Spec und erzeugt TypeScript-Typen sowie Request-Funktionen für **alle** 48 Endpoints.
- Übernimmt: Basic-Auth-Header, `api_key`-Injektion aus Config, Rate-Limit-bewusstes Verhalten (Backoff bei 429/Ratenüberschreitung), einheitliches Error-Mapping (BuchhaltungsButler-Fehlercodes → strukturierte Fehler).
- Diese Schicht ist **nicht** die MCP-Oberfläche — sie stellt lediglich sicher, dass die komplette API technisch erreichbar und typsicher ist, auch für Endpoints, die (noch) kein eigenes MCP-Tool haben.
- Vorteil: Bei einem Update der BuchhaltungsButler-API muss nur der Codegen erneut laufen, nicht 48 Handler von Hand angepasst werden.

**2. Tool-Layer (`src/tools/*.ts`)**

Handgeschriebene, kuratierte MCP-Tools oberhalb des Client-Layers, ein Modul pro Kategorie (`receipts.ts`, `transactions.ts`, `postings.ts`, `invoices.ts`, `contacts.ts` für Debitoren/Kreditoren, `accounts.ts`, `cost-locations.ts`, `comments.ts`).

**3. Server-Bootstrap (`src/index.ts`)**

Registriert alle Tools, initialisiert stdio-Transport, lädt Konfiguration aus Env-Variablen.

### Tool-Kuratierung

Ziel: die 48 API-Endpoints auf ca. **20–25 MCP-Tools** verdichten, ohne funktionale Abdeckung zu verlieren. Strategien:

- **CRUD pro Entität bündeln**, wo sinnvoll (z. B. Kostenstellen: `list_cost_locations`, `create_cost_location`, `update_cost_location`, `delete_cost_location` bleiben getrennt, da klar unterscheidbare Aktionen mit unterschiedlichen Pflichtfeldern).
- **Batch immer eingebaut**: Tools, die Datensätze anlegen (Belege, Transaktionen, Debitoren, Kreditoren, freie Buchungen), akzeptieren nativ ein Array — die getrennten `/add`- und `/addBatch`-Endpoints der API werden zu einem Tool zusammengeführt (ein Datensatz = Array der Länge 1).
- **Verwandte Aktionen über einen Parameter bündeln**, statt mehrere Tools: z. B. `unconfirm_posting(type: transaction|receipt|free, ...)` statt drei separater Tools für `/postings/unconfirm/transaction`, `/postings/unconfirm/receipt`, `/postings/unconfirm/free`. Analog `set_receipt_deleted(id, deleted: boolean)` statt getrennter `delete`/`restore`-Tools.
- **Parallele Arrays in Objekt-Arrays normalisieren**: Die API verlangt bei `/invoices/create` z. B. parallele Arrays (`item_name[]`, `item_amount[]`, `item_unit[]`, `item_vat[]`, `item_single_price[]`, ...). Das MCP-Tool-Schema bietet stattdessen `items: [{ name, amount, unit, vat, single_price, description? }]`; der Client-Layer flacht dies serverseitig in das von der API erwartete Parallel-Array-Format ab. Das reduziert Fehlerquellen (Arrays laufen sonst leicht auseinander) und damit unnötige Retry-Turns.

Die exakte finale Tool-Liste (Namen, Signaturen, welche Endpoints jeweils zusammengefasst werden) wird im Implementierungsplan festgelegt, nicht abschließend in diesem Design-Dokument — die obigen Prinzipien sind die verbindliche Leitlinie dafür.

### Token-Effizienz (Output-Seite)

Get-Endpoints der API liefern standardmäßig recht große Ergebnismengen (Defaults 25–1000 Zeilen je nach Endpoint) und vollständige Objekte. Gegenmaßnahmen auf Tool-Ebene:

- Eigene, kleinere Default-`limit`-Werte je Tool (z. B. 20 statt 500), unabhängig vom API-Default — der Agent kann bei Bedarf explizit höher gehen.
- Standardmäßig getrimmte Rückgabefelder (z. B. bei Belegen/Transaktionen: `id`, `date`, `amount`, `counterparty`, `status`) statt der vollständigen API-Objekte. Ein `full: true`-Parameter liefert bei Bedarf den kompletten Datensatz.

### Auth & Konfiguration

Single-Tenant, Konfiguration über Env-Variablen:

- `BB_API_CLIENT`, `BB_API_SECRET` — Basic-Auth-Zugangsdaten der Anwendung.
- `BB_API_KEY` — API-Key des zu verwaltenden Kunden/Mandanten.
- Optional `BB_API_BASE_URL` (Default: Produktions-Endpoint laut Spec).

Fehlen Pflicht-Env-Variablen, bricht der Server beim Start mit einer klaren Fehlermeldung ab (kein stiller Fallback).

Client- und Tool-Layer werden so gebaut, dass sie nicht fest an "genau ein Set Credentials aus Env" gekoppelt sind (z. B. `api_key` als expliziter Parameter der Client-Funktionen, nicht global gebunden) — das hält eine spätere Remote-/Multi-Tenant-Variante grundsätzlich möglich. Das ist **kein** Arbeitsauftrag für diese Phase, sondern nur eine Design-Randbedingung, die spätere Erweiterung nicht unnötig erschwert.

### Fehlerbehandlung

Die API liefert strukturierte Fehlercodes pro Endpoint (z. B. `401 (3)` ungültige Credentials, `400 (7)` ungültiges `date_from`, etc.), dokumentiert in der Swagger-Spec. Der Client-Layer mappt diese auf einheitliche, für den Agenten verständliche Fehlerobjekte statt rohe API-Fehlertexte durchzureichen.

### Testing-Strategie

Da noch keine API-Zugangsdaten vorliegen:

1. **Unit-Tests** gegen gemockte HTTP-Antworten. Die Swagger-Spec enthält vollständige Response-Schemas (inkl. Fehlerfälle pro Endpoint), aus denen Mock-Responses abgeleitet werden.
2. **Live-Integrationstest** gegen die echte API folgt, sobald Zugangsdaten verfügbar sind — kein Blocker für die Erstimplementierung.

## Out of Scope (Phase 1)

- Remote-/HTTP-Hosting des MCP-Servers.
- Multi-Tenant-Betrieb (mehrere Kunden gleichzeitig über eine Serverinstanz).
- OAuth/andere Auth-Verfahren als die von der API vorgegebene Basic-Auth-Kombination.

## Nächster Schritt

Übergabe an den Implementierungsplan (writing-plans), beginnend mit: Projekt-Setup, Codegen-Skript für den Client-Layer, danach Tool-Layer je Kategorie.
