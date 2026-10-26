# Reisekostenabrechnung – Häufige Fragen

Hintergrund zu `generate_travel_expense_report` und `generate_and_upload_travel_expense_report`. Quellen mit Kennzeichnung V (gelesen) / A (Auslegung) / U (nicht verifiziert): [rechtsgrundlagen-reisekosten.md](rechtsgrundlagen-reisekosten.md). Ersetzt keine Steuerberatung, siehe Haftungshinweis unten.

## Was rechnet das Tool, was nicht?

Es rechnet deterministisch im Konnektor (nicht in der KI): Verpflegungspauschalen Inland und Ausland, Mahlzeitenkürzung, Dreimonatsfrist, Übernachtungspauschale (nur Angestellte), Kilometergeld, Belege mit Vorsteuerlogik, Summen, Warnungen. Daraus entstehen ein PDF im Stil der Bewirtungsangaben und ein Buchungshinweis. `generate_travel_expense_report` ist schreibgeschützt und ruft BuchhaltungsButler nicht auf; `generate_and_upload_travel_expense_report` lädt das PDF zusätzlich hoch. **Gebucht wird nie automatisch.**

Nicht abgedeckt: private Reiseanteile, Lohnabrechnung, A1-Bescheinigung und DBA-Fragen, doppelte Haushaltsführung, Reisen ohne klare Stationen. Eine Reise darf höchstens 366 Kalendertage umfassen.

## Angestellte oder Selbstständige (`traveller_type`)?

- `employee`: Angestellte **und** Gesellschafter-Geschäftsführer mit Anstellungsvertrag (Arbeitnehmer, § 19 EStG); Erstattung durch den Arbeitgeber (§ 3 Nr. 16 EStG, § 9 Abs. 4a EStG, R 9.4 ff. LStR).
- `self_employed`: Selbstständige, Einzelunternehmer und Gesellschafter-Geschäftsführer ohne Anstellungsvertrag (`owner_manager`); Betriebsausgabe (§ 4 Abs. 5 Satz 1 Nr. 5 EStG i. V. m. § 9 Abs. 4a EStG, R 4.12 EStR).

Im Zweifel beim Nutzer erfragen; die Einordnung des Gesellschafter-Geschäftsführers ist ein Punkt für den Steuerberater (siehe unten), denn Übernachtungspauschale und Frühstückskürzung hängen daran. Die Verpflegungspauschalen sind für beide gleich. Unterschiede gibt es bei der Übernachtung (siehe nächste Frage), beim Frühstück im Hotelpreis, bei den Buchungskonten und beim Gesellschafter-Geschäftsführer mit der Vorab-Vereinbarung (siehe unten).

Name der reisenden Person und Reisezweck fragt das Tool nicht selbst ab: Die Tool-Beschreibung weist das Modell an, beides beim Nutzer zu erfragen und nie abzuleiten, und das Tool lehnt fehlende oder pauschale Angaben ab ("Geschäftsreise" oder "Kundenbesuch" als Zweck; R 9.4 Abs. 1 Satz 5 LStR: berufliche Veranlassung aufzeichnen).

## Übernachtungspauschale oder Belege?

Die Pauschale (Inland 20 €, Ausland laut Tabelle) gibt es nur für **Angestellte bei Erstattung durch den Arbeitgeber** (`use_lodging_flat_rate`). Bei `self_employed` (Selbstständige und Gesellschafter-Geschäftsführer ohne Anstellungsvertrag) lehnt das Tool die Pauschale ab: Weder R 4.12 EStR noch das BMF-Schreiben vom 23.12.2014 kennen sie, die LStR nur als steuerfreie Arbeitgebererstattung (R 9.7 Abs. 3 LStR). Das ist eine **Auslegung (A)**, im Beleg entsprechend gekennzeichnet. Selbstständige erfassen die tatsächlichen Kosten als Beleg.

Die Zahl der Nächte kommt aus dem Datumsunterschied (`nights` in der Antwort, informativ; die gezahlten Pauschalnächte stehen in `lodging_flat`). Nicht gezählt werden die Nacht der Heimreise vor 06:00 Uhr sowie Nächte im Flugzeug oder auf dem Schiff, soweit das Tool für die Etappe Zwischentage rechnet (erste Etappe oder Etappe mit `departs_at`, siehe Flug- und Schiffsreisen). Stimmt die Zahl nicht, korrigiert `lodging_nights` (nur nach unten). Pauschale und Beleg für dieselbe Nacht gleichzeitig führen zu einer Warnung.

