# Reisekostenabrechnung – Häufige Fragen

Hintergrund zu `generate_travel_expense_report` und `generate_and_upload_travel_expense_report`. Quellen mit Kennzeichnung V (gelesen) / A (Auslegung) / U (nicht verifiziert): [rechtsgrundlagen-reisekosten.md](rechtsgrundlagen-reisekosten.md). Ersetzt keine Steuerberatung, siehe Haftungshinweis unten.

## Was rechnet das Tool, was nicht?

Es rechnet deterministisch im Konnektor (nicht in der KI): Verpflegungspauschalen Inland und Ausland, Mahlzeitenkürzung, Dreimonatsfrist, Übernachtungspauschale (nur Angestellte), Kilometergeld, Belege mit Vorsteuerlogik, Summen, Warnungen. Daraus entstehen ein PDF im Stil der Bewirtungsangaben und ein Buchungshinweis. `generate_travel_expense_report` ist schreibgeschützt und ruft BuchhaltungsButler nicht auf; `generate_and_upload_travel_expense_report` lädt das PDF zusätzlich hoch. **Gebucht wird nie automatisch.**

Nicht abgedeckt: private Reiseanteile, Lohnabrechnung, A1-Bescheinigung und DBA-Fragen, doppelte Haushaltsführung, Reisen ohne klare Stationen. Eine Reise darf höchstens 366 Kalendertage umfassen.

## Angestellte oder Selbstständige (`traveller_type`)?

- `employee`: Erstattung durch den Arbeitgeber (§ 3 Nr. 16 EStG, § 9 Abs. 4a EStG, R 9.4 ff. LStR).
- `self_employed`: Selbstständige und Geschäftsführer, Betriebsausgabe (§ 4 Abs. 5 Satz 1 Nr. 5 EStG i. V. m. § 9 Abs. 4a EStG, R 4.12 EStR).

Die Verpflegungspauschalen sind für beide gleich. Unterschiede gibt es bei der Übernachtung (siehe nächste Frage), bei den Buchungskonten und beim Geschäftsführer mit der Vorab-Vereinbarung (siehe unten). Name der reisenden Person und Reisezweck fragt das Tool aktiv ab; "Geschäftsreise" oder "Kundenbesuch" als Zweck werden abgelehnt (R 9.4 Abs. 1 Satz 5 LStR: berufliche Veranlassung aufzeichnen).

## Übernachtungspauschale oder Belege?

Die Pauschale (Inland 20 €, Ausland laut Tabelle) gibt es nur für **Angestellte bei Erstattung durch den Arbeitgeber** (`use_lodging_flat_rate`). Bei Selbstständigen und Geschäftsführern lehnt das Tool die Pauschale ab: Weder R 4.12 EStR noch das BMF-Schreiben vom 23.12.2014 kennen sie, die LStR nur als steuerfreie Arbeitgebererstattung (R 9.7 Abs. 3 LStR). Das ist eine **Auslegung (A)**, im Beleg entsprechend gekennzeichnet. Selbstständige erfassen die tatsächlichen Kosten als Beleg.

Die Zahl der Nächte kommt aus dem Datumsunterschied. Nicht gezählt werden die Nacht der Heimreise vor 06:00 Uhr sowie Nächte im Flugzeug oder auf dem Schiff. Stimmt die Zahl nicht, korrigiert `lodging_nights` (nur nach unten). Pauschale und Beleg für dieselbe Nacht gleichzeitig führen zu einer Warnung.

## Was zählt als "Mahlzeit gestellt"?

Mahlzeiten, die der Arbeitgeber oder ein Dritter stellt oder veranlasst (`meals_provided`, je Datum Frühstück, Mittag, Abend). Gekürzt wird tageweise um 20 % (Frühstück) bzw. je 40 % (Mittag-/Abendessen) der 24-Stunden-Pauschale, höchstens bis 0 € (§ 9 Abs. 4a Satz 8 bis 10 EStG), unabhängig davon, ob die Mahlzeit eingenommen wird. Bei Angestellten gilt ein im Hotelpreis enthaltenes Frühstück als gestellt und kürzt die Pauschale am Folgetag. Bei Selbstständigen wird das Frühstück aus dem Hotelpreis herausgerechnet (Rz. 118 BMF 2020; 20 % der 24-Stunden-Pauschale oder der ausgewiesene Betrag, `breakfast_amount`); das ist eine Auslegung.

