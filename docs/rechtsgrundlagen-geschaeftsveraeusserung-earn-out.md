# Geschäftsveräußerung im Ganzen mit Earn-Out: Rechtsgrundlagen, Buchungsempfehlung und Umsetzungsvorschlag

Stand: Recherche vom 09.11.2026. Keine Steuerberatung; verbindlich sind das Finanzamt oder der Steuerberater. Umsetzungsstand im
Konnektor: Abschnitt 10. Alle Zahlen in Beispielen sind erfunden.

## 0. Sachverhalt, der geprüft wurde

Ein Einzelunternehmen (Einnahmenüberschussrechnung, SKR03, Regelbesteuerung) überträgt seinen Betrieb oder einen Teilbetrieb an einen
anderen Unternehmer, der ihn fortführt. Der Kaufpreis besteht aus einem festen Teil und einer umsatz- oder gewinnabhängigen Komponente
("Earn-Out", im Vertrag oft "Provision" genannt), die der Erwerber über mehrere Jahre nach dem Übergang zahlt. Daneben kann eine
Vermittlungsprovision an einen M&A-Berater anfallen, die der Veräußerer oder der Erwerber trägt, teils vom Kaufpreis einbehalten.

Nicht geprüft wurden die Veräußerung von GmbH-Anteilen (Share Deal), Personengesellschaften, Grundstücke, Kleinunternehmer als
Veräußerer und die Einbringung gegen Gesellschaftsrechte. Welche der Konstellationen konkret vorliegt, ist vor dem Buchen zu klären
(Abschnitt 8). Der Gegenfall ohne Betriebsübergang steht in 2.2a.

## 1. Ergebnis

| Frage | Einordnung |
| --- | --- |
| Umsatzsteuer auf Festpreis und Earn-Out? | Nein, nicht steuerbar (§ 1 Abs. 1a UStG), wenn die wesentlichen Grundlagen an einen Unternehmer übergehen, der den Betrieb fortführt. Earn-Out ist Entgelt desselben Umsatzes; die Zahlungsweise ändert den Charakter nicht. `vat` = `0_none`. |
| Umsatzsteuer-Voranmeldung | Keine Kennziffer. Auch nicht Kz 45 ("übrige nicht steuerbare Umsätze, Leistungsort nicht im Inland"), denn der Leistungsort ist im Inland. |
| Rechnung | Ohne Steuerausweis, mit Hinweis auf § 1 Abs. 1a UStG. Ein Steuerausweis löst § 14c Abs. 1 UStG aus, der Erwerber bekommt daraus keine Vorsteuer. |
| Vorsteuer aus Beraterkosten des Veräußerers | Abziehbar nach dem Verhältnis der gesamten Tätigkeit des Veräußerers; bei rein steuerpflichtigen Umsätzen voll (`19_pre`). |
| Vorsteuerberichtigung § 15a UStG | Beim Veräußerer keine; der Erwerber tritt in den Berichtigungszeitraum ein, der Veräußerer muss ihm die Angaben liefern. |
| Ertragsteuer fester Kaufpreis | Veräußerungsgewinn nach § 16 EStG im Jahr der Übertragung, Freibetrag § 16 Abs. 4 und Tarifermäßigung § 34 EStG möglich. Bei EÜR vorher fingierter Wechsel zum Bestandsvergleich mit Übergangsgewinn (laufender Gewinn). |
| Ertragsteuer Earn-Out | Erst bei Zufluss als nachträgliche Betriebseinnahme (§ 24 Nr. 2 EStG), ohne Rückwirkung auf den Veräußerungsgewinn, ohne § 16 Abs. 4 und § 34 EStG (BFH IV R 9/21). |
| Gewerbesteuer | Veräußerungsgewinn und Earn-Out bei natürlichen Personen nicht gewerbesteuerbar; der Übergangsgewinn aus dem Wechsel der Gewinnermittlungsart schon. |
| Konten (SKR03) | Erlöse 8829 (Sachanlagen, Buchgewinn) und 8837 (immaterielle Werte wie Kundenstamm, Firmenwert), Restbuchwerte 2315/2316 über die Anlagenverwaltung, Veräußerungskosten getrennt vom laufenden Aufwand. Nicht 8820/8801 (Automatikkonten mit 19 %). |

## 2. Umsatzsteuer

### 2.1 Voraussetzungen der nicht steuerbaren Geschäftsveräußerung

§ 1 Abs. 1a UStG: Umsätze im Rahmen einer Geschäftsveräußerung an einen anderen Unternehmer für dessen Unternehmen unterliegen nicht
der Umsatzsteuer. Eine Geschäftsveräußerung liegt vor, wenn ein Unternehmen oder ein in der Gliederung gesondert geführter Betrieb im
Ganzen entgeltlich oder unentgeltlich übereignet oder in eine Gesellschaft eingebracht wird. Der Erwerber tritt an die Stelle des
Veräußerers (Satz 3).

Aus dem Umsatzsteuer-Anwendungserlass (UStAE, Gesamtfassung Stand 19.10.2026, Abschnitt 1.5):

- **Hinreichendes Ganzes** (Abs. 1 Satz 1 bis 3): Die übertragenen Gegenstände müssen dem Erwerber die Fortsetzung der bisherigen
  Tätigkeit ermöglichen, und er muss das beabsichtigen. Gesamtwürdigung nach Art der Gegenstände und Ähnlichkeit der Tätigkeit vorher und
  nachher (BFH V R 21/07, V R 14/05). Die Unternehmereigenschaft des Erwerbers kann erst mit dem Erwerb beginnen.
- **Nur Übertragungsleistungen** (Abs. 1 Satz 4 und 5): Zur Geschäftsveräußerung zählen nur Leistungen im unmittelbaren Zusammenhang mit
  dem Übertragungsvorgang, die lediglich die Fortführung ermöglichen. Leistungen mit eigenständiger wirtschaftlicher Bedeutung gehören
  nicht dazu (BFH V R 41/21, BStBl II 2025 S. 642). Das ist der Prüfstein für die Earn-Out-Abrede (2.2).
- **Fortführung, Name egal** (Abs. 1 Satz 6, Abs. 1a Satz 1): Der Erwerber muss die Tätigkeit im Rahmen seiner Geschäftstätigkeit fortführen;
  Umbau oder Modernisierung schaden nicht, sofortige Abwicklung schließt die Geschäftsveräußerung aus (Abs. 1a Satz 2).
