# Gemischte Belege (privat und geschäftlich auf einem Bon): FAQ

Tools: `prepare_mixed_receipt`, `generate_mixed_receipt`, `generate_and_upload_mixed_receipt`. Rechtsgrundlagen: [rechtsgrundlagen-gemischte-belege.md](rechtsgrundlagen-gemischte-belege.md).

## Wofür?

Jemand kauft privat ein, auf demselben Bon stehen Dinge fürs Büro, bezahlt wurde mit eigenem Geld. Die Gesellschaft erstattet nur den geschäftlichen Anteil. Das Tool erzeugt dafür einen Auslagenbeleg: links der Bon (lange Bons auf Seite 2) mit geschwärzten privaten Positionen, rechts die geschäftlichen Positionen mit Netto, Steuer und Brutto je Steuersatz, wer ausgelegt hat und wofür.

## Ablauf

1. Den Bon wie gewohnt in BuchhaltungsButler hochladen.
2. `prepare_mixed_receipt` zeigt den Bon mit Zeilennummern und die Fragen, die vorher zu klären sind.
3. Fragen beantworten: welche Zeilen geschäftlich sind, Pfand und Rabatte, Bonnummer, wer ausgelegt hat, Anlass, MwSt-Zeilen des Bons, Bestätigung.
4. `generate_mixed_receipt` zeigt die fertige Seite als Bild. Nichts wird hochgeladen.
5. Nach Freigabe `generate_and_upload_mixed_receipt` mit `confirm: true`: Upload mit gesetzten Feldern, Kommentar am Original. Sobald der neue Beleg in BuchhaltungsButler bestätigt ist, löscht das Tool das Original (soft). Der Upload weist den Beleg nur mit der Hausregel `debitoren_kreditoren: aus` dem Auslagenkonto der Person zu (siehe unten), danach liefert die Antwort einen Buchungsvorschlag (`booking_proposal`, siehe unten).

## Wie wird der Beleg gebucht?

Das Tool bucht nichts. Nach dem Upload und dem Löschen des Originals liefert es in `booking_proposal` einen Vorschlag, den man prüft und selbst ausführt. Entscheidend ist die Hausregel `debitoren_kreditoren` (`set_policy`): ob die Debitoren-/Kreditorenbuchhaltung in BuchhaltungsButler aktiv ist (Einstellung 'Debitoren und Kreditoren aktivieren'; die Modi Selektiv und Sammelkonto zählen als aktiv). Gesetzt wird sie nur nach Aussage des Nutzers, nie aus Buchungen abgeleitet. Nicht gesetzt: der Vorschlag ist `needs_decision`, beschreibt beide Wege und gibt keinen fertigen Aufruf (gibt es Kreditoren in der Instanz, weist er darauf hin, dass sie vermutlich aktiv sind).

**Debitoren/Kreditoren aktiv: den Beleg buchen, die Zahlung gleicht nur aus.** Mit aktiven Debitoren/Kreditoren gibt es keine EÜR-Auswertung auf Zahlungsbasis; gebucht wird der Beleg selbst (Aufwand und Steuer am Beleg), die Zahlung gleicht den Kreditor danach nur aus. Der Vorschlag hat zwei Aufrufe in dieser Reihenfolge: (1) `add_receipt_postings` für den neuen Beleg mit einem Split je Steuersatz auf 4653 (SKR03; SKR04 6643; alternativ 4980 | 6850 Sonstiger Betriebsbedarf, das Konto legt der Steuerberater fest), Vorsteuer-Code 7_pre bzw. 19_pre, `creditor` = Kreditor des Händlers und `debtor: 10000` (das Debitoren-Sammelkonto, das das Schema verlangt); (2) `add_transaction_postings` auf der zugeordneten Zahlung mit einem Split über die Erstattung auf den Kreditor, vat `0_none`, Text "Ausgleich Beleg" und `receipt_id_by_customer`. Den Ausgleich bietet der Vorschlag nur an, wenn genau eine noch ungebuchte Zahlung zugeordnet ist, die auf den Cent der Erstattung entspricht. Ist noch keine Zahlung da, gibt es nur den Beleg-Aufruf; die Zahlung später dem Beleg zuordnen und denselben Ausgleich buchen. Ist der Beleg schon gebucht, kommt nur der Ausgleich; ist beides gebucht, `already_booked`. Weicht der Betrag ab, sind es mehrere Zahlungen oder ist die Zahlung schon "via Zahlung" gebucht, `needs_decision` ohne Ausgleich-Aufruf.

