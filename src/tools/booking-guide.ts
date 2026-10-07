import { z } from "zod";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// Buchhalterische Sonderfälle und Kontierungstipps aus BuchhaltungsButlers Wissensdatenbank
// (wissen.buchhaltungsbutler.de), bewusst als Daten statt als Fließtext in jeder Tool-Beschreibung:
// get_booking_guide liefert den passenden Eintrag erst, wenn der Fall auftritt.
//
// Konten stehen so wie im Artikel: "SKR03 | SKR04" (z. B. 1360 | 1460). Eine Nummer ohne zweite Zahl heißt,
// dass der Artikel sie nur für SKR03 nennt; die SKR04-Nummer dann per list_posting_accounts (search) nachschlagen.
// Beträge in den Beispielen sind die des Artikels, Beispiele mit "(Beispiel des Konnektors)" sind eigene Rechenbeispiele.
// Das ist Kontierungshilfe, keine Steuerberatung - jeder Eintrag ist mit dem Steuerberater abzustimmen.

export interface BookingGuideEntry {
  id: string;
  titel: string;
  quelle: string;
  regeln: string[];
  buchungen?: string[];
  ablauf?: string[];
  achtung?: string[];
  konnektor?: string[];
}

const GELDTRANSIT = "Geldtransit 1360 | 1460";
const INTERIM = "Interimskonto / Kontierung nicht bekannt 1590 | 1370";