## Was zählt als "Mahlzeit gestellt"?

Mahlzeiten, die der Arbeitgeber oder ein Dritter stellt oder veranlasst (`meals_provided`, je Datum Frühstück, Mittag, Abend). Gekürzt wird tageweise um 20 % (Frühstück) bzw. je 40 % (Mittag-/Abendessen) der 24-Stunden-Pauschale, höchstens bis 0 € (§ 9 Abs. 4a Satz 8 bis 10 EStG), unabhängig davon, ob die Mahlzeit eingenommen wird. Bei Angestellten gilt ein im Hotelpreis enthaltenes Frühstück als gestellt und kürzt die Pauschale am Folgetag, auch wenn das Unternehmen das Hotel direkt bezahlt hat (`paid_by: "company"`); der Hotelpreis bleibt ungekürzt. Das ist eine **Auslegung (A)**, gestützt auf Rz. 117 BMF 25.11.2020 (erstattet der Arbeitgeber das Frühstück mit der Übernachtung, wird die Verpflegungspauschale gekürzt); Punkt für den Steuerberater. Bei Selbstständigen wird das Frühstück aus dem Hotelpreis herausgerechnet (Rz. 118 BMF 2020; 20 % der 24-Stunden-Pauschale am Unterkunftsort, d. h. am Tag, an dem die Nacht beginnt, oder der ausgewiesene Betrag, `breakfast_amount`); das ist ebenfalls eine Auslegung. Liegt das Belegdatum außerhalb der Reisetage, schätzt das Tool den Anteil mit dem Inlandssatz 28 € und warnt.

Eigene Mahlzeiten des Reisenden sind nur über die Pauschale abziehbar. Bewirtung von Geschäftspartnern gehört auf einen eigenen Bewirtungsbeleg ([bewirtungsbeleg-faq.md](bewirtungsbeleg-faq.md)).

## Wie werden Abwesenheitszeiten gerechnet?

Eintägige Reise ohne Übernachtung: 14 € ab mehr als 8 Stunden (Inland). Mehrtägig: 14 € am An- und Abreisetag (ohne Mindestdauer), 28 € für Tage dazwischen. Rückkehr um genau 00:00 Uhr zählt als Ende um 24:00 Uhr des Vortags. Tätigkeit über Nacht ohne Übernachtung (`overnight_without_accommodation`, nur über genau zwei Kalendertage): 14 € für den Tag mit der überwiegenden Abwesenheit, aber nur, wenn die Abwesenheit an beiden Tagen zusammen mehr als 8 Stunden beträgt.

Im Ausland zählt der Ort, der vor 24 Uhr Ortszeit zuletzt erreicht wird. Die Rückkehr nach Hause muss nicht als Station erfasst werden. Wird sie doch als letzte Station (Deutschland) nach Auslandsstationen erfasst und kommt die erste Inlandsstation nach dem letzten Auslandsort am Rückreisetag an, rechnet das Tool den Rückreisetag mit dem Satz des letzten Auslandsorts (§ 9 Abs. 4a Satz 5 EStG: liegt der zuletzt erreichte Ort im Inland, gilt der letzte Tätigkeitsort im Ausland) und weist darauf hin. Das gilt nur für den letzten Reisetag. Kommt die erste Inlandsstation früher an (z. B. Wien, dann zwei Tage Arbeit in München), gilt am Rückreisetag der Inlandssatz.

## Dreimonatsfrist und Unterbrechung

Nur die ersten drei Monate an derselben Tätigkeitsstätte erhalten Verpflegungspauschale; eine Unterbrechung von mindestens vier Wochen setzt die Frist zurück (§ 9 Abs. 4a Satz 6 und 7 EStG). Das Tool kennt die Vorgeschichte nicht: Mit `same_location_since` (Beginn an dieser Tätigkeitsstätte) rechnet es die Frist, ohne die Angabe warnt es, dass die Frist nicht geprüft wurde.

