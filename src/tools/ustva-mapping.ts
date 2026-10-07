import { z } from "zod";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// Zuordnung von Buchungskonten zu den Positionen (Kennziffern) der Umsatzsteuer-Voranmeldung nach BuchhaltungsButlers
// Artikel "Buchungskonten den Kennziffern der USt.-VA zuordnen" (11472964130461, gilt ab Veranlagungszeitraum 2019;
// BHB richtet sich nach der DATEV-Kontenrahmenbeschreibung). Die Konto-Tabelle ist maschinell aus dem Artikel
// übernommen (95 Zeilen), nicht von Hand getippt. Die USt-VA selbst gibt es nur in der BHB-Oberfläche, nicht per API:
// das Tool sagt vorher, wo eine Buchung landen wird.

// [SKR03, SKR04, Kontoname, Kennziffer]
export const UST_VA_ACCOUNTS: ReadonlyArray<readonly [number, number, string, number]> = [
  [8336, 4336, "Umsätze/Erlöse Dienstleistungen EU mit Steuerschuldumkehr nach §13b", 21],
  [8742, 4742, "Gewährte Skonti Dienstleistungen EU mit Steuerschuldumkehr nach §13b", 21],
  [1773, 3803, "Umsatzsteuer 5%", 35],
  [1775, 3805, "Umsatzsteuer 16%", 35],
  [1770, 3800, "Umsatzsteuer (andere Steuersätze, nicht 7% u. 19%)", 36],
  [1781, 3830, "Umsatzsteuer – Vorauszahlungen 1/11 für Dauerfristverlängerung", 39],
  [2402, 6932, "Forderungsverluste aus steuerfreien EG-Lieferungen", 41],
  [8125, 4125, "Umsätze/Erlöse Lieferungen an Unternehmen in der EU (innerg. Lieferung, steuerfrei nach §4 Nr. 1b UStG)", 41],
  [8724, 4724, "Erlösschmälerungen EU-Lieferungen steuerfrei", 41],
  [8743, 4743, "Gewährte Skonti aus steuerfreien EU Lieferungen § 4, 1b UStG", 41],
  [8808, 6888, "Erlöse Sachanlageverkäufe EU, § 4 Nr. 1b UStG (bei Buchverlust)", 41],
  [8828, 4828, "Erlöse aus Verkäufen Sachanlagevermögen EU, § 4 Nr. 1b UStG (Buchgewinn)", 41],
  [8130, 4130, "Umsätze aus Lieferung des ersten Abnehmers bei Innergemeinschaftlichen Dreiecksgeschäften § 25b Abs. 2 UStG", 42],
  [8706, 4706, "Erlösschmälerungen Lieferung erster Abnehmer, steuerfreie innergemeinschaftliche Dreiecksgeschäfte, § 25b Abs. 2, 4 UStG", 42],
  [8120, 4120, "Umsätze/Erlöse Lieferungen nach Drittland (Ausfuhrlieferung, § 4 Nr. 1a UStG)", 43],
  [8140, 4140, "Steuerfreie Umsätze Offshore usw.", 43],
  [8150, 4150, "Sonstige steuerfreie Umsätze (§ 4 Nr. 2-7 UStG)", 43],
  [8194, 4139, "Umsatzerlöse aus Reiseleistungen § 25 Abs. 2 UStG, steuerfrei", 43],
  [8515, 4565, "Provisionsumsätze, steuerfrei § 4 Nr. 5 UStG", 43],
  [8575, 4575, "Sonstige Erträge aus Provisionen, Lizenzen und Patenten, steuerfrei (§ 4 Nr. 5 UStG)", 43],
  [8625, 4842, "Sonstige Erlöse betrieblich und regelmäßig, steuerfrei (§ 4 Nr. 2-7 UStG)", 43],
  [8702, 4702, "Erlösschmälerungen für steuerfreie Umsätze nach § 4 Nr. 2-7 UStG", 43],
  [8704, 4704, "Erlösschmälerungen für sonstige steuerfreie Umsätze mit Vorsteuerabzug", 43],
  [8705, 4705, "Erlösschmälerungen steuerfreie Ausfuhrlieferungen, § 4 Nr. 1a UStG", 43],
  [8807, 6884, "Erlöse Sachanlagenverkäufe Drittland, § 4 Nr. 1a UStG (Buchverlust)", 43],
  [8827, 4844, "Erlöse aus Verkäufen Sachanlagevermögen Drittland, § 4 Nr. 1a UStG (Buchgewinn)", 43],
  [8135, 4135, "Steuerfreie EG Lieferung von Neufahrzeugen o. USt-ID-Nr.", 44],
  [8320, 4320, "Umsätze/Erlöse Lieferungen an Privat im anderen EU Land steuerpflichtig", 45],
  [8331, 4331, "Erlöse aus im anderen EU-Land steuerpfl. elektronischen Dienstleistungen", 45],
  [8338, 4338, "Umsätze/Erlöse Dienstleistungen im Drittland steuerbar", 45],
  [8339, 4339, "Umsätze/Erlöse Dienstleistungen im anderen EU-Land steuerbar, im Inland nicht steuerbar", 45],
  [1785, 3835, "Umsatzsteuer nach § 13 b UStG", 46],
  [1787, 3837, "Umsatzsteuer nach § 13 b UStG mit VSt-Abzug 19%", 46],
  [9336, 9336, "Umsatzsteuer nach § 13 b UStG ohne VSt-Abzug 16%", 46],
  [2751, 4861, "Erlöse aus Vermietung und Verpachtung, umsatzsteuerfrei § 4 Nr. 12 UStG", 48],
  [8100, 4100, "Umsätze steuerfrei, §4 Nr.8 ff. UStG (Kredit-& Versicherungsverm.)", 48],
  [8105, 4105, "Steuerfreie Umsätze nach § 4 Nr. 12 UStG (Vermietung und Verpachtung)", 48],
  [8110, 4110, "Sonstige steuerfreie Umsätze Inland", 48],
  [8160, 4160, "Steuerfreie Umsätze ohne Vorsteuerabzug zum Gesamtumsatz gehörend, § 4 UStG", 48],
  [8165, 4165, "Steuerfreie Umsätze ohne Vorsteuerabzug zum Gesamtumsatz gehörend", 48],
  [8514, 4564, "Provisionsumsätze, steuerfrei § 4 Nr. 8 ff. UStG(Kredit-& Versicherungsverm.)", 48],
  [8574, 4574, "Sonstige Erträge aus Provisionen, Lizenzen und Patenten, steuerfrei(§ 4 Nr. 8 ff. UStG)", 48],
  [8609, 4841, "Sonstige Erlöse betrieblich und regelmäßig, steuerfrei (§ 4 Nr. 8 ff. UStG)", 48],
  [8701, 4701, "Erlösschmälerungen für steuerfreie Umsätze nach § 4 Nr. 8 ff. UStG", 48],
  [8703, 4703, "Erlösschmälerungen für sonstige steuerfreie Umsätze ohne Vorsteuerabzug", 48],
  [8851, 4866, "Erlöse aus Verkäufen von Wirtschaftsgütern des Umlaufvermögens, umsatzsteuerfrei § 4 Nr. 8 ff. UStG i. V. m. § 4 Abs. 3 Satz 4 EStG", 48],
  [8852, 4867, "Erlöse aus Verkäufen von Wirtschaftsgütern des Umlaufvermögens, umsatzsteuerfrei § 4 Nr. 8 ff. UStG i. V. m. § 4 Abs. 3 Satz 4 EStG, § 3 Nr. 40 EStG/§ 8b Abs. 2 KStG", 48],
  [8335, 4335, "Erlöse aus Lieferung Mobilfunkgeräte / Schaltkreise nach § 13b UStG", 60],
  [8337, 4337, "Umsätze/Erlöse Dienstleistungen DE mit Steuerschuldumkehr nach §13b", 60],
  [8738, 4738, "Gewährte Skonti Lieferung Mobilfunkgeräte/Schaltkreise nach § 13b UStG", 60],
  [8741, 4741, "Gewährte Skonti Dienstleistungen DE mit Steuerschuldumkehr nach §13b", 60],
  [1572, 1402, "Abziehbare Vorsteuer 7% innergem. Erwerb", 61],
  [1574, 1404, "Abziehbare Vorsteuer 19% innergem. Erwerb", 61],
  [1584, 1432, "Abziehbare Vorsteuer aus EG-Erwerb von Neufahrzeugen von Lieferanten ohne USt.-ID", 61],
  [1589, 9304, "Abziehbare Vorsteuer 16% aus innergem. Erwerb", 61],
  [9303, 9303, "Abziehbare Vorsteuer 5% aus innergem. Erwerb", 61],
  [1588, 1433, "Bezahlte Einfuhrumsatzsteuer", 62],
  [1587, 1484, "Vorsteuer nach allgemeinen Durchschnittssätzen UStVA Kz. 63", 63],
  [1528, 1376, "Nachträglich abziehbare Vorsteuer, § 15a Abs. 2 UStG", 64],
  [1529, 1377, "Zurückzuzahlende Vorsteuer, § 15a Abs. 2 UStG", 64],
  [1556, 1396, "Nachträglich abziehbare Vorsteuer, bewegliche Wirtschaftsgüter", 64],
  [1557, 1397, "Zurückzuzahlende Vorsteuer, bewegliche Wirtschaftsgüter", 64],
  [1558, 1398, "Nachträglich abziehbare Vorsteuer, unbewegl. Wirtschaftsgüter", 64],
  [1559, 1399, "Zurückzuzahlende Vorsteuer, unbewegl. Wirtschaftsgüter", 64],
  [1782, 3832, "Nachsteuer (KZ. 65)", 65],
  [1568, 1403, "Abziehbare Vorsteuer 5%", 66],
  [1570, 1400, "Abziehbare Vorsteuer", 66],
  [1571, 1401, "Abziehbare Vorsteuer 7%", 66],
  [1573, 1436, "Vorsteuer aus Erwerb als letzter Abnehmer innerhalb eines Dreiecksgeschäfts", 66],
  [1575, 1405, "Abziehbare Vorsteuer 16%", 66],
  [1576, 1406, "Abziehbare Vorsteuer 19%", 66],
  [1577, 1407, "Abziehbare Vorsteuer § 13b UStG 19%", 67],
  [1578, 1408, "Abziehbare Vorsteuer § 13b UStG", 67],
  [1579, 1409, "Abziehbare Vorsteuer § 13b UStG 16%", 67],
  [1769, 3839, "Umsatzsteuer aus der Auslagerung von Gegenständen aus einem Umsatzsteuerlager", 69],
  [1783, 3851, "Unrichtig oder unberechtigt ausgewiesene Umsatzsteuer (Kz. 69)", 69],
  [1794, 3819, "Umsatzsteuer aus Erwerb als letzter Abnehmer innerhalb eines Dreiecksgeschäfts", 69],
  [3553, 5553, "Erwerb Waren letzter Abnehmer Dreiecksgeschäft 19/16% VSt und 19/16% USt", 69],
  [8190, 4180, "Erlöse gemäß § 24 UStG", 76],
  [1776, 3806, "Umsatzsteuer 19%", 81],
  [3120, 5920, "Bauleistungen eines im Inland ansässigen Unternehmers 19/16% Vorsteuer und 19/16% Umsatzsteuer", 84],
  [3125, 5925, "Leistungen eines im Drittland ansässigen Unternehmers 19/16% VSt. und 19/16% USt.", 84],
  [3145, 5945, "Leistungen eines im Drittland ansässigen Unternehmers ohne Vorsteuer und 19/16% Umsatzsteuer", 84],
  [1771, 3801, "Umsatzsteuer 7%", 86],
  [1774, 3804, "Umsatzsteuer 19% innergem. Erwerb", 89],
  [1779, 3809, "Umsatzsteuer 19% innergem. Erwerb ohne VSt.-Abzug", 89],
  [3550, 5550, "Steuerfreier innergemeinschaftlicher Erwerb", 90],
  [1772, 3802, "Umsatzsteuer 7% innergem. Erwerb", 93],
  [9314, 9314, "Umsatzsteuer 7% innergem. Erwerb ohne VSt.-Abzug", 93],
  [3440, 5440, "EU-Erwerb von Neufahrzeugen 19/16% Vorsteuer und 19/16% Umsatzsteuer Lieferanten ohne USt.-ID", 94],
  [1786, 3836, "Umsatzsteuer aus innergemeinschaftlichem Erwerb 16 %", 95],
  [9313, 9313, "Umsatzsteuer 5% innergem. Erwerb", 95],
  [9333, 9333, "Umsatzsteuer 5% innergem. Erwerb ohne VSt.-Abzug", 95],
  [9334, 9334, "Umsatzsteuer 16% innergem. Erwerb ohne VSt.-Abzug", 95],
  [1784, 3834, "Umsatzsteuer aus EU-Erwerb von Neufahrzeugen von Lieferanten ohne USt.-ID", 96],
];

