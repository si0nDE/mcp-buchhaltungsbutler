# Bewirtungsbeleg – Häufige Fragen

Hintergrund zum `generate_entertainment_receipt`-Tool. Ersetzt keine Steuerberatung — siehe Haftungshinweis unten.

## Warum ist keine handschriftliche Unterschrift nötig?

Für Bewirtungen ab 1.1.2025 gilt das BMF-Schreiben vom 19.11.2025 (Rz. 19: "elektronische Unterschrift
oder eine elektronische Genehmigung der entsprechenden Angaben" genügt, sofern diese nachträglich
nicht undokumentiert verändert werden können). Es ersetzt das ursprüngliche BMF-Schreiben vom
30.06.2021 (IV C 6 - S 2145/19/10003 :003), das inhaltlich dieselbe Erleichterung eingeführt hatte und nur
noch für Bewirtungen bis 31.12.2024 weiter anzuwenden ist. Der erzeugte Beleg dokumentiert deshalb
Name und Zeitstempel der bewirtenden Person statt eines Unterschriftenfelds.

## Wie ist die GoBD-Festschreibung sichergestellt?

Über die Buchung in BuchhaltungsButler: Sobald der Beleg gebucht und die Buchung festgeschrieben ist,
sorgt BuchhaltungsButler für die revisionssichere, unveränderbare Aufbewahrung. Der Connector selbst
implementiert keine eigene Tamper-Proof-Schicht.

## Was passiert, wenn der Beleg schon in BuchhaltungsButler existiert?

Die BuchhaltungsButler-API kann die Datei eines bereits hochgeladenen Belegs nicht ersetzen. In diesem
Fall (Fall B) erzeugt `generate_entertainment_receipt` — ohne `bill_file` — nur die eine Seite mit den
Bewirtungsangaben; sie wird per `upload_receipt` mit `link_to_receipt_id_by_customer` an den
bestehenden Beleg angehängt, statt beide Dateien zu einem PDF zu verschmelzen (Fall A, wenn die
Rechnung noch nicht hochgeladen ist). Rechtlich zulässig, da das BMF-Schreiben neben dem
Zusammenführen ausdrücklich auch die Verbindung "durch gegenseitigen Verweis" erlaubt.

## Warum erscheint die Bewirtungsseite als zweiter Beleg?

Das passiert bei Fall B (`link_to_receipt_id_by_customer`): BuchhaltungsButler kennt keinen Endpunkt, der eine Datei
an einen bestehenden Beleg anhängt oder ersetzt (Spec geprüft: nur `add`, `addBatch`, `upload`, `delete`,
`restore`), die Verknüpfung erzeugt deshalb einen eigenen Beleg. Stattdessen `source_receipt_id_by_customer`
nutzen: Der Konnektor lädt das Original, hängt die Seite an und lädt **einen** neuen Beleg hoch.

## Wie lösche ich das Original?

Erst nach Prüfung des neuen Belegs und nur auf Bestätigung: `set_receipt_deleted` mit `deleted: true` auf das
Original (Soft-Delete, per `deleted: false` wiederherstellbar). Der Konnektor löscht nie automatisch. Danach auf den
neuen Beleg buchen.

## Warum ist die Datei nicht byte-identisch mit dem Original?

`pdf-lib` kennt kein inkrementelles Speichern und schreibt die Datei beim Speichern komplett neu. Der **Inhalt**
der Originalseiten (und eingebettete Dateien, Titel/Autor) bleibt erhalten, die **Bytes** nicht. Ausgeglichen wird
das durch den SHA-256 des Originals in der Fußzeile der Bewirtungsseite und durch das erhaltene (soft-gelöschte)
Original in BuchhaltungsButler. JPEG-Originale werden unverändert eingebettet, PNG verlustfrei neu verpackt.

## Warum sieht der neue Beleg in BuchhaltungsButler wie ein Duplikat aus?