Eigene Mahlzeiten des Reisenden sind nur über die Pauschale abziehbar. Bewirtung von Geschäftspartnern gehört auf einen eigenen Bewirtungsbeleg ([bewirtungsbeleg-faq.md](bewirtungsbeleg-faq.md)).

## Wie werden Abwesenheitszeiten gerechnet?

Eintägige Reise ohne Übernachtung: 14 € ab mehr als 8 Stunden. Mehrtägig: 14 € am An- und Abreisetag (ohne Mindestdauer), 28 € für Tage dazwischen. Rückkehr um genau 00:00 Uhr zählt als Ende um 24:00 Uhr des Vortags. Tätigkeit über Nacht ohne Übernachtung (`overnight_without_accommodation`, nur über genau zwei Kalendertage): 14 € für den Tag mit der überwiegenden Abwesenheit, aber nur, wenn die Abwesenheit an beiden Tagen zusammen mehr als 8 Stunden beträgt.

## Dreimonatsfrist und Unterbrechung

Nur die ersten drei Monate an derselben Tätigkeitsstätte erhalten Verpflegungspauschale; eine Unterbrechung von mindestens vier Wochen setzt die Frist zurück (§ 9 Abs. 4a Satz 6 und 7 EStG). Das Tool kennt die Vorgeschichte nicht: Mit `same_location_since` (Beginn an dieser Tätigkeitsstätte) rechnet es die Frist, ohne die Angabe warnt es, dass die Frist nicht geprüft wurde.

## Auslandstabelle: Quelle und jährliche Aktualisierung

Die Sätze stammen aus der BMF-Tabelle ab 01.01.2026 (BMF 05.12.2025, IV C 5 - S 2353/00094/007/012, BStBl I S. 2078; 166 Länder, 214 Einträge). Sie liegt als erzeugte Datei `src/tools/travel-rates-2026.ts` im Repo. Orte werden exakt, über Aliase oder über einen eindeutigen Namensanfang erkannt; ein unbekannter Ort fällt mit Warnung auf den Satz "im Übrigen" zurück. Länder, die nicht in der Tabelle stehen, erhalten den Luxemburg-Satz (mit Warnung); Mikronesien und mehrere karibische Staaten verwenden nach den Fußnoten der Tabelle die Sätze der Philippinen bzw. von Trinidad und Tobago.

**Nur 2026.** Für ein anderes Reisejahr bricht das Tool mit Fehlermeldung ab; es rechnet nie still mit Vorjahreswerten. Das BMF veröffentlicht die Tabelle für das Folgejahr üblicherweise im Dezember (für 2027 ist sie noch nicht veröffentlicht, U). Jährlich: Tabelle mit `scripts/generate-travel-rates.ts` erzeugen (`npx tsx scripts/generate-travel-rates.ts <Jahr> <HTML-Datei> "<Quellenangabe>" <Abrufdatum>`) und in `src/tools/travel-rates.ts` in `TABLES` eintragen.

## Flug- und Schiffsreisen: Zwischentage

Bei Flügen zählt der Staat der Landung. Dauert eine Flugreise mehr als zwei Kalendertage, gilt für die Zwischentage der Satz für Österreich; bei Schiffsreisen für die Zwischentage der Satz für Luxemburg, am Ein- und Ausschiffungstag der des Hafenorts (R 9.6 Abs. 3 LStR). Dafür die Beförderungsart je Station (`transport`: `flight`, `ship`) angeben. Eine eigene Zeitzonenregel gibt es nicht, der Ort vor 24 Uhr Ortszeit zählt. Die Nächte auf diesen Zwischentagen erhalten keine Übernachtungspauschale.

## Fahrtkosten und Kilometergeld

0,30 €/km Pkw, 0,20 €/km anderes motorbetriebenes Fahrzeug (`km_trips`). Nur für **private** Fahrzeuge (R 4.12 Abs. 2 EStR); bei `ownership: "business"` (Betriebs-Pkw) lehnt das Tool ab, dort zählen die tatsächlichen Kosten als Beleg. Fahrrad und Mitnahme von Personen: keine Pauschale. Die Entfernungspauschale gehört nicht in die Reisekostenabrechnung.

## Warum kein Eigenbeleg bei fehlendem Beleg?

In den gelesenen Texten kommt der "Eigenbeleg" als Nachweis nicht vor: Reisekosten sind nachzuweisen oder glaubhaft zu machen, sonst schätzt das Finanzamt nach § 162 AO. Deshalb erzeugt das Tool keinen Ersatzbeleg. Mit `receipt_missing: true` wird die Position markiert, es gibt eine Warnung, und es gibt keine Vorsteuer.

