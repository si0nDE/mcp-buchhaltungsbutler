# Changelog

## Unreleased

- Fix: `check_receipt_fields` meldete bei einer Rechnung mit mehreren Positionen einen Rechenfehler, weil die erste „Zwischensumme“ (je Position) als Netto galt. Jetzt werden alle Kandidaten für Netto, Steuer und Brutto geprüft; die Meldung `arithmetic` erscheint nur, wenn keine Kombination Netto + Steuer = Brutto aufgeht, und nennt alle gefundenen Beträge.

- Neu: `npm run release` baut `dist` nach dem Tag neu (`dist` ist gitignored, der lokale Konnektor läuft daraus; ohne Build blieb er nach dem Release auf altem Stand).

- Fix: `check_receipt_fields` meldete bei einer Mobilfunk-Rechnung zwei Fehlalarme. Rechnungsnummer mit Leerzeichen im PDF („56 1670 …“) gegen die Nummer ohne Leerzeichen in BHB gilt jetzt als gleich (Vergleich ohne Leerzeichen und Trennzeichen). Der Betrag aus BHB wird nicht mehr gegen ein beschriftetes „Brutto“ verglichen (eine Zeile „EUR brutto 100,00“ im Guthabenhinweis täuschte einen Betragsfehler vor), sondern gilt als auffällig nur, wenn er nirgends im Text steht. Die Rechenprobe erkennt „Summe Netto 19 % 46,86“, „+19 % USt. auf 46,86 € 8,90 €“ und „Betrag 55,76 €“ und schlägt nur an, wenn keiner der Brutto-Kandidaten zu Netto + Steuer passt.

- Neu: Tool `check_receipt_fields` (49 Tools, schreibgeschützt): Heuristik auf dem PDF-Text eines Belegs für auffällige oder fehlende Pflichtangaben nach § 14 Abs. 4 UStG: Steuernummer/USt-IdNr. (Platzhalter wie „folgt“, „beantragt“, „wird nachgereicht“ werden erkannt), Anschrift, Datum, Rechnungsnummer (auch gegen die Nummer in BHB), Leistungsdatum/-zeitraum, Steuersatz oder Befreiungshinweis, Rechenprobe Netto + Steuer = Brutto (±0,01 €) und Vergleich mit dem Betrag in BHB. Die Antwort enthält nur Auffälligkeiten (`auffaellig`) und nicht Prüfbares (`nicht_pruefbar`), nie eine Freigabe; ohne Textebene steht „nichts geprüft“. Grenzen: Aussteller und Empfänger der Steuernummer sind nicht zu trennen, keine Steuerberatung, Plausibilität bei verbundenen Unternehmen bleibt beim Nutzer.

- Fix: Antworten mit Zusatzfeldern neben `data` (`missing_invoicenumbers`, `query_counts`, `booking_hints`, `warnings`, ...) scheiterten im Client mit „Structured content does not match the tool's output schema: data must NOT have additional properties“ (live: `list_receipts` mit `invoicenumbers`, `list_transactions` mit `booked`). Der Server nimmt `additionalProperties: false` jetzt aus allen Output-Schemas. Neue Tests in `server-schema.test.ts` rufen die Tools über einen echten MCP-Client auf, der gegen das Schema validiert; die bisherigen Tests prüften nur die Handler und sahen den Fehler nicht.

- Fix: `posting_status.booked` ist `null` (unbekannt), wenn der Durchlauf der Buchungen abgebrochen wurde und zu einem Umsatz keine Buchung gesehen wurde; vorher `false`. Bei `list_transactions` mit `booked` bleiben solche Umsätze in beiden Filtern, damit eine mögliche Doppelbuchung nicht als „offen“ durchgeht.
- Neu: `get_account_ledger` liefert im Standardsatz `tax_key`, `tax_key_effective` und `vatPostingaccountNumbers` (wie BHB die Steuer gespeichert hat) und markiert Zeilen auf USt-/VSt-Konten mit `is_tax_line: true`. Ein `vat_code` (19_vat usw.) wird bewusst nicht abgeleitet: BHB gibt den beim Buchen übergebenen Code nicht zurück, die Zuordnung Schlüssel ↔ Code ist nur für 101 ↔ 19_vat beobachtet.

