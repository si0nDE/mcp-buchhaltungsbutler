# BuchhaltungsButler-Systematik im Konnektor

Quelle: Wissensdatenbank von BuchhaltungsButler (Artikel zu Zahlungszuordnung am Beleg, abweichendem Leistungsdatum,
Ist-/Soll-Wechsel, Steuerschlüsseln/§13b/Automatikkonten, Saldovortrag USt/VSt, Anfangsbeständen). Die API erzwingt
diese Regeln nicht und beschreibt sie nicht im Schema; der Konnektor bildet sie deshalb in Tool-Beschreibungen,
Server-Instruktionen und wenigen Vorab-Prüfungen ab.

| Regel in BHB | Wo im Konnektor |
| --- | --- |
| Reihenfolge: Beleg prüfen → Beleg buchen (Debitor/Kreditor) → Zahlung zuweisen → Zahlung buchen. Zuweisen erzeugt keine Buchung. | Server-Instruktionen, `confirm_payment`, `cancel_posting` |
| „Unter-/Überzahlt" vergleicht nur Rechnungs- und Zahlbetrag; Skonto, Gebühren, Sammelzahlung verfälschen die Anzeige. | Server-Instruktionen; `confirm_payment` verweist für abweichende Beträge auf `add_transaction_postings` |
| Auswertungen: BWA, SuSa und Kontenblatt per API (`create_report`/`get_report`/`get_account_ledger`). Berichte entstehen asynchron, ein neuer Bericht gleichen Typs ersetzt den alten. SuSa/Kontenblatt standardmäßig nach Buchungsdatum, mit `base=date_delivery_else_date` nach Leistungsdatum (passt zur USt-VA). | Beschreibungen der Berichts-Tools, Server-Instruktionen |
| OSS (One-Stop-Shop): sechs `vat_oss_*`-Codes mit Herkunfts-/Bestimmungsland und Steuersatz je Buchungszeile; OSS muss in den Steuereinstellungen aktiviert sein. | `vat`-Codes, Split-Felder `oss_*`, Vorab-Prüfung (Länder, nicht identisch, Satz außer bei `vat_oss_deli_eude_19`) |
| `confirm_payment` bucht mit `0_none` gegen Debitor/Kreditor – für Belege ohne Debitor/Kreditor-Buchung (EÜR) ist es falsch. | Beschreibung `confirm_payment` |
| Abweichendes Leistungsdatum darf nicht nach dem Belegdatum liegen; wirkt nur bei Debitor/Kreditor-Belegen. BWA und USt (Ausgang) nach Leistungsdatum, Vorsteuer, ZM und Kontenblätter standardmäßig nach Belegdatum (abweichend per `base=date_delivery_else_date`). | `create_receipts`/`upload_receipt` prüfen `date_delivery ≤ date` vor dem Senden; `create_invoice`/`create_einvoice` warnen bei `date_of_supply`, das BHB ignoriert oder nur aufs PDF druckt |
| Ist/Soll wird erst bei der Auswertung berechnet, nicht gebucht; ein Wechsel ändert auch vergangene Auswertungen. | Server-Instruktionen (kein Tool – die Einstellung gibt es in der API nicht) |
| Steuerschlüssel: Aufwand nur Vorsteuer, Ertrag nur USt; ausländische USt = `0_none`; i.g.E. nur Waren; Code §13b nur EU-Dienstleistungen (Sachverhalt 7), sonst Automatikkonto; 07–12/2020 gelten 16 %/5 % über dieselben Codes; Codes 57–59 muss der Steuerberater anlegen. | `vat`-Beschreibung aller Buchungs-Tools |
| Anlagenverwaltung (Anlagegüter, GWG, Sammelposten) gibt es nur in der BHB-Oberfläche; die API hat keine Anlagen-Endpunkte. Erfassung/Ausbuchen per Dialog nach Bestätigung der Buchung, danach bucht BHB monatlich automatisch ab (auch rückwirkend). | Warnung bei Buchungen auf Konten 0001–0599 (`add_*_postings`), keine Beispiel-AfA mehr in `add_free_postings`, Hinweis in `list_posting_accounts` und Server-Instruktionen |
| Erlös-/Aufwandskonten und alle USt/VSt-Konten starten jedes Wirtschaftsjahr bei 0; Bestands-, Basis- und Debitor/Kreditor-Konten werden fortgeschrieben. | Server-Instruktionen, `add_free_postings` |
| EB-Werte: Gegenkonto 9000 (unterjährig 9090), Datum 31.12. des Vorjahres; Bank/Kasse als manuelle Transaktion; Korrektur nur als Differenz; offene Posten besser als unbezahlte Belege erfassen. | `add_free_postings`, `create_transactions` |
| USt/VSt-Saldo manuell auf 1790/3841 vortragen; Vorauszahlung Dez (und Nov bei Dauerfrist) am 31.12. von 1780/3820 auf 1789/3840, am 01.01. auf 1790/3841. Gewinn-/Verlustvortrag gegen 9000. | `add_free_postings` |

