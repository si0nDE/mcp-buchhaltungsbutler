# Gemischte Belege (privat und geschäftlich auf einem Bon): FAQ

Tools: `prepare_mixed_receipt`, `generate_mixed_receipt`, `generate_and_upload_mixed_receipt`. Rechtsgrundlagen: [rechtsgrundlagen-gemischte-belege.md](rechtsgrundlagen-gemischte-belege.md).

## Wofür?

Jemand kauft privat ein, auf demselben Bon stehen Dinge fürs Büro, bezahlt wurde mit eigenem Geld. Die Gesellschaft erstattet nur den geschäftlichen Anteil. Das Tool erzeugt dafür einen Auslagenbeleg: links der Bon (lange Bons auf Seite 2) mit geschwärzten privaten Positionen, rechts die geschäftlichen Positionen mit Netto, Steuer und Brutto je Steuersatz, wer ausgelegt hat und wofür.

## Ablauf

1. Den Bon wie gewohnt in BuchhaltungsButler hochladen.
2. `prepare_mixed_receipt` zeigt den Bon mit Zeilennummern und die Fragen, die vorher zu klären sind.
3. Fragen beantworten: welche Zeilen geschäftlich sind, Pfand und Rabatte, Bonnummer, wer ausgelegt hat, Anlass, MwSt-Zeilen des Bons, Bestätigung.
4. `generate_mixed_receipt` zeigt die fertige Seite als Bild. Nichts wird hochgeladen.
5. Nach Freigabe `generate_and_upload_mixed_receipt` mit `confirm: true`: Upload mit gesetzten Feldern, Kommentar am Original. Sobald der neue Beleg in BuchhaltungsButler bestätigt ist, löscht das Tool das Original (soft). Danach wird der neue Beleg über das Auslagenkonto gebucht.

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
