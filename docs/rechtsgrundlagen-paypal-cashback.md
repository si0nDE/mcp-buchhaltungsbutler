# Cashback der PayPal Business Debit Mastercard: Rechtsgrundlagen und offene Punkte

Stand: Recherche vom 10.10.2026. Keine Steuerberatung; verbindlich sind das Finanzamt oder ein Steuerberater. Das Buchungsmuster steht im Thema
`paypal_cashback` von `get_booking_guide`, die Erkennung in `src/tools/cashback.ts`.

## Ergebnis

| Frage | Einordnung |
| --- | --- |
| Umsatzsteuer auf das Cashback? | Nein, nicht steuerbar. `vat` = `0_none`. |
| Vorsteuer der Einkäufe korrigieren? | Nein. |
| Ertragsteuer | Betriebseinnahme. EÜR: bei Gutschrift (§ 11 EStG). |
| Konto | Sonstige Erträge SKR03 2700, SKR04 4830, getrennt vom Aufwand. |
| Buchungstext | `PayPal Business Debit Cashback` (konstant, ohne Transaktionsnummer) |
| Beleg | keiner; Nachweis ist die Zahlung im PayPal-Konto |

## Begründung

1. **Kein Leistungsaustausch.** PayPal zahlt das Cashback dafür, dass die Karte genutzt wird. Der Karteninhaber erbringt PayPal dafür keine Leistung.
   Ohne Leistung gegen Entgelt ist die Zahlung nicht steuerbar (§ 1 Abs. 1 Nr. 1 UStG).
2. **Keine Entgeltminderung des Einkaufs.** § 17 Abs. 1 UStG verlangt, dass sich die Bemessungsgrundlage eines steuerpflichtigen Umsatzes ändert.
   Der Händler gewährt keinen Nachlass. PayPal zahlt aus eigenen Mitteln und steht nicht in der Lieferkette zwischen Händler und Karteninhaber.
   § 17 Abs. 1 S. 6 UStG (Preisnachlässe in der Leistungskette) setzt einen Unternehmer in der Kette voraus.
3. **Abgrenzung Payback.** Bei Payback finanziert der Partnerhändler die Punkte. Deshalb liegt beim Einlösen eine Entgeltminderung beim Händler vor
   (BFH V R 42/17), und ein unternehmerischer Kunde berichtigt seine Vorsteuer (§ 17 Abs. 1 S. 2 UStG). Beim Karten-Cashback zahlt kein Händler.
4. **Gegenansicht ohne andere Folge.** Wer das Cashback als Preisnachlass auf PayPals eigene Zahlungsdienste sieht, kommt zum selben Ergebnis: diese
   Dienste sind steuerfrei (§ 4 Nr. 8 UStG), es wurde keine Vorsteuer gezogen, es gibt nichts zu berichtigen.
5. **Ertragsteuer.** Die Karte hängt am Geschäftskonto und wird betrieblich genutzt. Das Cashback ist betrieblich veranlasst und damit eine
   Betriebseinnahme; eine Steuerbefreiung greift nicht.

## Beobachtete Form der Zahlung (BHB, PayPal-Konto)

| Feld | Wert |
| --- | --- |
| `to_from` | `PayPal Inc Debit Card` |
| `type` | `Cash Back Bonus` |
| `amount` | positiv, meist Cent-Beträge |
| `purpose` | PayPal-Transaktions-ID |

Die Zahlungsart `type` steht nur in der Einzelabfrage (`get_transaction`), nicht in der Liste (`list_transactions`, live geprüft am 10.10.2026).
Der Konnektor schlägt positive Zahlungen von „PayPal … Debit Card“ deshalb einzeln nach.

Nach den Kartenbedingungen (24.10.2024): 0,5 % auf den Nettobetrag berechtigter Kartenzahlungen (Zahlung abzüglich PayPal-Gebühren),
wöchentliche Gutschrift, befristete Aktionen mit höherem Satz möglich.

## Nicht verifiziert (nicht als Tatsache weitergeben)

- **Kein BMF-Schreiben, kein BFH- oder EuGH-Urteil** zu Cashback eines Kartenherausgebers gefunden. Die Einordnung ist aus § 17 UStG und der
  Payback-Linie abgeleitet. Einmal mit dem Steuerberater abstimmen.
- **Bilanzierer:** ob Cashback für Dezember-Zahlungen, das im Januar gutgeschrieben wird, als Forderung abzugrenzen ist (streng genommen ja, meist
  unwesentlich).
- **Private Kartenzahlungen** eines Einzelunternehmers: Cashback darauf ist nicht betrieblich veranlasst. Wie bei gemischter Nutzung aufzuteilen ist,
  wurde nicht geprüft.
- **Andere Programme** (Händler-Cashback, Cashback-Portale, Karten anderer Herausgeber) sind nicht abgedeckt; dort kann der Zahlende in der Lieferkette
  stehen.
- Im Skill-Repo [claude-fuer-deutsches-recht](https://github.com/Klotzkette/claude-fuer-deutsches-recht) gibt es kein Skill zu Cashback (Stand 29.09.2026).

## Quellen

- [§ 17 UStG, gesetze-im-internet.de](https://www.gesetze-im-internet.de/ustg_1980/__17.html)
- [UStAE 10.3 Entgeltminderungen (Haufe)](https://www.haufe.de/id/norm/umsatzsteuer-anwendungserlass-103-entgeltminderungen-HI7554985_p10.3.html)
- [BFH V R 42/17, Payback-Rabattsystem (NWB)](https://datenbank.nwb.de/Dokument/822638/)
- [Payback-System: Punktegutschriften, OFD (Haufe)](https://www.haufe.de/steuern/finanzverwaltung/payback-system-punktegutschriften-ab-112012-ofd_164_73734.html)
- [Gutscheine im Umsatzsteuerrecht: Bonusprogramme und Payback (Haufe)](https://www.haufe.de/id/beitrag/gutscheine-im-umsatzsteuerrecht-231-bonusprogramme-und-kartenpayback-systeme-HI16531881.html)
- [Bedingungen für Karteninhaber der PayPal Business Debit Mastercard, 24.10.2024](https://history.paypal.com/de/webapps/mpp/ua/bus-debitcard-tnc)
- Praxisdiskussion (nicht verbindlich): [DATEV-Community, Cashback richtig verbuchen](https://www.datev-community.de/t5/Betriebliches-Rechnungswesen/Cashback-richtig-verbuchen-USt-Konto/td-p/428528)