**Der Kreditor des Händlers** wird aus früheren Buchungen desselben Händlers abgeleitet, nie über den Namen: Der Name des Händlers auf dem Bon stimmt selten mit dem Namen des Kreditors in BuchhaltungsButler überein (zum Beispiel "Beispielmarkt" und "Beispielmarkt Handels GmbH & Co. KG Musterstadt"). Der Connector liest bis zu zehn frühere Belege des Händlers (genau dieser Name) und deren Buchungen der letzten 24 Monate und nimmt das Kreditor-Konto (ab 70000), auf dem sie gebucht sind. Gibt es genau eines, wird es genutzt; mehrere oder keines geben `needs_decision`. Dann den Kreditor mit `creditor` vorgeben (die Kontonummer zeigt `list_contacts` mit `contact_type: creditor`). Die Vorschau zeigt den Kreditor (`creditor`: Nummer, Herkunft, Belege als Beleg).

**Debitoren/Kreditoren aus: die Zahlung buchen.** Es gibt keine Beleg-Buchung, gebucht wird die Zahlung. Ist sie dem Beleg zugeordnet: Vorschlag `add_transaction_postings` auf diese Zahlung, ein Split je Steuersatz, Konto 4653 (SKR03; SKR04 6643; alternativ 4980 | 6850 Sonstiger Betriebsbedarf), Vorsteuer-Code 7_pre bzw. 19_pre. Ist die Zahlung schon gebucht, sagt der Vorschlag das (`already_booked`); weicht ihr Betrag ab oder sind es mehrere, nennt er die Beträge und fragt (`needs_decision`).

**Auslagenkonto.** Ob der Upload das Konto der auslegenden Person mitgibt (`account`), hängt von der Hausregel ab. Mit `aus` gibt er es mit (erkannt am Namen plus "Gesellschafter" oder "Auslage"); nutzt das Konto 'Beleg erzeugt Zahlung', legt BuchhaltungsButler die Zahlung selbst an. Mit `aktiv` oder nicht gesetzt gibt er es nicht mit, auch nicht, wenn `auslagenkonto` angegeben ist (dann steht eine Warnung in der Antwort): Ein Beleg auf einem Konto mit 'Beleg erzeugt Zahlung' lässt sich nicht auf einen Kreditor buchen. Die Zahlung wird dem Beleg später zugeordnet; liegt ein Beleg doch schon auf so einem Konto, erst die Zuordnung lösen (`unassign_receipt`). "Via Zahlung" buchen ist mit aktiven Debitoren/Kreditoren nur ein Ausnahmefall. Die Vorschau zeigt das Konto weiterhin (der Vorschlag nutzt es), mit `passed_on_upload`, ob es mitgegeben wird. Anderes Konto: `auslagenkonto` angeben; ohne Konto hochladen: `without_auslagenkonto: true`.

**Buchungstext.** Der Text im Vorschlag bleibt so neutral wie möglich, weil BuchhaltungsButler aus jedem unterschiedlichen Buchungstext einen eigenen Buchungsvorschlag macht (Leitfaden-Thema `buchungstexte`). Er enthält nie den Händler, auch keine Marke, Größe, Menge, Prozentangabe oder Bonnummer. Mit `booking_text` gibst du ihn vor, zum Beispiel "Milch"; ohne das Feld wird er aus den Positionsbezeichnungen abgeleitet (Zahlen und Einheiten entfernt, höchstens 40 Zeichen). Die Vorschau zeigt den Text als `booking_text`, bevor etwas hochgeladen wird.