BuchhaltungsButler dedupliziert Belege nicht automatisch nach Rechnungsnummer. Wird ein Beleg erneut
importiert oder eine Bewirtungsangaben-Seite per `generate_and_upload_entertainment_receipt` bzw.
`upload_receipt` mit `link_to_receipt_id_by_customer` zu einem bestehenden Beleg hochgeladen (z. B. weil
der ursprüngliche Versand fehlschlug oder ein Anhang verloren ging), entsteht ein neuer, eigenständiger
Beleg-Datensatz mit identischer Rechnungsnummer, Gegenpartei und Betrag wie das Original — nur verknüpft,
nicht strukturell als Anlage erkennbar. Nach jedem erneuten Versand/Upload deshalb per `list_receipts`
(gefiltert nach Gegenpartei und Datum) auf Duplikate prüfen und überzählige mit `set_receipt_deleted`
entfernen, bevor der Beleg weiterverarbeitet wird.

Mit `source_receipt_id_by_customer` entsteht bewusst ein neuer Beleg neben dem Original (das erst nach Bestätigung
per `set_receipt_deleted` entfernt wird); gleiche Gegenpartei/Datum/Rechnungsnummer stehen dann in
`duplicates_found` (Abgleich über Datum + Gegenpartei + Betrag, nicht über die Rechnungsnummer; `linked_to_original` zeigt alte Fall-B-Seiten, die mit dem Original verknüpft sind). Schlägt der Upload per Timeout fehl, wird nicht automatisch wiederholt - vor einem neuen Versuch
per `list_receipts` prüfen, ob der Beleg trotzdem angelegt wurde.

## Woher kommt die Aufteilung 70 % / 30 %?

§ 4 Abs. 5 Satz 1 Nr. 2 EStG. Bei vorsteuerabzugsberechtigten Unternehmen (Regelbesteuerung, Default)
wird sie auf den Nettobetrag (inkl. Trinkgeld, da ohne Umsatzsteuer) angewendet; die Vorsteuer bleibt
davon unabhängig zu 100 % abziehbar (§ 15 UStG). Bei Kleinunternehmern (§ 19 UStG,
`kleinunternehmer: true`) auf den Bruttobetrag, da keine separate Vorsteuerbuchung existiert.

## Wer gehört auf die Teilnehmerliste?

§ 4 Abs. 5 Satz 1 Nr. 2 Satz 3 EStG verlangt Angaben zu den "Teilnehmern ... der Bewirtung" — nicht zu den
Teilnehmern einer größeren umgebenden Veranstaltung. Maßgeblich ist **nicht**, wer mit am Tisch saß, sondern
wessen Verzehr durch den konkreten Beleg tatsächlich bezahlt wurde. Das schließt die eigenen Mitarbeitenden
ein, unabhängig davon, ob mit jeder einzelnen Person gesprochen wurde.

**Getrennte Zahlung ist der häufigste Stolperstein:** Wenn ein Teil der Anwesenden für sich selbst bezahlt
hat (z. B. jedes Fördermitglied zahlt seinen eigenen Teil), deckt der Beleg nur die tatsächlich davon
bezahlten Personen ab — auch wenn andere mit am Tisch saßen. Eine mitgelieferte Teilnehmerliste einer
größeren Veranstaltung (z. B. eine Anmeldeliste) beantwortet diese Frage nicht und darf nicht ungeprüft
übernommen werden; wer aus diesem konkreten Betrag bewirtet wurde, muss aktiv erfragt werden, bevor der
Beleg erzeugt wird. Ein Betrag, der rechnerisch nur zu wenigen der genannten Personen passt (z. B. Portionen
für 2 Personen bei 5 gelisteten Teilnehmern), ist ein Hinweis darauf, dass diese Rückfrage noch fehlt.

## Warum lehnt das Tool manche Anlass-Angaben ab?

Der Bundesfinanzhof hat pauschale Formulierungen wiederholt nicht anerkannt, u. a. "Geschäftsessen",
"Kontaktpflege", "Geschäftsbesprechung" (BFH v. 15.01.1998, IV R 81/96, BStBl II 1998, 263; BFH v.
26.02.2004, IV R 50/01, BStBl II 2004, 502). Der Anlass muss so konkret sein, dass ein Außenstehender
den geschäftlichen Zusammenhang sofort erkennt.

## Warum wird der Audit-Kommentar beim Buchen gekürzt, und was passiert, wenn er scheitert?

