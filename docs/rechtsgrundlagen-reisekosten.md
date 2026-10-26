# Reisekostenabrechnung: Rechtsgrundlagen und Auslegungspunkte

Hintergrund zu `generate_travel_expense_report` und `generate_and_upload_travel_expense_report`. Recherchestand 26.10.2026. Keine Steuerberatung; verbindlich sind das Finanzamt oder ein Steuerberater. Praktische Fragen und Antworten: [reisekosten-faq.md](reisekosten-faq.md).

Kennzeichnung je Aussage:

- **V** = Text selbst gelesen.
- **A** = Auslegung aus gelesenen Texten, keine wörtliche Aussage.
- **U** = nicht verifiziert, nicht als Tatsache weitergeben.

Gelesene Quellen: LStH 2026 Anhang 25 I (Auslandstabelle) und III (BMF 25.11.2020), `gesetze-im-internet.de` (EStG, UStG, UStDV, BRKG, AO, UStAE, KStR/KStH) und BMF vom 22.12.2025 zur Verpflegungsbesteuerung. Das Repo `Klotzkette/claude-fuer-deutsches-recht` ist **keine** Quelle (eigener Disclaimer, mehrere Fehler; Issue [#613](https://github.com/Klotzkette/claude-fuer-deutsches-recht/issues/613)).

## Verpflegung

- § 9 Abs. 4a EStG (V): 28 € bei 24 Stunden Abwesenheit je Kalendertag; 14 € für den An- und Abreisetag einer mehrtägigen Reise mit Übernachtung ohne Mindestdauer; 14 € bei eintägiger Reise ohne Übernachtung ab mehr als 8 Stunden; Tätigkeit über Nacht ohne Übernachtung: 14 € für den Tag mit der überwiegenden Abwesenheit. Ausland: 120 % bzw. 80 % des BRKG-Auslandstagegelds, aufgerundet (Satz 5).
  - Umsetzung im Tool: Bei Tätigkeit über Nacht ohne Übernachtung gibt es die 14 € nur, wenn die Abwesenheit an beiden Tagen zusammen mehr als 8 Stunden beträgt (A, Lesart von Satz 3 Nr. 3). Eine Rückkehr um genau 00:00 Uhr gilt als Ende um 24:00 Uhr des Vortags (A).
- Kürzung bei gestellten Mahlzeiten (Satz 8 bis 10, V): Frühstück 20 %, Mittag- und Abendessen je 40 % der 24-Stunden-Pauschale (5,60 € / 11,20 € Inland); tageweise, höchstens bis 0 €; unabhängig davon, ob die Mahlzeit eingenommen wird.
- Dreimonatsfrist (Satz 6 und 7, V): nur die ersten drei Monate an derselben Tätigkeitsstätte, Unterbrechung ab vier Wochen setzt zurück.
- BMF 25.11.2020 (IV C 5 - S 2353/19/10011 :006, BStBl I S. 1228; V über LStH 2026 Anhang 25 III) und BMF 05.12.2025 (IV C 5 - S 2353/00094/007/012, BStBl I S. 2078; V über LStH 2026 Anhang 25 I): Auslandstabelle 2026. Nicht aufgeführte Länder erhalten den Luxemburg-Satz (63 / 42 / 139), Übersee- und Außengebiete den Satz des Mutterlands.
  - Umsetzung im Tool: Die Tabelle liegt als erzeugtes Modul `src/tools/travel-rates-2026.ts` vor (166 Länder, 214 Einträge, abgerufen 26.10.2026). Städte werden exakt, über Aliase oder über einen eindeutigen Präfix erkannt; ein nicht erkannter Ort fällt mit Warnung auf "im Übrigen" zurück.
- Flug und Schiff (R 9.6 Abs. 3 LStR, V): Bei Flügen zählt der Staat der Landung; Zwischenlandungen bleiben unberücksichtigt, außer sie machen Übernachtungen nötig. Bei Flugreisen über mehr als zwei Kalendertage gilt für die Zwischentage der Satz für Österreich. Bei Schiffsreisen gilt der Satz für Luxemburg, am Ein- und Ausschiffungstag der des Hafenorts. Maßgeblich ist der Ort, der vor 24 Uhr Ortszeit zuletzt erreicht wird; eine eigene Zeitzonenregel gibt es nicht.
- Auslandstabelle 2027 (U): noch nicht veröffentlicht, Erwartung Dezember 2026. Das Tool rechnet für 2027 nicht mit Vorjahreswerten, sondern bricht mit Fehler ab.

## Übernachtung

- Angestellte (V): nachgewiesene Kosten oder bei Erstattung durch den Arbeitgeber die Pauschale (Inland 20 €, Ausland laut Tabelle), Rz. 128 BMF 2020 und BMF 05.12.2025.
  - Umsetzung im Tool: Die Nächte für die Pauschale ergeben sich aus dem Datumsunterschied. Die Nacht der Heimreise vor 06:00 Uhr sowie Nächte im Flugzeug oder auf dem Schiff zählen nicht (A); `lodging_nights` begrenzt die Zahl nach oben.
- Selbstständige und GF (A): nur tatsächliche Kosten. Weder R 4.12 EStR noch das BMF-Schreiben 23.12.2014 kennen eine Übernachtungspauschale; die LStR kennen sie nur als steuerfreie Arbeitgebererstattung (R 9.7 Abs. 3 LStR). Wird im Beleg als Auslegung gekennzeichnet.
- Frühstück im Hotelpreis (V, Rz. 118 BMF 2020): Ohne separaten Ausweis wird der Gesamtpreis um 20 % bzw. 40 % der 24-Stunden-Pauschale am Unterkunftsort gekürzt.

## Fahrtkosten

- 0,30 €/km Pkw, 0,20 €/km anderes motorbetriebenes Fahrzeug (§ 9 Abs. 1 Satz 3 Nr. 4a Satz 2 EStG i. V. m. § 5 Abs. 2 BRKG, Rz. 37 BMF 2020; V). Nicht bei regelmäßig verkehrenden Beförderungsmitteln.
- Gewinneinkünfte (R 4.12 Abs. 2 EStR, V): pauschale Kilometersätze nur für **private** Beförderungsmittel. Beim Betriebs-Pkw gelten die tatsächlichen Kosten.
- Fahrrad: keine steuerliche Pauschale (V). Mitnahme von Personen: kein Zuschlag (V).
- Die Entfernungspauschale (0,38 €/km, § 9 Abs. 1 Satz 3 Nr. 4 EStG) gehört nicht in die Reisekostenabrechnung.

## Nebenkosten, Belege, Aufzeichnung

- Nebenkosten (Rz. 129 bis 132 BMF 2020, V): Gepäck, Telefon, Parken, Maut; nicht erstattungsfähig u. a. Minibar, Pay-TV, Bußgelder, Kleidung.
- Nachweis (R 9.4 Abs. 1 Satz 5 LStR, V): berufliche Veranlassung, Reisedauer und Reiseweg sind aufzuzeichnen und nachzuweisen oder glaubhaft zu machen. Keine abschließende Mindestliste. Für Gewinneinkünfte gibt es keine eigene Aufzeichnungspflicht (§ 4 Abs. 7 EStG nennt Nr. 5 nicht).
- Fehlender Beleg (V): "Eigenbeleg" kommt in den gelesenen Texten nicht vor; es gilt nachweisen oder glaubhaft machen, sonst Schätzung nach § 162 AO. Das Tool erzeugt keinen Ersatzbeleg, sondern markiert die Position.
- Aufbewahrung (§ 147 Abs. 3 AO, V): 8 Jahre für Buchungsbelege.
- GoBD-Grundtext (BMF 28.11.2019) nicht gelesen (U); die Änderungsschreiben BMF 11.03.2024 und 14.07.2025 (V) betreffen E-Rechnungen.

## Umsatzsteuer

- Hotel 2026 (V, BMF 22.12.2025, III C 2 - S 7220/00023/014/027): Übernachtung 7 %; Restaurant- und Verpflegungsdienstleistungen ohne Getränke seit 1.1.2026 ebenfalls 7 % (§ 12 Abs. 2 Nr. 15 UStG), Getränke 19 %. Wie das Frühstück im Sammelposten zu behandeln ist, regelt der UStAE nicht eindeutig (Abs. 8 und 12 nennen es noch als nicht begünstigt); das Tool übernimmt den ausgewiesenen Steuerbetrag je Satz und warnt. Ein Beleg mit zwei Steuersätzen wird als zwei Ausgaben erfasst.
- Bahn: 7 % ohne Kilometergrenze (§ 12 Abs. 2 Nr. 10 Buchst. a UStG); Taxi und Fernbus 7 % nur innerhalb einer Gemeinde oder bis 50 km, sonst 19 %; Mietwagen 19 % (V). Grenzüberschreitend zählt nur der Inlandsanteil laut Bescheinigung nach § 34 Abs. 2 UStDV.
- Flug (V): Inlandsflug 19 %, Vorsteuer nur bei ausgewiesenem Steuersatz auf dem Fahrausweis (§ 35 Abs. 2 Satz 4 UStDV, UStAE 15.5 Abs. 5). Grenzüberschreitend ist nur der Inlandsteil steuerbar (§ 3b Abs. 1 UStG); nach § 26 Abs. 3 UStG kann die Steuer erlassen werden, wenn kein gesonderter Steuerausweis erfolgt, dann keine Vorsteuer. Die Praxis der Airlines ist nicht belegt (U).
- Ausländische Umsatzsteuer (V): kein deutscher Vorsteuerabzug; EU-Erstattungsverfahren (§ 18g UStG, UStAE 18g.1, BZSt-Portal), Frist 30. September des Folgejahres, Mindestbetrag 400 € (Antragszeitraum ab drei Monaten) bzw. 50 € (Jahresantrag). Belegvorlageschwellen und nationale Regeln der Erstattungsstaaten nicht geprüft (U).
- Pauschalen (A): kein Vorsteuerabzug, weil keine Rechnung vorliegt (§ 15 Abs. 1 Nr. 1 UStG).
- Rechnung auf den Arbeitnehmer (V/A): Vorsteuerabzug setzt eine Rechnung auf den Namen des Leistungsempfängers voraus (UStAE 15.2a Abs. 3, UStAE 1.8 Abs. 13); lautet sie auf den Arbeitnehmer, kann die Firma keinen Vorsteuerabzug nehmen, außer bei Kleinbetragsrechnung (§ 33 UStDV, bis 250 € brutto).
- E-Rechnung (V, § 14 Abs. 2 und § 27 Abs. 38 UStG): Hotelrechnungen an die Firma sind ab 2027 (Aussteller mit Vorjahresumsatz über 800.000 €) bzw. 2028 (alle) strukturiert zu erwarten; Beherbergung an Nichtunternehmer erfordert keine Rechnung (UStAE 12.16 Abs. 10). Eingehende E-Rechnungen sind im Empfangsformat aufzubewahren (GoBD Rz. 131, V über BMF 14.07.2025). Hängt das Tool eine E-Rechnung als Anhang an, geht die eingebettete XML-Datei nicht mit; das Empfangsformat muss separat aufbewahrt werden.
- Fremdwährung (V, § 16 Abs. 6 UStG, UStAE 16.4): BMF-Monatsdurchschnittskurs des Leistungsmonats; Tageskurs nur mit Gestattung des Finanzamts. Für die Einkommensteuer ist der Kurs bei Reisekosten nicht ausdrücklich geregelt (V, Negativfeststellung).

## Geschäftsführer (vGA)

- R 8.5 Abs. 2 KStR (V): Beim beherrschenden Gesellschafter wird die Veranlassung durch das Gesellschaftsverhältnis in der Regel angenommen, wenn eine zivilrechtlich wirksame, klare, eindeutige und im Voraus abgeschlossene Vereinbarung fehlt oder nicht danach verfahren wird. H 8.5 KStH nennt Reisekosten des GGf ausdrücklich (Zitat BFH I R 86/04; BFH-Volltext nicht gelesen, U). BMF 2020 Rz. 10 verlangt die Beachtung von § 42 AO und des Fremdvergleichs.

## Bewirtung auf der Reise

- Eigene Mahlzeiten des Reisenden sind nur über die Verpflegungspauschale abziehbar. Bewirtung Dritter folgt dem Bewirtungsbeleg ([bewirtungsbeleg-faq.md](bewirtungsbeleg-faq.md)); BMF 19.11.2025 (IV C 6 - S 2145/00026/005/033). Der Anteil des Reisenden an einer Bewirtungsrechnung ist nicht geklärt (U).

## Quellen mit Aktenzeichen

| Quelle | Aktenzeichen / Fundstelle | Gelesen über |
|---|---|---|
| BMF 05.12.2025, Auslandsreisekosten ab 01.01.2026 | IV C 5 - S 2353/00094/007/012, BStBl I S. 2078 | LStH 2026 Anhang 25 I |
| BMF 25.11.2020, Reisekosten ab 2020 | IV C 5 - S 2353/19/10011 :006, BStBl I S. 1228 | LStH 2026 Anhang 25 III |
| BMF 22.12.2025, Umsatzsteuer Verpflegung/Hotel | III C 2 - S 7220/00023/014/027 | BMF-Schreiben |
| BMF 19.11.2025, Bewirtung | IV C 6 - S 2145/00026/005/033 | BMF-Schreiben |
| BMF 14.07.2025, Änderung GoBD (E-Rechnung) | GoBD Rz. 131 | BMF-Schreiben |
| EStG, UStG, UStDV, BRKG, AO, UStAE | Normen wie oben genannt | gesetze-im-internet.de |

## Auslegungspunkte zur Prüfung durch den Steuerberater

Vor Produktivbetrieb liest ein Steuerberater gegen. Das Tool kennzeichnet diese Punkte im erzeugten Beleg als Auslegung bzw. warnt.

1. Ausschluss der Übernachtungspauschale bei Selbstständigen und Geschäftsführern (A).
2. Frühstück im Hotel-Sammelposten 2026: Steuersatz im UStAE nicht eindeutig; Herausrechnen bei Selbstständigen als Auslegung.
3. Umrechnungskurs bei der Einkommensteuer (nicht ausdrücklich geregelt).
4. vGA-Anforderungen beim Geschäftsführer (Vorab-Vereinbarung).
5. Flugtickets ohne Steuerausweis (Vorsteuer, § 26 Abs. 3 UStG; Praxis der Airlines nicht belegt, U).
6. GoBD-Anforderungen an den erzeugten Abrechnungsbeleg (GoBD-Grundtext nicht gelesen, U).

Weitere offene Punkte (nicht blockierend): Auslandstabelle 2027 (Veröffentlichung im Dezember 2026 erwartet); BFH-Volltexte und BFH-Rechtsprechung zum Eigenbeleg bei Reisekosten; BRKG-Verwaltungsvorschrift zum Fahrrad (steuerlich ohne Bedeutung).