- **Veräußerer darf weitermachen** (Abs. 1a Satz 4): Keine Beendigung der unternehmerischen Tätigkeit des Veräußerers nötig (BFH XI R 10/12).
  Ein Einzelunternehmer, der nach dem Verkauf mit anderem Gegenstand weiter tätig ist, bleibt im Anwendungsbereich.
- **Wesentliche Grundlagen** (Abs. 3 und 4): Unwesentliche Wirtschaftsgüter dürfen ausgenommen werden (Abs. 3 Satz 1). Wesentliche
  Wirtschaftsgüter dürfen statt übereignet auch langfristig oder unbefristet an den Erwerber vermietet werden (Abs. 3 Satz 2 bis 4). Nicht
  eigentumsfähige Güter wie Geschäftsbeziehungen, Forderungen und Dienstverträge muss der Veräußerer übertragen, soweit sie für die
  Fortführung erforderlich sind (Abs. 4 Satz 5). Ein im Unternehmenskaufvertrag vereinbartes **Wettbewerbsverbot** kann als Umsatz im Rahmen
  der Geschäftsveräußerung nicht steuerbar sein (Abs. 4 Satz 8, BFH XI R 1/11).
- **Teilakte** (Abs. 5): Mehrere zeitlich versetzte Verträge sind eine Geschäftsveräußerung, wenn sie sachlich und zeitlich zusammenhängen
  und der Wille auf Erwerb des Unternehmens gerichtet ist.
- **Teilbetrieb** (Abs. 6): Ein gesondert geführter Betrieb liegt vor, wenn der veräußerte Teil vom Erwerber als selbständiges Unternehmen
  fortgeführt werden kann; eine vorherige organisatorische Verselbständigung beim Veräußerer ist nicht nötig. Wird einkommensteuerlich ein
  Teilbetrieb angenommen (R 16 Abs. 3 EStR), kann umsatzsteuerlich davon ausgegangen werden (Abs. 6 Satz 4).

Grenzfälle, die gegen eine Geschäftsveräußerung sprechen: Übertragung nur des Kundenstamms ohne die übrigen Grundlagen, Aufteilung
auf mehrere Erwerber (Abs. 3 Satz 5 nur im Verhältnis zum fortführenden Erwerber), Erwerber ohne Fortführungsabsicht. Dann ist der
Vorgang eine Summe steuerbarer Lieferungen und sonstiger Leistungen zu 19 %.

### 2.2 Earn-Out ist Entgelt der Geschäftsveräußerung, keine neue Leistung

Der Earn-Out ist ein aufschiebend bedingter Teil des Kaufpreises für die Übertragung des Betriebs. Umsatzsteuerlich ist er Entgelt für
denselben, nicht steuerbaren Umsatz. Dass er erst später und in unbestimmter Höhe fließt, macht ihn nicht zu einem eigenen Umsatz; es
gibt auch nichts nach § 17 UStG zu berichtigen, weil für den Ausgangsumsatz keine Steuer entstanden ist. In der Voranmeldung erscheint
weder der Festpreis noch der Earn-Out.

Anders, wenn die "Provision" eine Leistung mit eigenständiger wirtschaftlicher Bedeutung vergütet (UStAE 1.5 Abs. 1 Satz 5). Typische
Fälle: Der Veräußerer berät den Erwerber in der Übergangszeit, leitet Kunden aktiv über, vermittelt laufend Aufträge oder stellt
Arbeitskraft. Solche Vergütungen sind steuerbare sonstige Leistungen zu 19 % (Leistungsort beim Unternehmer-Empfänger, § 3a Abs. 2 UStG),
auch wenn sie im selben Vertrag stehen. Prüfkriterium für die Buchung:

1. Steht der Earn-Out im Kaufvertrag als Kaufpreisbestandteil und hängt nur von Umsatz oder Gewinn des übertragenen Betriebs ab?
2. Schuldet der Veräußerer dafür keine weitere Tätigkeit (ein reines Wettbewerbsverbot ist unschädlich)?

Beide Fragen mit Ja: nicht steuerbar, `0_none`. Eine Frage mit Nein: den Tätigkeitsanteil als steuerpflichtigen Umsatz trennen und mit
Steuerausweis abrechnen; die Aufteilung gehört zum Steuerberater.

### 2.2a Gegenfall: Kundenstamm gegen laufende Provision ohne Betriebsübergang

Häufige Gestaltung bei kleinen IT-Dienstleistern: Übertragen wird nur der Kundenstamm (Kundenbeziehungen, Goodwill, Dokumentation).
Bestehende Kundenverträge werden beendet, der Erwerber schließt eigene Neuverträge, Forderungen, Anlagevermögen und Personal bleiben
beim Veräußerer. Vergütet wird je Kunde, der tatsächlich wechselt, ein gestaffelter Sockelbetrag nach dessen Jahresumsatz beim
Erwerber und über mehrere Jahre eine Provision auf den Rohertrag des Erwerbers mit diesen Kunden. Der Veräußerer schuldet dabei
Übergabeleistungen (Kundenvorstellung, Wissenstransfer, Stundenkontingent) und darf laufend weitere Kunden zuführen, die dieselben
Ansprüche auslösen.

Das ist keine Geschäftsveräußerung im Sinne des § 1 Abs. 1a UStG: Es fehlt das hinreichende Ganze (UStAE 1.5 Abs. 1 Satz 2), es wird
kein Betrieb, sondern kundenweise und bedingt eine Geschäftsbeziehung übergeleitet, und die Vergütung hängt an einer fortlaufenden
Mitwirkung des Veräußerers (UStAE 1.5 Abs. 1 Satz 5). Sockelbetrag und Provision sind Entgelt für steuerbare, steuerpflichtige
sonstige Leistungen (Überlassung des Kundenstamms und Vermittlung) zu 19 %, Leistungsort beim unternehmerischen Empfänger im Inland
(§ 3a Abs. 2 UStG). Folgen:

- Rechnung oder Gutschrift je Abrechnungsperiode mit 19 % Umsatzsteuer, Leistungszeitraum angeben (§ 14 Abs. 4 Nr. 6 UStG); der
  Erwerber hat den Vorsteuerabzug. Kz 81 der Voranmeldung. Steht im Vertrag nur beim Sockelbetrag "zuzüglich Umsatzsteuer", ist für
  die Provision schriftlich klarzustellen, dass die Sätze Nettobeträge sind, sonst droht ein Streit um Brutto oder Netto.