// Buchungen MIT Steuerschlüssel werden nach dem Steuersatz geschlüsselt, unabhängig vom Konto. Der Umsatz wird aus der
// gebuchten Steuer zurückgerechnet und abgerundet; deshalb lassen sich Umsatzsteuerkonten nicht direkt bebuchen.
export const UST_VA_BY_RATE: ReadonlyArray<{ schluessel: string; position: string }> = [
  { schluessel: "19% USt.", position: "Kz 81" },
  { schluessel: "7% USt.", position: "Kz 86" },
  { schluessel: "i.g.E. 19% USt./VSt.", position: "Kz 89 (USt.) und Kz 61 (VSt.)" },
  { schluessel: "i.g.E. 7% USt./VSt.", position: "Kz 93 (USt.) und Kz 61 (VSt.)" },
  { schluessel: "19% VSt.", position: "Kz 66" },
  { schluessel: "7% VSt.", position: "Kz 66" },
  { schluessel: "§13b 19% USt./VSt.", position: "Kz 46 (USt.) und Kz 67 (VSt.); ein anderes Konto kann ein anderes Mapping auslösen" },
];

export interface UstVaMatch {
  skr03: number;
  skr04: number;
  kontoname: string;
  kennziffer: number;
  treffer: "SKR03" | "SKR04" | "Kennziffer" | "Name";
}

