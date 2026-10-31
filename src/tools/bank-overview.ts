import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { attachPostingStatus } from "./posting-status.js";
import { fetchLedger, type Buchung } from "./controlling.js";
import { createReportRunner, type RunnerOptions } from "./report-runner.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";
import { finishWithExport } from "./export-file.js";

// Banken-Übersicht fürs Controlling: was liegt auf welchem Zahlungskonto, was war im Zeitraum los und was ist noch nicht
// erklärt. Zwei Stände je Konto, weil sie Verschiedenes sagen:
//   Buchsaldo     = Saldo des Kontos in der Summen- und Saldenliste (nur gebuchte Zahlungen)
//   Zahlungssaldo = Summe aller Zahlungen des Kontos bis zum Stichtag, ob gebucht oder nicht (wie 'Kontostand berechnen')
// Die Differenz sind Zahlungen, die noch nicht gebucht sind. Zusätzlich: Buchungen auf dem Interimskonto
// "Kontierung nicht bekannt", also gebucht, aber noch nicht zugeordnet.

type Row = Record<string, unknown>;
const r2 = (n: number) => Math.round(n * 100) / 100;

interface SumsEntry {
  postingaccount?: { class?: string; type?: string; name?: string };
  balanceAfterAbsolute?: number;
  balanceAfterSide?: string;
}
interface Sums {
  sums?: Record<string, SumsEntry>;
  integrityError?: boolean;
}
const signed = (e: SumsEntry) => (e.balanceAfterSide === "credit" ? -1 : 1) * (e.balanceAfterAbsolute ?? 0);

const art = (type: string | undefined) => (type === "cash" ? "kasse" : type === "bank/institution" ? "bank" : "sonstiges");

async function allTransactions(client: BBClient, account: number, dateTo: string): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  for (let i = 0; i < 20; i++) {
    const res = await client.call<BBListResult>("transactionsGet", { account, date_to: dateTo, limit: 500, offset: i * 500 });
    rows.push(...(res.data ?? []));
    if ((res.data ?? []).length < 500) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

// Durchlaufende Posten und Geldtransit müssen sich ausgleichen. Zwei Stufen, beide ohne Betragsgrenze:
//  1. Paare: eine Buchung im Soll hat eine Gegenbuchung gleichen Betrags im Haben (zurückgebuchte Lastschrift, Umbuchung). Gepaart
//     wird nach Betrag, die älteste zuerst.
//  2. Gruppen: was danach am selben Tag übrig ist und zusammen null ergibt (ein Einkauf, der auf mehrere Buchungen verteilt und
//     wieder ausgeglichen wurde), gleicht sich ebenfalls aus. Je Tag wird die größte Teilmenge mit Summe null gesucht, bis keine
//     mehr da ist (bis 16 Buchungen je Tag, darüber bleibt der Tag unverändert).
// Was übrig bleibt, hat keine Gegenbuchung. Beträge im Soll positiv, im Haben negativ.
const cents = (b: Buchung) => Math.round(b.betrag * 100);

function zeroSumSubset(rows: Buchung[]): Buchung[] | null {
  const n = rows.length;
  if (n < 2 || n > 16) return null;
  const c = rows.map(cents);
  let best = 0;
  let bestMask = 0;
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0;
    let size = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { sum += c[i]; size++; }
    if (sum === 0 && size > best) { best = size; bestMask = mask; }
  }
  return best === 0 ? null : rows.filter((_, i) => bestMask & (1 << i));
}