- Ertragsteuer: laufende Betriebseinnahmen bei Zufluss (§ 11 EStG), solange der Betrieb des Veräußerers fortbesteht; nach einer
  Betriebsaufgabe nachträgliche Einkünfte nach § 24 Nr. 2 EStG. In beiden Fällen keine §§ 16 Abs. 4, 34 EStG (die Zahlungen sind
  variabel, BFH IV R 9/21 gilt entsprechend). Gewerbesteuer: bei fortbestehendem Betrieb gewerbesteuerpflichtig (Freibetrag § 11 Abs. 1
  GewStG 24.500 €), nach Betriebsaufgabe nicht (R 7.1 Abs. 3 Satz 2 GewStR). Ob eine Betriebsaufgabe vorliegt, entscheidet der
  Steuerberater anhand der tatsächlichen Einstellung der Tätigkeit.
- Buchung in BHB (SKR03, EÜR): Ausgangsrechnung erstellen, Zahlung mit `19_vat` auf ein Erlöskonto 19 % buchen; empfohlen ein eigenes
  Erlöskonto ("Provisionserlöse Kundenstammübertragung") statt 8400, damit die Reihe in BWA und `get_tax_position` erkennbar bleibt. Der
  Quartalsbericht des Erwerbers ist als Anlage zum Beleg die Aufzeichnung der Bemessungsgrundlage (§ 22 UStG). Ratenaufschläge auf den
  Sockelbetrag sind Teil des Entgelts, kein steuerfreier Zins.
- Für den Konnektor: Buchungstexte mit "Earn-Out" oder "Provision" auf einem Erlöskonto mit `0_none` sind in dieser Konstellation ein
  Fehler (fehlende Umsatzsteuer), nicht die Regel. Die Warnung aus Abschnitt 7 Nr. 3 muss deshalb beide Richtungen kennen und auf die
  Prüffragen aus 2.2 verweisen, statt eine Richtung zu unterstellen.

### 2.3 Rechnung, Steuerausweis, Vorsorgeklausel

Über den Kaufpreis wird ohne Umsatzsteuer abgerechnet, mit dem Hinweis "nicht steuerbare Geschäftsveräußerung im Ganzen nach
§ 1 Abs. 1a UStG". Weist der Veräußerer trotzdem Steuer aus, schuldet er sie nach § 14c Abs. 1 UStG; die Berichtigung ist nur zulässig,
wenn die Rechnung berichtigt wird und die Gefährdung des Steueraufkommens beseitigt ist (§ 14c Abs. 1 Satz 3 UStG, UStAE 14c.1 Abs. 11,
Verfahren in 14c.2). Der Erwerber darf nur die gesetzlich geschuldete Steuer abziehen und muss zu Unrecht gezogene Vorsteuer
zurückzahlen (UStAE 14c.1 Abs. 10).

Empfehlung für den Kaufvertrag: eine Steuerklausel, nach der der Erwerber eine Umsatzsteuer nachzahlt, falls das Finanzamt die
Geschäftsveräußerung verneint. Eine Option nach § 9 UStG kommt im Rahmen einer Geschäftsveräußerung grundsätzlich nicht in Betracht; nur
für Grundstücksumsätze erkennt die Verwaltung eine vorsorglich im notariellen Kaufvertrag erklärte Option an (UStAE 9.1 Abs. 3 Satz 2
und 3). Für einen IT-Betrieb ohne Grundstück ist das nicht einschlägig.

### 2.4 Vorsteuer aus Kosten der Veräußerung

Eine Geschäftsveräußerung ist kein Verwendungsumsatz im Sinne des § 15 Abs. 2 UStG (UStAE 1.5 Abs. 7, BFH V R 24/98). Eingangsleistungen
dafür (M&A-Berater, Anwalt, Bewertung, Vermittlungsprovision) sind deshalb nicht vom Vorsteuerabzug ausgeschlossen. Sie gehören zu den
allgemeinen Kosten der wirtschaftlichen Gesamttätigkeit; der Abzug richtet sich nach deren Verhältnis (EuGH C-408/98, Abbey National; im
UStAE 15.17 Abs. 3 Satz 4 bleibt die Geschäftsveräußerung aus dem Aufteilungsschlüssel heraus). Ein IT-Dienstleister mit ausschließlich
steuerpflichtigen Umsätzen zieht die Vorsteuer voll (`19_pre`). Kleinunternehmer ziehen keine Vorsteuer.

Vorsteuerberichtigung nach § 15a UStG: Der Berichtigungszeitraum wird durch die Geschäftsveräußerung nicht unterbrochen, der Veräußerer
muss dem Erwerber die nötigen Angaben machen (§ 15a Abs. 10 UStG); es liegt keine Änderung der Verhältnisse vor (UStAE 15a.2 Abs. 3,
15a.10 Nr. 1). Für den Veräußerer bedeutet das: keine Berichtigungsbuchung, aber eine Aufstellung der Wirtschaftsgüter mit laufendem
Berichtigungszeitraum an den Erwerber (relevant bei Anschaffungen über 1.000 € netto der letzten fünf Jahre).

### 2.5 Kleinunternehmergrenze

Der Gesamtumsatz nach § 19 Abs. 2 UStG umfasst nur steuerbare Umsätze nach § 1 Abs. 1 Nr. 1 UStG; Umsätze mit Anlagevermögen bleiben
ohnehin außer Ansatz (§ 19 Abs. 2 Satz 2). Festpreis und Earn-Out einer Geschäftsveräußerung zählen beim Veräußerer also nicht für die
Grenzen von 25.000 € und 100.000 € (Leitfaden-Thema `kleinunternehmer`).

## 3. Ertragsteuer beim Veräußerer (Einzelunternehmen, EÜR)

### 3.1 Fester Kaufpreis: Veräußerungsgewinn

Der Gewinn aus der Veräußerung des ganzen Betriebs oder eines Teilbetriebs gehört zu den Einkünften aus Gewerbebetrieb (§ 16 Abs. 1
Satz 1 Nr. 1 EStG). Veräußerungsgewinn ist der Veräußerungspreis nach Abzug der Veräußerungskosten abzüglich des Werts des
Betriebsvermögens (§ 16 Abs. 2 Satz 1 EStG); dieser Wert ist für den Zeitpunkt der Veräußerung nach § 4 Abs. 1 oder § 5 EStG zu ermitteln
(§ 16 Abs. 2 Satz 2 EStG). Vergünstigungen: Freibetrag nach § 16 Abs. 4 EStG (einmal im Leben, ab 55 Jahren oder bei dauernder
Berufsunfähigkeit) und die Tarifermäßigung nach § 34 Abs. 1 oder Abs. 3 EStG; § 34 Abs. 2 Nr. 1 EStG nennt als außerordentliche Einkünfte
die Veräußerungsgewinne im Sinne des § 16 EStG.