const toMatch = (r: readonly [number, number, string, number], treffer: UstVaMatch["treffer"]): UstVaMatch => ({
  skr03: r[0],
  skr04: r[1],
  kontoname: r[2],
  kennziffer: r[3],
  treffer,
});

// Eine Kontonummer kann in SKR03 und SKR04 vorkommen (z. B. 9303); beide Treffer werden gemeldet, der Kontenrahmen des
// Mandanten entscheidet. Die Tabelle gilt nur für Konten, die eine feste Position auslösen.
export function lookupUstVa(q: { account?: number; kennziffer?: number; search?: string }): UstVaMatch[] {
  const out: UstVaMatch[] = [];
  for (const r of UST_VA_ACCOUNTS) {
    if (q.account !== undefined) {
      if (r[0] === q.account) out.push(toMatch(r, "SKR03"));
      if (r[1] === q.account && r[1] !== r[0]) out.push(toMatch(r, "SKR04"));
      if (r[1] === q.account && r[1] === r[0]) out.push(toMatch(r, "SKR03"));
    } else if (q.kennziffer !== undefined) {
      if (r[3] === q.kennziffer) out.push(toMatch(r, "Kennziffer"));
    } else if (q.search !== undefined && r[2].toLowerCase().includes(q.search.toLowerCase())) {
      out.push(toMatch(r, "Name"));
    }
  }
  return out;
}