BuchhaltungsButler akzeptiert `comment_text` nur mit 2 bis 210 Zeichen, sonst HTTP 400 „invalid comment_text
specified". Teilnehmer plus konkreter Anlass überschreiten das schnell; der Konnektor kürzt den Kommentar deshalb
auf höchstens 210 Bytes (Teilnehmer zuerst, der Anlass bleibt möglichst vollständig - der volle Wortlaut steht auf
der Bewirtungsangaben-Seite). Der Kommentar wird erst **nach** der Buchung angelegt. Scheitert er trotzdem, meldet
der Aufruf die Buchung als erfolgt und gibt eine Warnung zurück, statt mit einem Fehler abzubrechen - ein erneuter
Buchungsversuch würde doppelt buchen.

## Wie buche ich 4650 auf den vollen Betrag und danach 4654 per Umbuchung?

`entertainment_split_mode: "net_reclass"` bei `add_transaction_postings`/`add_receipt_postings`: Es wird nur 4650
(SKR04 6640) mit vollem Betrag und Vorsteuer gebucht. Die Antwort enthält `entertainment_reclass_hints` mit den
30 % vom **Netto** (Netto wird aus den USt-Codes der Splits abgeleitet). Diese Umbuchung (Soll 4654 an Haben 4650,
`vat: 0_none`) bucht der Konnektor nicht selbst, sondern sie wird mit `add_free_postings` angelegt. Der Standard
`gross_split` (beide Konten im selben Aufruf, 70/30 auf die gebuchten Beträge) bleibt unverändert.

## Was, wenn die Gaststättenrechnung fehlt?

Mit `original_invoice_status: "missing_requested"` (beim Gastwirt angefordert, nicht erhalten) oder `"lost"` (verloren oder unleserlich) erzeugt `generate_and_upload_entertainment_receipt` die Bewirtungsseite ohne Rechnung. Pflicht sind der Zahlbetrag (`gross_amount`, inklusive Trinkgeld), ein Zahlungsnachweis (`payment_evidence`), die Bewirtungsart (`entertainment_type`), bei `missing_requested` mindestens eine Anforderung (`invoice_requests`) und ohne Quell-Beleg die Gaststätte (`counterparty`). Fehlen mehrere Felder, nennt eine Fehlermeldung alle auf einmal. Speisen- und Getränkebeträge müssen leer bleiben: eine erfundene Aufteilung wäre falsch.

Die Seite ist dann selbst der Beleg (ein Upload, ohne Vorsteuer). Mit `payment_evidence.transaction_id_by_customer` prüft der Konnektor den Betrag der Banktransaktion (Toleranz 0,01 €). Zugeordnet wird der neue Beleg der Transaktion nur im Weg ohne `source_receipt_id_by_customer`; mit Quell-Beleg nennt die Antwort die Zuordnung nur als Hinweis (das Original kann schon zugeordnet sein). Die Antwort enthält `booking_hint` mit den Splits für die Buchungs-Tools (SKR03 4650/4654 (SKR04 6640/6644, sobald der Kontenrahmen als SKR04 erkannt wird; ist er nicht ermittelbar, ohne Kontonummern), immer `0_none`).

Für geschäftliche Bewirtung (§ 4 Abs. 5 Satz 1 Nr. 2 EStG) gibt es zwei Varianten, die der Nutzer **jedes Mal** wählt (`missing_invoice_treatment`):

| Variante | Buchung | Quelle |
|---|---|---|
| `practice_70_30_no_vat` | 70/30 des Zahlbetrags, keine Vorsteuer | Dennerlein Q42, bezogen auf Beträge unter 250 €; Anerkennung offen |
| `conservative_100_nondeductible` | 100 % auf 4654/6644, keine Vorsteuer | BFH X R 57/09 |

Über 250 € ist die Praxisvariante nur mit `acknowledge_practice_over_250: true` möglich, beim Generator wie bei `add_receipt_postings`/`add_transaction_postings` (dort zählt die Summe der Splits auf 4650/4654 bzw. 6640/6644); keine Quelle deckt diesen Fall ab.

**Warum zwei Varianten?** Der BFH verlangt bei Bewirtung in einer Gaststätte die Rechnung „ohne Ausnahme“ und lässt keinen Eigenbeleg als Ersatz zu (BFH X R 57/09 und X R 58/09). Die Seminarunterlagen von Dennerlein (Haufe-Lexware Akademie, 16.09.2026, Q42) empfehlen für Beträge unter 250 € trotzdem 70/30 ohne Vorsteuer und halten die Anerkennung offen. Der Konnektor entscheidet das nicht still.