**Ohne Debitoren/Kreditoren gibt es unter Umständen keine Zahlung.** Sind nur Geschäftskonten angelegt und hat die Person privat bezahlt, existiert zu dem Beleg in BuchhaltungsButler keine Zahlung, die man buchen könnte. Das ist normal, kein Fehler. Der Vorschlag sucht zuerst eine Erstattung (Abgang in Höhe des Erstattungsbetrags, Name der Person, 60 Tage ab Belegdatum) und nennt Treffer zur Auswahl. Ohne Treffer (`no_payment_exists`) bleiben drei Wege: (1) ein Auslagenkonto anlegen (`create_account`, type other, 'Beleg erzeugt Zahlung'), den Beleg zuweisen und die erzeugte Zahlung buchen; (2) ohne Konto per `add_free_postings` Soll 4653 an Haben Privateinlagen (Einzelunternehmen 1890 | 2180, GmbH/UG 730 | 3510) mit dem Beleg buchen, wobei eine freie Buchung mit Beleg in BuchhaltungsButler nicht als Zahlung zählt; (3) die Erstattung abwarten, dann zuordnen und buchen. Hat der Inhaber eines Einzelunternehmens selbst ausgelegt, ist es keine Erstattung, sondern eine Privateinlage.

Lassen sich die Lesezugriffe für den Vorschlag nicht ausführen, bleibt der Upload gültig, `booking_proposal.status` ist `unavailable` und nennt den Grund.

## Warum nur Schwarz-Weiß-Scans ohne Texterkennung?

Das Tool schwärzt Bildpixel und baut daraus eine neue PDF auf, die nur das geschwärzte Bild enthält. Scans mit Textebene (E-Bon oder Texterkennung) lehnt Version 1 trotzdem ab, damit kein privater Text unbemerkt durchrutscht; das ist eine zusätzliche Sicherung. Am Scanner: Farbmodus Schwarzweiß, Texterkennung (durchsuchbare PDF) aus, eine Seite je Bon, Bon gerade einlegen. Fotos und Graustufen-Scans sind noch nicht unterstützt, gedrehte Scans lehnt das Tool ebenfalls ab.

## Warum bleibt das Original in BuchhaltungsButler?

Belege dürfen nicht so verändert werden, dass der ursprüngliche Inhalt nicht mehr feststellbar ist (§ 146 Abs. 4 AO). Die geschwärzte Fassung ist deshalb eine zusätzliche Fassung. BuchhaltungsButler löscht Belege nie physisch: Ein "gelöschter" Beleg bleibt archiviert und über den Filter "Gelöschte Belege" sichtbar. Der Auslagenbeleg verweist mit Belegnummer und SHA-256-Prüfsumme auf das Original, das Original trägt einen Kommentar mit Verweis auf den Auslagenbeleg.

## Was verhindert doppelte Vorsteuer?

Gebucht wird nur der Auslagenbeleg. Das Original trägt den Kommentar „Nicht buchen“ und wird vom Tool soft-gelöscht, sobald der neue Beleg in BuchhaltungsButler bestätigt ist (aktiv, gleiche Bonnummer, Betrag = Erstattung). Lässt sich der neue Beleg nicht bestätigen oder schlägt das Löschen fehl (zum Beispiel weil das Original schon gebucht ist), bleibt das Original aktiv, und die Antwort sagt, was zu tun ist. Vor dem Upload prüft das Tool, ob es schon einen anderen aktiven Beleg mit derselben Bonnummer gibt (ein erneuter Upload unter anderer Bonnummer fällt dabei nicht auf).

## Wie viele Positionen passen auf den Beleg?

Etwa sechs kurze Positionen passen auf die Seite. Bei mehr Positionen oder einem sehr langen Anlass bricht das Tool mit einem Hinweis ab, statt Text übereinander zu drucken. Dann gleichartige Positionen zusammenfassen (z. B. "Milch, 3 Packungen") oder den Anlass kürzen.

## Textbaustein für die Verfahrensdokumentation

> Gemischte Einkäufe (private und betriebliche Positionen auf einem Kassenbon, privat bezahlt) werden so behandelt: Der Kassenbon wird unverändert als Scan in BuchhaltungsButler hochgeladen. Daraus entsteht ein Auslagenbeleg mit dem Bon, dessen private Positionen geschwärzt sind, den betrieblichen Positionen mit Netto, Steuer und Brutto je Steuersatz, der auslegenden Person und dem Anlass. Er verweist über Bonnummer und SHA-256-Prüfsumme auf das Original. Das Original wird in BuchhaltungsButler als gelöscht markiert, sobald der Auslagenbeleg dort bestätigt ist, bleibt dort aber unverändert archiviert und abrufbar und trägt einen Kommentar mit Verweis auf den Auslagenbeleg. Gebucht wird nur der Auslagenbeleg; erstattet wird nur der betriebliche Anteil.