- Neu: Buchungsstatus je Bankumsatz. `get_transaction` liefert `posting_status` {booked, posting_ids, splits, fixed}; `list_transactions` mit `with_posting_status` ebenso, mit `booked: true|false` filtert es auf gebuchte bzw. offene Umsätze (Durchlauf des ganzen Datumsfensters wie bei `query`). Quelle ist ein Durchlauf von `postingsGet` über die Datumsspanne der Umsätze (Buchungen tragen `transaction_id_by_customer` und das Umsatzdatum, live geprüft); bei Abbruch nach 10 Seiten steht der Hinweis, dass `booked: false` falsch sein kann.
- Neu: `list_postings` mit `transaction_id_by_customer` und `receipt_id_by_customer` (lokaler Filter nach Durchlauf des Datumsfensters; Antwort nennt gescannte und passende Buchungen). Für `get_account_ledger` nicht möglich: die Kontenblatt-Zeilen tragen keine Umsatz-ID.
- Neu: `list_receipts` mit `invoicenumbers` (bis 20 Nummern, je Nummer und Richtung ein paralleler Abruf, `list_direction: both` deckt „any“ ab); Nummern ohne Treffer stehen in `missing_invoicenumbers`.
- Doku: negative Splits für Rechnungskorrekturen/Gutschriften innerhalb derselben Zahlung in `add_transaction_postings` und im Guide `gutschrift_verrechnen` (in der BHB-Oberfläche verifiziert, über den Konnektor ungeprüft, `dry_run` prüft nur lokal und beweist nichts über BHB, also einen Umsatz buchen und das Kontenblatt prüfen; Rückfall: Betrag je Rechnung nach Verrechnung).

- Neu: Warnung W1 bei `add_transaction_postings`/`add_free_postings`: ein PDF-Beleg nennt „Reverse-Charge“, „Steuerschuldner des Leistungsempfängers“ oder „§ 13b“, die Buchung trägt aber `vat 0_none`
  (Hinweis auf 19_both_511/506; Ausnahme Zahlung eines schon auf einem Kreditor gebuchten Belegs). Höchstens 5 PDF-Abrufe je Aufruf, nur Belege mit Textebene, nichts wird geändert.
  W2 (Lieferantenland) entfällt bewusst: die API liefert kein Land, Anschriften aus dem PDF-Text zu lesen ist zu unzuverlässig.

- Doku: Guide `fremdwaehrung` um Sofortzahlung (tatsächlich abgebuchter Euro-Betrag, Bagatellregel laut Wiki), kreditorische Variante mit SKR03 2660/2150 und den ISO-Code am Beleg ergänzt; `reverse_charge_drittland` nennt das Automatikkonto 3125 | 5925 (Kz 84) als ungeprüfte zweite Route.

- Doku: Guide `reverse_charge_drittland` und `lieferantenportal_abgleich` nennen die Oberflächenoption „Drittland (§ 13b Abs. 2 Nr. 1)“ für Schlüssel 511 und erklären die Kurs-Warnung: BHB setzt den Tageskurs automatisch, am Beleg ist er manuell anpassbar; ein auffälliger Kurs heißt „angepasst oder Rechnung/Kartenumsatz weichen ab“, kein Buchungsfehler an sich.