Die Bewirtungsangaben sollen zeitnah entstehen (BMF 19.11.2025 Rn. 1 und 22). Eine Frist nennt der Erlass nicht; der Konnektor warnt ab mehr als 10 Tagen mit Orientierung an GoBD Rz. 47.

**Deprecated: `host_confirmed`.** `host_confirmed` an den Buchungs-Tools ist deprecated. `host_confirmed: true` entspricht `bewirtungsangaben_signed: true` plus `original_invoice_status: "present"`. Die Kombination mit `bewirtungsangaben_signed` oder `original_invoice_status` wird abgelehnt, damit es nur eine Quelle der Wahrheit gibt. `entertainment_type`, `missing_invoice_treatment`, `shareholder_manager_treatment` und `participant_relations` lassen sich mit dem Alias kombinieren. Jede Antwort mit `host_confirmed` enthält einen Deprecation-Hinweis.

## Welche Bewirtungsart (`entertainment_type`)?

| Typ | Gilt für | Buchung (SKR03) |
|---|---|---|
| `business` | mindestens ein Betriebsfremder | 70 % 4650 / 30 % 4654, Vorsteuer voll bei Rechnung |
| `business_mixed` | eigene Leute und Fremde | Gesamtbetrag 70/30 (R 4.10 Abs. 6 Satz 7 EStR; Dennerlein Q45); getrennte Anlässe manuell dokumentieren |
| `internal_employees` | nur eigene Arbeitnehmer | 100 %, 4140; Lohnsteuer prüfen (50-€-Freigrenze, 60-€-Grenze, Auswärtstätigkeit) |
| `internal_shareholder_managers` | nur Gesellschafter-Geschäftsführer | `shareholder_manager_treatment`: `as_employees` (wie intern) oder `business_70_30` |
| `attention` | Kaffee, Gebäck, Arbeitsessen | 4653 bzw. 4140 netto; keine Bewirtung (R 4.10 Abs. 5 Satz 9 EStR) |
| `sole_proprietor_self` | Einzelunternehmer allein | kein Bewirtungsbeleg, nur Verpflegungspauschale 14/28 € |

Bei Gesellschafter-Geschäftsführern unter sich widersprechen sich die Quellen (Dennerlein Q48 gegen Q55; Folie 6: ein geschäftlicher Anlass setzt Betriebsfremde voraus). Nach R 4.10 Abs. 7 EStR ist die rein interne Bewirtung eigener Arbeitnehmer unbegrenzt abziehbar, das spricht eher für `as_employees`; `business_70_30` ist die vorsichtigere Variante mit weniger Abzug. Bei beiden besteht vGA-Risiko, wenn die Bewirtung unangemessen ist (§ 8 Abs. 3 Satz 2 KStG). Bei Geschäftsführerverträgen mit Vergütungs- oder Sachbezugsverzicht ist der Lohnansatz gesondert zu prüfen. Welche Variante gilt, entscheidet der Nutzer; feste Vorgaben einzelner Mandanten gehören in deren Projektanweisung, nicht in den Konnektor.

Gesellschafter ohne Anstellung gelten als Dritte (Dennerlein Q6), freie Mitarbeiter ebenfalls (Folie 21). Dafür gibt es `participant_relations` bzw. `participants[].relation`.

**Vorsteuer ohne Rechnung ist nie zulässig** (§ 15 Abs. 1 Satz 1 Nr. 1 UStG). Bei `original_invoice_status` ≠ `present` lehnen die Buchungs-Tools jeden Vorsteuer-Code (`19_pre`, `7_pre`, `19_pre_app`, `7_pre_app`) auf jedem Konto ab (Codes ohne Vorsteuer wie 19_both_1_no_pre und Reverse-Charge-Fälle sind nicht betroffen). Für nicht geschäftliche Typen (intern, Aufmerksamkeit) greift die Rechnungspflicht des § 4 Abs. 5 Satz 1 Nr. 2 EStG nach R 4.10 Abs. 5 Satz 9 und Abs. 7 Satz 1 EStR nicht (Auffassung der Richtlinien; keine Quelle regelt den Fall ausdrücklich), deshalb gibt es dort nur Warnungen.

