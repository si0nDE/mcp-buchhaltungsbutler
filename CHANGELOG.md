# Changelog

## Unreleased

- Korrektur: Die `vat`-Beschreibung und die Server-Instruktionen behaupteten widersprüchlich „19_both_511 = §13b Drittland“ und „§13b nur EU“. Jetzt steht dort
  „§13b, Zuordnung EU/Drittland von BHB nicht bestätigt“ (Kennziffern im USt-VA-Entwurf prüfen), ebenso im Thema `reverse_charge_drittland`.
- Neu: Unbekannte Top-Level-Parameter (z. B. `search` bei `list_receipts`) werden weiter ignoriert, die Antwort enthält aber einen Warnhinweis
  (zusätzlicher Textblock und `structuredContent.warnings`), damit ein nicht wirksamer Filter nicht als Ergebnis gelesen wird.
- Neu: `amount` bei `add_receipt_postings`/`add_transaction_postings`/`add_free_postings` nimmt auch eine Zahl und sendet sie als String mit zwei Nachkommastellen.
- Neu: `assign_receipt_to_free_posting` akzeptiert `free_posting_id_by_customer` als Alias für `posting_id_by_customer`.
- Neu: `list_transactions` mit `query` (Teilstring über `to_from`, `purpose`, `payment_reference`, lokal nach Durchlauf des Datumsfensters). Die Antwort nennt
  gescannte, passende und gelieferte Zahlungen; bei Abbruch nach 20 Seiten `truncated`.
- Neu: `get_booking_guide` Themen `reverse_charge_drittland` (Eingangsrechnungen ohne USt von Anbietern außerhalb der EU, § 13b Abs. 2 Nr. 1 UStG,
  Buchung mit `19_both_511`, Entscheidungsweg, Muster für bezahlt/privat/offen/0,00-Rechnung/Korrektur), `lieferantenportal_abgleich` (Belegprüfung
  je Lieferant samt Kurs-Ausreißertest und Portalabgleich) und `pfaendung_zahlung_buchen`. Rechtsgrundlagen und ausdrücklich nicht verifizierte Punkte
  (Kennziffern Drittland, Zuordnung `19_both_511` zur Oberflächenoption, Meldeperiode) in [docs/rechtsgrundlagen-13b-drittland.md](docs/rechtsgrundlagen-13b-drittland.md).
- Neu: `dry_run: true` bei `add_receipt_postings`, `add_transaction_postings` und `add_free_postings`: alle lokalen Prüfungen laufen, die Antwort zeigt `would_send`
  (die berechneten Buchungen), angekündigte Kommentare/Belegzuordnungen und `warnings` (z. B. Steuerschlüssel passt nicht zum Konto). Es wird nichts geschrieben.
  Die Steuerschlüssel-Warnung gilt nur für SKR03 und nur für 19/7 `_vat`/`_pre`.
- Neu: Tool `get_receipt_overview`: Beleg (ohne Datei), zugeordnete Zahlungen, Buchungen zum Beleg (Art receipt/transaction/free), `paid_by_transactions`,
  `paid_by_free_postings`, `open_amount` und Hinweise (freie Buchungen zählen nicht als Zahlung, Sammelzahlung). Ersetzt drei Aufrufe. 46 Tools.
- Neu: `list_posting_accounts` liefert `vat_hint` (SKR03): übliche Steuerschlüssel je Konto, abgeleitet aus dem Nummernkreis, von BHB nicht bestätigt.

- Neu: `compact` (Standard), `fields` und `include_links` bei `list_postings` und `get_account_ledger`: leere Felder (`oss_*`, `cost_location`, ...) und
  PDF-Links entfallen, `fields: [...]` liefert nur die genannten Felder, `compact: false` die Rohzeilen. Weniger Tokens bei Prüfaufrufen.
- Neu: `list_receipts` mit `list_direction: "both"` (eine Anfrage statt zwei, jede Zeile trägt ihre Richtung).
- Neu: `add_free_postings` nimmt je Eintrag `receipt_id_by_customer` und ordnet den Beleg im selben Aufruf zu (`receipt_assignments` je Eintrag;
  die ID der neuen Buchung kommt aus der Batch-Antwort, live gegen BHB geprüft; Rückfall: Suche über Datum, Text, Betrag und Konten).
- Neu: `get_account_ledger` liefert standardmäßig ein Prüfset (Datum, Seite, Betrag, Gegenkonto, Text, Steuersatz, Beleg-/Zahlungs-ID, zugeordnete Belegdateinamen, Storno-IDs, Saldo; bei freien Buchungen steht die Belegzuordnung nur im Dateinamen);
  `fields` oder `compact: false` liefern den Rest.