**EÜR-Besonderheit:** Wer den Gewinn nach § 4 Abs. 3 EStG ermittelt, wird bei der Betriebsveräußerung so behandelt, als wäre er im
Augenblick der Veräußerung zum Betriebsvermögensvergleich übergegangen (R 4.5 Abs. 6 Satz 1 EStR, mit Verweis auf R 4.6 EStR). Das gilt
auch für Teilbetriebe (Satz 2). Es entsteht ein Übergangsgewinn (offene Forderungen, Verbindlichkeiten, Warenbestand, Umsatzsteuer-
Salden), der laufender, nicht begünstigter Gewinn ist. Nach Sekundärquellen ist bei der Veräußerung keine Verteilung auf drei Jahre
möglich (H 4.5 (6) EStH; Hinweistext nicht im Original gelesen). Die Schlussrechnung macht der Steuerberater; BHB liefert dafür die
Salden (offene Belege, Kontenblätter, Summen- und Saldenliste zum Stichtag).

Die Vermittlungsprovision des Veräußerers ist Veräußerungskosten und mindert den Veräußerungsgewinn, nicht den laufenden Gewinn.

### 3.2 Earn-Out: Zuflussbesteuerung ohne Begünstigung

BFH, Urteil vom 09.11.2023, IV R 9/21 (Vorinstanz FG Rheinland-Pfalz, 30.03.2021, 5 K 2442/17): Neben dem Festkaufpreis zu leistende
gewinn- oder umsatzabhängige Kaufpreisbestandteile sind erst im Zeitpunkt des Zuflusses als nachträgliche Betriebseinnahmen zu
versteuern; sie erhöhen den Veräußerungsgewinn nicht. Das gilt auch für Earn-Out-Klauseln, bei denen das Entstehen dem Grunde und der
Höhe nach ungewiss ist (Leitsätze; Rn. 25: keine stichtagsbezogene Rückwirkung; Rn. 26: § 24 Nr. 2 EStG). Der Senat schließt sich dem
I. Senat an (BFH 19.12.2018, I R 71/16) und knüpft an die Linie des Großen Senats zum stichtagsbezogenen Veräußerungspreis an
(GrS 2/92). Entschieden wurde zur Veräußerung eines Mitunternehmeranteils; die Begründung stützt sich auf § 16 Abs. 2 EStG und § 24 Nr. 2
EStG und ist auf die Veräußerung eines Einzelbetriebs übertragbar (gleiche Normen, Sekundärquellen gehen einhellig davon aus).

Folgen:

- Jede Earn-Out-Zahlung ist im Jahr des Zuflusses (§ 11 EStG) in voller Höhe laufend zu versteuern, als nachträgliche Einkünfte aus
  Gewerbebetrieb (§ 15 i. V. m. § 24 Nr. 2 EStG).
- Kein Freibetrag nach § 16 Abs. 4 EStG und keine Tarifermäßigung nach § 34 EStG auf diese Zahlungen, denn sie sind kein
  Veräußerungsgewinn im Sinne des § 16 EStG (vgl. für wiederkehrende Bezüge ausdrücklich H 16 (11) EStH "Freibetrag").
- Kein Wahlrecht: Das Wahlrecht zwischen Sofort- und Zuflussbesteuerung in R 16 Abs. 11 EStR besteht für Leibrenten und ähnliche
  wiederkehrende Bezüge, nicht für dem Grunde und der Höhe nach ungewisse Earn-Outs; für diese gilt zwingend die Zuflussbesteuerung.
- Wird ein fester Kaufpreis in Raten gezahlt (Betrag steht fest, nur die Fälligkeit ist gestreckt), bleibt es beim stichtagsbezogenen
  Veräußerungsgewinn; nur Zinsanteile sind laufende Einnahmen. Die Abgrenzung "feste Rate" gegen "variabler Preis" ist im Vertrag zu
  lesen.
- Behält der Erwerber vom Earn-Out Beträge ein (Gegenforderungen, Provision), ist trotzdem der Bruttobetrag Einnahme und der Abzug eine
  eigene Ausgabe oder Verrechnung.

### 3.3 Gewerbesteuer

Für die Gewerbesteuer sind § 16 Abs. 1 Satz 1 Nr. 1, Abs. 3 Satz 1 EStG (Veräußerung oder Aufgabe des Betriebs, auch Teilbetrieb) und
§ 24 EStG nicht anzuwenden; Betriebseinnahmen ohne Zusammenhang mit einem laufenden Gewerbebetrieb scheiden aus dem Gewerbeertrag aus
(R 7.1 Abs. 3 Satz 1 und 2 GewStR, Gewerbesteuer-Handbuch 2024). Veräußerungsgewinn und Earn-Out eines Einzelunternehmers sind damit
nicht gewerbesteuerbar. Dagegen unterliegen die durch den Wechsel der Gewinnermittlungsart bedingten Hinzu- und Abrechnungen
(Übergangsgewinn) als laufender Gewinn der Gewerbesteuer (R 7.1 Abs. 3 Satz 7 GewStR). `get_tax_position` darf Erlöse der
Geschäftsveräußerung also nicht in den Gewerbeertrag rechnen, den Übergangsgewinn aber schon, sobald er bekannt ist.

## 4. Ertragsteuer beim Erwerber (kurz)

Der Erwerber hat Anschaffungskosten, die er auf die übernommenen Wirtschaftsgüter nach Teilwerten verteilt; ein Restbetrag ist
Geschäfts- oder Firmenwert (SKR03 35, Abschreibung über 15 Jahre nach § 7 Abs. 1 Satz 3 EStG, Konto 4824). Earn-Out-Zahlungen sind
nachträgliche Anschaffungskosten, die erst bei Entstehen aktiviert werden, ohne Rückwirkung (§ 255 Abs. 1 Satz 2 HGB; Sekundärquellen,
Primärtext nicht gelesen). Die Vermittlungsprovision des Erwerbers ist Anschaffungsnebenkosten. Umsatzsteuer: keine Vorsteuer aus dem
Kaufpreis (keine Steuer entstanden), Vorsteuer aus eigenen Beraterkosten nach der künftigen Tätigkeit, Eintritt in den
Berichtigungszeitraum nach § 15a Abs. 10 UStG. Für einen Erwerber, der zuvor nicht Unternehmer war, ist für die Kleinunternehmerregel im
Erwerbsjahr der Vorjahresumsatz des Veräußerers maßgeblich (im UStAE so für § 24 UStG formuliert; für § 19 UStG nicht geprüft).

