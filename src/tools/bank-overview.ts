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

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function createBankOverviewTools(client: BBClient, opts: RunnerOptions = {}): [ToolDef] {
  const runReport = createReportRunner(client, { pollMs: 4000, ...opts });

  const getBankOverview = defineTool({
    name: "get_bank_overview",
    description:
      "Banken-Übersicht fürs Controlling: je Zahlungskonto (Bank, Kasse, Darlehens- und Verrechnungskonten) der gebuchte Stand (Summen- und " +
      "Saldenliste), der Zahlungsstand (alle Zahlungen, ob gebucht oder nicht), die Differenz, die Umsätze im Zeitraum (Ein- und " +
      "Auszahlungen), die noch nicht gebuchten Zahlungen einzeln und die Buchungen auf dem Interimskonto 'Kontierung nicht bekannt'. " +
      "Fragt der Nutzer, was auf welchem Konto liegt, ob Zahlungen offen oder unerklärt sind, dieses Tool aufrufen und als Artefakt " +
      "darstellen. Es erzeugt eine Summen- und Saldenliste und ERSETZT damit die zuletzt in BHB erzeugte. Bei angebundenen Bankkonten " +
      "zeigt die Oberfläche den von der Bank gemeldeten Stand, der kann vom Zahlungsstand abweichen. as_of und date_from als YYYY-MM-DD.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      as_of: z.string().optional().describe("YYYY-MM-DD, Stichtag der Stände. Standard: heute."),
      date_from: z.string().optional().describe("YYYY-MM-DD, Beginn des Umsatzzeitraums. Standard: 1. Januar des Jahres von as_of."),
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

      const nichtGebucht = open
        .map((r) => ({
          konto: Number(r._konto),
          id: Number(r.id_by_customer),
          datum: String(r.booking_date ?? "").slice(0, 10),
          betrag: r2(Number(r.amount)),
          gegenpartei: String(r.to_from ?? ""),
          zweck: String(r.purpose ?? "").split("\n")[0].slice(0, 140),
        }))
        .sort((a, b) => b.datum.localeCompare(a.datum) || a.konto - b.konto);

      // Gebucht, aber noch nicht zugeordnet: Interimskonto "Kontierung nicht bekannt"
      const unklar: Array<{ konto: number; name: string; saldo: number; buchungen: Buchung[] }> = [];
      for (const [nr, e] of Object.entries(entries)) {
        if (e.postingaccount?.class === "Interimskonto" && /nicht bekannt/i.test(e.postingaccount.name ?? "")) {
          const buchungen = await fetchLedger(client, Number(nr), "debit", { from, to: asOf });
          unklar.push({ konto: Number(nr), name: e.postingaccount.name ?? "", saldo: r2(signed(e)), buchungen });
        }
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
        unklare_buchungen: unklar,
        hinweise: [
          "Buchsaldo = Saldo in der Summen- und Saldenliste (nur gebuchte Zahlungen). Zahlungssaldo = Summe aller Zahlungen bis zum Stichtag, auch ungebuchter; ohne eingetragenen Anfangsbestand stimmt nur die Veränderung. Die Differenz sind Zahlungen, die noch nicht gebucht sind.",
          "Darlehens- und Verrechnungskonten stehen als Konten der Klasse Finanzkonto mit in der Liste (art: sonstiges); ihr Saldo zählt in BHB zum Cash-Bestand.",
          "Bei angebundenen Bank- und Kreditkartenkonten zeigt die BHB-Oberfläche den von der Bank gemeldeten Stand, nicht den hier berechneten.",
          "Unklare Buchungen: Buchungen auf dem Interimskonto 'Kontierung nicht bekannt'. Sie sind gebucht, aber keinem Sachkonto zugeordnet; Gegenbuchungen heben sich dort auf. Beträge zur Sollseite des Kontos (Haben negativ).",
        ],
        warnings,
      });
    },
  });
  return [getBankOverview];
}