## Rechnung nachgereicht – Ablauf

Es gibt dafür kein eigenes Tool. Der Ablauf besteht aus vorhandenen Bausteinen:

1. `generate_and_upload_entertainment_receipt` mit der neuen Rechnung als Quelle (`source_receipt_id_by_customer`) und `original_invoice_status: "present"`.
2. Die alte Buchung stornieren: `cancel_posting` (seit `v2026.10.07.001`). Festgeschriebene Buchungen storniert es per Gegenbuchung, aber nur für IDs, die der Nutzer in `reverse_posting_ids` freigibt (siehe [docs/buchungen-korrigieren-faq.md](buchungen-korrigieren-faq.md)). Fehlt das Tool, weil die Installation älter als `v2026.10.07.001` ist (dort gibt es `unconfirm_posting`, das nur nicht festgeschriebene Buchungen entfernt), per manueller Gegenbuchung über `add_free_postings` mit Verweis auf die Ursprungsbuchung.
3. Mit Vorsteuer neu buchen.
4. Die alte Bewirtungsseite (Eigenbeleg) ist bereits hochgeladen und zugeordnet. Nach der Buchung des neuen Belegs fragt man den Nutzer, ob sie entfernt werden soll; erst auf Bestätigung entfernt `set_receipt_deleted` sie (Soft-Delete, per `deleted: false` wiederherstellbar). Der Konnektor löscht nie automatisch.

**Offene Grenze, nicht belegt:** Der Vorsteuerabzug entsteht mit Leistung und Besitz der Rechnung (§ 15 Abs. 1 Satz 1 Nr. 1 UStG; BFH XI R 17/22). Die Ist-Versteuerung (§ 20 UStG) betrifft nur die Umsatzsteuer, nicht die Vorsteuer. Die BuchhaltungsButler-API kennt `date_vat_effective` nur als Lesefeld; die Auswertung folgt dem Leistungs- bzw. Buchungsdatum. Bei einer Zahlungsbuchung liegt das Datum damit in der Vergangenheit. Ob eine freie Buchung mit dem Datum des Rechnungseingangs (Vorsteuerkonto an 4650) in der richtigen USt-VA-Kennzahl landet, ist **nicht geprüft** und sollte in einem Test-Mandanten verifiziert werden. Bis dahin: Rücksprache mit dem Steuerberater.

## Quellen und Widersprüche

- Gesetz: § 4 Abs. 5 Satz 1 Nr. 2 und Abs. 7 EStG, § 15 Abs. 1 und 1a UStG, § 33 UStDV, § 8 Abs. 3 Satz 2 KStG.
- BFH 18.04.2012, X R 57/09 und X R 58/09: Rechnung ohne Ausnahme beizufügen, kein Ersatz durch Eigenbeleg.
- BMF 19.11.2025 (IV C 6 – S 2145/00026/005/033): ergänzt **und ersetzt** das Schreiben vom 30.06.2021 für Bewirtungen ab 01.01.2025. Rn. 1 zeitnah und unterschrieben, Rn. 8 Trinkgeld, Rn. 9–12 Rechnungen über 250 €, Rn. 13 Kassenbeleg/E-Rechnung, Rn. 16 unbare Zahlung, Rn. 19–22 digitale Eigenbelege.
- R 4.10 EStR (Abs. 5–7), GoBD Rz. 47, UStAE 3.6.
- Fachliteratur (nachrangig): Dennerlein, Haufe-Lexware Akademie, 16.09.2026. Folie 46 zeigt 59 € Vorsteuer, Q37 „korrigiert“ auf 5,90 €; richtig sind 9,50 € (19 % von 50 €).
- Handschriftliche Quittungen: BMF 2025 Rn. 13 schließt sie bei Kassensystem vollständig aus, Dennerlein Q32/Q57 sieht das milder. Der Konnektor warnt, wenn der Originalbeleg keine Textebene hat.

## Haftungshinweis

Diese Seite fasst unsere Recherche zusammen, ersetzt aber keine steuerliche Beratung. Vor
Produktivbetrieb sollten die rechtlichen Aussagen — insbesondere die BMF-Schreiben-Zitate — von
einem Steuerberater gegengelesen werden.