## 5. Buchungsempfehlung in BuchhaltungsButler (Veräußerer, SKR03, EÜR)

Ziel: Die Veräußerungsvorgänge stehen in BHB ohne Umsatzsteuer, auf eigenen Konten und mit eindeutigem Buchungstext, damit die
Umsatzsteuer-Voranmeldung sie nicht enthält, BWA und `get_tax_position` sie vom laufenden Gewinn trennen können und der Steuerberater den
Veräußerungsgewinn und den Übergangsgewinn daraus ableiten kann. BHB bleibt EÜR-Buchhaltung; die Schlussbilanz entsteht außerhalb.

### 5.1 Konten

Live im SKR03-Katalog von BHB nachgeschlagen (09.11.2026, `list_posting_accounts`):

| Zweck | Konto SKR03 | Hinweis |
| --- | --- | --- |
| Erlös Sachanlagen (Hardware, Einrichtung, Fahrzeuge) | 8829 Erlöse aus Anlagenverkäufen (Buchgewinn), 8800 (Buchverlust) | Ohne Automatik. 8820 und 8801 sind Automatikkonten "19/16 %" und falsch. |
| Erlös immaterielle Werte (Kundenstamm, Firmenwert, Software, Domains) | 8837 Erlöse aus Verkäufen immaterieller Vermögensgegenstände (Buchgewinn), 8817 (Buchverlust) | Ohne Automatik. |
| Erlös Warenbestand im Rahmen der Geschäftsveräußerung | eigenes Konto anlegen (frei z. B. 8830 bis 8836) | 8850 ist Automatikkonto 19 %; 8851/8852 sind für steuerfreie Umsätze nach § 4 Nr. 8 ff. beschriftet. |
| Earn-Out (nachträgliche Betriebseinnahme) | 8837 mit eigenem Buchungstext oder eigenes Konto (z. B. 8831 "Earn-Out Geschäftsveräußerung, § 24 Nr. 2 EStG") | Eigenes Konto empfohlen, weil die Zahlungen in Folgejahren ohne Begünstigung laufen. |
| Restbuchwerte | 2315 (Sachanlagen, Buchgewinn), 2316 (immaterielle, Buchgewinn), 2310/2311 (Buchverlust) | Entstehen über das Ausbuchen in der Anlagenverwaltung, nicht per API. |
| Veräußerungskosten (Vermittlungsprovision, Anwalt, Bewertung) | eigenes Konto anlegen (z. B. in 2300er "Veräußerungskosten Geschäftsveräußerung") oder 2309 Sonstige Aufwendungen unregelmäßig | Vorsteuer `19_pre`. Nicht auf laufende Beratungskonten (4950 ff.), damit die BWA stimmt. |
| Firmenwert, Anzahlungen (Erwerberseite) | 35, 38 | Nur für den Erwerber. |

Die Wahl eigener Konten (per `manage_posting_account`) mit dem Steuerberater abstimmen: dessen DATEV-Übernahme braucht die Zuordnung.
Die Kontonummern 8830 bis 8836 sind im BHB-Katalog frei, ob DATEV sie anderweitig belegt, wurde nicht geprüft.

### 5.2 Ablauf

1. **Vertrag lesen, Konstellation festhalten** (Abschnitt 8): Festpreis, Earn-Out-Formel, Leistungspflichten des Veräußerers,
   Wettbewerbsverbot, Provisionen, Stichtag. Prüffragen aus 2.2 beantworten und als Kommentar (`add_comment`) an die erste Zahlung hängen.
2. **Aufteilung des Festpreises** auf Sachanlagen, immaterielle Werte, Warenbestand laut Kaufvertrag oder Steuerberater. Ohne Aufteilung
   zunächst alles auf 8837 mit dem Vermerk "Aufteilung offen".
3. **Rechnung an den Erwerber** über den Festpreis ohne Umsatzsteuer, Hinweistext "Nicht steuerbare Geschäftsveräußerung im Ganzen nach
   § 1 Abs. 1a UStG, keine Umsatzsteuer", Leistungsdatum = Übergangsstichtag. Für den Earn-Out je Abrechnungsperiode eine eigene Rechnung
   oder Gutschrift mit demselben Hinweis und der Berechnungsgrundlage (Umsatz der Periode, Satz).
4. **Zahlung Festpreis buchen** (`add_transaction_postings`): Bank an 8829/8837/eigenes Konto, `vat` `0_none`, Buchungstext
   "Geschäftsveräußerung § 1 Abs. 1a UStG, Kaufpreis fest, Vertrag vom TT.MM.JJJJ". Bei Einbehalten des Erwerbers (Provision, Ablösen)
   Splitbuchung: voller Kaufpreis auf das Erlöskonto, Einbehalt als negativer Split auf das Kostenkonto mit dem dazugehörigen Beleg (BHB
   liefert Einbehalte als negative Beträge, siehe CHANGELOG zu `get_liquidity`).
5. **Anlagen ausbuchen** in der Anlagenverwaltung (Oberfläche, Thema `anlagen_browser`): je Anlagegut auf die Verkaufsbuchung ausbuchen,
   BHB bucht den Restbuchwert auf 2315/2316 bzw. 2310/2311 und stoppt die Abschreibung. Keine manuellen Abgangsbuchungen per API, sonst
   doppelt.
6. **Veräußerungskosten buchen**: Eingangsrechnung des Vermittlers auf das Kostenkonto mit `19_pre`, Buchungstext "Veräußerungskosten
   Geschäftsveräußerung, Vermittlungsprovision". Trägt der Erwerber die Provision, gehört sie nicht in die Bücher des Veräußerers.
7. **Earn-Out buchen** bei jedem Zufluss: Bank an Earn-Out-Konto, `0_none`, Buchungstext "Earn-Out Periode JJJJ-QN, Geschäftsveräußerung
   § 1 Abs. 1a UStG, nachträgliche Betriebseinnahme § 24 Nr. 2 EStG". Läuft die Buchhaltung nur noch für die Earn-Out-Zahlungen weiter,
   bleibt das BHB-Konto bis zur letzten Zahlung aktiv; die Einnahmen gehören in die Anlage G des Zuflussjahres.
