# mcp-buchhaltungsbutler

## Versionierung

CalVer `yyyy.mm.dd.NNN` (Quelle: `src/version.ts`, Details in `scripts/release.ts`). Nie von Hand ändern.

- Nach abgeschlossenen Änderungen (Tests grün, committet) `npm run release` ausführen. Das zählt den Tageszähler hoch, committet und setzt den Tag `vYYYY.MM.DD.NNN`.
- Vor jedem `git push` muss HEAD ein Release sein. Ein Hook (`scripts/check-release.sh`) blockiert den Push sonst.
- Änderungen mit Nutzerwirkung zuerst in `CHANGELOG.md` unter "Unreleased" eintragen.
- Push von Branch und Tag (`git push && git push origin <Tag>`) nur auf Wunsch des Nutzers.