- Neu: Warnungen beim Buchen mit Beleg (`add_transaction_postings`, `add_free_postings`, auch mit `dry_run`): (W4) § 13b-Schlüssel, aber Leistungs-/Belegdatum und Zahlungsdatum in verschiedenen
  Quartalen oder Jahren, Hinweis „Meldeperiode weicht ab“ (Zahllast neutral, nicht umdatieren); (W3) Fremdwährungsbeleg, dessen Kurs mehr als 5 % vom Median der bis zu 5 zeitlich
  nächsten Belege desselben Lieferanten abweicht (mindestens 3 Vergleichsbelege). Nur Hinweise, nichts wird geändert; höchstens 24 Beleg-Abrufe je Aufruf, Abruffehler erzeugen keine Warnung.
  W1/W2 (Beleg-Volltext, Lieferantenland) bleiben offen.
- Verifiziert: Zuordnung der §13b-Schlüssel zur USt-VA (Entwurf 2026 in BHB, Abgleich mit den Kontenblättern von 1787 nach Steuerschlüssel, stimmt auf den Cent):
  `19_both_506` = Kz 46/47 (§ 13b Abs. 1, übriges Gemeinschaftsgebiet), `19_both_511` = Kz 84/85 („Andere Leistungen“, § 13b Abs. 2 Nr. 1, 2, 4 bis 11, u. a. Drittland),
  Vorsteuer beider = Kz 67. `get_ustva_position` liefert beide Zeilen getrennt; `vat`-Beschreibung, Server-Instruktionen, Guide und Doku tragen die Zuordnung statt „unbestätigt“.
  Nicht geprüft bleiben `19_both_1`, `19_both_6506`/`6511`/`6501` und die `_app`-Varianten.