8. **Enthält die Provision eine Tätigkeit** des Veräußerers (2.2 mit Nein beantwortet): diesen Teil als steuerpflichtigen Erlös (8400,
   `19_vat`) mit ordentlicher Rechnung abrechnen und buchen; der Rest bleibt nicht steuerbar.
9. **Monatsabschluss**: In der Voranmeldung darf aus diesen Buchungen nichts stehen. `audit_vat_period` und die USt-VA-Vorschau in der
   Oberfläche prüfen, dass die 88xx-Buchungen ohne Steuer nicht als Fehler erscheinen.
10. **Übergabe an den Steuerberater**: Summen- und Saldenliste, Kontenblätter der 88xx/23xx-Konten, offene Belege zum Stichtag (für den
    Übergangsgewinn), Liste der Wirtschaftsgüter mit laufendem § 15a-Zeitraum (für den Erwerber).

### 5.3 Beispiel (erfunden)

Betrieb "Beispiel Systemhaus" wird zum 30.06. an die "Beispiel Erwerber GmbH" verkauft. Festpreis 60.000 € (davon 10.000 € Hardware,
50.000 € Kundenstamm), Earn-Out 10 % des Umsatzes mit den übernommenen Kunden für zwei Jahre, Vermittler erhält 6 % des Festpreises
zuzüglich 19 % Umsatzsteuer, vom Erwerber mit der ersten Zahlung einbehalten und an den Vermittler weitergeleitet.

- Zahlung 1 am 05.07.: 55.716 € (60.000 minus 4.284 € brutto Provision). Splits: +10.000 € 8829 `0_none` "Geschäftsveräußerung ...
  Hardware"; +50.000 € 8837 `0_none` "Geschäftsveräußerung ... Kundenstamm"; −4.284 € Veräußerungskosten `19_pre` mit der
  Vermittlerrechnung (3.600 € netto, 684 € Vorsteuer).
- Anlagenverwaltung: Restbuchwerte der verkauften Hardware 3.200 € werden auf 2315 ausgebucht.
- Earn-Out Q3: 2.750 € am 15.10. auf 8831 `0_none` "Earn-Out Periode 2026-Q3 ...". Rechnung ohne Umsatzsteuer mit Berechnung.
- Steuerlich: Veräußerungsgewinn vorläufig 60.000 − 3.200 − 3.600 = 53.200 € (vor Übergangsgewinn und Kapitalkonto) im Jahr der
  Übertragung, begünstigungsfähig. Earn-Out 2.750 € laufend im Zuflussjahr, nicht begünstigt, nicht gewerbesteuerbar.

## 6. Was der Konnektor heute dazu kann und nicht kann

- `get_booking_guide` hat kein Thema zur Geschäftsveräußerung; `abschreibung` und `anlagen_browser` decken nur den Abgang einzelner
  Anlagen ab.
- `get_ustva_position` kennt 8807/8808/8827/8828 (steuerfreie Anlagenverkäufe, Kz 41/43) und 8338/8339 (Kz 45), aber keine Aussage
  "nicht steuerbar, keine Kennziffer" für 8829/8837 mit `0_none`.
- `add_*_postings` warnt nicht, wenn ein Erlöskonto 88xx mit `19_vat` und einem Buchungstext zur Geschäftsveräußerung gebucht wird, und
  nicht, wenn `0_none` auf die Automatikkonten 8820/8801 trifft.
- `create_invoice` kennt den Hinweistext für § 1 Abs. 1a UStG nicht; der Kleinunternehmer-Hinweis ist der einzige vorgefertigte.
- `get_tax_position` rechnet alle Erlöskonten in den laufenden Gewinn und in die Gewerbesteuer; Veräußerungserlöse würden Gewerbesteuer
  und Einkommensteuer falsch hochrechnen und die §§ 16, 34 EStG ignorieren.
- `get_controlling` zeigt die 88xx-Erlöse im Umsatz, wenn BHBs BWA sie dort führt (nicht geprüft).

## 7. Umsetzungsvorschlag für den Einbau (Stand der Umsetzung: Abschnitt 10)

1. **Leitfaden-Thema `geschaeftsveraeusserung`** in `src/tools/booking-guide.ts` mit `regeln` (Voraussetzungen aus 2.1 in fünf Sätzen,
   Earn-Out als Entgelt, Prüffragen aus 2.2, § 14c, Vorsteuer aus Kosten, § 15a-Angaben, ESt-Folgen aus 3.1 bis 3.3, Erwerber kurz),
   `buchungen` (Tabelle 5.1 und Beispiel 5.3 in Sätzen), `ablauf` (5.2), `achtung` (Automatikkonten, Anlagenverwaltung, Übergangsgewinn,
   keine Begünstigung für Earn-Out, Tätigkeitsanteil trennen), `konnektor` (welche Tools was tun). `quelle` nennt diesen Vermerk; es gibt
   keinen BHB-Wissensartikel dazu (Stand 09.11.2026 nicht gesucht, bei Einbau einmal in wissen.buchhaltungsbutler.de prüfen).
2. **`get_ustva_position`**: Konten 8800, 8817, 8829, 8837 (und 8830 bis 8836 als frei) mit der Erklärung "Erlöskonto ohne feste Position;
   mit `0_none` als nicht steuerbare Geschäftsveräußerung keine Kennziffer, auch nicht Kz 45" beantworten, statt "kein Treffer".
3. **Buchungswarnungen** in `postings.ts`: (a) Erlöskonto 8800 bis 8839 mit `19_vat` oder `7_vat` und Buchungstext mit
   "Geschäftsveräußerung", "Earn-Out", "Kaufpreis" oder "§ 1 Abs. 1a" → Hinweis auf § 14c und das Thema, aber als Rückfrage mit den Prüffragen aus 2.2, denn im Gegenfall 2.2a ist 19 % richtig; umgekehrt `0_none` auf einem Erlöskonto mit solchem Text → Rückfrage, ob eine Geschäftsveräußerung vorliegt. (b) `0_none` auf 8820, 8801 oder
   8850 → Hinweis Automatikkonto. (c) Buchung auf 2310 bis 2317 per API → Hinweis Anlagenverwaltung (gibt es schon ähnlich für
   Anlagenkonten? prüfen).
4. **`create_invoice`**: Parameter `nicht_steuerbar_gig: true` (oder Erkennung am Positionstext), der Steuersatz 0 erzwingt und den
   Hinweistext einsetzt; bei Steuersatz > 0 und gesetztem Parameter ablehnen.