## Auslandstabelle: Quelle und jährliche Aktualisierung

Die Sätze stammen aus der BMF-Tabelle ab 01.01.2026 (BMF 05.12.2025, IV C 5 - S 2353/00094/007/012, BStBl I S. 2078; 166 Länder, 214 Einträge). Sie liegt als erzeugte Datei `src/tools/travel-rates-2026.ts` im Repo. Orte werden exakt, über Aliase oder über einen eindeutigen Namensanfang erkannt; ein unbekannter Ort fällt mit Warnung auf den Satz "im Übrigen" zurück. Länder, die nicht in der Tabelle stehen, erhalten den Luxemburg-Satz (mit Warnung); Mikronesien und mehrere karibische Staaten verwenden nach den Fußnoten der Tabelle die Sätze der Philippinen bzw. von Trinidad und Tobago.

**Eingebaut ist nur 2026.** Inlandstage brauchen keine Tabelle (28 €, 14 € und 20 € stehen im Gesetz bzw. in R 9.7 Abs. 3 LStR) und werden in jedem Jahr gerechnet; reine Inlandsreisen lösen nie einen Abruf aus. Für ein Reisejahr mit Auslandstagen ohne eingebaute Tabelle bricht das Tool nicht ab, sondern geht so vor:

1. **Online-Abruf** der Tabelle von der Seite der Lohnsteuer-Hinweise: `https://lsth.bundesfinanzministerium.de/lsth/<Jahr>/B-Anhaenge/Anhang-25/I/inhalt.html`, ersatzweise derselbe Pfad auf `ksth.bundesfinanzministerium.de`. Nur diese beiden Hosts, nur https, die Adresse wird nur aus der Jahreszahl (2025 bis 2100) gebildet; eine Weiterleitung auf einen anderen Host wird abgelehnt; Zeitlimit 15 Sekunden, höchstens 3 MB, nur HTML. Die Seite wird nur als Daten gelesen und vor der Verwendung geprüft: Überschrift "Übersicht über die ab 1. Januar <Jahr> geltenden Pauschbeträge ..." mit genau diesem Jahr, mindestens 150 Länder, Luxemburg und Österreich vorhanden, Teilsatz nie über dem Vollsatz, Werte zwischen 1 und 1000, bei Ländern mit Städten eine Zeile "im Übrigen". Jeder Fehler (Netz, Status, Prüfung) gilt als "nicht verfügbar", nie als Abbruch. Die Quelle (Adresse und Abrufdatum) steht in der Antwort (`rates_sources`) und auf der Hinweisseite des PDF.
2. **Vorläufig:** Ist die Tabelle nicht verfügbar, rechnet das Tool die Auslandstage mit der letzten eingebauten Tabelle (höchstes Jahr bis zum Reisejahr, sonst das höchste) und markiert das deutlich: Warnung "BMF-Auslandstabelle <Jahr> nicht verfügbar … vorläufig mit der Tabelle <Jahr> berechnet", `rates_provisional: true`, `provisional` an den betroffenen Tagen, Hinweis **VORLÄUFIG** auf Seite 1 des PDF. Nach Veröffentlichung neu berechnen, bevor die Buchung bestätigt wird.

Ein erfolgreicher Abruf bleibt für die Laufzeit des Konnektors im Speicher, ein Fehlschlag 10 Minuten (damit nicht jeder Aufruf erneut auf das Zeitlimit wartet). Mit `BHB_TRAVEL_RATES_ONLINE=0` (oder `false`) ist der Abruf abgeschaltet; dann wird ohne Netzzugriff sofort vorläufig gerechnet.

Das BMF-Schreiben für das Folgejahr erscheint üblicherweise im Dezember; die LStH-Seite kann später folgen. Geprüft am 26.10.2026: Die Seiten für 2025 und 2026 existieren unter diesem Adressmuster (Abruf und Prüfung erfolgreich, 2025: 179 Länder, 224 Einträge), für 2027 kam HTTP 404. Eine eingebaute Tabelle fügt man weiterhin mit dem Skript hinzu: `npx tsx scripts/generate-travel-rates.ts <Jahr> <HTML-Datei> "<Quellenangabe>" <Abrufdatum>` und in `src/tools/travel-rates.ts` in `TABLES` eintragen; dann ist kein Abruf mehr nötig.