- Neu: PayPal-Business-Debit-Cashback wird erkannt (Zahlung mit `type` „Cash Back Bonus“ und PayPal als Gegenpartei, positiver Betrag). `list_transactions` und `get_transaction` liefern dann `booking_hints` (Konto Sonstige Erträge SKR03 2700 / SKR04 4830, `vat` `0_none`, Text „PayPal Business Debit Cashback“, kein Beleg) samt Textblock. Die BHB-Liste liefert `type` nicht (live geprüft), deshalb schlägt `list_transactions` positive Zahlungen von „PayPal … Debit Card“ einzeln nach (höchstens 25 je Aufruf, Rest als `unconfirmed_ids`). `add_transaction_postings` warnt (auch bei `dry_run`), wenn bei einer Cashback-Zahlung Konto, `vat` oder Text abweichen; dafür ein lesender `transactionsGet` über den ID-Bereich des Batches plus Einzelabfragen für Kandidaten. `list_transactions` beschreibt `id_by_customer_from`/`_to` als exklusive Grenzen (live beobachtet). Neues Thema `paypal_cashback` in `get_booking_guide`, Begründung und Quellen in [docs/rechtsgrundlagen-paypal-cashback.md](docs/rechtsgrundlagen-paypal-cashback.md) (nicht steuerbar, keine Vorsteuerkorrektur, Betriebseinnahme; kein BMF-Schreiben oder Urteil zu genau diesem Fall).
- Doku/Tests: Beispielnummern in den Tests und im Code-Kommentar von `pair_receipt_family` durch erfundene ersetzt.
- Neu: Tool `preview_vat_impact` (48 Tools, schreibgeschützt): Summen der Vorsteuer- und Umsatzsteuerkonten (SKR03 1571/1576/1577 und 1771/1776/1787, SKR04 1401/1406/1407 und 3801/3806/3837) aus den Kontenblättern eines Zeitraums, daraus Zahllast oder Erstattung mit den Kennziffern. `base` Standard `date_delivery_else_date` (wie die USt-VA). Ausdrücklich nicht die ELSTER-Zahl; den Entwurf in der BHB-Oberfläche gegenprüfen. Kontenrahmen wird bei SKR03 erkannt, sonst `chart` angeben. An einem echten Q3 gegen das Kontenblatt 1576 nachgerechnet (25 Zeilen, 351,77).
- Neu: `add_free_postings` stellt (als `warnings`, auch bei `dry_run`) die Rückfrage „Zahlt ein Dritter? Zahlungsdatum erfragen“, wenn eine Buchung mit Vorsteuer (`*_pre`) über das Interimskonto (SKR03 1590, SKR04 1370) läuft. Bei Ist-Versteuerung zählt das Zahlungsdatum; ohne Angabe mit Rechnungsdatum buchen und per `add_comment` vermerken. Erkennung nur an Konto und Vorsteuercode, bei anderem Zweck des Interimskontos ignorieren.
- Neu: Tool `pair_receipt_family` (47 Tools, schreibgeschützt): fasst übergebene Beleg-IDs zu Fällen (Abrechnung, Rechnung, Zahlung) zusammen, anhand einer Nummer, die im PDF-Text von mindestens zwei Belegen steht (eine Nummer, die in mehr als `max_family_size` Belegen vorkommt, zählt nicht). Je Fall und Beleg: zugeordnete Zahlungen aus BHB (nie per Betrag geraten) und Lücken (keine Zahlung, kein Datum, Zahlungen weichen vom Belegbetrag ab). Belege ohne Textebene oder ohne gemeinsame Nummer stehen unter `unassigned` mit der Rückfrage an den Nutzer. Zuordnung ist eine Textheuristik und vor dem Buchen zu bestätigen. Ein Buchstabenpräfix vor der Nummer zählt nicht (Abrechnung `2026-10001`, Rechnung `KR-2026-10001` sind derselbe Fall). Hängt dieselbe Zahlung an mehreren Belegen eines Falls und weicht vom Betrag ab, steht das als Hinweis (Drittzahlung); übersteigen die Zahlungen den Belegbetrag, als Lücke (vermutlich falsche Zuordnung bei gleich hohen Zahlungen). An 40 echten Belegen geprüft: 20 Fälle gefunden, 3 Fehlzuordnungen gemeldet. Neu auf Fallebene (`case_gaps`): Belege eines Falls ohne gemeinsame Zahlung und eine Zahlung, die an Belegen verschiedener Fälle hängt (Kreuzzuordnung bei gleich hohen Beträgen).
- Neu: `list_receipts` warnt (zusätzlicher Textblock und `structuredContent.warnings`) bei Belegen ohne Datum in der Liste und bei `date_since_last_modified` (nicht verlässlich für „was ist neu“, beobachtet: neue Belege fehlten). Die Liste selbst bleibt unverändert.
- Neu: `get_booking_guide` Themen `gegenertrag_interimskonto` (Aufwand mit Vorsteuer und Gegenertrag über 1590 in zwei freien Buchungen, vermeidet Fehler 31; Käuferzahlung als Privateinlage 1890; paarweise Prüfung statt Saldo; Rechenprobe der Abrechnung; Rückfrage nach dem Zahlungsdatum bei Drittzahlung; Risikohinweis Gewerblichkeit) und `buchungstexte` (konstante Texte je Fallart).
- Neu: `add_receipt_postings`, `add_transaction_postings` und `add_free_postings` warnen (auch bei `dry_run`), wenn ein `postingtext` Rechnungsnummer, Datum oder Klammerzusatz enthält, und schlagen einen bereinigten Text vor. Der Text wird nie geändert. Beispieltexte in den Tool-Beschreibungen ohne Rechnungsnummer.

- Fix: `npm audit fix` (Abhängigkeiten `proxy-addr`, `source-map-js`, `fast-uri` und `@modelcontextprotocol/sdk` auf gepatchte Versionen; nur `package-lock.json`).
- Doku: `docs/bhb-systematik.md` um Parameter-Warnung, `query` bei `list_transactions` (live bestätigt: `to_from` ist kein Textfilter, HTTP 400) und `amount` als Zahl ergänzt; Tests für die Buchungsmuster Drittland-SaaS und Sammelzahlung.

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