5. **Hausregel** `tax_profile.geschaeftsveraeusserung` in `policy.ts`: `{ stichtag, erloeskonten[], kostenkonten[], earn_out_konten[],
   uebergangsgewinn_eur | null }`. `get_tax_position` rechnet damit: Erlöse und Restbuchwerte dieser Konten aus dem laufenden Gewinn
   heraus, zeigt "Veräußerungsgewinn vorläufig" (Erlöse − Restbuchwerte − Kosten, ohne Kapitalkonto und Übergangsgewinn, mit Warnung),
   Earn-Out-Konten als "nachträgliche Betriebseinnahmen (laufend, ohne §§ 16, 34 EStG, nicht gewerbesteuerbar)", Übergangsgewinn als
   laufenden und gewerbesteuerpflichtigen Gewinn, sobald eingetragen. Warnungen: Freibetrag und Tarifermäßigung nur auf den
   stichtagsbezogenen Gewinn und nur nach Prüfung durch den Steuerberater; § 16 Abs. 4 einmal im Leben.
6. **`list_transactions` / `get_transaction`**: `booking_hints` für Zahlungseingänge, deren Verwendungszweck "Earn-Out", "Kaufpreis" oder
   "Geschäftsveräußerung" enthält, mit Verweis auf das Thema (wie bei `paypal_cashback`).
7. **`audit_vat_period` / `check_month_end`**: Erlösbuchungen ohne Steuer auf 88xx mit passendem Text nicht als Fehler, ohne passenden
   Text als Rückfrage melden.
8. **Doku**: CHANGELOG unter "Unreleased", README-Tabelle, Server-Anweisungen (ein Satz mit dem Themennamen), Tests mit erfundenen
   Zahlen (kein Livekonto in Tests).

Vor dem Einbau offen zu prüfen: die Wortlaute von § 16 Abs. 2 Satz 2 und Abs. 4, § 34 Abs. 1 und 3, § 7 Abs. 1 Satz 3 EStG (hier aus dem
Gedächtnis zitiert, nicht erneut gelesen), H 4.5 (6) EStH zur Nichtverteilung des Übergangsgewinns, die DATEV-Belegung der Konten 8830
bis 8836, und ob BHBs BWA die 88xx-Konten als Umsatz führt.

## 8. Offene Punkte, vor dem Buchen zu klären

1. Welche Seite bucht: Fieber IT als Veräußerer (EÜR, SKR03) oder eine Gesellschaft als Erwerber? Der Vermerk ist für den Veräußerer
   geschrieben, Abschnitt 4 deckt den Erwerber nur an.
2. Ist die "Earn-Out-Provision" ein variabler Kaufpreis an den Veräußerer oder die Provision eines Vermittlers, die am Earn-Out bemessen
   wird? Beides ist beschrieben (2.2 bzw. 2.4 und 5.2 Schritt 6), die Buchung ist verschieden.
3. Kaufvertrag: Earn-Out ohne Leistungspflicht des Veräußerers? Übergangsberatung gesondert vergütet? Wettbewerbsverbot? Steuerklausel?
4. Hat der Erwerber den Betrieb fortgeführt und war er Unternehmer (oder ist er es mit dem Erwerb geworden)?
5. Kaufpreisaufteilung auf Wirtschaftsgüter und Höhe des Übergangsgewinns: nur mit dem Steuerberater.
6. Liegt die Übertragung in einem Jahr, in dem Fieber IT noch laufende Umsätze hatte? Dann Teilbetrieb oder Gesamtbetrieb (für § 16
   Abs. 4 EStG und die Gewerbesteuerfreiheit ist beides erfasst, für die Ermittlung aber verschieden).

## 9. Quellenprotokoll und Fundstellenprüfung

Geprüft nach den fünf Dimensionen Existenz, Identität, Inhalt, Zeitbezug und Übertragbarkeit. "Original gelesen" heißt: Volltext am
09.11.2026 abgerufen und die zitierte Stelle gelesen. Suchausschnitte und Fachbeiträge sind kein Nachweis und unten getrennt genannt.