export function createUstVaTools(): [ToolDef] {
  const getUstVaPosition = defineTool({
    name: "get_ustva_position",
    description:
      "Nachschlagen, in welcher Position (Kennziffer) der Umsatzsteuer-Voranmeldung eine Buchung auf einem Konto landet - " +
      "vor dem Buchen, denn die USt-VA gibt es nur in der BuchhaltungsButler-Oberfläche (Abschluss), nicht per API. Kein " +
      "API-Aufruf. Genau einen von account (SKR03- oder SKR04-Nummer), kennziffer (alle Konten dieser Position) oder " +
      "search (Teil des Kontonamens) angeben; ohne Angabe kommen die Regeln nach Steuerschlüssel. Die Tabelle gilt nur " +
      "für Konten, die eine feste Position auslösen; Buchungen mit Steuerschlüssel werden nach dem Steuersatz geschlüsselt " +
      "(Umsatz aus der Steuer zurückgerechnet und abgerundet), unabhängig vom Konto. Eine Nummer kann in beiden " +
      "Kontenrahmen vorkommen: das Feld treffer zeigt, welche Spalte passte. Die Zuordnung eines Kontos zu einer " +
      "Kennziffer lässt sich in BuchhaltungsButler nicht ändern. Quelle: BHB-Artikel zur Zuordnung (Stand der " +
      "Wissensdatenbank, ab Veranlagungszeitraum 2019); im Zweifel die USt-VA-Vorschau in der Oberfläche prüfen.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      account: z.number().int().optional().describe("Kontonummer (SKR03 oder SKR04)."),
      kennziffer: z.number().int().optional().describe("Kennziffer der USt-VA, z. B. 81."),
      search: z.string().optional().describe("Teil des Kontonamens, z. B. 'Dreiecksgeschäft'."),
    },
    async handler(args) {
      const given = [args.account, args.kennziffer, args.search].filter((v) => v !== undefined);
      if (given.length > 1) throw new Error("Nur eines von account, kennziffer oder search angeben.");
      if (given.length === 0) return ok({ nach_steuerschluessel: UST_VA_BY_RATE });
      const treffer = lookupUstVa(args);
      return ok({
        treffer,
        ...(treffer.length === 0
          ? {
              hinweis:
                "Kein Konto mit fester Position gefunden. Das heißt: eine Buchung auf diesem Konto wird nach ihrem Steuerschlüssel " +
                "geschlüsselt (siehe get_ustva_position ohne Parameter) oder gar nicht in die USt-VA übernommen.",
            }
          : {}),
        ...(args.account !== undefined && treffer.length > 1 ? { hinweis: "Die Nummer kommt in mehreren Kontenrahmen vor: der des Mandanten gilt." } : {}),
      });
    },
  });
  return [getUstVaPosition];
}
