# Gemischte Belege (privat und geschäftlich): Rechtsgrundlagen und Auslegungspunkte

Hintergrund zu `prepare_mixed_receipt`, `generate_mixed_receipt` und `generate_and_upload_mixed_receipt`. Recherchestand 30.10.2026. Keine Steuerberatung; verbindlich sind das Finanzamt oder ein Steuerberater.

Kennzeichnung je Aussage:

- **V** = Text selbst gelesen.
- **A** = Auslegung aus gelesenen Texten, keine wörtliche Aussage.
- **U** = nicht verifiziert, nicht als Tatsache weitergeben.

Gelesene Quellen: `gesetze-im-internet.de` (AO, UStG, UStDV, EStG, KStG), GoBD (BMF 28.11.2019, IV A 4 - S 0316/19/10003 :001, BStBl I 2019 S. 1269, Kopie beim LfSt Bayern; Änderungen vom 11.03.2024 und 14.07.2025 über `bundesfinanzministerium.de`), UStAE in der Fassung inkl. BMF 09.04.2026 über die NWB-Datenbank (`steuerschroeder.de` ist veraltet: dort noch 150-€-Grenze), EStH 2025, LStH 2026 und KStH 2026 über die BMF-Handbuchseiten, BStBK-FAQ "Digitale Aufbewahrung" (Stand 19.03.2026), BFH-Urteile über Haufe. Das Repo `Klotzkette/claude-fuer-deutsches-recht` ist **keine** Quelle (Issue [#613](https://github.com/Klotzkette/claude-fuer-deutsches-recht/issues/613)).

## Ausgangslage

Ein Gesellschafter oder Mitarbeiter kauft privat ein und bezahlt mit eigenem Geld; auf demselben Kassenbon stehen auch Positionen für das Unternehmen (typisch: Kaffee, Milch, Wasser fürs Büro). Das Unternehmen erstattet den geschäftlichen Anteil als Auslage. Ziel: Nur der geschäftliche Anteil wird gebucht, die privaten Positionen sind im gebuchten Beleg unkenntlich, das Original bleibt unverändert erhalten.

## Unveränderbarkeit und Aufbewahrung

- § 146 Abs. 4 AO (V): "Eine Buchung oder eine Aufzeichnung darf nicht in einer Weise verändert werden, dass der ursprüngliche Inhalt nicht mehr feststellbar ist."
- § 147 Abs. 1 Nr. 4, Abs. 3 Satz 1 AO (V): Buchungsbelege sind acht Jahre aufzubewahren.
- GoBD Rz. 58, 107, 108 (V): Informationen, die einmal in den Verarbeitungsprozess eingeführt wurden (Beleg, Grundaufzeichnung, Buchung), dürfen "nicht ohne Kenntlichmachung durch neue Daten ersetzt werden".
- GoBD Rz. 111 Satz 1 (V): "Spätere Änderungen sind ausschließlich so vorzunehmen, dass sowohl der ursprüngliche Inhalt als auch die Tatsache, dass Veränderungen vorgenommen wurden, erkennbar bleiben."
- GoBD Rz. 110 (V): Die Ablage in einem Dateisystem erfüllt die Unveränderbarkeit "regelmäßig nicht, soweit nicht zusätzliche Maßnahmen ergriffen werden".
- GoBD Rz. 130 (V): Ein gescannter oder fotografierter Papierbeleg ist so aufzubewahren, "dass die Wiedergabe mit dem Original bildlich übereinstimmt".
- GoBD Rz. 135 (V): Bei einer Konvertierung sind "beide Versionen zu archivieren, derselben Aufzeichnung zuzuordnen und mit demselben Index zu verwalten sowie die konvertierte Version als solche zu kennzeichnen".
- Folgerung (A): Der Kassenbon ist für den geschäftlichen Teil ein Buchungsbeleg. Eine geschwärzte Fassung darf nur **zusätzlich** entstehen; das ungeschwärzte Original bleibt unverändert, beide werden verknüpft (Belegnummer, SHA-256) und die geschwärzte Fassung ist als solche gekennzeichnet.
- BuchhaltungsButler (A, aus der BHB-Hilfe, siehe `get_booking_guide`): Belege werden nie physisch gelöscht; ein "gelöschter" Beleg bleibt im Archiv, ist über den Filter "Gelöschte Belege" sichtbar und wiederherstellbar. Das Original kann deshalb in BHB bleiben und soft-gelöscht werden, damit es nicht gebucht wird. Es bleibt für alle mit BHB-Zugang sichtbar; das ist keine Zugriffsbeschränkung im Sinne von Rz. 172.

## Schwärzen

- GoBD Rz. 172 (V): "Enthalten elektronisch gespeicherte Datenbestände z. B. nicht aufzeichnungs- und aufbewahrungspflichtige, personenbezogene oder dem Berufsgeheimnis (§ 102 AO) unterliegende Daten, so obliegt es dem Steuerpflichtigen oder dem von ihm beauftragten Dritten, die Datenbestände so zu organisieren, dass der Prüfer nur auf die aufzeichnungs- und aufbewahrungspflichtigen Daten des Steuerpflichtigen zugreifen kann. Dies kann z. B. durch geeignete Zugriffsbeschränkungen oder 'digitales Schwärzen' der zu schützenden Informationen erfolgen. Für versehentlich überlassene Daten besteht kein Verwertungsverbot." Gleichlautend BStBK-FAQ Frage 3.3.
- GoBD Rz. 113 (V): Die Aufbewahrungspflicht besteht "grundsätzlich nur im Umfang der Aufzeichnungspflicht".
- GoBD Rz. 173 (V): Vorgefilterte Reports, die nicht mehr alle aufzeichnungs- und aufbewahrungspflichtigen Daten enthalten, akzeptiert die Finanzbehörde nicht.
- Folgerung (A): Private Positionen dürfen in der geschwärzten Fassung unkenntlich sein. Bonsumme und MwSt-Zeilen bleiben sichtbar, damit die Aufteilung nachprüfbar bleibt (Rz. 79, 173).
- Keine Quelle gefunden (U): eine ausdrückliche Aussage zum Schwärzen einzelner Positionen auf einem Kassenbon.
- Technik (V, selbst geprüft): Ein schwarzes Rechteck über Text lässt den Text in der PDF lesbar. Das Tool schwärzt deshalb die Bildpixel und ersetzt den Bildinhalt; der alte Inhalt steckt danach nicht mehr in der Datei.

## Vorsteuer

- § 15 Abs. 1 Satz 1 Nr. 1 UStG (V): Abziehbar ist die Steuer für Leistungen, die "für sein Unternehmen ausgeführt worden sind"; Voraussetzung ist eine Rechnung nach §§ 14, 14a UStG.
- § 33 UStDV (V): Eine Rechnung, "deren Gesamtbetrag 250 Euro nicht übersteigt", braucht keine Angabe des Leistungsempfängers. Maßgeblich ist der Gesamtbetrag des ganzen Bons, nicht des geschäftlichen Teils (A).
- § 35 Abs. 1 UStDV, UStAE 15.11 Abs. 4 Satz 2 (V): Bei Kleinbetragsrechnungen teilt der Unternehmer den Betrag selbst mit dem angegebenen Steuersatz in Entgelt und Steuer auf.
- UStAE 15.2b Abs. 1 Satz 1 und 2 (V): Leistungsempfänger ist, wer aus dem zugrunde liegenden Vertragsverhältnis berechtigt oder verpflichtet ist, "regelmäßig der Auftraggeber oder Besteller".
- BFH 18.02.2009, V R 82/07, BStBl II 2009, 876 (V): Maßgeblich ist, "ob ein Handeln gegenüber Dritten im eigenen Namen oder berechtigterweise im Namen eines anderen vorliegt"; "unerheblich ist, ob die Person […] auf eigene oder auf fremde Rechnung handelt". Die Zahlung vom Privatkonto schadet also nicht.
- UStAE 15.2a Abs. 3 Satz 4 (V): Aus einer Rechnung nur auf einen Gesellschafter ohne Hinweis auf die Gesellschaft kann die Gesellschaft keinen Vorsteuerabzug vornehmen.
- UStAE 1.8 Abs. 13 (V): Ausdrücklich zugelassen ist die Kleinbetragsrechnung für Verpflegung bei unternehmerisch bedingter Auswärtstätigkeit des Arbeitnehmers.
- Offen (U): Eine Verwaltungsanweisung oder ein Urteil, das den Ladeneinkauf eines Geschäftsführers oder Mitarbeiters mit Kleinbetragsbon für das Unternehmen ausdrücklich regelt, wurde nicht gefunden. Für das Unternehmen als Leistungsempfänger spricht beim Bargeschäft des täglichen Lebens das "Geschäft für den, den es angeht" (A, zivilrechtlicher Grundsatz, hier nicht belegt). Mit dem Steuerberater klären.
- Folgerung fürs Tool (A): Liegt der ganze Bon über 250 €, warnen; dann braucht es eine Rechnung mit dem Unternehmen als Empfänger.

## Kaffee, Milch und Ähnliches fürs Büro

- R 4.10 Abs. 5 Satz 9 Nr. 1 und Satz 10 EStR (V, EStH 2025): Keine Bewirtung bei "Gewährung von Aufmerksamkeiten in geringem Umfang (wie Kaffee, Tee, Gebäck), z. B. anlässlich betrieblicher Besprechungen"; solche Aufwendungen "können unbegrenzt als Betriebsausgaben abgezogen werden". Kein Bewirtungsbeleg nötig (A).
- R 19.6 Abs. 2 Satz 1 LStR (V, LStH 2026): Getränke und Genussmittel, die der Arbeitgeber zum Verzehr im Betrieb überlässt, gehören nicht zum Arbeitslohn.
- § 3 Abs. 1b Satz 1 Nr. 2 und Abs. 9a UStG (V): keine unentgeltliche Wertabgabe, "sofern keine Aufmerksamkeiten vorliegen".
- Anlage 2 UStG (V): lfd. Nr. 4 (Milch und Milcherzeugnisse) und Nr. 12 (Kaffee, Tee) mit 7 %. Pflanzendrinks, Kapseln, Pads und Kaffeegetränke nicht geprüft (U); maßgeblich ist der Steuersatz auf dem Bon.
- Verdeckte Gewinnausschüttung (A, § 8 Abs. 3 Satz 2 KStG, R 8.5 KStR): Erstattet die Gesellschaft auch private Positionen, droht eine vGA. Die Aufteilung je Bon begrenzt die Erstattung auf den geschäftlichen Anteil.
- Konten (V, DATEV-Kontenrahmen 2026, Branchenpaket Bau und Handwerk; Gleichheit mit dem Standard-SKR ist A): Aufmerksamkeiten 4653 (SKR 03) / 6643 (SKR 04), Sonstiger Betriebsbedarf 4980 / 6850, Verbindlichkeiten gegenüber Gesellschaftern 0730 / 3510. Welches Konto gilt, legt der Steuerberater fest.

## Für den Steuerberater

1. Reicht die geschwärzte Fassung als gebuchter Beleg, wenn das ungeschwärzte Original in BHB soft-gelöscht und verknüpft bleibt?
2. Ist das Unternehmen beim Ladeneinkauf des Geschäftsführers mit Kleinbetragsbon Leistungsempfänger (Vorsteuerabzug)?
3. Welches Aufwandskonto für Bürogetränke und -verbrauchsmaterial?