## Vorsteuer: Rechnung auf die Firma, Flug, Ausland

Das Tool übernimmt Steuersatz und Steuerbetrag so, wie sie auf dem Beleg stehen, und leitet sie nicht aus dem Satz her.

- **Rechnungsempfänger** (`invoice_recipient`, beim Nutzer erfragen): Vorsteuer nur bei Rechnung auf die Firma, bei Rechnungen bis 250 € brutto auch sonst (Kleinbetragsrechnung, § 33 UStDV). Lautet die Rechnung auf den Reisenden und liegt über 250 €, gibt es keinen Vorsteuerabzug (UStAE 15.2a Abs. 3).
- **Zwei Steuersätze auf einem Beleg** (z. B. Hotel 7 % und Getränke 19 %): als **zwei** Ausgaben erfassen, jede mit einem `vat_rate`/`vat_amount`.
- **Flug**: Vorsteuer nur bei ausgewiesener Umsatzsteuer auf dem Ticket; sonst Warnung (§ 35 Abs. 2 UStDV; grenzüberschreitend ggf. Erlass nach § 26 Abs. 3 UStG, die Praxis der Airlines ist nicht belegt, U).
- **Ausländische Umsatzsteuer** (`foreign_vat`): kein deutscher Vorsteuerabzug, nur EU-Erstattungsverfahren (§ 18g UStG, BZSt-Portal, Frist 30. September des Folgejahres, Mindestbetrag 400 € bzw. 50 € beim Jahresantrag).
- **Pauschalen**: nie Vorsteuer (keine Rechnung).
- **Fremdwährung**: `fx_rate` und `fx_source` sind Pflicht. Für die Umsatzsteuer gilt der BMF-Monatsdurchschnittskurs (§ 16 Abs. 6 UStG); für die Einkommensteuer ist der Kurs nicht ausdrücklich geregelt, das Tool warnt.
- **Hotel 2026**: Übernachtung 7 %, Verpflegung ohne Getränke seit 1.1.2026 ebenfalls 7 %, Getränke 19 % (BMF 22.12.2025). Der Satz des Frühstücks im Sammelposten ist nicht eindeutig geregelt; das Tool warnt.

## Geschäftsführer: warum die Frage nach der Vorab-Vereinbarung?

Bei Gesellschafter-Geschäftsführern (`is_shareholder_manager: true`) ist `agreement_in_advance` Pflicht. Beim beherrschenden Gesellschafter wird die Veranlassung durch das Gesellschaftsverhältnis in der Regel angenommen, wenn eine klare, im Voraus getroffene Vereinbarung zur Reisekostenerstattung fehlt (R 8.5 Abs. 2 KStR, H 8.5 KStH): Risiko einer verdeckten Gewinnausschüttung. Ohne Vereinbarung gibt es eine Warnung.

## Buchungshinweis (`booking_hint`)

Die Antwort enthält Splits für die Buchungs-Tools; der Konnektor bucht nicht selbst, jede Buchung bestätigt der Nutzer. Konten SKR03 (in BuchhaltungsButler bestätigt):

| Position | Angestellte | Selbstständige/GF |
|---|---|---|
| Fahrt (Bahn, Flug, Taxi) | 4663 | 4673 |
| Kilometergeld | 4668 | 4678 |
| Verpflegung (Pauschale), `0_none` | 4664 | 4674 |
| Übernachtung | 4666 | 4676 |
| Nebenkosten | 4660 | 4676 |

Vorsteuer nur je Belegsatz (`19_pre`, `7_pre`) und nur bei Rechnung auf die Firma bzw. Kleinbetrag; Pauschalen, ausländische Steuer und Positionen ohne Beleg immer `0_none`. Ist der Kontenrahmen nicht SKR03 oder nicht ermittelbar (beim Nur-Erzeugen-Tool wird er nicht abgefragt), nennt der Hinweis keine Kontonummern. Das Konto 4672 (nicht abziehbarer Anteil) ist nicht belegt.

`posting_fields` im Hinweis enthält `traveler_name`, `traveler_role` (`employee` oder `owner_manager`) und `business_purpose`: Die bestehenden Buchungs-Tools `add_receipt_postings` und `add_transaction_postings` verlangen diese Angaben auf den Konten 4660 bis 4678.