## Flug- und Schiffsreisen: Zwischentage

Bei Flügen zählt der Staat der Landung. Dauert eine Flugreise mehr als zwei Kalendertage, gilt für die Zwischentage der Satz für Österreich; bei Schiffsreisen für die Zwischentage der Satz für Luxemburg, am Ein- und Ausschiffungstag der des Hafenorts (R 9.6 Abs. 3 LStR). Eine eigene Zeitzonenregel gibt es nicht, der Ort vor 24 Uhr Ortszeit zählt.

Dafür die Beförderungsart je Station (`transport`: `flight`, `ship`) angeben. Eine Station hat nur eine Ankunftszeit; wann die Etappe dorthin begann, weiß das Tool nur so:

- **Erste Station:** Die Etappe beginnt mit der Abreise (`departure`).
- **Ab der zweiten Station:** nur mit `departs_at` (Abflug bzw. Abfahrt in Ortszeit am vorigen Ort, zwischen der Ankunft an der vorigen Station und der Ankunft hier). Ohne `departs_at` gilt die Etappe als am Ankunftstag zurückgelegt: keine Zwischentage, keine Transitnächte. Liegen zwischen der vorigen Ankunft und dieser Ankunft zwei oder mehr Kalendertage, weist das Tool darauf hin. So ergibt ein kurzer Rückflug nach drei Tagen in Paris keine Österreich-Tage.

Nur für Etappen, für die das Tool Zwischentage rechnet, zählen die Nächte im Flugzeug oder an Bord (Nacht des Abflug- bzw. Einschiffungstags und die Zwischentage) nicht als Übernachtung und erhalten keine Übernachtungspauschale.

## Fahrtkosten und Kilometergeld

0,30 €/km Pkw, 0,20 €/km anderes motorbetriebenes Fahrzeug (`km_trips`). Nur für **private** Fahrzeuge (R 4.12 Abs. 2 EStR): `ownership` ist Pflicht und beim Nutzer zu erfragen; ohne Angabe lehnt das Tool ab, bei `ownership: "business"` (Betriebs-Pkw) ebenfalls, dort zählen die tatsächlichen Kosten als Beleg. Fahrrad und Mitnahme von Personen: keine Pauschale. Die Entfernungspauschale gehört nicht in die Reisekostenabrechnung.

## Warum kein Eigenbeleg bei fehlendem Beleg?

In den gelesenen Texten kommt der "Eigenbeleg" als Nachweis nicht vor: Reisekosten sind nachzuweisen oder glaubhaft zu machen, sonst schätzt das Finanzamt nach § 162 AO. Deshalb erzeugt das Tool keinen Ersatzbeleg. Mit `receipt_missing: true` wird die Position markiert, es gibt eine Warnung, und es gibt keine Vorsteuer.

## Vorsteuer: Rechnung auf die Firma, Flug, Ausland

Das Tool übernimmt Steuersatz und Steuerbetrag so, wie sie auf dem Beleg stehen, und leitet sie nicht aus dem Satz her.