- Neu: Beschreibungen von `add_transaction_postings`, `add_receipt_postings`, `add_free_postings` und `add_comment` enthalten einen vollständigen
  Beispielaufruf; Hinweis, erst einen Aufruf zu testen und dann zu parallelisieren. BHB-Fehler "pre tax", "invalid vat" und Summenfehler bekommen
  einen Korrekturhinweis (`19_pre`/`7_pre`).

- Neu: `get_booking_guide` Thema `belegpruefung`. Belege prüfen und Belegdaten korrigieren geht nur in der Weboberfläche (Bearbeiten-Dialog setzt
  `confirmationStatus`; der Pfad verlangt eine Browser-Sitzung, die API hat keinen Endpunkt). Dokumentiert: Ersatzsignal über
  `date_since_last_modified`, typische OCR-Fehler bei Gutschriften, die Alternative mit aktivierter Debitorenbuchhaltung samt ihren Grenzen
  (nicht per API verifiziert). `upload_receipt` weist auf die OCR-Falle bei Gutschriften hin. Siehe [docs/bhb-systematik.md](docs/bhb-systematik.md).
- Korrektur: `buchungsvormerkung_eur` sagte „Vormerkungen gibt es per API nicht". Die undokumentierten Endpunkte `/postings-reservations/add|get|delete`
  existieren, liefern aber „insufficient privileges".

- Fix: `tools/list` meldete bei allen Tools `"$schema": "http://json-schema.org/draft-07/schema#"` (SDK 1.30 erzeugt immer draft-07). Clients mit
  Ajv-Standard (2020-12) lehnten die Tools mit "invalid outputSchema" ab. `$schema` wird jetzt aus Input- und Output-Schemas entfernt
  (`stripDraft07Dialect` in `src/server.ts`, Test `src/server-schema.test.ts`).
- Neu: Versionierung als CalVer `yyyy.mm.dd.NNN` (`src/version.ts`; `package.json` führt die semver-konforme Form `yyyy.mmdd.N`). `npm run release`
  zählt den Tageszähler anhand der Git-Tags hoch, committet und taggt `vYYYY.MM.DD.NNN`. Neues Tool `check_for_update` (read-only) vergleicht die
  laufende Version mit den Release-Tags auf GitHub. 45 Tools.

- Neu: Auswertung von 135 Artikeln der Kategorien Fehlerbehebung, Administratives und Funktionen & Einstellungen (siehe
  [docs/bhb-systematik.md](docs/bhb-systematik.md)). Neue Tools: `get_ustva_position` (USt-VA-Kennziffern, 95 Konten maschinell aus dem BHB-Artikel) und
  `calculate_account_balance` ("Kontostand berechnen", Abgleich mit dem Kontoauszug). Neue Vorab-Prüfungen: `create_transactions` lehnt 0,00-€-Zahlungen und
  Verwendungszwecke über 500 Zeichen ab; `manage_posting_account` ergänzt abgelehnte Nummern um den Hinweis auf gesperrte Kontonummern; `list_receipts` hat
  die Filter `invoicenumber` und `due_date` (Duplikatprüfung). Beschreibungen: Debitor/Kreditor-Ausgleich ohne Steuer und keine Doppelerfassung, Upload-Regeln
  und Kontingent, Matching-Regeln und Zahlungsreferenz, Auswertungen nur mit bestätigten Buchungen, revisionssichere Konten, Kostenstellen, E-Rechnung.
  `get_booking_guide` um 13 Themen erweitert (u. a. festgeschriebene_loeschen, belege_upload_matching, debitoren_kreditoren_logik, ust_va_zm, konten_einrichtung);
  Kennziffer-Hinweis im Thema eu_neufahrzeug korrigiert. 44 Tools.
- Neu: `get_booking_guide` Thema `anlagen_browser` - Übergabe des Teams zum Erfassen/Übernehmen von Anlagevermögen in der BHB-Weboberfläche (kein
  API-Weg): fachliche Regeln (Übernahmebetrag, volle Nutzungsdauer in Monaten, Erinnerungswert), Dialogfelder, Klick-Ablauf mit den bekannten
  Stolpersteinen, Verifikation, Grenzen. Die Anlagen-Warnung, `list_posting_accounts`, die Server-Instruktionen und das Thema `abschreibung`
  verweisen darauf. Der Eintrag ist als Team-Erfahrung (nicht als BHB-Artikel) gekennzeichnet und nur für einen Fall getestet.
- Neu: Tool `check_month_end` (read-only) mit den Monatsabschluss-Prüfungen aus BHBs Best Practice, soweit die API sie hergibt (Duplikate,
  Zahlungen/Belege ohne Buchung, nicht festgeschriebene Buchungen, Saldo Geldtransit/Interimskonto); der Rest wird als `nicht_pruefbar` gelistet.
  `get_booking_guide` um sieben Verfahrensthemen aus neun Best-Practice-Artikeln erweitert (erste_schritte, wechsel_zu_bhb, monatsabschluss,
  automatisierungsregeln, bedienung_shortcuts, buchungsvormerkung_eur, ausgangsrechnung_kasse). Feldbeschreibungen: `receipt_creates_transaction`
  (nur Eingangsbelege), `is_disabled_in_select`, `correspondence` (Codes für Automatisierungsregeln). 42 Tools.