| Fundstelle | Zugang | Existenz/Identität | Inhalt | Zeitbezug | Übertragbarkeit auf den Fall |
| --- | --- | --- | --- | --- | --- |
| § 1 Abs. 1a, § 15a Abs. 10 UStG | gesetze-im-internet.de, per Agent sinngemäß mit Kurzzitaten | bestätigt | bestätigt (sinngemäß, drei bzw. zwei Sätze) | geltende Fassung, Seite nennt keinen Stand | direkt einschlägig |
| § 14c Abs. 1, § 19 Abs. 2 UStG; § 24 Nr. 2, § 34 Abs. 2 Nr. 1 EStG | gesetze-im-internet.de, direkt gelesen | bestätigt | bestätigt (Wortlaut gelesen) | geltende Fassung | direkt einschlägig |
| § 16 Abs. 1, 2, 4; § 34 Abs. 1, 3; § 7 Abs. 1 Satz 3 EStG; § 255 Abs. 1 Satz 2 HGB | nicht erneut gelesen | aus dem Gedächtnis, Existenz nicht fraglich | **offen**: Wortlaut vor Einbau lesen | offen | einschlägig |
| UStAE Abschnitt 1.5 Abs. 1 bis 8 | BMF-Gesamtfassung PDF, Stand 19.10.2026 (nach Stand 31.12.2025 mit Änderungen bis 2026), Text extrahiert und vollständig gelesen | bestätigt | bestätigt, Sätze oben zitiert | aktuell; Abs. 1 Satz 8 zuletzt geändert durch BMF 20.01.2026 | direkt einschlägig |
| UStAE 9.1 Abs. 3 Satz 2 und 3; 14c.1 Abs. 10 und 11; 15.2 Abs. 4; 15.17 Abs. 3 Satz 4; 15a.2 Abs. 3; 15a.10 Nr. 1; 3a.2 Abs. 8 Satz 2 | dieselbe Fassung, gelesen | bestätigt | bestätigt | aktuell | einschlägig; 9.1 nur für Grundstücke relevant |
| BFH 09.11.2023, IV R 9/21 | IWW-Abruf 239077 (nichtamtliche Wiedergabe, Rn. 1 bis 28 wörtlich, Rest nur Zusammenfassung); amtliche BFH-Seite nicht erreicht (Suchformular, rewis 403) | Aktenzeichen, Datum, Vorinstanz 5 K 2442/17 und Leitsätze in der nichtamtlichen Quelle konsistent; amtliche Veröffentlichung laut Sekundärquellen 18.04.2024 | Leitsätze und Rn. 19 bis 28 bestätigt; Aussage zu § 34 EStG im gelesenen Teil nur mittelbar (Rn. 25 "Systematik der §§ 16, 34 EStG"), der Ausschluss der Begünstigung folgt aus § 34 Abs. 2 Nr. 1 EStG und H 16 (11) EStH | 2023, keine Gesetzesänderung seither bekannt | entschieden zum Mitunternehmeranteil; Übertragung auf den Einzelbetrieb ist eigene Schlussfolgerung über dieselben Normen |
| BFH I R 71/16, GrS 2/92, V R 41/21, XI R 1/11, XI R 10/12, V R 24/98, V R 14/05, V R 21/07 | nur als Zitate im UStAE bzw. in IV R 9/21 | Existenz über die amtliche Zitierung plausibel | **nicht gelesen** | - | nur so weit, wie UStAE bzw. BFH sie wiedergeben |
| EuGH 22.02.2001, C-408/98, Abbey National | nicht gelesen; Sekundärquellen | Existenz plausibel | **offen**; die Aussage "Kosten der Geschäftsveräußerung sind allgemeine Kosten der Gesamttätigkeit" stammt aus Sekundärquellen und wird durch UStAE 1.5 Abs. 7 und 15.17 Abs. 3 im Ergebnis getragen | 2001 | einschlägig |
| R 4.5 Abs. 6, R 16 Abs. 3 und 11, H 16 (11) EStR/EStH 2025 | esth.bundesfinanzministerium.de (Amtliches ESt-Handbuch 2025), gelesen | bestätigt | bestätigt | EStR-Stand des Handbuchs 2025 | direkt einschlägig |
| H 4.5 (6) EStH (keine Verteilung des Übergangsgewinns bei Veräußerung) | nicht gelesen; Sekundärquellen | offen | **offen** | - | - |
| R 7.1 Abs. 3 Satz 1, 2 und 7 GewStR | gewsth.bundesfinanzministerium.de (Amtliches GewSt-Handbuch 2024), gelesen | bestätigt | bestätigt | GewStR-Stand des Handbuchs 2024 | direkt einschlägig |
| Anleitung zur USt-Voranmeldung 2026 (USt 1 E) | nicht erreicht (BMF 503, Formularserver ohne Direktlink) | - | **offen**; Kz-45-Wortlaut "Übrige nicht steuerbare Umsätze (Leistungsort nicht im Inland)" nur aus Vordruckabdrucken Dritter | - | Schluss "Geschäftsveräußerung nicht in Kz 45" ist eigene Folgerung aus dem Vordruckwortlaut |
| SKR03-Konten 8800 ff., 2310 ff., 35/38, 4824 | `list_posting_accounts` am Fieber-IT-Konto (Kontenkatalog, keine Buchungsdaten) | bestätigt | bestätigt | Katalog 09.11.2026 | direkt |

Nichtamtliche Quellen, nur zur Orientierung genutzt (keine Nachweise): Kleeberg, EY, PwC, Grant Thornton, IWW, Haufe, BDO, BUSE,
REEF Legal (zu IV R 9/21 und Earn-Out); Haufe und steuerkurse.de (UStAE 1.5, Kundenstamm); firma.de, Deubner, Sonntag & Partner
(§ 14c, Steuerklausel); CMS, Rödl, Deloitte (Earn-Out beim Erwerber); jahresabschluss.io, NWB-Datenbank (Gewerbesteuer); steuerschroeder.de
(Vordrucke 2026). Im Skill-Repo claude-fuer-deutsches-recht gibt es kein Skill zu Umsatz- oder Ertragsteuer der Geschäftsveräußerung
(Skill-Liste vom 09.11.2026 durchgesehen).

Technik der Abrufe: UStAE als PDF von bundesfinanzministerium.de (`Umsatzsteuer-Anwendungserlass-aktuell.pdf`), Text mit `unpdf` aus
dem Repo extrahiert; EStH/GewStH über die BMF-Handbuchseiten; Gesetze über gesetze-im-internet.de. Die Haufe-Seiten zum UStAE sind
hinter einer Paywall, steuerschroeder.de antwortete mit HTTP 500, rewis.io mit 403, die BFH-Entscheidungsdatenbank ist nur über ihr
Suchformular erreichbar.

## 10. Umsetzungsstand 09.11.2026

Umgesetzt (Modul `src/tools/geschaeftsveraeusserung.ts`, Tests mit erfundenen Daten in `geschaeftsveraeusserung.test.ts`):

- Nr. 1 Leitfaden-Thema `geschaeftsveraeusserung` mit beiden Fällen (2.1 bis 2.5 und 2.2a, 3, 5), Quelle ist dieser Vermerk.
- Nr. 2 `get_ustva_position` beantwortet 8800, 8817, 8829, 8837 mit dem Hinweis "keine feste Position, mit 0_none nicht in der USt-VA,
  nicht Kz 45".
- Nr. 3 Buchungswarnungen in beide Richtungen (Text mit Umsatzsteuer, Text mit 0_none, 0_none auf 8820/8801/8850), als Rückfrage mit
  Verweis auf die Prüffragen; der Kontenrahmen wird nur bei einem möglichen Treffer geholt.
- Nr. 4 `create_invoice`: kein eigener Parameter, sondern Erkennung am Positions- oder Begleittext; Prüffragen bei Steuersatz > 0,
  Textvorschlag für `final_provisions` bei Steuersatz 0 ohne Hinweis. Keine Ablehnung, weil beide Richtungen richtig sein können.
- Nr. 6 `booking_hints` in `list_transactions` und `get_transaction`.
- Nr. 8 CHANGELOG, Server-Anweisungen (ein Absatz), dieser Vermerk.

Nicht umgesetzt: Nr. 5 (Hausregel und Rechnung in `get_tax_position`; braucht Stichtag, Kontenliste und Übergangsgewinn vom
Steuerberater) und Nr. 7 (`audit_vat_period`; die Prüfung meldet Erlöse ohne Steuer heute nicht gesondert, es gab nichts zu
unterdrücken). Die in Abschnitt 7 genannten offenen Normwortlaute wurden nicht nachgelesen; der Leitfaden zitiert sie nur so,
wie dieser Vermerk sie wiedergibt.