export function pairOff(rows: Buchung[]): { paare: number; gruppen: number; offen: Buchung[] } {
  const sorted = [...rows].filter((r) => r.betrag !== 0).sort((a, b) => a.datum.localeCompare(b.datum) || a.id - b.id);
  const open = new Map<number, Buchung[]>();
  let paare = 0;
  for (const r of sorted) {
    const key = Math.abs(cents(r));
    const list = open.get(key) ?? [];
    const i = list.findIndex((x) => Math.sign(x.betrag) !== Math.sign(r.betrag));
    if (i >= 0) {
      list.splice(i, 1);
      paare++;
    } else list.push(r);
    open.set(key, list);
  }
  const byDay = new Map<string, Buchung[]>();
  for (const r of [...open.values()].flat()) byDay.set(r.datum, [...(byDay.get(r.datum) ?? []), r]);
  let gruppen = 0;
  const offen: Buchung[] = [];
  for (const day of byDay.values()) {
    let rest = day;
    for (let sub = zeroSumSubset(rest); sub !== null; sub = zeroSumSubset(rest)) {
      gruppen++;
      rest = rest.filter((x) => !sub.includes(x));
    }
    offen.push(...rest);
  }
  offen.sort((a, b) => a.datum.localeCompare(b.datum) || a.id - b.id);
  return { paare, gruppen, offen };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function createBankOverviewTools(client: BBClient, opts: RunnerOptions = {}): [ToolDef] {
  const runReport = createReportRunner(client, { pollMs: 4000, ...opts });

  const getBankOverview = defineTool({
    name: "get_bank_overview",
    description:
      "Banken-Übersicht fürs Controlling: je Zahlungskonto (Bank, Kasse, Darlehens- und Verrechnungskonten) der gebuchte Stand (Summen- und " +
      "Saldenliste), der Zahlungsstand (alle Zahlungen, ob gebucht oder nicht), die Differenz, die Umsätze im Zeitraum (Ein- und " +
      "Auszahlungen), alle Zahlungen des Zeitraums je Konto mit Buchungsstatus und Gegenkonten (zahlungen; with_payments: false lässt sie weg), die noch nicht gebuchten Zahlungen einzeln und die Prüfung, ob durchlaufende Posten und Geldtransit ausgeglichen sind (Saldo, gepaarte und offene Buchungen). " +
      "Fragt der Nutzer, was auf welchem Konto liegt, ob Zahlungen offen oder unerklärt sind, dieses Tool aufrufen und als Artefakt " +
      "darstellen. Es erzeugt eine Summen- und Saldenliste und ERSETZT damit die zuletzt in BHB erzeugte. Bei angebundenen Bankkonten " +
      "zeigt die Oberfläche den von der Bank gemeldeten Stand, der kann vom Zahlungsstand abweichen. Teil des Standard-Controlling-Artefakts (get_booking_guide controlling_artefakt). as_of und date_from als YYYY-MM-DD.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      as_of: z.string().optional().describe("YYYY-MM-DD, Stichtag der Stände. Standard: heute."),
      date_from: z.string().optional().describe("YYYY-MM-DD, Beginn des Umsatzzeitraums. Standard: 1. Januar des Jahres von as_of."),
      with_payments: z.boolean().optional().describe("Alle Zahlungen des Zeitraums je Konto mitliefern (zahlungen: Datum, Betrag, Gegenpartei, Zweck, gebucht, Gegenkonten), Standard true. false liefert nur die nicht gebuchten."),
      save_as: z.string().optional().describe("Dateiname (ohne Pfad): das volle Ergebnis wird als JSON unter ~/.mcp-buchhaltungsbutler/exports/ gespeichert und nur eine Kurzfassung zurückgegeben. Für Artefakte und große Auswertungen."),
    },
    async handler(args) {
      const asOf = args.as_of ?? new Date().toISOString().slice(0, 10);
      if (!ISO.test(asOf)) throw new Error(`as_of "${asOf}" ist nicht im Format YYYY-MM-DD.`);
      const from = args.date_from ?? `${asOf.slice(0, 4)}-01-01`;
      if (!ISO.test(from)) throw new Error(`date_from "${from}" ist nicht im Format YYYY-MM-DD.`);
      if (from > asOf) throw new Error("date_from liegt nach as_of.");

      const accounts = (await client.call<BBListResult>("accountsGet", {})).data ?? [];
      const sums = await runReport<Sums>("sums", { from: `${asOf.slice(0, 4)}-01-01`, to: asOf });
      const entries = sums.sums ?? {};

      const warnings: string[] = [];
      if (sums.integrityError) warnings.push("BHB meldet einen Integritätsfehler in der Summen- und Saldenliste; Zahlen nicht verwenden, bis er geklärt ist.");

      const perAccount: Array<{ nummer: number; name: string; rows: Row[] }> = [];
      for (const a of accounts) {
        const nummer = Number(a.postingaccount_number);
        const t = await allTransactions(client, nummer, asOf);
        if (t.truncated) warnings.push(`Konto ${nummer}: Zahlungen nach 20 Seiten abgebrochen, Zahlungsstand unvollständig.`);
        perAccount.push({ nummer, name: String(a.name ?? ""), rows: t.rows });
      }

      // Buchungsstatus der Zahlungen im Zeitraum, in einem Durchgang für alle Konten
      const inRange = perAccount.flatMap((a) => a.rows.filter((r) => String(r.booking_date ?? "").slice(0, 10) >= from).map((r) => ({ ...r, _konto: a.nummer })));
      const status = await attachPostingStatus(client, inRange);
      if (status.truncated) warnings.push("Buchungsstatus: Abfrage der Buchungen nach 10 Seiten abgebrochen, nicht gebuchte Zahlungen können unvollständig sein.");
      const open = status.rows.filter((r) => (r.posting_status as { booked: boolean | null }).booked === false);

      const konten = perAccount.map((a) => {
        const e = entries[String(a.nummer)];
        const buch = e ? r2(signed(e)) : 0;
        const zahl = r2(a.rows.reduce((t, r) => t + (Number(r.amount) || 0), 0));
        const range = a.rows.filter((r) => String(r.booking_date ?? "").slice(0, 10) >= from);
        const nicht = open.filter((r) => r._konto === a.nummer);
        return {
          nummer: a.nummer,
          name: a.name,
          art: art(e?.postingaccount?.type),
          buchsaldo: buch,
          zahlungssaldo: zahl,
          differenz: r2(zahl - buch),
          einzahlungen: r2(range.filter((r) => Number(r.amount) > 0).reduce((t, r) => t + Number(r.amount), 0)),
          auszahlungen: r2(range.filter((r) => Number(r.amount) < 0).reduce((t, r) => t - Number(r.amount), 0)),
          anzahl_zahlungen: range.length,
          nicht_gebucht_anzahl: nicht.length,
          nicht_gebucht_summe: r2(nicht.reduce((t, r) => t + (Number(r.amount) || 0), 0)),
        };
      });

      const zeile = (r: Row) => ({
        konto: Number(r._konto),
        id: Number(r.id_by_customer),
        datum: String(r.booking_date ?? "").slice(0, 10),
        betrag: r2(Number(r.amount)),
        gegenpartei: String(r.to_from ?? ""),
        zweck: String(r.purpose ?? "").split("\n")[0].slice(0, 140),
      });
      const nichtGebucht = open.map(zeile).sort((a, b) => b.datum.localeCompare(a.datum) || a.konto - b.konto);

      // Alle Zahlungen des Zeitraums mit Buchungsstatus und Gegenkonten (die Seite der Buchung, die nicht das Zahlungskonto ist).
      const kontoName = (nr: string) => entries[nr]?.postingaccount?.name ?? "";
      const zahlungen =
        args.with_payments === false
          ? []
          : status.rows
              .map((r) => {
                const ps = status.postings.get(String(r.id_by_customer)) ?? [];
                const eigenes = String(r._konto);
                const gegen = [...new Set(ps.map((p) => (String(p.debit_postingaccount_number) === eigenes ? String(p.credit_postingaccount_number) : String(p.debit_postingaccount_number))))];
                const st = r.posting_status as { booked: boolean | null; fixed: boolean };
                return { ...zeile(r), gebucht: st.booked, festgeschrieben: st.fixed, gegenkonten: gegen.map((nr) => ({ nummer: Number(nr), name: kontoName(nr) })) };
              })
              .sort((a, b) => a.konto - b.konto || b.datum.localeCompare(a.datum) || b.id - a.id);

      // Durchlaufende Posten und Geldtransit: alle Interimskonten mit Bewegung oder Saldo, mit dem, was sich nicht ausgleicht
      const durchlaufend: Array<{ konto: number; name: string; art: string; saldo: number; ausgeglichen: boolean; buchungen_anzahl: number; paare: number; gruppen: number; offen: Buchung[] }> = [];
      for (const [nr, e] of Object.entries(entries)) {
        if (e.postingaccount?.class !== "Interimskonto") continue;
        const buchungen = await fetchLedger(client, Number(nr), "debit", { from, to: asOf });
        const saldo = r2(signed(e));
        if (buchungen.length === 0 && saldo === 0) continue;
        const { paare, gruppen, offen } = pairOff(buchungen);
        durchlaufend.push({
          konto: Number(nr),
          name: e.postingaccount?.name ?? "",
          art: /geldtransit/i.test(e.postingaccount?.name ?? "") ? "geldtransit" : "durchlaufende_posten",
          saldo,
          ausgeglichen: saldo === 0,
          buchungen_anzahl: buchungen.length,
          paare,
          gruppen,
          offen,
        });
      }

      const sum = (f: (k: (typeof konten)[number]) => number) => r2(konten.reduce((t, k) => t + f(k), 0));
      return finishWithExport(args.save_as, {
        as_of: asOf,
        date_from: from,
        konten,
        summe: {
          buchsaldo: sum((k) => k.buchsaldo),
          zahlungssaldo: sum((k) => k.zahlungssaldo),
          differenz: sum((k) => k.differenz),
          einzahlungen: sum((k) => k.einzahlungen),
          auszahlungen: sum((k) => k.auszahlungen),
          nicht_gebucht_anzahl: nichtGebucht.length,
        },
        nicht_gebuchte_zahlungen: nichtGebucht,
        zahlungen,
        durchlaufende_posten: durchlaufend,
        durchlaufende_ausgeglichen: durchlaufend.every((d) => d.ausgeglichen),
        hinweise: [
          "Buchsaldo = Saldo in der Summen- und Saldenliste (nur gebuchte Zahlungen). Zahlungssaldo = Summe aller Zahlungen bis zum Stichtag, auch ungebuchter; ohne eingetragenen Anfangsbestand stimmt nur die Veränderung. Die Differenz sind Zahlungen, die noch nicht gebucht sind.",
          "Darlehens- und Verrechnungskonten stehen als Konten der Klasse Finanzkonto mit in der Liste (art: sonstiges); ihr Saldo zählt in BHB zum Cash-Bestand.",
          "Bei angebundenen Bank- und Kreditkartenkonten zeigt die BHB-Oberfläche den von der Bank gemeldeten Stand, nicht den hier berechneten.",
          "Durchlaufende Posten und Geldtransit (Interimskonten): der Saldo muss 0 sein. paare sind Buchungen mit gleich hoher Gegenbuchung (zurückgebuchte Lastschrift, Umbuchung), gruppen sind Buchungen eines Tages, die zusammen null ergeben (ein auf mehrere Buchungen verteilter Einkauf), offen sind Buchungen ohne Ausgleich im Zeitraum. Der Saldo gilt zum Stichtag, die Buchungen für den Zeitraum ab date_from. Beträge zur Sollseite (Haben negativ). Ein Posten mit Kennzeichen 'kein Beleg' ist gewollt gebucht und kein offener Fall.",
        ],
        warnings,
      });
    },
  });
  return [getBankOverview];
}