- **Rechnungsempfänger** (`invoice_recipient`, beim Nutzer erfragen): Vorsteuer nur bei Rechnung auf die Firma, bei Rechnungen bis 250 € brutto auch sonst (Kleinbetragsrechnung, § 33 UStDV). Die Grenze gilt **je Beleg**: Positionen mit derselben `receipt_id` werden zusammengezählt (Bruttobeträge in Euro, vor einem herausgerechneten Frühstück). Lautet die Rechnung auf den Reisenden und liegt über 250 €, gibt es keinen Vorsteuerabzug (UStAE 15.2a Abs. 3).
- **Zwei Steuersätze auf einem Beleg** (z. B. Hotel 7 % und Getränke 19 %): als **zwei** Positionen mit **derselben `receipt_id`** erfassen, jede mit einem `vat_rate`/`vat_amount`. Ohne `receipt_id` zählt jede Position für die 250-€-Grenze einzeln. Positionen einer `receipt_id` brauchen dieselbe Währung, denselben Rechnungsempfänger und denselben Zahler (`paid_by`).
- **Flug**: Vorsteuer nur bei ausgewiesener Umsatzsteuer auf dem Ticket; sonst Warnung (§ 35 Abs. 2 UStDV; grenzüberschreitend ggf. Erlass nach § 26 Abs. 3 UStG, die Praxis der Airlines ist nicht belegt, U).
- **Ausländische Umsatzsteuer** (`foreign_vat`): kein deutscher Vorsteuerabzug, nur EU-Erstattungsverfahren (§ 18g UStG, BZSt-Portal, Frist 30. September des Folgejahres, Mindestbetrag 400 € bzw. 50 € beim Jahresantrag). Hat ein Beleg an einem Auslandstag oder in Fremdwährung Umsatzsteuer und ist `foreign_vat` nicht gesetzt, warnt das Tool (sonst würde deutsche Vorsteuer angesetzt).
- **Pauschalen**: nie Vorsteuer (keine Rechnung).
- **Fremdwährung**: `fx_rate` und `fx_source` sind Pflicht. Für die Umsatzsteuer gilt der BMF-Monatsdurchschnittskurs (§ 16 Abs. 6 UStG); er wird hier als Ansatz verwendet. Für die Einkommensteuer ist der Kurs nicht ausdrücklich geregelt, das Tool warnt.
- **Hotel 2026**: Übernachtung 7 %, Verpflegung ohne Getränke seit 1.1.2026 ebenfalls 7 %, Getränke 19 % (BMF 22.12.2025). Der Satz des Frühstücks im Sammelposten ist nicht eindeutig geregelt; das Tool warnt.

## Vom Unternehmen bezahlte Kosten (`paid_by`)

Standard ist `paid_by: "traveller"`: Die reisende Person hat bezahlt und bekommt den Betrag erstattet. Hat das Unternehmen direkt bezahlt (Firmenkarte, Hotelrechnung an die Firma bezahlt), `paid_by: "company"` setzen (beim Nutzer erfragen). Die Position steht dann in der Abrechnung (Status "vom Unternehmen gezahlt") und in `costs`, zählt aber nicht zum Gesamtbetrag, zum Erstattungsbetrag, zum hochgeladenen Belegbetrag und zu den Buchungssplits; sie wird über ihren eigenen Beleg gebucht. Die Summe steht nachrichtlich in `totals.companyPaid` und in der Summenbox. Das gilt für Angestellte und Selbstständige gleich. Ein im Hotelpreis enthaltenes Frühstück kürzt bei Angestellten trotzdem die Verpflegungspauschale (siehe oben). Positionen mit derselben `receipt_id` brauchen denselben `paid_by`. Sind nur vom Unternehmen gezahlte Kosten erfasst und gibt es keine Verpflegungspauschale, ist der Gesamtbetrag 0 €: Das Tool weist darauf hin, dass nichts erstattet wird, und das Upload-Tool lädt den Beleg mit Betrag 0 € hoch (mit Hinweis, kein Fehler).

## Belege und Fahrten außerhalb der Reise

Liegt das Datum eines Belegs oder einer Kilometerfahrt vor dem Abreise- oder nach dem Rückkehrdatum, gibt es je Position einen Hinweis (kein Fehler, z. B. bei einer im Voraus gekauften Fahrkarte): Zuordnung zur Reise prüfen.

## Geschäftsführer: warum die Frage nach der Vorab-Vereinbarung?

Bei Gesellschafter-Geschäftsführern (`is_shareholder_manager: true`, beim Nutzer erfragen) ist `agreement_in_advance` Pflicht. Beim beherrschenden Gesellschafter wird die Veranlassung durch das Gesellschaftsverhältnis in der Regel angenommen, wenn eine klare, im Voraus getroffene Vereinbarung zur Reisekostenerstattung fehlt (R 8.5 Abs. 2 KStR, H 8.5 KStH): Risiko einer verdeckten Gewinnausschüttung. Ohne Vereinbarung gibt es eine Warnung.

## Buchungshinweis (`booking_hint`)

Die Antwort enthält Splits für die Buchungs-Tools; der Konnektor bucht nicht selbst, jede Buchung bestätigt der Nutzer. Konten SKR03 (in BuchhaltungsButler bestätigt):

