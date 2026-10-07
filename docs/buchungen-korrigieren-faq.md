# Falsche Buchungen korrigieren – Häufige Fragen

Hintergrund zum Tool `cancel_posting`. Ersetzt keine Steuerberatung.

## Welchen Endpunkt nutzt `cancel_posting`?

`/postings/cancel` (in der Live-API-Doku, Spec v1.9.1 vom Oktober 2026; die ältere lokale Spec kannte ihn noch nicht).
Er nimmt **eine** Buchung (`posting_id_by_customer`): nicht festgeschriebene Buchungen werden gelöscht, festgeschriebene
per **Gegenbuchung (Stornobuchung)** storniert – das Original bleibt bestehen. `cancel_posting` ruft ihn je Buchung auf
und ergänzt Vorschau, Freigabe festgeschriebener Buchungen und Nachkontrolle.

## Wie läuft eine Korrektur ab?

1. `cancel_posting` mit `confirm: false` (oder ohne `confirm`) – zeigt jede betroffene Buchung mit ihrer Aktion
   („löschen" oder „stornieren (Gegenbuchung)"). Buchungsdaten notieren: die API liefert kein Änderungsprotokoll.
2. Nutzer bestätigt → `cancel_posting` mit `confirm: true`. Sind festgeschriebene Buchungen dabei, zusätzlich
   `reverse_posting_ids` mit genau deren IDs aus der Vorschau.
3. Ergebnis prüfen (`gelöscht: true`, bei Stornos die `neu_angelegt`-Liste), danach korrekt neu buchen.

`date_from`/`date_to` sind nötig, weil `/postings/get` nicht nach ID filtern kann; der Zeitraum muss das Buchungsdatum
enthalten (und bei Stornos auch das Datum der Gegenbuchung, sonst taucht sie in `neu_angelegt` nicht auf).

## Was wird bearbeitet?

- `type=transaction`: **alle** Buchungen dieser Zahlung (z. B. beide Splits 3001 und 3002 zu Zahlung 2001).
- `type=receipt`: alle Buchungen dieses Belegs.
- `type=free`: genau eine freie Buchung (z. B. 3003).

## Warum müssen festgeschriebene Buchungen einzeln freigegeben werden?

Eine Stornobuchung ist selbst eine Buchung. Würde man dieselbe Zahlung/denselben Beleg noch einmal „stornieren", könnte
die Gegenbuchung miterfasst und damit wieder aufgehoben werden. Deshalb werden festgeschriebene Buchungen nur storniert,
wenn ihre ID ausdrücklich in `reverse_posting_ids` steht; IDs, die nicht zu den festgeschriebenen Buchungen des Ziels
gehören, werden abgelehnt. Einen Aufruf für dieselbe Einheit nicht wiederholen.

## Was ist mit Teil-Fehlern?

Die Buchungen werden nacheinander bearbeitet. Scheitert eine, bricht das Tool ab und nennt, was schon erledigt und was
noch offen ist. Nicht blind wiederholen, sondern erst mit `confirm: false` den Stand prüfen.

## Wann nicht verwenden?

Für Zeiträume, die bereits in einer USt-Voranmeldung oder einem Jahresabschluss verarbeitet sind – nur mit dem
Steuerberater. `unconfirm_posting` hebt dagegen die Festschreibung auf und ist nur nach ausdrücklicher Entscheidung des
Nutzers gedacht. Ganze Zahlungen löscht `delete_transaction` (bei GoBD-gesicherten Konten als Storno-Zahlung).

## Empfohlene Buchungsreihenfolge

Beleg prüfen → Beleg buchen → Zahlung zuweisen → Zahlung buchen. Wird direkt über die Zahlung gebucht, fehlt der
Belegbezug und eine Korrektur wird nötig.

## Nicht live verifiziert

Das Verhalten von `/postings/cancel` bei einzelnen Splits einer Zahlung/eines Belegs und das Datum der Gegenbuchung sind
nur aus der Spec bekannt, nicht gegen ein echtes Konto getestet.