Anlagen: Der Konnektor kann kein Anlagegut anlegen, ausbuchen oder löschen. Den Weg über die Weboberfläche (Übernahme bestehender Güter) beschreibt
der Leitfaden-Eintrag `anlagen_browser`; er stammt aus der Übergabe des Teams, nicht aus einem BHB-Artikel, und ist nur für einen Fall getestet
(Einzelunternehmen, EÜR, SKR03, Übernahme zum 01.01.). DOM-Namen und Abläufe können sich mit einem BHB-Update ändern. Die Warnung ist ein Hinweis, keine Sperre:
Wer ein Anlagegut per API bucht, muss es anschließend in BHB erfassen („Erfassen" bzw. „Bestehendes Anlagegut übernehmen"),
und darf die Abschreibung nicht manuell nachbuchen. Der Konten-Bereich 0001–0599 ist bewusst eng gewählt (SKR03 und
SKR04 Anlagevermögen, ohne SKR03-Verbindlichkeiten/Kapital ab 0600); er schließt Finanzanlagen mit ein, die nicht
abgeschrieben werden – die Warnung nennt die Erfassung dann trotzdem, das ist gewollt konservativ.

Bewusst nicht automatisiert: Alle Jahresabschluss- und Vortragsbuchungen macht normalerweise der Steuerberater; der
Konnektor weist darauf hin, bucht sie aber nicht von selbst. Beim Anlegen der Buchungen vorher mit dem Steuerberater
klären, ob sie für den Mandanten relevant sind.

