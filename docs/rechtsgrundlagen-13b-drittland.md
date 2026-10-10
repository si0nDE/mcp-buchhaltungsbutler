# § 13b UStG bei Leistungen aus dem Drittland: Rechtsgrundlagen und offene Punkte

Quelle: Übergabe des Teams vom 09.10.2026. Primärquelle gelesen: gesetze-im-internet.de (§ 3, § 3a, § 13b, § 15 UStG), Abfrage am 09.10.2026.
Wortlaut nur sinngemäß. Vor jeder Übernahme in Endnutzertexte den aktuellen Gesetzestext prüfen. Keine Steuerberatung; verbindlich sind das
Finanzamt oder ein Steuerberater. Das zugehörige Buchungsmuster steht im Thema `reverse_charge_drittland` von `get_booking_guide`.

## Gesetzestext (sinngemäß)

| Norm | Inhalt |
| --- | --- |
| § 3 Abs. 1, Abs. 9 UStG | Lieferung = Verschaffung der Verfügungsmacht über einen Gegenstand; sonstige Leistung = alles, was keine Lieferung ist. Ob ein konkretes Produkt (z. B. SaaS-Abo) darunter fällt, ist Subsumtion. |
| § 3a Abs. 2 UStG | Leistung an einen Unternehmer für sein Unternehmen: Ort dort, wo der Empfänger sein Unternehmen betreibt (hier: Inland). |
| § 13b Abs. 1 UStG | Steuerschuld des Empfängers bei Leistungen eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmers; Steuer entsteht mit Ablauf des Voranmeldungszeitraums der Leistung. |
| § 13b Abs. 2 Nr. 1 UStG | Sonstige Leistungen eines im Ausland ansässigen Unternehmers, die nicht unter Abs. 1 fallen (= Drittland). Steuer entsteht mit Ausstellung der Rechnung, spätestens mit Ablauf des der Leistung folgenden Kalendermonats. |
| § 13b Abs. 3 UStG | Dauerleistungen über mehr als ein Jahr: Steuer spätestens mit Ablauf jedes Kalenderjahres. Ein Monatsabo fällt nicht darunter. |
| § 13b Abs. 4 UStG | Entgelt vor der Leistung gezahlt: Steuer insoweit mit Ablauf des Voranmeldungszeitraums der Zahlung. Zahlung nach der Leistung ändert die Entstehung nicht. |
| § 13b Abs. 5 S. 1 UStG | Der Empfänger schuldet die Steuer, wenn er Unternehmer oder juristische Person ist. |
| § 13b Abs. 7 UStG | „Im Ausland ansässig“: kein Wohnsitz, Sitz, Geschäftsleitung oder Betriebsstätte im Inland. Bei Zweifeln: Bescheinigung des Finanzamts des Leistenden. |
| § 15 Abs. 1 S. 1 Nr. 4 UStG | Vorsteuer abziehbar für die Steuer nach § 13b Abs. 1 und 2. Zahlung nur bei Vorauszahlung verlangt; eine Rechnung mit Steuerausweis wird hier nicht verlangt (nur in Nr. 1). |

## Häufige Irrtümer

| Irrtum | Befund laut Gesetzestext |
| --- | --- |
| „Nur wenn es auf dem Beleg steht.“ | Ein Hinweiserfordernis steht in § 13b Abs. 1 bis 5 nicht. |
| „Nur bei EU-Unternehmen mit USt-IdNr.“ | Drittland ist über Abs. 2 Nr. 1 erfasst, eine USt-IdNr. wird nicht verlangt. |
| „Bei Ist-Versteuerung entsteht alles mit der Zahlung.“ | Für § 13b gelten die Entstehungsregeln der Abs. 1 bis 4. Die EÜR-Ausgabe selbst folgt dem Abfluss (EStG-Regeln nicht gelesen). |
| „Ohne Zahlung kein Vorsteuerabzug.“ | § 15 Abs. 1 S. 1 Nr. 4 kennt keine Zahlungsbedingung, außer bei Vorauszahlung. |

## Verifiziert im BHB-Entwurf (10.10.2026)

Die USt-VA-Vorschau für 2026 trennt „sonstige Leistungen eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmens (§ 13b Abs. 1)“ (Kz 46/47)
und „Andere Leistungen (§ 13b Abs. 2 Nr. 1, 2, 4 bis 11 UStG)“ (Kz 84/85); die Vorsteuer beider steht in Kz 67. Der Abgleich mit den Kontenblättern
von 1787 nach Steuerschlüssel stimmt auf den Cent: Schlüssel `19_both_506` = Kz 46/47, Schlüssel `19_both_511` = Kz 84/85, Summe = Kz 67.
Damit ist `19_both_511` der Schlüssel für Drittland-Leistungen nach Abs. 2 Nr. 1 (die Zeile fasst mehrere Nummern zusammen).
Bestätigt auch von der Buchungsseite: Eine Zahlung, die im Ledger den Schlüssel 511 trägt, zeigt im Dialog „Zahlung buchen“ die Steuerauswahl „Drittland (§ 13b Abs. 2 Nr. 1)“.
Nicht geprüft sind `19_both_1`, `19_both_6506`/`6511`/`6501` und die `_app`-Varianten. Der Vordruck selbst (BMF) wurde nicht gelesen,
die Beschriftungen stammen aus der BHB-Vorschau.

## Nicht verifiziert (nicht als Tatsache weitergeben)

- **Verwaltungsauffassung** (UStAE 13b.1, 13b.15, 3a.12): nicht gelesen.
- **Periode:** BHB ordnet Buchungen nach Zahlungsdatum, § 13b Abs. 2 knüpft an die Rechnung. Ob BHB für § 13b nach Rechnungsdatum melden kann,
  und ob bei EÜR/Ist ein Beleg ohne Zahlung kreditorisch gebucht werden kann, ist offen (Anhaltspunkt: Thema `ust_va_zm`, Bilanzierer buchen
  periodenübergreifend bezahlte Belege kreditorisch).

Die Periodenfrage lässt sich nur beim BHB-Support oder im Entwurf eines Quartals mit abweichenden Rechnungs- und Zahlungsdaten klären.

## Quellenhinweis zur Recherche

`gesetze-im-internet.de` und BMF-Seiten waren per WebFetch wegen Robots-Regeln gesperrt, nicht per curl umgehen. Gelesen wurde über den Browser
(neuer Tab, `gesetze-im-internet.de/ustg_1980/__13b.html`, Seitentext lesen). Sekundärquellen (Merkblätter, Blogs) gegen den Gesetzestext prüfen:
Ein Merkblatt nannte „Ablauf des Voranmeldungszeitraums“ für alle Auslandsleistungen, der Gesetzestext trennt EU (Abs. 1) und Drittland (Abs. 2 Nr. 1).