export const BOOKING_GUIDE: BookingGuideEntry[] = [
  {
    id: "abschreibung",
    titel: "Abschreibungen (AfA) berechnen und verbuchen",
    quelle: "Abschreibungen berechnen und verbuchen (11259650218013)",
    regeln: [
      "Bevorzugt die Anlagenverwaltung von BuchhaltungsButler nutzen (nur Oberfläche, keine API): sie bucht monatlich automatisch. Nur ohne Anlagenverwaltung von Hand buchen.",
      "Manuelle Buchung im erweiterten Buchen (add_free_postings) zum 31.12.: AfA-Aufwandskonto im Soll, Bestandskonto (Anlagekonto) im Haben, vat 0_none.",
      "Linear nach Nutzungsdauer. Ab einem Wert über 1.000 € gilt die amtliche AfA-Tabelle; bei geringwertigen Wirtschaftsgütern unter 1.000 € gibt es weitere Methoden (Sofortabschreibung, Sammelposten über 5 Jahre).",
      "Unterjährige Anschaffung: im ersten und im letzten Jahr nur die Nutzungsmonate. Erstes Jahr = Anschaffungsmonat bis Dezember, insgesamt Nutzungsdauer x 12 Monate, das letzte Jahr bekommt die Restmonate.",
      "Einmal jährlich oder monatlich abschreiben: mit dem Steuerberater klären.",
    ],
    buchungen: [
      "Beispiel Artikel: Schreibtisch 2.000 € netto, Nutzungsdauer 13 Jahre (Büroeinrichtung), gekauft im September. Anschaffung auf Büroeinrichtung (420 | 650) mit 19 % VSt. Jahresbetrag 2.000 / 13 = 153,84 €, Monatsbetrag 12,82 €, im ersten Jahr 4 Monate = 51,28 €.",
    ],
    achtung: [
      "Nicht manuell abschreiben, wenn die Anlage in der Anlagenverwaltung geführt wird: Doppelabschreibung.",
      "Die Nummer des AfA-Aufwandskontos steht im Artikel nicht im Text: per list_posting_accounts (search \"Abschreibungen\") nachschlagen. Beispiele SKR03 aus der Team-Übergabe: BGA 4830, Pkw 4832, Software 4822 (Thema anlagen_browser).",
      "Bestehende Anlagegüter aus einem Vorsystem in die Anlagenverwaltung übernehmen: Thema anlagen_browser.",
    ],
  },
  {
    id: "rap",
    titel: "Aktive und passive Rechnungsabgrenzungsposten (aRAP/pRAP)",
    quelle: "Aktive & passive Rechnungsabgrenzungsposten verbuchen (11278472921117)",
    regeln: [
      "Aufwand/Ertrag gehört in die Periode, in die er wirtschaftlich fällt, unabhängig vom Zahlungszeitpunkt (§ 252 Abs. 1 Nr. 5 HGB).",
      "aRAP: Zahlung im alten Jahr, Aufwand im neuen. Zahlung belegios gegen 980 (Aktive Rechnungsabgrenzung) ohne USt/VSt buchen, im neuen Jahr im erweiterten Buchen umbuchen.",
      "pRAP: Geldeingang im alten Jahr, Ertrag im neuen. Zahlung gegen 990 (Passive Rechnungsabgrenzung) buchen, im neuen Jahr umbuchen.",
      "Auch Jahresabos müssen periodengerecht aufgeteilt werden.",
    ],
    buchungen: [
      "aRAP (SKR03, Beispiel Artikel): Miete Januar 2021, im Dezember 2020 überwiesen, 1.190 € brutto, keine Rechnung. Dezember: Bank an 980, ohne USt/VSt. Januar (erweitert): 4210 Büromiete (Soll) an 980 (Haben) mit 19 % VSt.",
      "Jahresabo (Beispiel Artikel): 1.200 € für 12 Monate ab Oktober vorausbezahlt = 100 €/Monat. 3 Monate = 300 € Aufwand im ersten Jahr, 9 Monate = 900 € als aRAP, im zweiten Jahr als Aufwand umbuchen.",
      "pRAP (SKR03, Beispiel Artikel): Zinszahlung 500 € im Dezember für das neue Jahr, Zinsen USt-frei (§ 4 Nr. 8a UStG). Dezember: Bank an 990 ohne USt. Januar (erweitert): 990 (Soll) an 2650 Sonstige Zinsen und ähnliche Erträge (Haben) ohne USt.",
    ],
    achtung: ["Die Artikelbeispiele sind SKR03; die SKR04-Nummern per list_posting_accounts nachschlagen."],
  },
  {
    id: "auslagen",
    titel: "Auslagen, Spesen und Privateinlagen",
    quelle: "Auslagen, Spesen oder Privateinlagen buchen (11278919655965)",
    regeln: [
      "Auslagen/Spesen sind Vorauszahlungen eines Dritten (Inhaber, Gesellschafter, Mitarbeiter) für die Firma, die 1:1 erstattet werden.",
      "Bei regelmäßigen Auslagen je Inhaber/Gesellschafter/Mitarbeiter ein 'Sonstiges Basiskonto' als Auslagenkonto anlegen (create_account, type other). Vorlage Einzelunternehmen: Privateinlagen 1890 | 2180 (der Artikel nennt an einer Stelle 2190: prüfen), GmbH: Verbindlichkeiten gegenüber Gesellschaftern 730 | 3510.",
      "Mit 'Beleg erzeugt Zahlung' (receipt_creates_transaction) erzeugt die Belegzuweisung zum Auslagenkonto automatisch eine Zahlung samt Buchungsvorschlag. Der Kontostand zeigt die aufgelaufenen Auslagen. Eine Auslagenrechnung ist nicht nötig.",
      "Ausgleich der Auslagen: Geldabgang auf der Bank gegen Geldtransit (1360 | 1460) und eine manuelle Zahlung (Geldeingang) in gleicher Höhe auf dem Auslagenkonto, ebenfalls gegen Geldtransit.",
      "Ohne eigenes Basiskonto: Privateinlage im erweiterten Buchen, Einzelunternehmen Aufwand (Soll) an 1890 | 2180 Privateinlagen (Haben); GmbH Aufwand (Soll) an 730 | 3510 (Haben). Bei häufigen Fällen lieber ein Basiskonto anlegen.",
    ],
    buchungen: [
      "Beispiel Artikel: Porto 63,00 € von der Deutschen Post, privat bezahlt: Beleg dem Auslagenkonto zuweisen und auf 4910 Porto buchen; Erstattung 63,00 € Bank an Geldtransit 1360 und Auslagenkonto an Geldtransit 1360.",
    ],
    konnektor: ["create_account (type other, postingaccount_number, receipt_creates_transaction true), create_transactions für die manuelle Zahlung."],
  },
  {
    id: "ist_versteuerer_debitoren",
    titel: "Debitoren-Buchhaltung als Ist-Versteuerer",
    quelle: "Besonderheiten bei der Debitoren-Buchhaltung als Ist-Versteuerer (11279492940061)",
    regeln: [
      "Ist/Soll wirkt nur bei debitorisch gebuchten Ausgangsrechnungen. Die fällige USt wird fiktiv bei der Auswertung berechnet, nicht hart gebucht.",
      "Zahlung gegen ein Debitorenkonto: ohne zugewiesenen Beleg wird zum Standard-Steuersatz der Einstellungen gerechnet, mit zugewiesenem debitorisch gebuchtem Beleg zu den Steuersätzen der Belegbuchung. Unterzahlung wird anteilig auf die Sätze umgelegt, Überzahlung zum Satz des Standarderlöskontos.",
      "Im Hintergrund wird die USt von 'nicht fällig' (z. B. 1766 USt nicht fällig 19 %) auf 'fällig' (1776 USt 19 %) umgebucht.",
      "Ein Beleg hängt an der Zahlung, nicht an einer einzelnen Buchung. Mehrere Belege einer Zahlung nur bei gleichem Steuersatz (Berechnung nach FIFO); bei unterschiedlichen Sätzen die Zahlung aufteilen. Empfehlung: nur ein Beleg je Zahlung (DATEV überträgt nur einen Beleglink je Zahlung).",
      "Forderungsverlust: Rechnung erneut hochladen (möglichst als 'Forderungsausfall' beschriftet), datiert auf den Tag des Ausfalls, Betrag negativ, auf denselben Debitor gegen Forderungsverluste mit 19 % USt. buchen: Debitor ausgeglichen, USt nicht fällig ausgebucht.",
    ],
    achtung: [
      "Eine debitorisch gebuchte Ausgangsrechnung lässt sich NICHT über das erweiterte Buchen (add_free_postings) ausgleichen: es erfolgt keine Umbuchung der fälligen USt und der Beleg wird nicht automatisch ausgeglichen.",
      "Workaround (z. B. Verrechnung einer erhaltenen Anzahlung): sonstiges Basiskonto anlegen, dort eine Zahlung zum Buchungsdatum erzeugen, Beleg zuweisen, Debitor ausgleichen; eine zweite manuelle Zahlung gleicht den Saldo des Basiskontos aus und wird gegen das gewünschte Konto gebucht.",
    ],
    konnektor: ["add_transaction_postings mit receipt_id_by_customer je Split, nur Belege mit gleichem Steuersatz je Zahlung."],
  },
  {
    id: "differenzbesteuerung",
    titel: "Differenzbesteuerung (§ 25a UStG)",
    quelle: "Besonderheiten bei der Differenzbesteuerung (11279998187293)",
    regeln: [
      "Nur die Differenz zwischen Einkaufs- und Verkaufspreis wird besteuert; gilt für von Privat gekaufte bewegliche Gegenstände ohne Vorsteuerabzug (Gebrauchtwagen-, Kunst-, Secondhand-Handel). Vereinfachend immer 19 %.",
      "Aufzeichnungen getrennt führen: eigene Konten mit manage_posting_account anlegen, nicht als Automatikkonto. Wareneingang Einzeldifferenz und Gesamtdifferenz (Vorlage Wareneingang 3200 | 5200, Beispiel 3220), Erlöse Einzeldifferenz ohne USt und mit USt, Erlöse Gesamtdifferenz ohne USt und mit USt (Vorlage Umsätze/Erlöse 8200 | 4200, Beispiele 8220, 8225, 8221, 8226).",
      "Gesamtdifferenz (§ 25a Abs. 4 UStG): nur für Waren mit Einkaufspreis bis 500 €, dann für alle solchen Waren im ganzen Besteuerungszeitraum, einmal jährlich ausgewiesen, Bindung für den Zeitraum.",
    ],
    buchungen: [
      "Einzeldifferenz (Beispiel Artikel): Notebook für 600 € von einer Privatperson gekauft: 600 € auf Wareneingang Einzeldifferenz, ohne USt/VSt. Verkauf für 900 €: Split 600 € (Einkaufspreis) auf Erlöse Einzeldifferenz ohne USt. und 300 € (Marge) auf Erlöse Einzeldifferenz mit USt. (19 % USt).",
      "Gesamtdifferenz: gleiches Schema, z. B. Verkauf 60 €: 45 € auf 8221 Erlöse Gesamtdifferenz ohne USt. und 15 € auf 8226 Erlöse Gesamtdifferenz mit 19 % USt.",
    ],
    achtung: ["Ob § 25a anwendbar ist, klärt der Steuerberater."],
    konnektor: ["manage_posting_account (create), dann add_transaction_postings mit mehreren splits."],
  },
  {
    id: "amazon",
    titel: "Buchhaltung mit Amazon (Marktplatz-Konten, Payouts, Gebühren)",
    quelle: "Buchhaltung mit Amazon (11281029665309)",
    regeln: [
      "Je Marktplatz entsteht ein eigenes Zahlungskonto. Sein Kontostand ist die Kontrollsumme und soll nach einem vollständigen Settlement 0 € sein (Zahlungen eines Settlement Batch heben sich auf).",
      "Abweichung ist nicht zwingend ein Fehler: Zahlungen der Vorperiode gelöscht (dann Anfangsbestand einbuchen), Zahlungen auf den 'Backup'-Konten ('Amazon', 'Amazon_de Prod.', nicht löschen), fehlende Zahlungen oder Reports (Bericht erneut importieren).",
      "Payout: Abgang auf dem Amazon-Konto und Eingang auf dem Bankkonto beide gegen Geldtransit (1360 | 1460), ggf. ein eigenes Konto auf Basis von Geldtransit. Der Saldo muss 0 sein. Prüfen per Volltextsuche 'Payout'.",
      "Gebühren, die einem Umsatz zuzuordnen sind, werden vom Bruttoerlös als Teilbuchung abgesplittet. Konto in den Automatisierungsregeln hinterlegen (möglich: Nebenkosten des Geldverkehrs 4970 | 6855). Steuersatz laut Gebührenrechnung (früher Reverse Charge, weil Amazon im EU-Ausland tätig war: an die aktuelle Rechnung anpassen). Kreditorisch gebuchte Gebührenrechnung dem Payout der Periode zuordnen.",
      "Amazon Current Reserve Amount und die spätere Gutschrift (Previous Reserve Amount Balance) auf Durchlaufende Posten (1590 | 1370) buchen, nach der Wiedergutschrift ausgeglichen.",
      "Automatisieren: Ausgangsrechnungen debitorisch buchen oder per CSV importieren, Sammelfunktion, Automatisierungsregeln, Belegmatching über die Payment-Referenz (payment_reference am Beleg).",
    ],
    achtung: ["Kontierung vorab mit dem Steuerberater klären; Umsatzerlöse im EU-Versandhandel siehe Thema oss."],
  },
  {
    id: "steuersatz_5_5_10_7",
    titel: "Eingangsrechnungen mit 5,5 % und 10,7 % Vorsteuer",
    quelle: "Buchungen mit 10,7% und 5,5% USt/VSt erfassen (11281149705885)",
    regeln: [
      "Die Sätze 5,5 % und 10,7 % (typisch Landwirtschaft) sind nicht wählbar. Nur für Eingangsrechnungen gibt es einen Workaround über eine Teilbuchung.",
      "Zeile 1: Aufwand/Wareneingang mit dem Gegenkonto, Betrag netto, ohne Steuer (vat 0_none). Zeile 2: Abziehbare Vorsteuer (1570 | 1400) mit dem reinen Vorsteuerbetrag (5,5 % bzw. 10,7 % des Nettos), ebenfalls ohne Steuer.",
      "EÜR-Rechner buchen dasselbe an der Zahlung.",
    ],
    buchungen: ["Beispiel Artikel: Zahlung 1.213,25 € = 1.150,00 € auf 3200 Wareneingang (ohne USt/VSt) + 63,25 € auf 1570 Abziehbare Vorsteuer (ohne USt/VSt)."],
    achtung: ["Ausgangsrechnungen mit 5,5 % oder 10,7 % lassen sich in BuchhaltungsButler nicht verbuchen."],
    konnektor: ["add_transaction_postings oder add_receipt_postings mit zwei splits, beide vat 0_none. create_invoice warnt bei diesen Sätzen."],
  },
  {
    id: "gutschrift_verrechnen",
    titel: "Rechnung mit Gutschrift verrechnen",
    quelle: "Eine Rechnung mit einer Gutschrift verrechnen (11281267173277)",
    regeln: [
      "Gilt für Gutschriften, ähnlich für Rechnungskorrekturen/Stornorechnungen.",
      "Teilgutschrift mit Zahlung: Rechnung und Gutschrift beide der Zahlung zuweisen, die Zahlung auf Aufwand/Ertrag bzw. gegen Debitor/Kreditor kontieren.",
      "Vollständige Gutschrift ohne Zahlung, ohne Debitoren/Kreditoren: eine Zahlung über 0,01 € auf einem sonstigen Basiskonto in der Vergangenheit (vor Beginn der Buchhaltung, z. B. 01.01. des Vorjahres) anlegen, gegen das Interimskonto 1590 | 1370 buchen und Rechnung und Gutschrift zuweisen. Beide sind danach nicht mehr offen; weitere Rechnungen/Gutschriften lassen sich derselben Zahlung zuweisen.",
      "Vollständige Gutschrift ohne Zahlung, mit Debitoren/Kreditoren: eigenes Basiskonto (z. B. Interimskonto 1891 | 3631) mit 'Beleg erzeugt Zahlung'. Soll-Versteuerer: Zahlung zum Rechnungsdatum manuell anlegen, der Beleg ordnet sich zu. Ist-Versteuerer: Zahlung zum Gutschriftsdatum in Höhe der Ausgangsrechnung anlegen (die USt wird erst mit der Gutschrift fällig). Gutschrift dem Basiskonto zuweisen (Zahlung entsteht automatisch), beide Zahlungen gegen Debitor/Kreditor buchen.",
    ],
    buchungen: ["Beispiel Artikel: Zahlung 59,50 € mit zugewiesener Rechnung 119,00 € und Gutschrift 59,50 €, gebucht gegen das Debitorenkonto 10000."],
    konnektor: ["create_invoice_correction erzeugt die Rechnungskorrektur zu einer Ausgangsrechnung."],
  },
  {
    id: "skonto",
    titel: "Erhaltenen und gewährten Skonto",
    quelle: "Erhaltenen und gewährten Skonto verbuchen (11281526395037)",
    regeln: [
      "Den Beleg nie um den Skonto mindern: er wird mit der Gesamtsumme als Erlös/Aufwand erfasst.",
      "Der Skonto kommt bei der Zahlung als Teilbuchung (Split) mit NEGATIVEM Betrag auf das Skontokonto (der negative Betrag tauscht Soll/Haben) und mit dem Steuersatz der Rechnung, damit USt/VSt korrigiert wird. Differenz = Rechnungsbetrag minus Zahlbetrag.",
      "Konten: Erhaltene Skonti 19 % Vorsteuer 3736 | 5736, Gewährte Skonti 19 % USt. 8736 | 4736 (Stichwort 'Erhaltene'/'Gewährte'/'Skonti').",
      "Kreditorisch gebuchter Beleg: in der ersten Zeile das Kreditorenkonto statt des Aufwandskontos. Debitorisch gebuchter Beleg: das Debitorenkonto statt des Erlöskontos.",
      "Bei Buchungen im Jahr 2020 (Mehrwertsteuersenkung) das allgemeine Konto 'Erhaltene Skonti'/'Gewährte Skonti' ohne festen Satz wählen: der Satz folgt dem Buchungsdatum.",
    ],
    buchungen: [
      "Beispiel des Konnektors: Eingangsrechnung 119,00 € brutto, 2 % Skonto = 2,38 €, bezahlt 116,62 €. Splits: 119,00 (Aufwand bzw. Kreditor, vat 19_pre) und -2,38 (Erhaltene Skonti, vat 19_pre). Die Summe der Splits muss dem Zahlbetrag entsprechen.",
    ],
    konnektor: [
      "Negativ ist nur der Skonto-Split. Die übrigen Splits einer Ausgangszahlung positiv geben und die Summe auf den Zahlbetrag bringen; ein durchweg negativer Satz wird von BuchhaltungsButler mit Fehler 27 abgelehnt (Summe stimmt nicht).",
      "Mit receipt_id_by_customer am Split den Beleg zuordnen, der ausgeglichen wird.",
    ],
  },
  {
    id: "dreiecksgeschaeft",
    titel: "Erwerb von Waren als letzter Abnehmer im Dreiecksgeschäft",
    quelle: "Erwerb von Waren im Dreiecksgeschäft (11281694063005)",
    regeln: [
      "Das DATEV-Automatikkonto 3553 | 5553 ist in BuchhaltungsButler deaktiviert, weil es die Steuer nicht korrekt aufschlüsselt.",
      "Ein individuelles Sachkonto anlegen (manage_posting_account), Vorlage Wareneingang 3200 | 5200 und kein Automatikkonto; empfohlen 3260 | 5260. Den Zahlbetrag bzw. Rechnungsbetrag darauf buchen.",
      "Danach im erweiterten Buchen 19 % USt und denselben Betrag als Vorsteuer buchen, Gegenkonto Interimskonto 1590 | 1370. Ergebnis in der USt-Voranmeldung: Kennziffern 66 und 69.",
    ],
    buchungen: [
      "Beispiel Artikel (1.000 € netto, 190 €): USt-Konto 1794 (Umsatzsteuer aus Erwerb als letzter Abnehmer innerhalb eines Dreiecksgeschäfts) gegen 1590 und Vorsteuer-Konto 1573 (Vorsteuer aus Erwerb als letzter Abnehmer innerhalb eines Dreiecksgeschäfts) gegen 1590, jeweils 190 €, Text 'Umsatzsteuer/Vorsteuer aus Dreiecksgeschäft', vat 0_none.",
    ],
    achtung: [
      "Im Bild des Artikels stehen beide Zeilen mit vertauschtem Soll/Haben (USt im Soll, Vorsteuer im Haben). Fachlich gehört die USt ins Haben und die Vorsteuer ins Soll, so wie im Neufahrzeug-Beispiel (eu_neufahrzeug). Mit dem Steuerberater prüfen.",
    ],
    konnektor: ["add_free_postings."],
  },
  {
    id: "eu_neufahrzeug",
    titel: "EU-Neufahrzeug-Erwerb von Lieferanten ohne USt-ID",
    quelle: "EU Neufahrzeug-Erwerb v. Lieferanten o. USt. ID (11281833740189)",
    regeln: [
      "Das Automatikkonto 3440 | 5440 ist gesperrt. Ein neues Sachkonto auf einer Vorlage anlegen, die kein Automatikkonto ist; empfohlen 3250 | 5250 auf Basis Wareneingang 3200 | 5200.",
      "Kaufpreis auf dieses Konto buchen (Bankkonto oder kreditorisch am Beleg).",
      "Im erweiterten Buchen 19 % USt abführen und denselben Betrag als Vorsteuer abziehen, Gegenkonto Interimskonto 1590 | 1370. Der Artikel nennt als Ausweis in der USt-Voranmeldung die Felder 61 und 94; mit dem Workaround über 1784 und 1584 weist die Zuordnungstabelle jedoch Kz 96 (USt) und Kz 61 (VSt) aus: vor der Übermittlung in der USt-VA-Vorschau prüfen.",
    ],
    buchungen: [
      "Beispiel Artikel (190 €): 1590 (Soll) an 1784 Umsatzsteuer aus EU-Erwerb von Neufahrzeugen von Lieferanten ohne USt-ID (Haben); 1584 Abziehbare Vorsteuer aus innergemeinschaftlichem Erwerb von Neufahrzeugen (Soll) an 1590 (Haben); beides vat 0_none.",
      "Laut Zuordnungstabelle der USt-VA (get_ustva_position) landet 1784 in Kz 96 und 1584 in Kz 61; Kz 94 gehört zum gesperrten Automatikkonto 3440 | 5440.",
    ],
    konnektor: ["manage_posting_account (create), add_free_postings."],
  },
  {
    id: "geldtransit",
    titel: "Geldüberträge zwischen Zahlungskonten",
    quelle: "Geldüberträge zwischen Zahlungskonten verbuchen (11281936719005)",
    regeln: [
      "Die direkte Buchung von einem Zahlungskonto gegen ein anderes ist gesperrt, weil jedes Konto anhand seiner Kontoauszüge gebucht wird (sonst würde eine Seite doppelt gebucht).",
      `Beide Seiten über das Interimskonto ${GELDTRANSIT} buchen: Geldabgang (z. B. Bank) gegen Geldtransit; der Geldeingang (Kasse, Auslagenkonto, PayPal, Kreditkarte) als manuelle Zahlung gegen Geldtransit.`,
      "Typische Fälle: Kasse einzahlen oder abheben, Kreditkartenabrechnung (Bank an Kreditkarte), PayPal-Transfer, Auslagenerstattung. Das Konto Geldtransit muss in der SuSa ausgeglichen sein. Als Buchungstext z. B. 'Geldtransit', 'Bank an Kasse', 'Auslagenerstattung'.",
    ],
    konnektor: ["create_transactions für die manuelle Gegenzahlung, add_transaction_postings mit postingaccount 1360 | 1460 und vat 0_none."],
  },
  {
    id: "prepaid",
    titel: "Lieferanten mit Prepaid-Guthaben (z. B. Deutsche Post, Google Ads)",
    quelle: "Lieferanten mit Prepaid-Guthaben buchen (11282126009373)",
    regeln: [
      "Das Prepaid-Konto als sonstiges Basiskonto mit 'Beleg erzeugt Zahlung' führen (create_account, type other, receipt_creates_transaction true). Der Kontostand ist das Guthaben.",
      "Einzahlung: manuelle Zahlung auf dem Prepaid-Konto; Bankabgang und Prepaid-Zugang beide gegen Geldtransit.",
      "Lieferantenrechnung dem Prepaid-Konto zuweisen: es entsteht eine Zahlung, die das Guthaben mindert; diese auf den Aufwand buchen. So wird die Vorsteuer erst bei Leistung und Rechnung gezogen, nicht bei der Aufladung.",
    ],
    achtung: [
      "Nur korrekt für Guthaben, das für unterschiedliche Leistungen genutzt und im Zweifel zurückgefordert werden kann. Eine Prepaid-Waschkarte ist ein Einzweck-Gutschein (§ 3 UStG): dort wird die Vorsteuer schon bei der Aufladung abgezogen.",
    ],
  },
  {
    id: "lohn",
    titel: "Lohnbuchhaltung erfassen",
    quelle: "Lohnbuchhaltung in BuchhaltungsButler erfassen (11282286368541)",
    regeln: [
      "Ohne Lohnimport: Zahlungen gegen Aufwandskonten buchen. Gehälter 4120 | 6020, die Lohnsteuer auf dasselbe Konto wie das Gehalt, Sozialversicherung auf Gesetzliche soziale Aufwendungen 4130 | 6110. Zahlung der Lohnsteuer zum 10.01. für Dezember abgrenzen.",
      "Mit Buchungsjournal (CSV über den Datenimport, bei TAXMARO automatisch) oder durch den Steuerberater: Aufwand Gehalt (4120 | 6020) an Verbindlichkeiten aus Lohn und Gehalt (1740 | 3720) im erweiterten Buchen.",
      "Dann die Zahlungen auf der Bank NICHT erneut als Aufwand buchen, sondern gegen die Verbindlichkeitskonten: Lohn und Gehalt 1740 | 3720, Lohn- und Kirchensteuer 1741 | 3730, soziale Sicherheit 1742 | 3740.",
      "Praxis: ein Lohnverrechnungskonto 1755 | 3790 zwischen Aufwand und Verbindlichkeiten schalten; nach den Zahlungen ist es im Soll und Haben ausgeglichen.",
    ],
    buchungen: [
      "Beispiel Artikel mit Verrechnungskonto (Beträge): 1755 (Soll) an 1740 (Haben) 1.671,10 €; 1755 an 1741 657,10 €; 1755 an 1742 471,80 €; 4120 Gehälter (Soll) an 1755 (Haben) 2.800,00 € (Summe der Verbindlichkeiten = Brutto). Alles vat 0_none.",
    ],
    konnektor: ["add_free_postings."],
  },
  {
    id: "mwst_senkung_2020",
    titel: "Mehrwertsteuersenkung 2020 (16 %/5 %) - nur für Altjahre 2020/2021",
    quelle: "Software-Änderungen | Mehrwertsteuersenkung 2020 (11282864819357)",
    regeln: [
      "01.07.-31.12.2020 galten 16 % statt 19 % und 5 % statt 7 %. In BuchhaltungsButler folgen die 'impliziten' Sätze '19/16 %' und '7/5 %' dem Buchungs- bzw. Leistungsdatum; 'explizite' Sätze (unter 'alte Steuersätze') lösen immer den alten Satz aus.",
      "Das abweichende Leistungsdatum beeinflusst den Satz nur bei Belegen, die debitorisch/kreditorisch gebucht sind. Sonst gilt das Buchungs- bzw. Zahlungsdatum. EÜR ohne Debitoren/Kreditoren: den expliziten (alten) Satz wählen, z. B. bei einer Rechnung aus Juni 2020, bezahlt im Juli.",
      "Konten mit '19/16 %' im Namen lassen sich nur mit dem impliziten Satz buchen. Für 19 % nach dem 01.07.2020 das Konto ohne Satz im Namen wählen (z. B. 'Umsätze / Erlöse').",
      "Eine Rechnung mit 19 % und 16 % lässt sich nur splitten, wenn Leistungs- bzw. Buchungsdatum nach dem 01.07.2020 liegt. Anzahlung im Juni für eine Leistung im Juli: auf Interimskonto 1590 buchen und im Juli umbuchen.",
      "Rechnungskorrekturen frühestens mit der USt-Voranmeldung für Juli verbuchen. Buchungsschlüssel (BU) bleiben die der DATEV; individuelle Schlüssel im 50er Bereich (§ 13b 19 %, i.g.E. explizit, aufzuteilende Vorsteuer) muss der Steuerberater vor dem Import anlegen.",
    ],
    konnektor: [
      "date_delivery (receipts) und date_of_supply (Rechnungen) werden übernommen, wenn sie im API-Format vorliegen und nicht nach dem Beleg-/Rechnungsdatum liegen.",
      "Ob die API-Codes 19_*/7_* sich wie die impliziten Sätze verhalten, ist nicht dokumentiert: bei 2020er Daten prüfen, bevor gebucht wird.",
    ],
  },
  {
    id: "storno_ruecklastschrift",
    titel: "Stornos, Rücklastschriften und Teilgutschriften",
    quelle: "Stornos oder Rücklastschriften erfassen (11320416257693)",
    regeln: [
      "Ursprüngliche Zahlung schon verbucht: die Rückzahlung gegen dasselbe Aufwands-/Erlöskonto mit demselben Steuersatz buchen. Soll und Haben vertauschen sich, Aufwand/Erlös und USt/VSt werden gemindert.",
      "Ursprüngliche Zahlung noch nicht verbucht: Zahlung und Rechnungskorrektur/Gutschrift beide ohne Steuer auf ein Interimskonto (1590) buchen: erfolgsunwirksam, keine Steuer.",
      "Rücklastschriftgebühren per Split auf Nebenkosten des Geldverkehrs (4970 | 6855) abgrenzen, damit Last- und Gutschrift gleich hoch sind und das Konto ausgeglichen ist.",
      "Teilgutschrift: den ursprünglichen Betrag auf das Erlös-/Aufwandskonto buchen und die Teilgutschrift ebenfalls dagegen, beide mit gleichem Steuersatz.",
    ],
    buchungen: [
      "Beispiel Artikel: Abbuchung 83,00 € = 80,00 € Abschlagszahlung Strom auf 4240 (19 % VSt) + 3,00 € Rücklastschriftgebühren auf 4970 (ohne USt).",
      "Beispiel Artikel: Einnahme 150,00 € auf 8400 (19 % USt), Storno -150,00 € ebenfalls auf 8400 (19 % USt). Teilgutschrift: 250,00 € und -50,00 € auf 8400 (19 % USt).",
    ],
    konnektor: [
      "Per API die Splitbeträge positiv geben; die Richtung folgt der Zahlung (ein Storno ist eine Zahlung in Gegenrichtung).",
      "Gutschrift ohne Zahlung: Thema gutschrift_verrechnen.",
    ],
  },
  {
    id: "trinkgeld",
    titel: "Trinkgeld",
    quelle: "Trinkgeld verbuchen (11320758964381)",
    regeln: [
      "Trinkgeld im Rahmen eines Geschäftsessens ist Betriebsausgabe, wenn es angemessen ist (5-15 %) und nachgewiesen wird: Quittierung durch die Servicekraft, gesonderter Ausweis auf der Kreditkartenabrechnung oder Eigenbeleg.",
      "Buchung: Teilbuchung in der Transaktion, zweite Zeile 'Trinkgeld' auf Bewirtungskosten, Steuer 'keine USt.' (0_none), Betrag = Trinkgeld; der Betrag der ersten Zeile mindert sich entsprechend. Beide Zeilen stehen auf Bewirtungskosten.",
    ],
    konnektor: [
      "Der Konnektor prüft bei 4650/4654 (SKR04 6640/6644) die 70/30-Aufteilung über die gebuchten Beträge. Ein Trinkgeld-Split auf 4650 zählt dabei zum abziehbaren Teil: die 70/30-Aufteilung auf den Gesamtbetrag inklusive Trinkgeld abstimmen (im Zweifel mit dem Steuerberater).",
    ],
  },
  {
    id: "split_buchung",
    titel: "Mehrere Konten oder Steuersätze, Saldierung von Forderung und Verbindlichkeit",
    quelle: "Verschiedene Buchungskonten oder Steuersätze bebuchen (11321777612957)",
    regeln: [
      "Ein Beleg/eine Zahlung mit unterschiedlichen Kostenarten oder Steuersätzen wird gesplittet. Auch Skonto läuft über einen Split.",
      "BuchhaltungsButler leitet Soll/Haben aus Geldeingang bzw. Geldausgang ab; ein negativer Teilbetrag kehrt die Stellung um.",
      "Saldiert ein Lieferant, der zugleich Kunde ist, Forderung und Verbindlichkeit und zahlt nur die Differenz, buchen Sie die Zahlung als Split: Kundenrechnung als Erlös, die Lieferantenrechnung mit negativem Betrag.",
    ],
    buchungen: [
      "Beispiel Artikel: Geldeingang 50 €, zugewiesene Belege 100 € und 50 €: Split 100,00 € auf 8400 (19 % USt) und -50,00 € auf 3400 Wareneingang (19 % VSt). Die Summe der Splits ergibt den Zahlbetrag.",
    ],
    konnektor: ["add_transaction_postings: negativer Betrag nur im Saldierungs-Split, Summe = Transaktionsbetrag."],
  },
  {
    id: "oss",
    titel: "One-Stop-Shop (OSS) im EU-Versandhandel",
    quelle: "Vorbereitung der OSS-Meldung in der Buchhaltung (11322803594269)",
    regeln: [
      "Ab der EU-weiten Lieferschwelle von 10.000 € für grenzüberschreitende B2C-Umsätze wird im Zielland besteuert; mit OSS meldet man alle EU-Umsätze gebündelt beim BZSt.",
      "Einrichtung (nur Oberfläche): Steuerliche Einstellungen, OSS Einstellungen: OSS aktivieren, Herkunftsländer mit USt-ID/Steuernummer hinterlegen (für den DATEV-Export zwingend), Zielländer eingrenzen, Standard-Umsatzart wählen. Ohne Aktivierung lehnt die API OSS-Buchungen ab.",
      "Buchen: OSS-Steuerschlüssel setzen (API: vat_oss_deli_deeu, vat_oss_deli_eueu, vat_oss_deli_eude, vat_oss_deli_eude_19, vat_oss_serv_deeu, vat_oss_serv_eueu) mit Herkunftsland, Zielland und dem Steuersatz des Ziellandes. Die Steuer wird automatisch auf das Sammelkonto für im Ausland steuerpflichtige Umsätze gebucht, egal ob DATEV-Standard-OSS-Erlöskonten oder eigene Erlöskonten (z. B. 'Erlöse PL/OSS') genutzt werden.",
      "Satzarten der OSS-Auswertung: Fernverkauf (Inland), Fernverkauf (Auslandslager), Dienstleistung, Fernverkauf (EU an EU).",
      "Meldung quartalsweise bis Ende des Folgemonats, keine Dauerfristverlängerung, Nullmeldungen sind nötig. Es gibt keine elektronische Schnittstelle zum BZSt: die CSV der OSS-Auswertung (Abschluss, nur Oberfläche) ist im BZSt-Format zum Hochladen.",
      "Unterjähriger Wechsel auf OSS: bisherige Erlöskonten ggf. bis zum Jahreswechsel fortführen und mit dem Steuerberater abstimmen. CSV-Import von OSS-Buchungen mit Konfiguration 5.",
    ],
    achtung: [
      "API-Fehler: 47 Steuersatz fehlt, 48 Satz im Zielland zum Lieferdatum nicht gültig, 49 Länder fehlen, 50 Ursprungs- und Bestimmungsland identisch, 51 Nicht-EU-Land, 52 OSS nicht aktiviert oder keine USt-ID, 53 keine USt-ID/Steuernummer fürs Abgangsland, 54/55 Land nicht als Abgangs- bzw. Zielland konfiguriert.",
      "Die OSS-Auswertung selbst steht nicht in der API. Die Themen gehen tief ins Umsatzsteuerrecht: Steuerberater einbeziehen (§ 6 StBerG).",
    ],
    konnektor: ["Splitfelder oss_origin_country, oss_destination_country, oss_vat_rate bei add_receipt_postings/add_transaction_postings/add_free_postings; der Konnektor prüft sie vorab."],
  },
  {
    id: "ausland_ust",
    titel: "Umsatzsteuerpflicht in einem anderen Land (ohne OSS-Fall)",
    quelle: "Was muss ich beachten, wenn ich in einem anderen Land umsatzsteuerpflichtig bin? (11407622675485)",
    regeln: [
      "Direkt gebucht werden kann nur deutsche USt. Für ein weiteres Land: individuelles Erlöskonto anlegen (z. B. 8201 'Erlöse 23 % USt. PL', Vorlage 8200 Umsätze/Erlöse 0 % USt), alle Umsätze brutto ohne Steuerschlüssel (0_none) darauf buchen.",
      "Am Monatsende die anzumeldende USt aus dem Kontenblatt/der SuSa errechnen (brutto / 1,23 x 0,23) und im erweiterten Buchen umbuchen: Erlöskonto (Soll) an 1767 Umsatzsteuer aus im anderen EU-Land steuerpflichtigen Lieferungen (Haben), Text z. B. 'Umbuchung Umsatzsteuer Polen'.",
    ],
    buchungen: ["Beispiel Artikel: Umsatz 1.230,00 € brutto laut Kontenblatt 8201: 1.230 / 1,23 = 1.000 x 0,23 = 230,00 € USt."],
    konnektor: ["Kontenblatt per get_account_ledger, Umbuchung per add_free_postings (vat 0_none). Für B2C-EU-Umsätze im OSS-Verfahren: Thema oss."],
  },
  {
    id: "fremdwaehrung",
    titel: "Belege und Zahlungen in Fremdwährung",
    quelle: "Wie erfasse ich Belege und Zahlungen in einer Fremdwährung? (11407902754333)",
    regeln: [
      "Gebucht wird immer in Euro. BuchhaltungsButler rechnet automatisch um (Tageskurs, Referenzkurse der EZB; Kurse an Zahlung und Beleg manuell änderbar; Kurs zum Rechnungs- bzw. Zahlungsdatum). Automatische Kurse: AUD, BGN, BRL, CAD, CHF, CNY, CZK, DKK, GBP, HKD, HUF, IDR, ILS, INR, ISK, JPY, KRW, MXN, MYR, NOK, NZD, PHP, PLN, RON, RUB, SEK, SGD, THB, TRY, USD, ZAR und weitere (u. a. historische).",
      "Zahlung mit Umrechnungszahlung des Instituts (z. B. PayPal, drei Zahlungen: Fremdwährungsabgang, 'From Euro', 'To U.S. Dollar'): die vom Institut umgerechnete Euro-Zahlung direkt als Aufwand buchen. Die beiden Fremdwährungszahlungen gegen ein Interimskonto/Geldtransit (1360) buchen. Die Differenz zum Tageskurs zum Monatsende bzw. Periodenabschluss im erweiterten Buchen als Aufwand/Ertrag aus Währungsumrechnung umbuchen.",
      "Zahlung ohne Umrechnungszahlung (z. B. Fremdwährungskonto): wird automatisch umgerechnet und direkt in Euro gebucht; Kursgewinne/-verluste zu Stichtagen über eine manuelle Zahlung. Ein Konto mit mehreren Währungen zeigt den Kontostand eventuell falsch (er kann nur eine Währung enthalten).",
      "Rechnung in Fremdwährung: Währung am Beleg wählen. Fehlt sie, den Betrag manuell in Euro umrechnen und mit Währung EUR erfassen. Ohne Debitoren/Kreditoren muss nicht umgerechnet werden: Beleg der Zahlung zuweisen und die Zahlung buchen.",
      "Kursdifferenzen auf Debitor/Kreditor: bei der Ausgleichsbuchung die Differenz als Split auf Aufwand bzw. Ertrag aus Wechselkursschwankungen buchen, damit das Personenkonto ausgeglichen ist.",
    ],
    buchungen: [
      "Beispiel Artikel (SKR03): Softwareabo 49,00 USD = 46,40 € laut Institut, 42,34 € laut BuchhaltungsButler. Euro-Zahlung 46,40 € auf 4964 Softwarekosten (19 % VSt); beide Fremdwährungszahlungen gegen 1360. Differenz 4,06 € (46,40 - 42,34): 2150 Aufwendungen aus der Währungsumrechnung (Soll) an 1360 (Haben).",
    ],
    konnektor: [
      "create_receipts: currency nimmt laut API nur USD, GBP und CHF an (sonst Betrag selbst in EUR umrechnen und EUR erfassen). upload_receipt: currency nur 'EUR'; die Fremdwährung wählt man dort am Beleg in der Oberfläche.",
      "create_transactions: currency mit den von der API unterstützten Währungen (u. a. USD, GBP, CHF, JPY, PLN, SEK, ...), Betrag in der Transaktionswährung.",
    ],
  },
  {
    id: "iab",
    titel: "Investitionsabzugsbetrag (§ 7g EStG)",
    quelle: "Investitionsabzugsbetrag (20068054846237)",
    regeln: [
      "Der IAB wirkt nur außerbilanziell in der Steuerbilanz/Steuererklärung; die Handelsbilanz bleibt unberührt (latente Steuern prüfen). Gebucht wird auf den Konten 9970 und 9971 'Investitionsabzugsbetrag § 7g Abs. 1 EStG (außerbilanziell)'.",
      "Voraussetzungen: Gewinn höchstens 200.000 €, bewegliches Wirtschaftsgut des Anlagevermögens, mindestens 90 % betrieblich genutzt, Anschaffung innerhalb von 3 Jahren, Verbleib im Betrieb bis zum Ende des Folgejahres. Höhe: höchstens 50 % der voraussichtlichen Anschaffungskosten (netto bei Vorsteuerabzug, Kleinunternehmer brutto) und insgesamt höchstens 200.000 €.",
      "Bildung im Jahr 01: 9970 im Soll, 9971 im Haben in Höhe des IAB. Auflösung im Jahr der Anschaffung: 9973 (Soll) an 9972 (Haben) 'Auflösung Investitionsabzugsbetrag § 7g II EStG aus vorangeg. WJ, außerbilanziell' in gleicher Höhe.",
      "Im Jahr der Anschaffung wird der IAB dem Gewinn hinzugerechnet; die Anschaffungskosten als Abschreibungsbasis mindern sich um den IAB. Zusätzlich ist eine Sonderabschreibung von 20 % möglich (auch ohne IAB, auf bis zu 5 Jahre à 4 % verteilbar).",
      "Wird nicht investiert, ist der IAB nach spätestens 3 Jahren rückwirkend im Bildungsjahr gewinnerhöhend aufzulösen (Änderung des Steuerbescheids, ggf. Zinsen); freiwillig schon früher möglich.",
    ],
    buchungen: ["Beispiel Artikel: Firmenwagen 30.000 € netto in 2025 geplant, IAB 2024 = 15.000 €. Bildung: 9970 (Soll) an 9971 (Haben) 15.000 €. Auflösung 2025: 9973 (Soll) an 9972 (Haben) 15.000 €; Abschreibungsbasis 30.000 - 15.000 = 15.000 €."],
    achtung: ["Steuerliche Wirkung nur mit dem Steuerberater festlegen; der Artikel nennt die Kontonummern für SKR03, SKR04 per list_posting_accounts nachschlagen."],
    konnektor: ["add_free_postings, vat 0_none."],
  },
  {
    id: "erste_schritte",
    titel: "Erste Schritte: Bilanzierer oder EÜR, wo wird gebucht",
    quelle: "Erste Schritte mit BuchhaltungsButler (11419668183709)",
    regeln: [
      "Die Ersteinrichtung fragt: Bilanzierer oder Einnahmenüberschussrechner, Kontenrahmen, Länge der Sachkonten, Soll- oder Ist-Versteuerer, Buchungskontonummer der Bankkonten. Nachträglich NICHT änderbar sind nur Kontenrahmen und Länge der Sachkonten; im Zweifel den Steuerberater oder den Support fragen.",
      "Ein Testaccount lässt sich nicht zurücksetzen: für den produktiven Start einen neuen Account registrieren.",
      "Reihenfolge nach der Einrichtung: Bankkonten verknüpfen (Zahlungen werden automatisch importiert), erste Belege hochladen, als Bilanzierer Debitoren/Kreditoren aktivieren und bestehende importieren.",
      "Bilanzierer buchen Aufwand und Erlös am Beleg (kreditorisch/debitorisch) und auf dem Bankkonto üblicherweise den Ausgleich des Debitors/Kreditors. EÜR-Rechner buchen Aufwand und Erlös nicht am Beleg, sondern bei den Zahlungen.",
      "Vier Szenarien bei einer Zahlung: (1) Beleg automatisch zugewiesen, Buchungsvorschlag unbestätigt; (2) Zuweisung und Vorschlag bestätigt, Vorgang abgeschlossen; (3) kein Beleg, aber ein Buchungsvorschlag; (4) weder Beleg noch Vorschlag.",
      "Kontieren geht ohne Kontenrahmen-Kenntnis über ein Stichwort im Buchungstext (z. B. 'Taxi', 'Bahn', 'Kopierpapier'): passende Konten werden vorgeschlagen.",
      "Buchungen ohne Zahlung und ohne Beleg (Rückstellungen, Rechnungsabgrenzungen, Buchungen aus der Lohnbuchhaltung) laufen im erweiterten Buchen.",
    ],
    konnektor: [
      "Bilanzierer: add_receipt_postings (creditor/debtor) für den Beleg, dann den Ausgleich per add_transaction_postings oder confirm_payment. EÜR: nur add_transaction_postings an der Zahlung.",
      "Stichwortsuche nach dem Konto: list_posting_accounts mit search. Buchungen ohne Zahlung/Beleg: add_free_postings.",
    ],
  },
  {
    id: "wechsel_zu_bhb",
    titel: "Wechsel zu BuchhaltungsButler (Typen A bis E, Anfangsbestände, Lexware-Export)",
    quelle: "Wechsel zu BuchhaltungsButler (11421251511965); Wechsel von Lexware Office zu BuchhaltungsButler (32110192691357)",
    regeln: [
      "Nicht alle Altdaten importieren: ungefiltert kopierte 'Daten-Altlasten' führen zu einem chaotischen Start. Erst den Wechsel-Typ bestimmen.",
      "Typ A (Standard): Start zum neuen Wirtschaftsjahr, Vorjahr im Altsystem abgeschlossen. Keine Buchungen importieren, nur Stammdaten, Anfangsbestände setzen.",
      "Typ B (1:1-Übernahme): unterjähriger Wechsel, Buchungen bis zum Stichtag sind sauber. Journal (DATEV-Export oder CSV) ZUERST importieren, DANACH die Bank verbinden mit Startdatum = Tag nach dem Import (vermeidet Duplikate). Debitoren-/Kreditorennummern wie im Altsystem. Der Banksaldo muss dann mit dem Kontoauszug übereinstimmen.",
      "Typ C (Reparatur): Altdaten fehlerhaft. Keine Buchungen importieren, Bank verbinden mit weit zurückliegendem Abrufdatum, die Umsätze neu verbuchen, Anfangsbestand vor der ersten eingespielten Transaktion über 9000 setzen.",
      "Typ D (Vereinfacher): Wechsel von Bilanz/Debitoren zu EÜR ohne Personenkonten. Keine Buchungen importieren, Neustart auf Basis der Bankflüsse zum Stichtag, Anfangsbestand über 9000.",
      "Typ E (Digitalisierer): bisher Excel/Papier, kein DATEV-Export. Nur Kontakte importieren, Bank verbinden, Bank- und Kassenstand zum Stichtag als Anfangsbestand über 9000.",
      "Für alle: Unternehmensdaten vollständig pflegen (Basis für Rechnungen, USt-Voranmeldung und Belegerkennung), Kunden-/Lieferanten-/Artikellisten als CSV importieren, für jedes Bankkonto, jede Kasse und jedes PayPal-Konto ein Basiskonto anlegen (nur anlegen, noch nicht mit der Live-Bank verbinden).",
      "Anfangsbestände: Kontostand zum 31.12. des Vorjahres über das Konto 9000 (Saldenvorträge) gegen das Bankkonto. Finalisieren: offene Posten vor dem Wechsel manuell erfassen, Buchwerte des Anlagevermögens und Forderungen/Verbindlichkeiten mit der SuSa abgleichen.",
      "Go-Live-Check: Banksaldo = Online-Banking; eine Test-Rechnung an die Beleg-Mail kommt an; die erste Automatisierungsregel greift bei einer neuen Zahlung. Dazu Regeln für wiederkehrende Abbuchungen (Miete, Leasing, Telefon, Hosting) und die Beleg-E-Mail-Weiterleitung einrichten.",
      "Lexware Office: Export über Einstellungen, Export. (1) 'Belege/Belegbilder mit Buchungsvorschlag (DATEV-Format)' als ZIP herunterladen und NICHT entpacken (wird unverändert per Drag & Drop importiert). (2) 'DATEV-konforme Dateien + Belegbilder' für das Journal; fehlen Berater-/Mandantennummer, genügen fiktive Werte wie 1234. (3) Artikel: Menü Artikel, 'Alle Artikel exportieren (CSV)'. (4) Kontakte: 'Alle Kunden exportieren (CSV)', optional dasselbe im Lieferantenmanager.",
    ],
    achtung: [
      "Importe (Datenimport, DATEV-ZIP, CSV) und das Verbinden der Bank gibt es nur in der Oberfläche, nicht per API.",
    ],
    konnektor: [
      "Anfangsbestand eines Bankkontos per API: create_transactions (vorzeichenrichtiger Saldo, booking_date = letzter Tag des Vorjahres), danach add_transaction_postings gegen 9000 mit vat 0_none. EB-Werte von Sachkonten: add_free_postings gegen 9000.",
      "Stammdaten: create_contacts statt CSV-Kontaktimport.",
    ],
  },
  {
    id: "monatsabschluss",
    titel: "Buchhaltung am Monatsende fertigstellen",
    quelle: "Schritte, um die Buchhaltung am Monatsende fertigzustellen (11421107352989)",
    regeln: [
      "1. Duplikatsprüfung bei Eingangs- und Ausgangsbelegen (Filter 'Duplikatsverdacht'; nach Gegenpartei/Datum sortieren). Vor dem Löschen immer prüfen, ob es wirklich Duplikate sind.",
      "2. Ungebuchte Zahlungen prüfen: Filter 'ungebucht', Zeitraum eingrenzen, 'Alle Konten' einstellen (nicht nur ein Konto).",
      "3. Ungebuchte Belege prüfen (Bilanzierer): für einen korrekten Periodenabschluss ungebuchte Eingangsrechnungen kreditorisch als offene Verbindlichkeit einbuchen, ebenso Ausgangsrechnungen debitorisch.",
      "Ein Beleg gilt auch dann als 'gebucht', wenn die ihm zugeordnete Zahlung verbucht ist. Einzige Ausnahme: die Zahlung wurde ausschließlich gegen ein Debitoren-/Kreditorenkonto gebucht, dann bleibt der Beleg 'ungebucht'. Deshalb zeigt der Filter 'ungebuchte Belege' manchmal einen bekannten ungebuchten Beleg nicht an.",
      "4. Banksalden abstimmen ('Kontostand berechnen' oder SuSa unter Abschluss).",
      "5. Konten plausibilisieren (Abschluss, SuSa-Liste/Kontenblätter): Soll/Haben auf der richtigen Seite, Anzahl der Miet-/Telefonzahlungen = Anzahl der Perioden, konsistente Kontierung, verdächtige Buchungen mit/ohne USt/VSt. Wichtig: Geldtransit (1360 | 1460) und Interimskonto (1590 | 1370) müssen einen Nuller-Saldo haben.",
      "6. Buchungen festschreiben (Abschluss, zuerst den Zeitraum einstellen), erst danach die Umsatzsteuer-Voranmeldung.",
    ],
    konnektor: [
      "check_month_end prüft davon, was die API hergibt (Duplikate, Zahlungen/Belege ohne Buchung, nicht festgeschriebene Buchungen, Saldo Geldtransit/Interimskonto) und listet den Rest als nicht_pruefbar (Banksalden, Plausibilisierung, Festschreiben, USt-Voranmeldung). 'Gebucht' ist dort aus den Buchungen abgeleitet, eine Näherung.",
      "Plausibilisierung per create_report/get_report (sums) und get_account_ledger. Festschreiben und USt-Voranmeldung nur in der Oberfläche.",
    ],
  },
  {
    id: "automatisierungsregeln",
    titel: "Automatisierungsregeln (Wenn/Dann)",
    quelle: "Mit Automatisierungsregeln arbeiten (11421057914781)",
    regeln: [
      "Regeln werden in der Oberfläche unter Einstellungen, Automatisierungsregeln angelegt und greifen nur bei NEU importierten Belegen/Zahlungen, nicht auf bereits vorhandene. Regeln für Eingangsrechnungen brauchen aktive Kreditoren, für Ausgangsrechnungen aktive Debitoren.",
      "Wenn-Seite: Bereich Zahlung (Gegenpartei, Betrag, Verwendungszweck), Eingangsbeleg und Ausgangsrechnung (Gegenpartei, Rechnungsnummer, Betrag, Volltext). Operatoren: ist, ist nicht, enthält, enthält nicht; beim Betrag ist, ist nicht, größer als, kleiner als; beim Volltext enthält, enthält nicht. Beliebig viele Kriterien, UND-verknüpft.",
      "Dann-Seite: 'Beleglos markieren' (z. B. Miete, Kontoführungsgebühren); 'Kontieren auf' (Beleg oder Zahlung, bestätigt direkt, Schaltfläche schon grün); 'Buchungsvorschlag auf' (überschreibt den Vorschlag, muss noch bestätigt werden); 'Teilbuchungsvorschlag auf' (bis zu 10 Zeilen mit Konto, Text, USt, KSt, KSt 2; Aufteilung je Zeile als Festbetrag, Prozent oder Restbetrag); 'Kreditor zuweisen' und 'Debitor zuweisen' (z. B. Sammelkonto).",
      "Teilbuchungsvorschlag: reine Prozent-Aufteilungen müssen genau 100 % ergeben; mit einer Festbetragszeile ist zusätzlich eine Restbetragszeile nötig. Nur für Eingangsbelege und Ausgangsrechnungen, nicht für Zahlungen (setzt Kreditoren-/Debitorenbuchung voraus), nicht für Belege in Fremdwährung. Bestehende Buchungsreservierungen haben Vorrang vor Regelvorschlägen.",
      "Beispiele: Verwendungszweck enthält 'Miete' UND Gegenpartei ist 'Max Mustermann' dann kontiere auf 'Büromiete'; Gegenpartei 'PayPal (Europe) S.a.r.l.' dann kontiere auf Geldtransit; Gegenpartei 'GoCardless' dann beleglos; Betrag größer 1.000 € dann Buchungsvorschlag auf 'Durchlaufende Posten' mit Text 'zu prüfen'.",
      "Praxistipp: Das Layout der Ausgangsrechnungen um 'Codes' je Steuerfall erweitern und per Volltext-Regel nutzen, z. B. Volltext enthält 'DEnachFR' dann Debitor 'Debitorensammelkonto Frankreich' zuweisen und auf 'Erlöse OSS/FR' kontieren.",
    ],
    achtung: [
      "Ob Regeln auch bei per API angelegten Belegen/Zahlungen (create_receipts, create_transactions, upload_receipt) greifen, ist nicht dokumentiert (der Artikel sagt 'beim Import neuer Belege oder Zahlungen').",
    ],
    konnektor: [
      "Regeln lassen sich per API weder anlegen noch lesen: den Nutzer bitten, sie in der Oberfläche einzurichten.",
      "Mit create_invoice lässt sich der Code gleich in den Rechnungstext schreiben (Felder correspondence, final_provisions); er steht dann im PDF-Volltext, auf den die Regel reagiert.",
    ],
  },
  {
    id: "bedienung_shortcuts",
    titel: "Hacks, Filter, Sammelfunktion und Schnellfilter",
    quelle: "Hacks und Shortcuts mit BuchhaltungsButler (11420828181277); Schnellfilter - Vorlagen für Filter erstellen (21062365037981)",
    regeln: [
      "Belege per E-Mail: eigene Adresse eingang.<Name>@belege.buchhaltungsbutler.de, Weiterleitungsregeln im Postfach (oder Zapier) für bestimmte Absender. Dropbox-Synchronisation ist der beste Weg für viele Belege auf einmal.",
      "Fehlender Beleg an einer Zahlung: dort direkt 'Beleg hochladen'. Liegt der Beleg schon an einer anderen Zahlung, den Filter von 'unbezahlt' (Standard) auf 'alle' stellen.",
      "Die zwei wichtigsten Filter: 'Fehlender Beleg' (Zahlungen) und 'Ungebucht' (Zahlungen, bei Bilanzierern auch Belege). Zeigt eine Ansicht nicht das Erwartete, zuerst die Filter zurücksetzen.",
      "Sammelfunktion (unten bei Belegen und Zahlungen, 'Alle auswählen' wirkt auf alles Angezeigte, mit Filter/Volltextsuche kombinierbar). Belege: Bestätigen, Aufheben, Festschreiben, Aktualisieren, Kontieren, Überweisen, Löschen, Zuweisen (Debitor/Kreditor), Zuordnen (Eingangs-/Ausgangsbeleg). Zahlungen: Bestätigen, Aufheben, Festschreiben, Beleglos, Aktualisieren, Kontieren, Löschen.",
      "Ungenutzte Basiskonten ausblenden: Kontenverwaltung, Stift am Konto, 'In der Dropdownliste der Basiskonten ausblenden'.",
      "Schnellfilter: Filterprofile in Zahlungen, Belege und Erweitert ('Schnellfilter anlegen', 'Speichern & anwenden'). Sie gehören dem jeweiligen Nutzer und sind nicht für alle im Account sichtbar; anlegen kann sie jede Rolle mit Zugriff auf mindestens einen der drei Bereiche. Löschen muss bestätigt werden.",
    ],
    konnektor: [
      "Alles davon ist Oberfläche. Per API: manage_account mit is_disabled_in_select blendet ein Basiskonto aus; Beleg an eine Zahlung: upload_receipt (payment_reference für das automatische Matching) und assign_receipts_to_transactions.",
    ],
  },
  {
    id: "buchungsvormerkung_eur",
    titel: "Buchungsvormerkung für Einnahmen-Überschuss-Rechner",
    quelle: "Buchungsvormerkungen erfassen (für EÜR) (16331667205917)",
    regeln: [
      "EÜR-Rechner buchen nur Zahlungen. Bei einem unbezahlten Beleg lässt sich am Beleg eine Buchungsvormerkung erfassen: der Beleg selbst wird dabei nicht gebucht.",
      "Die Vormerkung wird automatisch als Buchungsvorschlag auf die Zahlung angewendet, sobald diese mit dem Beleg verknüpft wird, aber nur, wenn Zahlungs- und Rechnungsbetrag exakt übereinstimmen.",
      "Bestehende Buchungsreservierungen haben Vorrang vor Vorschlägen aus Automatisierungsregeln.",
    ],
    konnektor: [
      "Nicht dokumentiert, aber vorhanden: /postings-reservations/add, /get und /delete (die Spec v1.9.1 enthält nur ihre Antwortschemas PostingsReservations*, ohne Pfade). Felder laut Schema: receipt_id_by_customer, postingaccount, postingtext, vat_option, amount, cost_location, cost_location_two; Fehlertexte u. a. 'the total amount of all postings reservations does not match the receipt amount'.",
      "Getestet am 07.10.2026: Die Routen existieren (401 statt 404), liefern mit gültigen Zugangsdaten aber Fehler 4 'insufficient privileges', auch wenn alle dokumentierten Endpunkte für den Zugang funktionieren. Ohne Freischaltung durch BuchhaltungsButler kein Tool im Konnektor.",
      "Die Weboberfläche zeigt den Status als postingsReservationsStatus am Beleg; die API liefert ihn nicht. EÜR ohne Vormerkung: die Zahlung direkt buchen (add_transaction_postings), sobald sie da ist.",
    ],
  },
  {
    id: "ausgangsrechnung_kasse",
    titel: "Ausgangsrechnungen in der Kasse oder auf dem EÜR-Verrechnungskonto",
    quelle: "Ausgangsrechnungen in der Kasse verbuchen (11419453337373)",
    regeln: [
      "'Beleg erzeugt Zahlung' (bei Kasse oder EÜR-Verrechnungskonto aktivierbar) gilt nur für Eingangsbelege. Für Ausgangsrechnungen gibt es diese Logik nicht: die Zahlungseingänge müssen auf dem Basiskonto/in der Kasse manuell angelegt werden.",
      "Vorgehen: den Beleg in den Ordner 'Ausgangsrechnungen' hochladen, dann die Transaktion auf dem Konto manuell anlegen.",
      "Ausgangsrechnungen nie in den Eingangsbereich laden oder Eingangsrechnungen zuordnen.",
    ],
    konnektor: [
      "upload_receipt mit type 'invoice outbound', dann create_transactions auf dem Kassenkonto (account) und assign_receipts_to_transactions. receipt_creates_transaction bei create_account/manage_account wirkt nur für Eingangsbelege.",
    ],
  },
  {
    id: "anlagen_browser",
    titel: "Anlagevermögen per Browser in die Anlagenverwaltung übernehmen (kein API-Weg)",
    quelle: "Übergabe des Teams (eigene Erfahrung, kein BHB-Artikel): getestet mit Einzelunternehmen, EÜR, SKR03, Übernahme zum 01.01.; Hintergrund: Anlagenverwaltung (11473445146397)",
    regeln: [
      "Es gibt kein MCP-Tool dafür: die API kennt keine Anlagen. Der Weg läuft über die Weboberfläche https://app.buchhaltungsbutler.de/asset-management/ mit dem eingebauten Browser (Claude_Browser__*) oder Claude in Chrome. Der Nutzer ist eingeloggt, richtiger Mandant aktiv; keine Zugangsdaten eingeben.",
      "Pro Anlagegut aus dem Anlagenverzeichnis des Vorjahres nötig: Anschaffungsdatum, Anschaffungskosten (AK), Nutzungsdauer (ND), Restbuchwert zum 31.12.",
      "Übernahmedatum = 01.01. des Jahres, ab dem BHB buchen soll. Übernahmebetrag = Restbuchwert zum 31.12. des Vorjahres (netto).",
      "Abschreibungsdauer = volle Nutzungsdauer in Monaten ab Anschaffungsdatum, NICHT die Restmonate; BHB rechnet die Restmonate selbst. AfA läuft monatlich automatisch ab dem Übernahmedatum. Plausibilität: Übernahmewert / Restmonate = AfA pro Monat.",
      "Der Haken 'mit 1,00 € Erinnerungswert im Anlagevermögen behalten' ist vorbelegt und bleibt so. Endet die Laufzeit schon vor dem Übernahmedatum, legt BHB das Gut mit Buchwert 1 € und Status 'Abgeschrieben' an: kein Fehler.",
      "Inventarnummer ist eine ganze Zahl; Text wie '320-001' wird abgelehnt.",
      "Konten SKR03 (Beispiele der Übergabe): Software Anlagekonto 27 mit AfA 4822, Pkw 320 mit AfA 4832, Betriebs- und Geschäftsausstattung 410 mit AfA 4830. Andere Güter: Konto per list_posting_accounts (search) bestimmen.",
      "Geringwertige Posten mit Restbuchwert 1 € brauchen keine Abschreibung: weglassen oder mit 'Anlagegut nicht abschreiben' und Übernahmewert 1,00 € anlegen.",
      "Korrektur: 'Anlage löschen' entfernt das Gut; bereits gebuchte AfA bleibt und muss im Journal geprüft oder storniert werden (cancel_posting).",
    ],
    ablauf: [
      "Vorbereiten: resize_window 1440 x 900 (danach sind Koordinatenklicks unzuverlässig: immer Refs über find oder read_page mit filter=interactive nutzen). Am Ende resize_window mit preset=desktop.",
      "Menü: der erste der zwei Buttons nach dem Suchfeld (drei Punkte) öffnet das Menü, der zweite nur den Filter. Eintrag 'Bestehendes Anlagegut übernehmen' per find suchen (Text kommt mehrfach vor; scheitert der Klick mit 'entirely outside the viewport', den nächsten Ref nehmen).",
      "Dialogfelder (DOM-Name): Inventarnummer inventory_number, Bezeichnung name, Anschaffungsdatum date_purchase, Anschaffungsbetrag amount_purchase, Übernahmedatum date_takeover, Übernahmebetrag amount_takeover, Anlagekonto asset_postingaccount, Radio depreciation-status (depreciable / not_depreciable), Abschreibungskonto depreciation_postingaccount, Abschreibungsdauer depreciation_months_total, Checkbox amount_target_book_value (Erinnerungswert).",
      "Textfelder: Ref anklicken, dann type (form_input setzt diese Felder nicht zuverlässig). Beträge als 4400,00, Daten als TT.MM.JJJJ.",
      "Inventarnummer ist mit der nächsten freien Zahl vorbelegt und beim Tippen wird angehängt (aus '2' plus '34' wird '234'): Vorbelegung übernehmen oder per triple_click markieren und neu tippen (cmd+a plus Backspace leert nicht zuverlässig).",
      "Datumsfelder öffnen einen Datepicker, der das nächste Feld überdeckt: schließen per Klick auf den Dialogtitel (vorher einmal einen Screenshot machen, sonst lehnt das Tool Koordinatenklicks ab). Nie auf das X des Dialogs klicken: das schließt und leert das Formular.",
      "Konten: Feld anklicken, Kontonummer tippen (z. B. 27), dann ArrowDown und Return. Nur so wird der Eintrag übernommen (die Listeneinträge sind per Ref nicht klickbar). Wird das nächste Feld vor der Bestätigung getippt, landet die Eingabe im falschen Feld (Fehlerbild '27; EDV-Software4822'): Feld leeren, neu auswählen.",
      "Vor dem Speichern per javascript_tool prüfen: [...document.querySelectorAll('[name=inventory_number],[name=name],[name=date_purchase],[name=amount_purchase],[name=date_takeover],[name=amount_takeover],[name=asset_postingaccount],[name=depreciation_postingaccount],[name=depreciation_months_total]')].map(i=>i.name+'='+i.value). Die Kontofelder müssen Nummer und Klartext enthalten (z. B. '27; EDV-Software (Anlagevermögen)'), nicht nur '27'.",
      "'Übernehmen' (Submit unten rechts) per Ref klicken, dann im Dialog 'Rückwirkende Abschreibungsbuchungen' per find 'Bestätigen' klicken (bei Anschaffung in einer früheren Periode normal). Der erste Klick auf 'Übernehmen' reagiert manchmal nicht sichtbar: vor einem zweiten Klick mit get_page_text prüfen, ob der Bestätigungsdialog schon da ist, sonst entstehen Doppelanlagen.",
      "Erfolg ist das grüne Banner 'Das Anlagegut wurde erfolgreich in die Anlagenverwaltung übernommen'. Danach die Seite per navigate neu laden (alte Refs sind veraltet).",
      "Verifikation je Gut: Zeile aufklappen und Anlagekonto, AfA-Konto, kumulierte Abschreibung (= AK minus Buchwert), AfA-Ende, Nutzungsdauer, Übernahmedatum, Übernahmewert prüfen. Journal (Menü Erweitert, /postings/free/): eine AfA-Buchung pro Monat ab Übernahmedatum, keine davor. Jahres-AfA gegen die Spalte 'AfA' im Anlagenverzeichnis des Vorsystems abgleichen.",
    ],
    buchungen: [
      "Beispiel (erfunden), Übernahme 01.01.2026: Pkw, angeschafft 02.12.2020, AK 30.000,00, Übernahmewert 4.400,00, Konto 320, AfA 4832, 72 Monate: AfA-Ende 30.11.2026, 11 Restmonate, rund 400 €/Monat, danach Buchwert 1 €. Software, angeschafft 01.02.2023, AK 3.600,00, Übernahmewert 100,00, Konto 27, AfA 4822, 36 Monate: AfA-Ende 31.01.2026, 1 Restmonat, 99 €, Status 'Abgeschrieben', Buchwert 1 €.",
    ],
    achtung: [
      "Kleine Abweichungen sind zu erwarten: bei Gütern, die im Übernahmejahr auslaufen, bucht BHB 1 € weniger (Erinnerungswert bleibt stehen); die Monatsverteilung kann abweichen (BHB verteilt den Restwert auf seine Restmonate, das Vorsystem oft gleichmäßig auf 12). Für die EÜR zählt nur die Jahressumme.",
      "Nicht geprüft: ob die Übernahme das Anlagekonto in der Bilanz mit einem Saldo versieht. Es wurde bewusst keine zusätzliche Eröffnungsbuchung gegen 9000 gebucht (Doppelungsgefahr); laut BHB-Wiki genügen für die EÜR die Anfangsbestände der Zahlungskonten. Bei Bedarf die Salden der Anlagekonten im Journal kontrollieren; für Bilanzierer mit dem Steuerberater klären.",
      "Doppelanlage: Zeile aufklappen, Dreipunktmenü, 'Anlage löschen', danach das Journal auf bereits erzeugte AfA prüfen.",
      "Die DOM-Namen und Abläufe stammen aus einer Browser-Sitzung und können sich mit einem BHB-Update ändern: bei Abweichung neu über read_page ermitteln, nicht raten.",
      "Das Journal ist per list_postings oder get_account_ledger lesbar; bei einem Clientfehler dort ('outputSchema draft-07') stattdessen die Oberfläche nutzen.",
    ],
    konnektor: [
      "Zahlungsbuchungen auf Anlagenkonten per API legen kein Anlagegut an (siehe Warnung bei add_*_postings). Neuanschaffungen ebenfalls in der Oberfläche erfassen ('Erfassen' nach Bestätigung der Buchung), nicht von Hand abschreiben.",
    ],
  },
  {
    id: "festgeschriebene_loeschen",
    titel: "Festgeschriebene Zahlungen, Belege und Buchungen entfernen oder korrigieren (GoBD)",
    quelle: "Löschen von festgeschriebenen Zahlungen und Belegen (11422252682781); GoBD konformes Arbeiten mit BuchhaltungsButler (11432424987037); Revisionssicheres Kassenbuch einrichten und auswerten (11467646903069)",
    regeln: [
      "Festgeschriebene Zahlungen und Belege lassen sich aus Gründen der Revisionssicherheit nicht löschen. Auch hochgeladene Belege werden nie physisch gelöscht: ein 'gelöschter' Beleg bleibt im Archiv, ist über den Filter 'Gelöschte Belege' sichtbar und lässt sich wiederherstellen. Das Upload-Kontingent bekommt man durch Löschen nicht zurück.",
      "Zahlung mit festgeschriebener Buchung (Oberfläche): entweder eine zweite 'falsche' Zahlung mit gleichem Betrag und umgekehrtem Vorzeichen anlegen und beide auf das Interimskonto (1590 | 1370) kontieren (die Buchungen gleichen sich aus); oder die Zahlung mit leerem Buchungskonto speichern: das löscht die festgeschriebene Buchung, im Hintergrund entsteht eine Stornobuchung, die Zahlung bleibt offen (Exporte und Auswertungen warnen dann wegen ungebuchter Geschäftsvorfälle).",
      "Beleg mit festgeschriebener debitorischer/kreditorischer Buchung: erst die Buchung am Beleg entfernen ('Buchung bearbeiten', 'Buchung entfernen', bestätigen). BuchhaltungsButler legt dabei eine Stornobuchung an, die auch nach dem Löschen des Belegs bestehen bleibt, damit die SuSa ausgeglichen bleibt. Danach lässt sich der Beleg löschen.",
      "Offene-Posten-Buchhaltung: ein Beleg ist fest mit der zugewiesenen Zahlung verbunden, solange diese Zahlung verbucht ist. Zuerst die Buchung an der Zahlung lösen, dann die Belegzuweisung aufheben, dann den Beleg löschen.",
      "Revisionssicheres Kassenkonto: Zahlungen sind nur per Storno änderbar ('Zahlung löschen' erzeugt automatisch den Storno).",
      "Importierte CSV-Buchungen mit Festschreibekennzeichen werden festgeschrieben übernommen, das Festschreibedatum wird auf den Importtag gesetzt.",
    ],
    konnektor: [
      "cancel_posting löscht nicht festgeschriebene Buchungen und storniert festgeschriebene per Gegenbuchung (nur mit freigegebenen IDs); delete_transaction legt bei einem revisionssicheren Konto eine Storno-Zahlung an und scheitert bei einer Zahlung mit festgeschriebener Buchung; unassign_receipt hebt eine Zuweisung auf; set_receipt_deleted löscht/stellt Belege wieder her.",
      "Zahlungen aus dem Archiv, die nicht mehr existieren sollen, lieber per Gegenzahlung auf Interimskonto neutralisieren, wenn kein Storno möglich ist.",
    ],
  },
  {
    id: "belege_upload_matching",
    titel: "Belegupload, OCR, Belegmatching, manuelle Zuweisung, fehlende Belege",
    quelle: "Belege hochladen und verarbeiten (11443147763101); Belegmatching verstehen und optimieren (11443781087389); Belege manuell einer Zahlung zuweisen (11443312093725); Zahlung durch Belegzuweisung erzeugen (11444714286621); Fehlende Belege identifizieren (11443881408285); Fehlermeldung beim Belegupload (11422121017757); Belegupload per E-Mail funktioniert nicht (11421494594077); Belegupload via Dropbox funktioniert nicht (11421652514845); E-Mail Weiterleitung benötigt Bestätigungscode (11421952068125); Belegzuordnung zu falschem Debitoren-/Kreditorenkonto (11421829670045); E-Rechnungen (20227969805853)",
    regeln: [
      "Wege: eigene E-Mail-Adressen für Eingangs- und Ausgangsbelege (der Absender muss autorisiert sein; bei Weiterleitungsregeln auch der ursprüngliche Absender), Dropbox/Google Drive/OneDrive, manueller Upload (höchstens 20 Belege je Schritt, danach die Beleganzahl unten auf der Seite als Prüfsumme nutzen), API, GetMyInvoices/InvoiceFetcher, Ausgangsrechnungen auch als debitorischer CSV-Buchungssatz. Ausgangsbelege per Bcc an die Ausgangsbeleg-Adresse schicken.",
      "Formate: PDF, JPEG, PNG, TIFF, BMP, GIF, ZUGFeRD (PDF mit XML), XRechnung (XML). Höchstens 50 Seiten und 20 MB je Datei (per E-Mail 10 MB). Die OCR (ABBYY) liest die ersten Seiten (bis Seite 3), ab vier Seiten gibt es keine automatische Erkennung und keinen OCR-Volltext: Daten nachtragen. Ein abweichendes Leistungsdatum erkennt die OCR nie. Eine falsch gelesene USt/VSt hat keine Wirkung: maßgeblich ist die bei der Buchung gewählte Steuer.",
      "Erkennung verbessern: Unternehmensdaten vollständig (eigene IBAN und USt-ID dienen als Ausschlusskriterium; fehlen sie, werden Belege dem falschen Debitor/Kreditor zugewiesen), IBAN und USt-ID in den Debitoren/Kreditoren-Stammdaten, E-Rechnung statt PDF nutzen (keine OCR nötig). Die Gegenpartei lernt das System aus Korrekturen.",
      "Upload-Fehler: 'Dateityp wird nicht unterstützt' (Format wandeln), 'Datei kann nicht verarbeitet werden' (meist schreibgeschütztes PDF: als normales PDF drucken oder online umwandeln). Dropbox: nie mehr als 50 Dateien auf einmal, Ordnerstruktur nicht ändern, Belege nicht im Überordner ablegen, Upload-Limit beachten (wartende Belege laden erst nach einem neuen erfolgreichen Upload). E-Mail: Apple-Mail-'Inline-Attachments' werden nicht gelesen ('In reinen Text umwandeln'), bei Weiterleitung mit Bestätigungscode (Gmail) ein Zwischenpostfach oder Zapier nutzen.",
      "Matching: Beleg und Zahlung werden nur verknüpft, wenn der Betrag übereinstimmt (Fremdwährungsbelege und Zahlungen mit Skonto werden nicht gematcht) und das Rechnungsdatum höchstens 90 Tage vor bis 30 Tage nach der Zahlung liegt. Vorselektion bis 1.000 Belege; Rangfolge: Betrag plus Rechnungsnummer (als alleiniger Wert im Verwendungszweck), Betrag plus Gegenpartei, Betrag. Eine bereits verbuchte Zahlung wird nicht mehr gematcht.",
      "Payment Reference (E-Commerce): bei PayPal/Amazon/Stripe liefert BuchhaltungsButler die Referenz an der Zahlung selbst. Per API/Import muss sie im Feld Zahlungsreferenz mitgegeben werden, bei Belegen ebenfalls (bei klassischem Upload muss sie auf dem Beleg hinter einem Signalwort stehen: Verwendungszweck, Purpose, Zahlungs-ID, Transaction-id, Referenz-Nr, Reference-ID, Referenz, Reference, Zahlungsreferenz, getrennt durch Satzzeichen und Leerzeichen, z. B. 'Referenz: 123456abc'; nicht 'Referenz123456abc').",
      "Manuell zuweisen: am Beleg ('Zahlung zuweisen') oder an der Zahlung ('Belege zuweisen'). Standardmäßig sieht man bei Zahlungsausgängen die Eingangsbelege und bei Eingängen die Ausgangsbelege: für Gutschriften/Korrekturen den Filter anpassen. Mehrere Belege je Zahlung nur manuell; DATEV kann mehrere debitorisch/kreditorisch erfasste Belege je Zahlung nicht korrekt ausziffern: dann ein sonstiges Basiskonto (Verrechnungskonto) anlegen und je Beleg eine manuelle Zahlung hinzufügen. Einen Beleg mehreren Zahlungen zuweisen: Filter von 'unbezahlt' auf 'alle' stellen.",
      "'Beleg erzeugt Zahlung': Zuweisung eines Eingangsbelegs zu einem manuellen Zahlungskonto erzeugt die Zahlung (Datum = Belegdatum); nachträgliche Korrekturen am Beleg passen die Zahlung an. Standard bei manuell angelegten Konten.",
      "Fehlende Belege: Zahlungen mit Filter 'Fehlender Beleg' prüfen; was keinen Beleg braucht, als 'beleglos' markieren; fehlt ein Beleg grundsätzlich, einen Kommentar mit dem Sachverhalt hinterlegen, damit der Steuerberater ihn einordnen kann. BuchhaltungsButler warnt nicht vor doppelt hochgeladenen Belegen: erst prüfen, ob der Beleg nur nicht zugeordnet wurde; Filter 'Duplikatsverdacht'.",
      "Archiv: Originale bleiben unveränderbar gespeichert; mangels Wirtschaftsprüfertestat rät BuchhaltungsButler nicht, Papierbelege zu vernichten.",
    ],
    konnektor: [
      "Prüfen und Korrigieren von Belegdaten (Gegenpartei, Nummer, USt) geht per API nicht: siehe belegpruefung.",
      "upload_receipt/create_receipts: payment_reference setzen; vorher list_receipts (counterparty, invoicenumber) gegen Duplikate; assign_receipts_to_transactions für Fälle, die nicht automatisch matchen; add_comment für den Hinweis an den Steuerberater; die Zahlung 'beleglos' markieren kann nur die Oberfläche.",
    ],
  },
  {
    id: "belegpruefung",
    titel: "Belegprüfung und Korrektur von Belegdaten (nur Weboberfläche)",
    quelle:
      "Übergabe des Teams (07.10.2026): API-Tests gegen Spec v1.9.1 und die Live-API, Mitschnitt der Weboberfläche beim Prüfen eines Belegs. Kein BHB-Artikel.",
    regeln: [
      "Ein Beleg gilt in der Weboberfläche als geprüft, wenn sein Bearbeiten-Dialog gespeichert wurde. Intern wechselt dabei confirmationStatus von 'unconfirmed' auf 'confirmed'. Prüfen und Korrigieren sind ein Schritt: der Dialog überträgt alle Belegfelder (Rechnungssteller, Empfänger, Rechnungsnummer, Datum, Leistungsdatum, Betrag, Währung, USt-Satz, Fälligkeit).",
      "Die Weboberfläche nutzt dafür POST /receipts/dialog-receipt-details mit action=editReceipt auf app.buchhaltungsbutler.de. Dieser Pfad verlangt eine angemeldete Browser-Sitzung; API-Zugangsdaten (Basic-Auth, api_key) werden mit 401 abgelehnt. Der Login ist durch reCAPTCHA geschützt.",
      "Die API hat keinen Endpunkt, um Belegfelder zu ändern oder den Prüfstatus zu setzen: unter /receipts gibt es nur get, add, addBatch, upload, delete, restore und assigned-transactions/get. Auch undokumentierte Kandidaten (u. a. receipts/update, receipts/edit, receipts/confirm, settings/update/receipt) antworten mit 404 oder 'invalid type'. confirmationStatus fehlt auch in der ungekürzten Antwort von receipts/get.",
      "Ersatzsignal per API: list_receipts mit date_since_last_modified (z. B. '2000-01-01 00:00:00') liefert nur Belege, die in der Weboberfläche bearbeitet wurden. Hochladen, Zahlung zuordnen, Zahlung buchen und Kommentieren setzen das Signal nicht. Belege, die dort fehlen, sind ungeprüft. Das ist eine Beobachtung, kein dokumentiertes Prüfkennzeichen.",
      "Typische OCR-Fehler bei Gutschriften und Provisionsabrechnungen (Aussteller ist der Zahler): die eigene Firma (Rechnungsempfänger) landet als Gegenpartei, eine Kunden- oder Kreditorennummer statt der Abrechnungsnummer als Rechnungsnummer, der USt-Satz fehlt. Der Dateiname übernimmt den falschen Namen und ändert sich beim späteren Korrigieren nicht.",
    ],
    ablauf: [
      "Im Browser: Beleg öffnen, Felder gegen das PDF korrigieren, speichern. Danach list_receipts mit date_since_last_modified: der Beleg muss jetzt in der Liste stehen.",
      "Der Beleg wird über Belegdatum, Rechnungsnummer und Betrag gefunden; die id_by_customer der API zeigt die Weboberfläche nicht an.",
    ],
    achtung: [
      "Alternative mit aktivierter Debitoren-/Kreditorenbuchhaltung: ein Beleg lässt sich dann per add_receipt_postings buchen und gilt laut Beobachtung in der Oberfläche danach als geprüft. Per API nicht verifiziert: ohne Aktivierung lehnt BHB mit Fehler 12 'debtor posting is not activated' ab. Das Buchen korrigiert keine falschen Felder, und ein unvollständiger Beleg wird mit Fehler 13 'the receipt is not valid, please complete the data' abgelehnt.",
      "Die Aktivierung geht nur in der Oberfläche und ändert die Buchungslogik des ganzen Mandanten (Belege werden zum Belegdatum auf den Debitor gebucht, die Zahlung gleicht ihn aus). Bei EÜR mit Ist-Versteuerung vorher mit dem Steuerberater klären (siehe ist_versteuerer_debitoren und debitoren_kreditoren_logik).",
      "Ersetzen statt Ändern (Buchung zurücknehmen, set_receipt_deleted, neu hochladen, zuordnen, buchen) korrigiert die Daten, setzt aber den Prüfstatus nicht, kostet Upload-Kontingent und funktioniert bei E-Rechnungen nicht: dort ignoriert BHB die mitgegebenen Felder.",
    ],
    konnektor: [
      "Fehler vermeiden statt korrigieren: bei upload_receipt counterparty, invoice_number, date, amount und vat_rate selbst aus dem PDF setzen, nicht der OCR überlassen (wirkt nicht bei E-Rechnungen).",
      "Nach dem Upload get_receipt mit extract_text aufrufen und die Felder gegen den PDF-Text vergleichen; Abweichungen dem Nutzer mit Belegdatum, Rechnungsnummer und Betrag zur Korrektur in der Weboberfläche nennen.",
    ],
  },
  {
    id: "eigenbeleg",
    titel: "Eigenbeleg bei verlorenem Originalbeleg",
    quelle: "Eigenbelege (20426914295453)",
    regeln: [
      "Eigenbelege entstehen in der Oberfläche direkt an der Zahlung ('Eigenbeleg erstellen'); Gegenpartei, Datum und Betrag kommen aus der Zahlung. Erst prüfen, ob das Original gefunden oder nachgefordert werden kann: nur damit ist der Vorsteuerabzug zulässig.",
      "Ein Eigenbeleg ist Betriebsausgabe, berechtigt aber nicht zum Vorsteuerabzug: Steueroption 'ohne USt./VSt.' und ein Aufwandskonto OHNE Steuerautomatik (z. B. Wareneingang 3200 | 5200 statt 3400 | 5400).",
      "Bei Geschäftsvorfällen über 250 € empfiehlt sich die Adresse der Gegenpartei. Beim Grund 'Sonstiges' ist eine Erläuterung Pflicht.",
      "Nach dem Erstellen ist der Eigenbeleg nicht mehr änderbar (fortlaufende Nummer, digitale Signatur/GUID, mit dem Namen des Nutzers und den Unternehmensdaten). Er liegt unter den Eingangsbelegen (Suche 'Eigenbeleg') und ist mit der Zahlung verknüpft.",
      "Wird das Original später gefunden: den Eigenbeleg im Eingangsbereich löschen (die Zuordnung zur Zahlung fällt weg; die Nummer bleibt vergeben, gelöschte lassen sich wiederherstellen), das Original hochladen, zuordnen und die ursprüngliche Buchung ohne Steuer anpassen, falls auf dem Original Steuer steht.",
      "Das Recht, Eigenbelege zu erstellen, haben Admin, Steuerberater und Standardnutzer; wer kein Finanzkonto sehen darf, kann keine erstellen.",
    ],
    konnektor: ["Keine API für Eigenbelege. Für Bewirtungsbelege gibt es generate_entertainment_receipt und generate_and_upload_entertainment_receipt."],
  },
  {
    id: "debitoren_kreditoren_logik",
    titel: "Debitoren und Kreditoren: Logik, Modi, Ausgleich, Doppelerfassung",
    quelle: "Grundlagen zur Arbeit mit Debitoren und Kreditoren (11451892160797); Mit Debitoren und Kreditoren buchen (11452107588893); Debitoren und Kreditoren aktivieren und einrichten (11451725464477)",
    regeln: [
      "Debitor = Kunde, Kreditor = Lieferant; relevant, sobald Rechnungs- und Zahlungsdatum auseinanderfallen (offener Posten). Bilanzierende Unternehmen müssen Eingangs- und Ausgangsrechnungen zum Leistungsdatum erfassen; Soll-Versteuerer sollten Ausgangsrechnungen debitorisch buchen, sonst wird die USt womöglich zu spät gemeldet. Die Umstellung nur zum Jahreswechsel und mit dem Steuerberater.",
      "Die Vorsteuer muss, egal ob Soll- oder Ist-Versteuerer, zum Rechnungsdatum geltend gemacht werden. Wird die Rechnung erst in einer späteren Periode bezahlt, kreditorisch erfassen; sonst ist die Vorsteuer frühestens bei Zahlung buchbar, und bei der Prüfung kann der Abzug versagt werden (5-Jahres-Frist).",
      "Selektiv buchen spart Aufwand: den Monat über Aufwand/Erlös an der Zahlung buchen und nur Rechnungen, die in der Periode nicht bezahlt wurden, debitorisch/kreditorisch erfassen.",
      "Aufwand/Erlös und die Steuer werden am Beleg gebucht. Die Zahlung gleicht nur den offenen Posten aus, IMMER ohne Steuer (vat 0_none), auch bei Ist-Versteuerung (die USt wird im Hintergrund von 'nicht fällig' auf 'fällig' umgebucht). Der Saldo aller D/K-Konten spiegelt sich auf Forderungen aus Lieferungen und Leistungen (1400 | 1200) bzw. Verbindlichkeiten (1600 | 3300).",
      "Keine Doppelerfassung: ist ein einer Zahlung zugeordneter Beleg debitorisch/kreditorisch gebucht, lässt sich die Zahlung nur gegen den Debitor/Kreditor buchen, nicht gegen Aufwand/Erlös. Umgekehrt lässt sich ein Beleg nicht D/K-buchen, wenn seine Zahlung schon auf Aufwand/Erlös gebucht ist: erst diese Buchung aufheben.",
      "Immer zuerst den Beleg buchen, dann die Zahlung: der Filter 'ungebucht' blendet sonst auch Belege einer verbuchten Teilzahlung aus.",
      "Konten mit 'Beleg erzeugt Zahlung' (Bank/Kasse/Auslagen als Basiskonto) lassen keine D/K-Buchung zu, weil die Zahlung zum Rechnungsdatum erzeugt wird. Soll eine bar bezahlte Eingangsrechnung trotzdem kreditorisch gebucht werden: mit 'automatischer Kontenzuordnung' hochladen, kreditorisch buchen, die Zahlung in der Kasse manuell anlegen.",
      "Aktivierung (Einstellungen, Buchhalterische Einstellungen): Modus 'Selektiv' (ohne vorhandenen Debitor/Kreditor wird nicht automatisch D/K-gebucht) oder 'Sammelkonto' (Debitoren-Sammelkonto 10000, Kreditoren-Sammelkonto 70000). Existiert ein eigenes Konto zur Gegenpartei, wird es in beiden Modi gewählt. Die EÜR-Auswertung gibt es nur bei ausgeschalteten Debitoren/Kreditoren.",
      "Skonto immer an der Zahlung als negativer Split buchen, der volle Rechnungsbetrag steht auf dem Beleg (Thema skonto).",
    ],
    konnektor: [
      "add_receipt_postings (creditor/debtor) für den Beleg, dann der Ausgleich mit add_transaction_postings (Split auf die Personenkontonummer, vat 0_none, receipt_id_by_customer) oder confirm_payment. list_posting_accounts mit exclude_* zeigt Debitoren/Kreditoren.",
    ],
  },
  {
    id: "ust_va_zm",
    titel: "Umsatzsteuer-Voranmeldung, Zusammenfassende Meldung und ihre Warnungen",
    quelle: "Umsatzsteuer-Voranmeldung (USt.-VA) erstellen und übermitteln (11473240647965); Zusammenfassende Meldung (ZM) erstellen (11473312092445); Berichtigte Umsatzsteuer-Voranmeldung (11469981205277); Konsolidierte USt.-VA (11473051798941); Warn- und Fehlermeldungen bei der USt-VA (11432104747677); Buchungskonten den Kennziffern der USt.-VA zuordnen (11472964130461)",
    regeln: [
      "USt-VA und ZM entstehen unter Abschluss in der Oberfläche und werden von dort per Elster übermittelt (mit dem Zertifikat von BuchhaltungsButler, § 87d AO; kein eigenes Zertifikat nötig). Das Übermittlungsprotokoll wird NICHT gespeichert: extern ablegen. Berichtigte Anmeldung: Checkbox 'berichtigte Anmeldung'. Konsolidierte USt-VA (mehrere Unternehmen, eine Steuernummer) geht nicht in BuchhaltungsButler, sondern per ElsterOnline mit eigenem Zertifikat aus den Werten der einzelnen Accounts. Eine korrigierte ZM nach der Übermittlung ist nur über ElsterOnline möglich.",
      "Kennziffern: get_ustva_position liefert die Zuordnung (nach Steuerschlüssel: 19 % Kz 81, 7 % Kz 86, i.g.E. 19 % Kz 89 und 61, i.g.E. 7 % Kz 93 und 61, Vorsteuer Kz 66, §13b Kz 46 und 67; dazu die Konten mit fester Position). Umsatzsteuerkonten lassen sich nicht direkt bebuchen, weil der Umsatz aus der gebuchten Steuer zurückgerechnet und abgerundet wird.",
      "ZM: berücksichtigt Sonstige Leistungen an Unternehmen in der EU (8336 | 4336) und Lieferungen an Unternehmen in der EU (8125 | 4125) sowie darauf basierende individuelle Konten; Datum ist das Rechnungsdatum. Die gemeldeten Umsätze müssen mit der USt-VA übereinstimmen: Umsatzart L = Kz 41, S = Kz 21. Beim Debitor die USt-ID speichern, sonst fehlt sie in der ZM.",
      "Warnung 'Buchungen auf dem Konto XXXX': das Konto wird in der USt-VA nicht korrekt ausgewertet (z. B. 'Leistungen nach § 13b UStG ohne Vorsteuerabzug' 3165 | 5965): die USt-VA dann in Elster machen und die Steuer dieser Buchungen von Hand berechnen.",
      "Warnung 'Buchungen entgegen der normalen Logik' (Zahlungsausgang als Erlös oder Eingang als Aufwand über 100 € je Buchung bzw. 400 € insgesamt): oft gewollt (Rückerstattung, Storno), sonst ein Fehler; für durchlaufende Posten das Interimskonto 1590 | 1370 nehmen.",
      "Warnung 'unbestätigte Buchungen' (Zahlungen, bei Bilanzierern auch Belege mit Debitor/Kreditor, nicht verbucht) und 'nicht festgeschriebene Buchungen': vor der Übermittlung festschreiben (Abschluss, 'Jetzt festschreiben'), das Festschreibedatum muss älter als die Übermittlung sein. Warnung 'nicht verbuchte Belege': Vorsteuer gehört zum Rechnungs-/Leistungsdatum, periodenübergreifend bezahlte Belege deshalb kreditorisch buchen.",
      "Elster-Fehler wie 'Das Feld ... Telefon darf maximal 20 Zeichen enthalten' sind Formatfehler in den Unternehmensdaten (Systemdaten/Ansprechpartner, Allgemeine Firmendaten, Steuerliche Informationen): das letzte Wort der Meldung nennt das Feld; häufig auch Sonderzeichen im Firmennamen oder eine ungültige Steuernummer.",
    ],
    konnektor: ["get_ustva_position für die Kennziffer-Vorhersage; check_month_end meldet nicht festgeschriebene Buchungen; die Vorbereitung der USt-VA (Festschreiben, Übermitteln) nur in der Oberfläche."],
  },
  {
    id: "auswertungen",
    titel: "Auswertungen: BWA, SuSa, EÜR, Bilanz, GuV, Kontostand, Kassenbuch",
    quelle: "Leere oder fehlerhafte Auswertungen (11431990158365); Eine Einnahmenüberschussrechnung (EÜR) erstellen (11474039285405); Eine BWA erstellen (11473653935005); Summen- und Saldenliste (11474193643293); Zahlungskonten über Kontostand berechnen plausibilisieren (11474253173021); Monatsabschluss-Checkliste (Beta) (38676182512029)",
    regeln: [
      "Alle Auswertungen unter Abschluss berücksichtigen NUR bestätigte Buchungen. Eine leere oder zu kleine Auswertung heißt meist: unbestätigte Buchungen in Zahlungen (Filter 'ungebucht'), bei Debitoren/Kreditoren auch in Belege, und in Erweitert. Die Auswertung warnt bei unbestätigten Buchungen.",
      "EÜR: nur bei Gewinnermittlungsart EÜR und AUSGESCHALTETEN Debitoren/Kreditoren verfügbar; sie enthält zusätzlich zur BWA die vereinnahmte USt und die verauslagte Vorsteuer, deshalb weicht ihr Ergebnis von der BWA ab. EÜR und BWA lassen sich nach Kostenstellen aufschlüsseln (CSV-Export). Bei der BWA hilft bei Problemen ein kürzerer Zeitraum.",
      "SuSa: Anfangssalden müssen erfasst sein; ungebuchte Zahlungen fehlen darin. Kontenauswahl: alle, Zahlungs-, Sach-, Debitoren-, Kreditorenkonten oder einzelne. Die Summe der Buchungssätze im Drilldown kann von der Kontensumme abweichen, wenn nach dem Generieren noch gebucht wurde.",
      "Kontostand berechnen (Abschluss): Summe der Zahlungen eines Kontos bis zum Stichtag, zum Abgleich mit dem Kontoauszug. Ohne Anfangsbestand stimmt nur die Veränderung; Fremdwährungen werden nicht umgerechnet. Bei angebundenen Bank-/Kreditkartenkonten zeigt 'Zahlungen' den Stand laut Bank, bei manuellen Konten (Kasse, Auslagen, Verrechnungskonto) sowie PayPal/Amazon/eBay/Stripe den berechneten.",
      "Kassenbuch (nur mit revisionssicherem Kassenkonto): Sortierung nach Erfassungsdatum, nicht Zahlungsdatum; nachträglich erfasste Buchungen anderer Perioden zwischen den Zahlungen werden mit ausgegeben.",
      "Monatsabschluss-Checkliste (Beta) im Abschluss-Cockpit: Abschnitte abhaken, ausblenden, eigene Aufgaben/Abschnitte anlegen (gilt für den ganzen Account), Fortschritt je Kategorie speichern (pro Account und Monat, gemeinsam), Kontosalden ('Aktualisieren'; nach Monatsende fest zum Monatsletzten; den Bankstand trägt man selbst ein). Rollen Admin, Steuerberater, Standardnutzer.",
    ],
    konnektor: [
      "Per API: create_report/get_report (BWA, SuSa), get_account_ledger, calculate_account_balance (Kontostand berechnen), check_month_end. EÜR, GuV, Bilanz, Kassenbuch, OSS-Auswertung und die Checkliste gibt es nur in der Oberfläche.",
    ],
  },
  {
    id: "konten_einrichtung",
    titel: "Kontenrahmen, Sachkonten, Basiskonten, revisionssicheres Kassenkonto",
    quelle: "Kontenrahmen und Sachkontenlänge wählen (11465983139101); Individuelle Sachkonten anlegen (11454526317085); Informationen zu Basiskonten und zur Einrichtung (11465877273757); Basiskonten ausblenden oder löschen (11454462250909); Revisionssicheres Kassenbuch einrichten und auswerten (11467646903069)",
    regeln: [
      "Kontenrahmen: SKR 03, SKR 03 Gastro, SKR 03 Ärzte, SKR 04, SKR 42, SKR 45 (soziale Einrichtungen), SKR 49 (Vereine). Erkennbar an Kasse/Bank/Erlöse 19 %: SKR03 1000/1200/8400, SKR04 1600/1800/4400, SKR45 1220/1260, SKR49 920/945. Ein Wechsel setzt den Account zurück (löscht Konten, Zahlungen, Buchungen, individuelle Konten, Debitoren/Kreditoren, gespeicherte Vorschläge) und geht nur, solange nichts festgeschrieben ist (Support); sonst Periode abschließen, exportieren, per Mapping in einen neuen Account importieren.",
      "Sachkontenlänge 4 bis 8 Stellen, Debitoren/Kreditoren eine Stelle mehr (5 bis 9). Sie ist bei der Einrichtung festzulegen und später nicht änderbar.",
      "Individuelles Sachkonto: Nummer im selben Nummernkreis wie das Vorlagekonto, eindeutige Bezeichnung. Das Vorlagekonto bestimmt das Verhalten in den Auswertungen; steht in seinem Namen ein Steuersatz, ist es ein Automatikkonto und die Steuerautomatik wird übernommen (dann den Satz auch in den neuen Namen schreiben). Für freie Steuerwahl ein Vorlagekonto ohne Satz nehmen.",
      "Gesperrte Kontonummern für individuelle Sachkonten, SKR03: 1400, 1512, 1517, 1572, 1574, 1577-1579, 1589, 1600, 1712, 1717, 1763, 1765, 1771-1779, 1785-1787, 3089, 3151, 3152, 3154, 3155, 3440, 3553, 3732, 3735, 3737, 3739, 3740, 3742, 3747, 3749, 3792, 3793, 8333, 8340, 8732, 8735, 8747, 8749, 9303, 9313, 9314, 9333, 9334, 9336. SKR04: 1200, 1182, 1184, 1402, 1404, 1407-1409, 3261, 3270, 3300, 3801-3809, 3813, 3815, 3835-3838, 4333, 4340, 4732, 4735, 4747, 4749, 5189, 5440, 5553, 5732, 5735, 5737, 5739, 5740, 5742, 5747, 5749, 5792, 5793, 5951, 5952, 5954, 5955, 9303, 9304, 9313, 9314, 9333, 9334, 9336. Auf diese Konten ist auch kein Vortrag von Summen oder Salden möglich (Steuerkonten: Thema bilanz_integritaet).",
      "Basiskonto = Hauptkonto, Sachkonto = Gegenkonto. Das Basiskonto steht bei Geldeingang im Soll, bei Geldausgang im Haben; ein negativer Split kehrt das um. Manuelle Basiskonten (nicht verknüpfbares Bankkonto, Kasse, Auslagenkonto, Verrechnungskonto) können 'Beleg erzeugt Zahlung' nutzen.",
      "Zulässige Nummern je Typ (SKR03 | SKR04): Bank/Geldinstitut Bank 1200 | 1800, Bank 1 bis 4 1210-1240 | 1810-1840, Bank 5 1250-1288 | 1850-1888, Postbank 1100 | 1700 (1100, 1120, 1130 | 1710-1730), LZB 1190 | 1780, Bundesbank 1195 | 1790; Kasse 1000 | 1600, Nebenkasse 1010, 1020 | 1610, 1620; Sonstiges Basiskonto u. a. Verbindlichkeiten gegenüber Gesellschaftern 730 | 3510, Verrechnungskonto Gewinnermittlung § 4 Abs. 3 EStG (EÜR-Verrechnungskonto) 1371 | 1486, Sonstige Verbindlichkeiten 1700 | 3500, Darlehen 1705 | 3560, Kreditkartenabrechnung 1730 | 3610, Interimskonten 1792 | 3630, Privateinlagen 1890-1899 | 2180-2189 (SKR45 2120-2129).",
      "Wo 'Kasse' steht, erwartet das Finanzamt ein revisionssicheres Kassenbuch; sonst lieber ein Auslagenkonto oder das EÜR-Verrechnungskonto (nur für nicht Bilanzierungspflichtige; Einnahmen und Ausgaben direkt dagegen, kein Kassenbuch, Bankkonten nicht zwingend nötig; mit dem Steuerberater klären).",
      "Revisionssicheres Kassenkonto: Option 'Revisionssicher' beim Anlegen; Zahlungen sind nicht löschbar, nur per Storno; Bericht 'Kassenbuch'. 'Beleg erzeugt Zahlung' schreibt die Zahlung zum Zeitpunkt der Belegbestätigung ins Kassenbuch (keine Ordnung nach Belegdatum): bei nicht chronologischer Bearbeitung ausschalten und manuell buchen.",
      "Basiskonto löschen nur für Testkonten oder falsche Nummern und nur, wenn keine bestätigten Buchungen darauf liegen (die müssen vorher auf unbestätigt gesetzt werden). Bereits bebuchte, nicht mehr genutzte Konten nur ausblenden ('In der Dropdownliste der Basiskonten ausblenden').",
    ],
    konnektor: [
      "create_account (type bank/institution, cash, other; postingaccount_number im zulässigen Bereich; is_revision_safe), manage_account (update/delete, is_disabled_in_select), manage_posting_account (Sachkonto anlegen; bei gesperrter Nummer ergänzt der Konnektor die Fehlermeldung um den Hinweis), list_posting_accounts.",
    ],
  },
  {
    id: "einstellungen_aendern",
    titel: "Grundeinstellungen nachträglich ändern (Gewinnermittlung, Funktionsumfang, GWG/Sammelposten, Besteuerungsart)",
    quelle: "Gewinnermittlungsart nachträglich ändern (23423191873565); Funktionsumfang nachträglich ändern (23423036141213); Abschreibungsart zwischen GWG und Sammelposten ändern (11444878256413); Erklärungen zu Soll- und Ist-Versteuerung (11445000762781)",
    regeln: [
      "Gewinnermittlungsart (EÜR oder Bilanz): jederzeit unter Einstellungen, Steuerliche Einstellungen änderbar; die EÜR-Auswertung gibt es nur bei ausgeschalteten Debitoren/Kreditoren. Funktionsumfang: jederzeit unter Buchhalterische Einstellungen.",
      "GWG oder Sammelposten: unter Einstellungen, Buchhalterische Einstellungen, Abschreibungen. Je nach Wahl stehen andere Buchungskonten zur Verfügung (GWG 480 | 670). Beim CSV-Import mit Buchungen auf beiden Arten kommt 'Einzelne Konten sind bei Ihren derzeitigen Einstellungen nicht verfügbar': in zwei Schritten importieren (GWG-Buchungen abtrennen, Art umstellen, zurückstellen).",
      "Besteuerungsart: Einstellungen, Steuerliche Einstellungen, Besteuerungsart. Ist-Versteuerung: USt zum Zahlungszeitpunkt; Soll-Versteuerung: zum Leistungsdatum, dafür Ausgangsrechnungen debitorisch buchen. Die Vorsteuer wird in beiden Fällen immer zum Rechnungsdatum geltend gemacht. Ein Wechsel ändert auch vergangene Auswertungen (die Steuer wird bei der Auswertung berechnet).",
    ],
    konnektor: ["Keine dieser Einstellungen ist per API les- oder änderbar: den Nutzer fragen, welche Gewinnermittlungsart, Besteuerungsart und Debitoren/Kreditoren-Einstellung gelten."],
  },
  {
    id: "rechnungen_erstellen",
    titel: "Rechnungen, Angebote, Gutschriften, E-Rechnungen und Korrekturen erstellen",
    quelle: "Rechnungen, Angebote und Gutschriften erstellen (11454209365661); Stornorechnungen oder Rechnungskorrekturen erstellen (11454359040925)",
    regeln: [
      "Stammdaten kommen aus den Unternehmensdaten. Nummernkreise (Rechnung, Angebot, Gutschrift) unter Einstellungen, Rechnungseinstellungen: Zahlen sind Pflicht (mindestens eine), dazu Buchstaben, Trennzeichen und die Datumsvariablen TT, MM, JJJJ; hochgezählt wird die letzte Zahl (1001 gibt 1002; 'TT.MM.JJJJ-1001' wird zu '02.02.2023-1002').",
      "Entwurf: ohne Datum und Nummer gespeichert, Platzhalter 'Entwurf' als Nummer. Beim Finalisieren ersetzt BuchhaltungsButler ihn durch die nächste freie Nummer, nur wenn der Platzhalter stehen bleibt; eine eigene Nummer steht ohne das Wort 'Entwurf'.",
      "E-Rechnung (ZUGFeRD, XRechnung): Pflicht in den Unternehmensdaten sind Straße/Hausnummer, PLZ, Ort, Land und Steuernummer oder USt-ID; empfohlen Registergericht/-nummer, Inhaber, IBAN, BIC, Institut. Empfänger vollständig (Firma, Anschrift, E-Mail), Referenz beim Käufer (ohne Referenz '0') und bei öffentlichen Auftraggebern die Leitweg-ID. Liefer-/Leistungsdatum nur als Datum; deckt es einen Zeitraum ab, den letzten Tag nehmen.",
      "Stornorechnung/Rechnungskorrektur ist eine normale Rechnung mit negativem Betrag und wird automatisch als 'Rechnungskorrektur' bezeichnet; im Freitext 'Rechnungskorrektur zur Rechnung Nr. X vom TT.MM.JJJJ' angeben. Bei Debitoren dem Debitor zuweisen; bei Zahlung Rechnung UND Korrektur der Zahlung zuweisen (Thema gutschrift_verrechnen). Eine Gutschrift ist dagegen ein eigener Belegtyp.",
      "Dokumente umwandeln: Rechnung in Gutschrift, Angebot in Rechnung. Wiederkehrende Rechnung: die erste entsteht sofort, die nächste zum eingestellten Datum; Stoppen in 'Wiederkehrende Rechnungen'. Versand aus dem Account über die interne 'E-Mail für den Rechnungsversand' (Absender standardmäßig rechnungsversand@buchhaltungsbutler.de, eigene Absenderadresse möglich). Das Logo darf höchstens 20 MB groß sein. Jeder angelegte Kunde und Artikel wird für spätere Rechnungen gespeichert.",
    ],
    konnektor: [
      "create_invoice (draft, negativer Betrag = Korrektur, recurring_*), create_einvoice (e_invoice_id = Käuferreferenz/Leitweg-ID), create_invoice_correction (volle Korrektur einer Ausgangsrechnung); payment_reference nur für Amazon-Bestell-ID, PayPal- und Stripe-Transaktions-ID.",
    ],
  },
  {
    id: "kostenstellen",
    titel: "Kostenstellen und Projektverwaltung",
    quelle: "Projektverwaltung und Kostenstellen (11445076569885)",
    regeln: [
      "Die Projektverwaltung ist in die Kostenstellen integriert: eine Kostenstelle plus ein Freitextfeld für den Projektnamen. Aktivieren unter Einstellungen, Kostenstellen / Projektverwaltung, 'Kostenstellen nutzen'. Die Kostenstelle wird mit dem Buchungsvorschlag gespeichert und beim nächsten gleichen Geschäftsvorfall mit vorgeschlagen.",
      "Auswertung über den CSV-Export von BWA oder EÜR mit 'Nach Kostenstellen aufschlüsseln'; die Zuordnung steht auch im Export der Buchungssätze und Belege.",
      "SKR42 (Vereine): die Projektverwaltung ist aktiv, voreingestellt 1 Ideeller Bereich, 2 Vermögensverwaltung, 3 Zweckbetrieb, 4 Wirtschaftlicher Geschäftsbetrieb, 9 Sammelposten.",
      "Kostenstelle 2: Freitextfeld (Standort, Produkt, Dienstleistung), nach Aktivierung der Kostenstellen separat einschaltbar; wirkt im DATEV-Export, nicht in BWA/EÜR. In der Oberfläche nur ab 1.440 Pixel Breite sichtbar.",
    ],
    konnektor: ["list_cost_locations, manage_cost_location; Splitfelder cost_location und cost_location_two bei den Buchungstools."],
  },
  {
    id: "paket_und_limits",
    titel: "Paket, Belegkontingent und API-Zugang",
    quelle: "Einen Paketwechsel durchführen (11441670785949); Zusätzliche Belege buchen (11441898777757); Einrichtung der API-Schnittstelle (11468075328797); Übersicht: Einzelne Rechte der Standard Nutzerrollen (13110056377245)",
    regeln: [
      "Belegkontingent: 500 Belege pro Monat in allen Paketen, 1.000 bei E-Commerce Premium. Ein genutztes Kontingent erholt sich durch Löschen nicht (gelöschte Belege bleiben aus GoBD-Gründen). Zusätzliche Belege einmalig (30 Tage gültig) oder dauerhaft als Add-on in den Tarifinformationen. Ist das Limit erreicht, schlagen Uploads fehl.",
      "Pakete (Stand des Artikels): Light, Smart, Premium, Vereine, E-Commerce Smart, E-Commerce Premium; die Paketübersicht nennt 'API-Client' ausdrücklich bei E-Commerce Premium. Ob die API in den anderen Paketen freigeschaltet ist, geht aus dem Artikel nicht hervor: im Zweifel Tarifinformationen oder Support prüfen.",
      "API-Zugang einrichten: Einstellungen, 'Schnittstellen und API-Zugang' aktivieren (API Client, API Secret, API Key); das Recht 'Belegübertragung / Schnittstellen / API-Zugang' haben Admin, Steuerberater und Standardnutzer. Die Zahlungs-Abschnitte am Beleg brauchen das Privileg 'Alle Konten'.",
      "Upgrade wirkt sofort (Differenz sofort berechnet), Downgrade zum Ende des Abrechnungszeitraums; Monat- zu Jahresplan ist ein Upgrade. Die API ist auf 100 Anfragen pro Minute und Kunde begrenzt.",
    ],
    konnektor: ["Der Fehler 4 'customer not found or insufficient privileges' kann auf fehlende Rechte (Rolle, 'Alle Konten') oder einen nicht freigeschalteten API-Zugang hindeuten."],
  },
  {
    id: "bilanz_integritaet",
    titel: "Bilanz-Integritätsprobleme und Saldovorträge",
    quelle: "Bilanz: Integritätsprobleme beheben (11431862574109)",
    regeln: [
      "Integritätsprobleme heißen: Aktiv- und Passivseite der Bilanz stimmen nicht überein. Häufigste Ursache sind fehlende oder unvollständige EB-Werte oder fehlende Saldovorträge.",
      "Erstes Jahr mit BuchhaltungsButler: alle Eröffnungsbilanzwerte über das Konto Saldenvorträge Sachkonten (9000) erfassen (SuSa des Steuerberaters zum 01.01.). Der Saldo aller Buchungen auf 9000 muss in Summe 0 ergeben (jede Aktivseite braucht ihre Passivseite, z. B. Kassenbestand gegen Bankdarlehen oder Gewinnvortrag).",
      "Folgejahre: EB-Werte werden automatisch berechnet (Erlös- und Aufwandskonten werden genullt, Bilanzkonten fortgeschrieben). Manuell vorzutragen sind der Saldo der Umsatz- und Vorsteuerkonten (auf Umsatzsteuer Vorjahr 1790 | 3841) und der Gewinn-/Verlustvortrag (z. B. Gewinnvortrag 860 | 2970), sonst fehlt der Jahresüberschuss auf der Passivseite.",
      "Praxistipp: die SuSa des Steuerberaters zum 01.01. mit der von BuchhaltungsButler abgleichen und Differenzen gegen 9000 einbuchen. Stimmen alle Salden und nullt sich nur 9000 nicht, ist die Bilanz dennoch korrekt und man kann damit weiterarbeiten.",
    ],
    konnektor: ["add_free_postings gegen 9000 (vat 0_none), Saldo per get_account_ledger oder create_report (sums) prüfen; Details zu den Vorträgen in der Beschreibung von add_free_postings."],
  },
  {
    id: "zahlungen_probleme",
    titel: "Doppelte, fehlende und unvollständige Zahlungen",
    quelle: "Import von doppelten Zahlungen (11423965528605); Es fehlen vereinzelte Zahlungen (11423365749149); Die Zahlungsinformationen sind unvollständig (11423251653149); Kontoauszüge manuell importieren (11448205191197); Zahlungskonten über Kontostand berechnen plausibilisieren (11474253173021)",
    regeln: [
      "Doppelte Zahlungen entstehen typisch, wenn das Konto erneut verbunden wurde, ohne das richtige 'Importiere ab'-Datum zu setzen, oder wenn Daten per CSV importiert wurden, obwohl das Konto angebunden ist. Sicher doppelte Zahlungen lassen sich einzeln oder gesammelt löschen (Oberfläche); Bankabruf läuft über finAPI oder Qwist, Scraping kann nicht zu 100 % richtig sein: der Abgleich mit dem Kontoauszug bleibt geboten.",
      "Fehlende Zahlungen: gelöschte Zahlungen werden NICHT erneut abgerufen. Sie lassen sich als manuelle Zahlung oder per CSV wieder anlegen. Fehlen die Zahlungen der letzten Tage, liegt eher ein Abrufproblem vor.",
      "Unvollständige Zahlungen (nur Datum und Betrag, ohne Gegenpartei und Verwendungszweck) sind ein Fall für den Support. Für Support-Fälle zur Bankanbindung (Kategorie 'Frage zur Bankenanbindung') braucht BuchhaltungsButler: System-E-Mail des Accounts, Schnittstelle (finAPI/Qwist), Bank mit BIC, letzte 4 Ziffern der IBAN, betroffenen Zeitraum, Screenshots.",
      "Abgleich: Kontostand berechnen (Abschluss) zum Stichtag mit dem Online-Banking vergleichen; bei größeren Abweichungen auch den Anfangsbestand prüfen.",
      "CSV-Import von Kontoauszügen: Pflichtfelder Empfänger/Zahlungspflichtiger, Betrag (eine Spalte, Ausgänge negativ; 0,00 € entfernen), Buchungsdatum TT.MM.JJJJ. Optional IBAN, BIC, Institut, Wertstellung, Währung (bei Fremdwährung nötig), Verwendungszweck (höchstens 500 Zeichen, für das Matching empfohlen), Auftragsart, Buchungstext, Zahlungsreferenz (für PayPal/Amazon/eBay nötig).",
    ],
    konnektor: [
      "calculate_account_balance mit statement_balance; create_transactions prüft Betrag ungleich 0 und Verwendungszweck bis 500 Zeichen vorab; auf angebundenen Konten keine Zahlungen von Hand anlegen.",
    ],
  },
];