Skonto: BHB dokumentiert ihn als negativen Teilbetrag an der Zahlung mit dem Steuersatz der Rechnung (Artikel „Erhaltenen und
gewährten Skonto verbuchen"). Dass das auch per `add_transaction_postings` so funktioniert (mehrere Splits, Summe = Zahlbetrag),
ist daraus abgeleitet und nicht live verifiziert; ebenso, dass `confirm_payment` unter Ist-Versteuerung die USt-Umbuchung
auslöst (folgt aus dem EB-Artikel, dort wird sie für Buchungen ohne Belegverknüpfung ausdrücklich ausgeschlossen).

## Sonderfälle und Kontierungstipps: `get_booking_guide`

Das Tool liefert ohne Parameter die Themenliste und mit `topic` Regeln, Konten (SKR03 | SKR04), Beispielbuchungen und Fallstricke
des jeweiligen Wissensdatenbank-Artikels (kein API-Aufruf; Daten in `src/tools/booking-guide.ts`, geprüft durch einen Test, dass
jeder der 31 Quell-Artikel abgedeckt ist). Themen: `abschreibung`, `rap`, `auslagen`, `ist_versteuerer_debitoren`,
`differenzbesteuerung`, `amazon`, `steuersatz_5_5_10_7`, `gutschrift_verrechnen`, `skonto`, `dreiecksgeschaeft`, `eu_neufahrzeug`,
`geldtransit`, `prepaid`, `lohn`, `mwst_senkung_2020`, `storno_ruecklastschrift`, `trinkgeld`, `split_buchung`, `oss`, `ausland_ust`,
`fremdwaehrung`, `iab`; dazu die Best Practices `erste_schritte`, `wechsel_zu_bhb`, `monatsabschluss`, `automatisierungsregeln`,
`bedienung_shortcuts`, `buchungsvormerkung_eur`, `ausgangsrechnung_kasse`, sowie `anlagen_browser` und `belegpruefung` (Team-Übergaben).

Zusätzlich im Code umgesetzt:

| Regel in BHB | Wo im Konnektor |
| --- | --- |
| Ausgangsrechnungen mit 5,5 %/10,7 % USt sind nicht verbuchbar (nur Eingangsrechnungen per Split-Workaround). | `create_invoice` warnt (`unbookableRateWarnings`) |
| Freie Buchung auf ein Debitor/Kreditor-Konto gleicht keinen Beleg aus und löst unter Ist-Versteuerung keine USt-Umbuchung aus. | `add_free_postings` warnt bei Konten ab 10000 (`personenkontoWarnings`), sperrt aber nicht (Anfangsbestände sind erlaubt) |
| Negativer Split kehrt Soll/Haben um und ist für Skonto/Saldierung gedacht; die Summe muss der Zahlung entsprechen. | Beschreibung `add_transaction_postings` |
| `create_receipts` akzeptiert nur USD/GBP/CHF, `upload_receipt` nur EUR als Währung. | Feldbeschreibungen `currency` |
| Direkte Buchung zwischen Zahlungskonten ist gesperrt, beide Seiten laufen über Geldtransit. | Server-Instruktionen, Thema `geldtransit` |

### Was die Artikel nicht hergeben
- **Bilder:** Die Buchungsbeispiele stehen in Screenshots. Die vier Abschreibungs-Beispiele (AfA-Konto, Buchungen Jahr 1 bis 13) liegen auf einem CDN, das
  automatische Abrufe sperrt; sie wurden nicht umgangen. Der Eintrag `abschreibung` nennt deshalb keine AfA-Kontonummer.
- **SKR04:** Viele Bildbeispiele zeigen nur SKR03; die SKR04-Nummer ist per `list_posting_accounts` nachzuschlagen.
- **Unstimmigkeiten in den Artikeln (nicht übernommen, im Eintrag vermerkt):** Im Dreiecksgeschäft-Bild stehen USt und Vorsteuer mit
  vertauschtem Soll/Haben (das Neufahrzeug-Beispiel zeigt die fachlich richtige Richtung); die Privateinlagen werden als 2180 und 2190
  genannt; das Abschreibungsbeispiel (13 Jahre, Kauf im September) rechnet bis „Jahr 13" nur 144 statt 156 Monate, der Leitfaden nennt deshalb
  nur die Regel (Nutzungsdauer x 12 Monate, Restmonate im letzten Jahr); der Einzweck-Gutschein wird mit „§ 3 Abs. 13f UStG" zitiert, der
  Leitfaden schreibt nur „§ 3 UStG".

## Best Practices der Wissensdatenbank: was davon in den Konnektor passt

Von den neun Best-Practice-Artikeln sind die meisten Oberflächen-Anleitungen. Sie stehen als Leitfaden-Einträge im Tool, damit ein Agent den
Nutzer richtig anleiten kann; per API umsetzbar ist nur ein Teil:

| Artikel | Im Konnektor |
| --- | --- |
| Monatsabschluss-Schritte | Tool `check_month_end` (read-only): Duplikatsverdacht, Zahlungen/Belege ohne Buchung, nicht festgeschriebene Buchungen, Saldo Geldtransit/Interimskonto. Banksalden, Plausibilisierung, Festschreiben und USt-VA stehen als `nicht_pruefbar` in der Antwort (kein Endpunkt). |
| Erste Schritte | Eintrag `erste_schritte` und Server-Instruktion: Bilanzierer buchen Belege + Ausgleich, EÜR nur Zahlungen; nur Kontenrahmen und Länge der Sachkonten sind später nicht änderbar. |
| Wechsel zu BHB, Lexware-Export | Eintrag `wechsel_zu_bhb` (Typen A-E, 9000, Reihenfolge Import vor Bank). Import und Bankverbindung nur in der Oberfläche. |
| Automatisierungsregeln | Eintrag `automatisierungsregeln`. Regeln lassen sich per API weder anlegen noch lesen. Der Code-Tipp ist in der Feldbeschreibung `correspondence` von `create_invoice` verankert. |
| Hacks/Shortcuts, Schnellfilter | Eintrag `bedienung_shortcuts`; Oberfläche. Per API: `manage_account` mit `is_disabled_in_select` blendet ein Basiskonto aus. |
| Buchungsvormerkung (EÜR) | Eintrag `buchungsvormerkung_eur`. Undokumentierte Endpunkte `/postings-reservations/add\|get\|delete` existieren, liefern aber „insufficient privileges" (siehe unten). Kein Tool. |
| Ausgangsrechnungen in der Kasse | Eintrag `ausgangsrechnung_kasse`; `receipt_creates_transaction` wirkt nur für Eingangsbelege (Feldbeschreibung). |

## Belegprüfung: nur im Browser

Stand 07.10.2026, ermittelt mit API-Tests gegen Spec v1.9.1 und die Live-API sowie einem Mitschnitt der Weboberfläche (Thema `belegpruefung`).

- **Was „geprüft" ist:** Die Weboberfläche führt am Beleg `confirmationStatus` (`unconfirmed` / `confirmed`). Er wechselt, wenn der
  Bearbeiten-Dialog gespeichert wird: `POST /receipts/dialog-receipt-details` mit `action=editReceipt` auf `app.buchhaltungsbutler.de`, mit allen
  Belegfeldern. Prüfen und Korrigieren sind derselbe Schritt.
- **Warum der Konnektor das nicht kann:** Der Pfad verlangt eine angemeldete Browser-Sitzung und lehnt API-Zugangsdaten mit 401 ab; der Login ist
  durch reCAPTCHA geschützt. Die API selbst hat keinen Endpunkt zum Ändern von Belegfeldern oder zum Setzen des Status (geprüft: alle dokumentierten
  Pfade, die verwaisten Definitionen der Spec, die Pfad-Familien mit Typ-Parameter und rund 300 Namenskandidaten). `confirmationStatus` fehlt auch in
  der ungekürzten Antwort von `receipts/get`.
- **Ersatzsignal:** `list_receipts` mit `date_since_last_modified` liefert nur Belege, die in der Oberfläche bearbeitet wurden. Upload, Zuordnung,
  Zahlungsbuchung und Kommentar setzen es nicht. Eine Beobachtung, kein dokumentiertes Kennzeichen.
- **Alternative mit Debitoren-/Kreditorenbuchhaltung:** Mit aktivierter Debitorenbuchhaltung lässt sich ein Beleg per `add_receipt_postings` buchen;
  laut Beobachtung in der Oberfläche gilt er dann als geprüft. Per API nicht verifiziert (ohne Aktivierung: Fehler 12 „debtor posting is not
  activated"). Das Buchen korrigiert keine Felder, die Aktivierung geht nur in der Oberfläche und ändert die Buchungslogik des ganzen Mandanten
  (bei EÜR/Ist-Versteuerung mit dem Steuerberater klären).
- **Buchungsvormerkung:** `/postings-reservations/add`, `/get`, `/delete` existieren (401 statt 404; die Spec enthält nur ihre Antwortschemas),
  antworten mit gültigen Zugangsdaten aber mit Fehler 4 „insufficient privileges", auch wenn alle dokumentierten Endpunkte funktionieren.

### Grenzen von `check_month_end`
- Die API liefert an Belegen und Zahlungen keinen Buchungsstatus. „Gebucht" wird aus den Buchungen im Zeitraum abgeleitet (Verweis über `receipt_id_by_customer`,
  `receipts_assigned_ids_by_customer`, `transaction_id_by_customer`). Das ist eine Näherung: eine Buchung mit abweichendem Datum wird nicht erkannt, und ein
  Beleg, dessen Zahlung nur gegen ein Debitoren-/Kreditorenkonto gebucht wurde, gilt in BHB als ungebucht, hier aber als gebucht.
- Beim Saldo von Geldtransit/Interimskonto zählt nur der Zeitraum, sofern `balance_from` nicht auf den Beginn des Wirtschaftsjahres gesetzt wird. Die Konten
  werden über ihren Namen im Kontenplan gefunden.
- Pro Abfrage werden höchstens 10 Seiten gelesen; bei Überschreitung warnt die Antwort (`unvollstaendig`), statt ein falsches `ok` zu melden.
- Nicht live gegen ein Konto verifiziert; die Felder stammen aus der Spec.

## Fehlerbehebung, Administratives, Funktionen & Einstellungen: Auswertung von 135 Artikeln

Drei Kategorien der Wissensdatenbank wurden durchgesehen (135 Artikel). Nach Relevanz für den Konnektor ausgewählt und eingearbeitet:

| Bereich | Umsetzung |
| --- | --- |
| USt-VA-Kennziffern (95 Konten, maschinell aus dem Artikel übernommen) und Regeln nach Steuerschlüssel | Tool `get_ustva_position` (kein API-Aufruf) |
| „Kontostand berechnen" (Summe der Zahlungen bis zum Stichtag, mit Abgleich zum Kontoauszug) | Tool `calculate_account_balance`, Hinweis in `check_month_end` |
| 0,00-€-Zahlungen sind nicht buchbar, Verwendungszweck höchstens 500 Zeichen | Vorab-Prüfung in `create_transactions` (`assertTransactionEntry`) |
| Gesperrte Kontonummern für individuelle Sachkonten (SKR03/SKR04) | `manage_posting_account` ergänzt eine Ablehnung durch BHB um den Hinweis; keine Vorab-Sperre, weil sich die Nummern der Kontenrahmen überschneiden |
| Ausgleich von Debitor/Kreditor immer ohne Steuer, keine Doppelerfassung, Beleg vor Zahlung, „Beleg erzeugt Zahlung" und D/K | Beschreibungen `add_receipt_postings`/`add_transaction_postings`, Thema `debitoren_kreditoren_logik` |
| Upload-Regeln (Formate, 50 Seiten/20 MB, OCR nur erste Seiten, kein Duplikatwarnung, Kontingent), Zahlungsreferenz-Signalwörter, Matching-Regeln | Beschreibungen `upload_receipt`/`create_receipts`/`assign_receipts_to_transactions`/`set_receipt_deleted`/`unassign_receipt`, Filter `invoicenumber`/`due_date` bei `list_receipts` (Duplikatprüfung), Thema `belege_upload_matching` |
| Auswertungen berücksichtigen nur bestätigte Buchungen | Beschreibungen `create_report`/`get_report`, Server-Instruktionen, Thema `auswertungen` |
| Revisionssichere Konten, zulässige Nummernbereiche der Basiskonten, Kostenstellen, E-Rechnungs-Pflichtangaben, Rechnungsnummern | Feldbeschreibungen bei `create_account`, `manage_account`, Kostenstellen- und Rechnungs-Tools; Themen `konten_einrichtung`, `kostenstellen`, `rechnungen_erstellen` |
| Festgeschriebenes entfernen, Eigenbeleg, GoBD, Paket/Kontingent/API-Rechte, Bilanz-Integrität, Zahlungsprobleme, Einstellungen | Themen `festgeschriebene_loeschen`, `eigenbeleg`, `paket_und_limits`, `bilanz_integritaet`, `zahlungen_probleme`, `einstellungen_aendern` |

Bewusst nicht übernommen (reine Oberflächen- oder Vertriebsinhalte ohne Wirkung auf API-Nutzung): Bank- und Kreditkartenanbindung (finAPI/Qwist),
CSV-Import-Formate der Zahlungsdienstleister (Etsy, eBay, Klarna, Kaufland, Wise, Shopify, Amazon Pay), Datenexporte an Steuerberater-Software,
Überweisungen und Rechnungsfreigabe, Nutzerverwaltung, Datenschutz-/TOM-Dokumente, Kündigung/Preise, Premium-Services, Scan-App und Scanlösungen.

### Korrekturen an früheren Einträgen
- `eu_neufahrzeug`: Die Zuordnungstabelle weist die USt auf Konto 1784 in Kz 96 und die Vorsteuer auf 1584 in Kz 61 aus; Kz 94 gehört zum gesperrten Automatikkonto
  3440 | 5440. Der Artikel selbst nennt 61 und 94: der Eintrag vermerkt die Abweichung.
- `belege`: Die OCR liest laut Upload-Artikel bis Seite 3; der GoBD-Artikel spricht von bis zu vier Seiten. Der Leitfaden schreibt: ab vier Seiten keine Erkennung.
- Privateinlagen: Der zulässige Bereich ist 1890-1899 (SKR03) bzw. 2180-2189 (SKR04); die in einem Artikel genannte 2190 liegt außerhalb.

### Nicht live verifiziert
Die Felder, aus denen `check_month_end` und `calculate_account_balance` rechnen, und die Konten-Hinweise stammen aus Spec und Artikeln. Ob die API-Codes `19_*`/`7_*`
sich in 2020 wie die „impliziten" Steuersätze verhalten, ist weiterhin nicht dokumentiert.