- Neu: Tool `get_booking_guide` mit den buchhalterischen Sonderfällen und Kontierungstipps aus 22 BHB-Wissensdatenbank-Artikeln
  (Abschreibung, RAP, Auslagen, Ist-Versteuerer-Debitoren, Differenzbesteuerung, Amazon, 5,5 %/10,7 %, Gutschrift verrechnen, Skonto,
  Dreiecksgeschäft, EU-Neufahrzeug, Geldtransit, Prepaid, Lohn, MwSt-Senkung 2020, Storno/Rücklastschrift, Trinkgeld, Split/Saldierung,
  OSS, Umsatzsteuer im Ausland, Fremdwährung, IAB). Neue Warnungen: `create_invoice` bei 5,5 %/10,7 %, `add_free_postings` bei
  Debitor/Kreditor-Konten. Währungsfelder bei Belegen beschrieben (`create_receipts` nur USD/GBP/CHF, `upload_receipt` nur EUR).
  Server-Instruktionen verweisen auf den Leitfaden (41 Tools). Siehe [docs/bhb-systematik.md](docs/bhb-systematik.md).
- Spec-Update auf den Stand der Live-API-Doku (58 statt 48 Endpunkte; die lokale Spec trug dieselbe Version 1.9.1, war aber älter).
  Neue Tools: `create_report`/`get_report`/`get_account_ledger` (BWA, Summen- und Saldenliste, Kontenblatt; `base` für
  Leistungsdatum), `delete_transaction`, `manage_account` (update/delete), `create_invoice_correction`. Neue Filter
  `date_since_last_modified` bei `list_receipts`/`list_transactions`. OSS: sechs `vat_oss_*`-Codes mit `oss_*`-Feldern und Vorab-Prüfung.
  Hinweis: Das bedeutet 40 statt 34 Tools; die neuen Endpunkte sind nur per Unit-Tests abgedeckt, nicht live verifiziert.
- Geändert: `cancel_posting` nutzt jetzt `/postings/cancel` statt `unconfirm`. Festgeschriebene Buchungen werden nicht mehr
  abgelehnt, sondern per Gegenbuchung storniert – aber nur für IDs, die der Nutzer in `reverse_posting_ids` freigibt. Neu in
  der Antwort: `neu_angelegt`. Ein Fehler mitten im Lauf nennt erledigte und offene Buchungen. Siehe
  [docs/buchungen-korrigieren-faq.md](docs/buchungen-korrigieren-faq.md).
- Anlagenverwaltung: Der Konnektor weist darauf hin, dass es sie nur in der BHB-Oberfläche gibt (keine API). Buchungen auf
  Konten 0001–0599 liefern eine Warnung (kein Anlagegut, keine automatische AfA, keine manuelle Doppelabschreibung);
  „depreciation" ist kein Beispiel mehr für `add_free_postings`. Siehe [docs/bhb-systematik.md](docs/bhb-systematik.md).
- BHB-Systematik (siehe [docs/bhb-systematik.md](docs/bhb-systematik.md)): Server-Instruktionen mit den Kernregeln;
  `vat`-Beschreibung erklärt alle Steuerschlüssel (ausländische USt, i.g.E. nur Waren, §13b/Automatikkonten,
  aufzuteilende Vorsteuer, 2020-Sätze); `create_receipts`/`upload_receipt` lehnen `date_delivery` nach dem Belegdatum
  vor dem Senden ab; `create_invoice`/`create_einvoice` warnen, wenn `date_of_supply` ignoriert oder nicht als
  Leistungsdatum übernommen wird; `add_free_postings`/`create_transactions` beschreiben Anfangsbestände, USt/VSt-Saldovortrag
  und Gewinn-/Verlustvortrag; `confirm_payment` grenzt sich gegen EÜR-Belege ohne Debitor/Kreditor und Skonto/Sammelzahlung ab.
- Neu: Tool `cancel_posting` – entfernt nicht festgeschriebene Buchungen (Wrapper um `/postings/unconfirm/*`) mit
  Vorschau (`confirm: false`), Ablehnung festgeschriebener Buchungen und Nachkontrolle (`gelöscht: true/false`).
  Siehe [docs/buchungen-korrigieren-faq.md](docs/buchungen-korrigieren-faq.md). Bestehende Tools unverändert.
- Neu: `list_receipts` unterstützt `include_offers`; `list_posting_accounts` unterstützt `order` (clientseitig sortiert);
  `list_cost_locations` holt alle Seiten per `limit`/`offset` statt sich auf das API-Standardlimit zu verlassen.