const BOOKING_TOPICS = BOOKING_GUIDE.map((e) => e.id) as [string, ...string[]];

export function findBookingGuide(topic: string): BookingGuideEntry | undefined {
  return BOOKING_GUIDE.find((e) => e.id === topic);
}

export function createBookingGuideTools(): [ToolDef] {
  const getBookingGuide = defineTool({
    name: "get_booking_guide",
    description:
      "Kontierungshilfe für buchhalterische Sonderfälle in BuchhaltungsButler, aus dessen Wissensdatenbank (kein API-Aufruf, " +
      "keine Steuerberatung): Regeln, Konten (SKR03 | SKR04), Beispielbuchungen und Fallstricke. Ohne topic kommt die " +
      "Themenliste, mit topic der volle Eintrag. Vor dem Buchen aufrufen bei: Abschreibung, Rechnungsabgrenzung (rap), Auslagen/" +
      "Privateinlagen, Ist-Versteuerer mit Debitoren, Differenzbesteuerung, Amazon, 5,5 %/10,7 %, Gutschrift verrechnen, " +
      "Skonto, Dreiecksgeschäft, EU-Neufahrzeug, Geldtransit (Kasse/Bank/PayPal/Kreditkarte), Prepaid-Guthaben, Lohn, " +
      "Mehrwertsteuersenkung 2020, Storno/Rücklastschrift, Trinkgeld, Split/Saldierung, OSS, Umsatzsteuer in anderem Land, " +
      "Fremdwährung, Investitionsabzugsbetrag. Außerdem Verfahren und Best Practices: erste_schritte (Bilanzierer vs. EÜR), wechsel_zu_bhb (Typen A-E, Anfangsbestände, Lexware-Export), monatsabschluss (siehe check_month_end), automatisierungsregeln, bedienung_shortcuts, buchungsvormerkung_eur, ausgangsrechnung_kasse. Weitere Verfahren und Regeln: festgeschriebene_loeschen, belege_upload_matching, eigenbeleg, debitoren_kreditoren_logik, ust_va_zm, auswertungen, konten_einrichtung, einstellungen_aendern, rechnungen_erstellen, kostenstellen, paket_und_limits, bilanz_integritaet, zahlungen_probleme. Anlagevermögen erfassen: anlagen_browser (Ablauf in der Weboberfläche, kein API-Weg). Belege prüfen und Belegdaten korrigieren: belegpruefung (nur Weboberfläche, kein API-Weg). Jeder Eintrag ist vor dem Buchen mit dem Steuerberater abzustimmen, wenn der " +
      "Fall nicht eindeutig ist; Kontonummern ohne SKR04-Angabe per list_posting_accounts nachschlagen.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      topic: z.enum(BOOKING_TOPICS).optional().describe("Thema-ID; ohne Angabe wird die Themenliste geliefert."),
    },
    async handler(args) {
      if (args.topic === undefined) {
        return ok({ themen: BOOKING_GUIDE.map((e) => ({ topic: e.id, titel: e.titel })) });
      }
      const entry = findBookingGuide(args.topic);
      if (!entry) throw new Error(`Unbekanntes Thema "${args.topic}".`);
      return ok(entry);
    },
  });
  return [getBookingGuide];
}