| Position | Angestellte | Selbstständige/GF |
|---|---|---|
| Fahrt (Bahn, Flug, Taxi) | 4663 | 4673 |
| Kilometergeld | 4668 | 4678 |
| Verpflegung (Pauschale), `0_none` | 4664 | 4674 |
| Übernachtung | 4666 | 4676 |
| Nebenkosten | 4660 | 4676 |

Vorsteuer nur je Belegsatz (`19_pre`, `7_pre`) und nur bei Rechnung auf die Firma bzw. Kleinbetrag; Pauschalen, ausländische Steuer und Positionen ohne Beleg immer `0_none`. Ist der Kontenrahmen nicht SKR03 oder nicht ermittelbar (beim Nur-Erzeugen-Tool wird er nicht abgefragt), nennt der Hinweis keine Kontonummern. Das Konto 4672 (nicht abziehbarer Anteil) ist nicht belegt. Vom Unternehmen gezahlte Positionen (`paid_by: "company"`) sind nicht in den Splits; sie werden über ihren eigenen Beleg gebucht.

`posting_fields` im Hinweis enthält `traveler_name`, `traveler_role` (`employee` oder `owner_manager`) und `business_purpose`: Die bestehenden Buchungs-Tools `add_receipt_postings` und `add_transaction_postings` verlangen diese Angaben auf den Konten 4660 bis 4678.

## Erstattung: Auslagen-Verfahren

Bezahlt die reisende Person selbst, läuft die Erstattung über das Auslagen-Verfahren von BuchhaltungsButler (`get_booking_guide`, Thema `auslagen`): Sonstiges Basiskonto als Auslagenkonto (`create_account`, Typ `other`, `receipt_creates_transaction: true`); der dem Konto zugewiesene Beleg erzeugt die Zahlung; die Erstattung läuft als Bankabgang gegen Geldtransit 1360 (SKR03) | 1460 (SKR04) und eine manuelle Zahlung in gleicher Höhe auf dem Auslagenkonto, ebenfalls gegen Geldtransit. Bei Selbstständigen nennt der Hinweis ohne Basiskonto Privateinlagen (Einzelunternehmen) bzw. Verbindlichkeiten gegenüber Gesellschaftern (GmbH) als Gegenkonto.

## Upload: Was lädt das Tool hoch?

`generate_and_upload_travel_expense_report` lädt das PDF über denselben Endpoint wie `upload_receipt` hoch (Gegenpartei: die reisende Person, Datum: Rückkehrdatum) und liefert `id_by_customer` statt des PDFs. Der hochgeladene Belegbetrag ist der **Gesamtbetrag** (ohne vom Unternehmen gezahlte Positionen), nicht der Erstattungsbetrag nach Vorschuss.

Das Tool wiederholt den Upload **nie automatisch**: BuchhaltungsButler erkennt Duplikate nicht, und das Upload-Kontingent wird nicht erstattet. Schlägt der Upload fehl, kann der Beleg trotzdem angelegt sein; vor einem neuen Versuch per `list_receipts` (Gegenpartei und Datum) prüfen. Wird der Upload ohne ID quittiert, ebenfalls erst prüfen.

## Anhänge und E-Rechnungen

Belege können als Base64 (`attachments`: PDF, PNG, JPEG) hinter die Abrechnung gehängt werden; sie werden als Seiten angehängt. Eine in einer E-Rechnung eingebettete XML-Datei (ZUGFeRD/XRechnung) geht dabei **nicht** mit. E-Rechnungen im Empfangsformat separat aufbewahren (GoBD Rz. 131 in der Fassung des BMF-Schreibens vom 14.07.2025).

## Bestätigung durch die reisende Person

`traveller_confirmed: true` setzt man erst, nachdem die reisende Person die Angaben bestätigt hat; der Beleg trägt Name und Zeitstempel als elektronische Bestätigung. Ob das eine Unterschrift ersetzt, ist für Reisekosten nicht belegt (Punkt für den Steuerberater, GoBD-Grundtext nicht gelesen, U). Buchungsbelege sind 8 Jahre aufzubewahren (§ 147 Abs. 3 AO). Welche Anforderungen an die unveränderbare Aufbewahrung des erzeugten Belegs gelten, ist nicht verifiziert (U); der Konnektor hat keine eigene Tamper-Proof-Schicht.

