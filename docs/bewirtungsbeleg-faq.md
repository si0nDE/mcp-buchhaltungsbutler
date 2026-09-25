# Bewirtungsbeleg – Häufige Fragen

Hintergrund zum `generate_entertainment_receipt`-Tool. Ersetzt keine Steuerberatung — siehe Haftungshinweis unten.

## Warum ist keine handschriftliche Unterschrift nötig?

Nach dem BMF-Schreiben vom 30.06.2021 (IV C 6 - S 2145/19/10003 :003), inhaltlich bestätigt durch das
BMF-Schreiben vom 19.11.2025, genügt bei digital erstellten Bewirtungsangaben eine elektronische
Genehmigung/Bestätigung, sofern die Angaben nachträglich nicht undokumentiert verändert werden können.
Der erzeugte Beleg dokumentiert deshalb Name und Zeitstempel der bewirtenden Person statt eines
Unterschriftenfelds.

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

## Woher kommt die Aufteilung 70 % / 30 %?

§ 4 Abs. 5 Satz 1 Nr. 2 EStG. Bei vorsteuerabzugsberechtigten Unternehmen (Regelbesteuerung, Default)
wird sie auf den Nettobetrag (inkl. Trinkgeld, da ohne Umsatzsteuer) angewendet; die Vorsteuer bleibt
davon unabhängig zu 100 % abziehbar (§ 15 UStG). Bei Kleinunternehmern (§ 19 UStG,
`kleinunternehmer: true`) auf den Bruttobetrag, da keine separate Vorsteuerbuchung existiert.

## Warum lehnt das Tool manche Anlass-Angaben ab?

Der Bundesfinanzhof hat pauschale Formulierungen wiederholt nicht anerkannt, u. a. "Geschäftsessen",
"Kontaktpflege", "Geschäftsbesprechung" (BFH v. 15.01.1998, IV R 81/96, BStBl II 1998, 263; BFH v.
26.02.2004, IV R 50/01, BStBl II 2004, 502). Der Anlass muss so konkret sein, dass ein Außenstehender
den geschäftlichen Zusammenhang sofort erkennt.

## Haftungshinweis

Diese Seite fasst unsere Recherche zusammen, ersetzt aber keine steuerliche Beratung. Vor
Produktivbetrieb sollten die rechtlichen Aussagen — insbesondere die BMF-Schreiben-Zitate — von
einem Steuerberater gegengelesen werden.
