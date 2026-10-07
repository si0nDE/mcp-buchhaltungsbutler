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
`duplicates_found`. Schlägt der Upload per Timeout fehl, wird nicht automatisch wiederholt - vor einem neuen Versuch
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

## Haftungshinweis

Diese Seite fasst unsere Recherche zusammen, ersetzt aber keine steuerliche Beratung. Vor
Produktivbetrieb sollten die rechtlichen Aussagen — insbesondere die BMF-Schreiben-Zitate — von
einem Steuerberater gegengelesen werden.