## Erstattung: Auslagen-Verfahren

Bezahlt die reisende Person selbst, läuft die Erstattung über das Auslagen-Verfahren von BuchhaltungsButler (`get_booking_guide`, Thema `auslagen`): Sonstiges Basiskonto als Auslagenkonto (`create_account`, Typ `other`, `receipt_creates_transaction: true`); der dem Konto zugewiesene Beleg erzeugt die Zahlung; die Erstattung läuft als Bankabgang gegen Geldtransit 1360 (SKR03) | 1460 (SKR04) und eine manuelle Zahlung in gleicher Höhe auf dem Auslagenkonto, ebenfalls gegen Geldtransit. Bei Selbstständigen nennt der Hinweis ohne Basiskonto Privateinlagen (Einzelunternehmen) bzw. Verbindlichkeiten gegenüber Gesellschaftern (GmbH) als Gegenkonto.

## Upload: Was lädt das Tool hoch?

`generate_and_upload_travel_expense_report` lädt das PDF über denselben Endpoint wie `upload_receipt` hoch (Gegenpartei: die reisende Person, Datum: Rückkehrdatum) und liefert `id_by_customer` statt des PDFs. Der hochgeladene Belegbetrag ist der **Gesamtbetrag**, nicht der Erstattungsbetrag nach Vorschuss.

Das Tool wiederholt den Upload **nie automatisch**: BuchhaltungsButler erkennt Duplikate nicht, und das Upload-Kontingent wird nicht erstattet. Schlägt der Upload fehl, kann der Beleg trotzdem angelegt sein; vor einem neuen Versuch per `list_receipts` (Gegenpartei und Datum) prüfen. Wird der Upload ohne ID quittiert, ebenfalls erst prüfen.

## Anhänge und E-Rechnungen

Belege können als Base64 (`attachments`: PDF, PNG, JPEG) hinter die Abrechnung gehängt werden; sie werden als Seiten angehängt. Eine in einer E-Rechnung eingebettete XML-Datei (ZUGFeRD/XRechnung) geht dabei **nicht** mit. E-Rechnungen im Empfangsformat separat aufbewahren (GoBD Rz. 131 in der Fassung des BMF-Schreibens vom 14.07.2025).

## Bestätigung durch die reisende Person

`traveller_confirmed: true` setzt man erst, nachdem die reisende Person die Angaben bestätigt hat; der Beleg trägt Name und Zeitstempel als elektronische Bestätigung statt einer Unterschrift. Buchungsbelege sind 8 Jahre aufzubewahren (§ 147 Abs. 3 AO); die unveränderbare Aufbewahrung folgt der Festschreibung in BuchhaltungsButler, der Konnektor hat keine eigene Tamper-Proof-Schicht.

## Offene Punkte für den Steuerberater

Diese Punkte sind Auslegung (A) oder nicht verifiziert (U) und sollten vor Produktivbetrieb gegengelesen werden:

1. Ausschluss der Übernachtungspauschale bei Selbstständigen und Geschäftsführern (A).
2. Frühstück im Hotel-Sammelposten 2026: Steuersatz im UStAE nicht eindeutig; Herausrechnen bei Selbstständigen (A).
3. Umrechnungskurs bei der Einkommensteuer: nicht ausdrücklich geregelt.
4. vGA-Anforderungen beim Geschäftsführer (Vorab-Vereinbarung).
5. Flugtickets ohne Steuerausweis (Praxis der Airlines nicht belegt, U).
6. GoBD-Anforderungen an den erzeugten Abrechnungsbeleg (GoBD-Grundtext nicht gelesen, U).

Ebenfalls offen: Auslandstabelle 2027 (nicht veröffentlicht, U). Außerdem sind Rechenregeln wie die Behandlung der Nacht der Heimreise vor 06:00 Uhr und die 8-Stunden-Prüfung über beide Tage bei Tätigkeit über Nacht Lesarten des Gesetzes (A).

Stand der Tests: Die Tools sind mit erfundenen Daten und über einen echten MCP-Client getestet; gegen ein echtes BuchhaltungsButler-Konto sind sie noch nicht gelaufen.

## Haftungshinweis

Diese Seite fasst unsere Recherche zusammen, ersetzt aber keine steuerliche Beratung. Vor
Produktivbetrieb sollten die rechtlichen Aussagen — insbesondere die BMF-Schreiben-Zitate — von
einem Steuerberater gegengelesen werden.
