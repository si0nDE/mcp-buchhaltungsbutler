import { describe, expect, it } from "vitest";
import { parseRatesHtml } from "./travel-rates-parse.js";

// Invented minimal fixture that mirrors the structure of the BMF table (header rows, bold cells, <br/> in names).
const FIXTURE = `
<table>
<tr class="table-header-row"><td rowspan="3">Land</td><td colspan="2">Pauschbeträge</td></tr>
<tr class="table-header-row"><td>€</td><td>€</td><td>€</td></tr>
<tr><td>Ägypten</td><td class="center">50</td><td class="center">33</td><td class="center">112</td></tr>
<tr><td>Albanien</td><td class="center"><span class="richtext-bold-text">33</span></td><td class="center"><span class="richtext-bold-text">22</span></td><td class="center"><span class="richtext-bold-text">116</span></td></tr>
<tr><td>Australien</td><td class="center">&nbsp;</td><td class="center">&nbsp;</td><td class="center">&nbsp;</td></tr>
<tr><td>Canberra<br/></td><td class="center">74</td><td class="center">49</td><td class="center">186</td></tr>
<tr><td>im Übrigen<br/></td><td class="center">57</td><td class="center">38</td><td class="center">173</td></tr>
<tr><td>Bahrain</td><td class="center">48</td><td class="center">32</td><td class="center">153</td></tr>
</table>`;

describe("parseRatesHtml", () => {
  it("parses countries, city blocks, bold cells and <br/> names", () => {
    expect(parseRatesHtml(FIXTURE)).toEqual([
      { country: "Ägypten", place: null, full: 50, partial: 33, night: 112 },
      { country: "Albanien", place: null, full: 33, partial: 22, night: 116 },
      { country: "Australien", place: "Canberra", full: 74, partial: 49, night: 186 },
      { country: "Australien", place: "im Übrigen", full: 57, partial: 38, night: 173 },
      { country: "Bahrain", place: null, full: 48, partial: 32, night: 153 },
    ]);
  });

  it("ends a city block at 'im Übrigen' so the next country is not attached to it", () => {
    const entries = parseRatesHtml(FIXTURE);
    expect(entries.at(-1)?.country).toBe("Bahrain");
    expect(entries.at(-1)?.place).toBeNull();
  });

  it("throws a clear error when the table is missing", () => {
    expect(() => parseRatesHtml("<html><body>nichts</body></html>")).toThrow(/Tabelle nicht gefunden/);
  });
});

describe("parseRatesHtml - hostile input stays linear", () => {
  const MB3 = 3 * 1024 * 1024;
  const timed = (html: string) => {
    const started = performance.now();
    let result: unknown;
    try {
      result = parseRatesHtml(html);
    } catch (error) {
      result = error;
    }
    return { ms: performance.now() - started, result };
  };

  it.each([
    ["'<'", "<"],
    ["'<tr'", "<tr"],
    ["'<td'", "<td"],
  ])("3 MB of %s after the anchor finishes well under 1 s and yields no rows", (_name, unit) => {
    const { ms, result } = timed(`<table><tr><td>Ägypten</td></tr>${unit.repeat(Math.floor(MB3 / unit.length))}`);
    expect(ms).toBeLessThan(1000);
    expect(result).toEqual([]);
  });

  it("3 MB of '<' inside one cell finishes well under 1 s", () => {
    const { ms } = timed(`<table><tr><td>Ägypten</td><td>${"<".repeat(MB3)}</td><td>1</td><td>1</td></tr></table>`);
    expect(ms).toBeLessThan(1000);
  });

  it("parses rows split over lines and attributes like before", () => {
    const html = `<table>\n<tr class="x"\n data-a="1">\n<td\n class="c">Ägypten</td><td>50</td><td>33</td><td>112</td>\n</tr>\n</table>`;
    expect(parseRatesHtml(html)).toEqual([{ country: "Ägypten", place: null, full: 50, partial: 33, night: 112 }]);
  });
});