## Eingabefelder im Überblick

Gegenüber der Spezifikation geändert oder ergänzt:

| Feld | Bedeutung |
|---|---|
| `km_trips[].ownership` | `private` oder `business`, **Pflicht** (in der Spezifikation `vehicle_ownership`). Ohne Angabe Fehler, bei `business` ebenfalls. |
| `stops[].departs_at` | Ergänzt: Beginn der Etappe zu dieser Station (ab der zweiten Station). Nur damit rechnet das Tool bei Flug und Schiff Zwischentage und Transitnächte. |
| `expenses[].receipt_id` | Ergänzt: Positionen mit derselben Kennung sind ein Beleg (250-€-Grenze, Rechnungsempfänger). Zwei Steuersätze = zwei Positionen mit derselben `receipt_id`. |
| `expenses[].paid_by` | Ergänzt: `traveller` (Standard, erstattet) oder `company` (vom Unternehmen gezahlt, nicht im Gesamtbetrag). |
| `lodging_nights` | Ergänzt: begrenzt die Zahl der Pauschalnächte nach unten. |

Die Antwort enthält neben `totals`, `days`, `costs` und `km` auch `nights` (aus den Zeiten abgeleitet, informativ), `lodging_flat` (gezahlte Pauschalnächte), `sources` (Quellen der Sätze), `rates_provisional` (Auslandssätze vorläufig ja/nein) und `rates_sources` (Tabelle je Jahr mit Auslandstagen: `year`, `origin` `builtin`/`online`/`provisional`, `source`, bei vorläufig `provisional_from`).

## Offene Punkte für den Steuerberater

Diese Punkte sind Auslegung (A) oder nicht verifiziert (U) und sollten vor Produktivbetrieb gegengelesen werden:

1. Ausschluss der Übernachtungspauschale bei Selbstständigen und Gesellschafter-Geschäftsführern ohne Anstellungsvertrag (A).
2. Frühstück im Hotel-Sammelposten 2026: Steuersatz im UStAE nicht eindeutig; Herausrechnen bei Selbstständigen (A).
3. Umrechnungskurs bei der Einkommensteuer: nicht ausdrücklich geregelt.
4. vGA-Anforderungen beim Gesellschafter-Geschäftsführer (Vorab-Vereinbarung).
5. Flugtickets ohne Steuerausweis (Praxis der Airlines nicht belegt, U).
6. GoBD-Anforderungen an den erzeugten Abrechnungsbeleg, auch elektronische Bestätigung statt Unterschrift (GoBD-Grundtext nicht gelesen, U).
7. Einordnung des Gesellschafter-Geschäftsführers mit Anstellungsvertrag (Arbeitnehmer, § 19 EStG) vs. ohne (Betriebsausgabe): Übernachtungspauschale und Frühstückskürzung hängen daran.
8. Frühstück im Hotelpreis bei Angestellten als gestellte Mahlzeit, auch bei vom Unternehmen bezahltem Hotel (A, Rz. 117 BMF 25.11.2020).

Ebenfalls offen: Auslandstabelle 2027 (nicht veröffentlicht, U; bis dahin rechnet das Tool 2027 vorläufig oder mit der online abgerufenen Tabelle, siehe oben). Außerdem sind Rechenregeln wie die Behandlung der Nacht der Heimreise vor 06:00 Uhr, die 8-Stunden-Prüfung über beide Tage bei Tätigkeit über Nacht, Flug- und Schiffsetappen ohne `departs_at` als Etappe am Ankunftstag und die Anwendung von § 9 Abs. 4a Satz 5 EStG (letzter Auslandsort) nur auf den Rückreisetag Lesarten bzw. Vereinfachungen (A).

Stand der Tests: Die Tools sind mit erfundenen Daten und über einen echten MCP-Client getestet; gegen ein echtes BuchhaltungsButler-Konto sind sie noch nicht gelaufen.

## Haftungshinweis

Diese Seite fasst unsere Recherche zusammen, ersetzt aber keine steuerliche Beratung. Vor
Produktivbetrieb sollten die rechtlichen Aussagen — insbesondere die BMF-Schreiben-Zitate — von
einem Steuerberater gegengelesen werden.
