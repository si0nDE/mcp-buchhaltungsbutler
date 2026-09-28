import { extractTextItems, getDocumentProxy } from "unpdf";

interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
}

const ROW_Y_TOLERANCE = 3;

// unpdf's extractText returns items in raw PDF content-stream order, not
// reading order (verified empirically: a two-column layout drawn as "both
// labels, then both values" comes back exactly that way, not row by row) -
// exactly the kind of ambiguity that made a real receipt's three
// unlabeled "7%" tax lines need pdftotext -layout to disentangle in the
// first place (see docs/bewirtungsbeleg-faq.md). This reconstructs row-major
// reading order from extractTextItems' x/y positions instead of trusting
// stream order: group into rows by y (top to bottom, within a small
// tolerance for sub-pixel baseline differences), then order each row
// left to right by x.
export function sortIntoReadingOrder(items: PositionedTextItem[]): string {
  const sortedByY = [...items].sort((a, b) => b.y - a.y);
  const rows: PositionedTextItem[][] = [];
  for (const item of sortedByY) {
    const row = rows.find((r) => Math.abs(r[0].y - item.y) <= ROW_Y_TOLERANCE);
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows
    .map((row) =>
      row
        .sort((a, b) => a.x - b.x)
        .map((item) => item.str)
        .join(" ")
    )
    .join("\n");
}

// Returns the receipt's text in reading order, or undefined if there's
// nothing usable to extract (not a PDF, corrupt, or a scanned/image-only
// page with no text layer) - callers fall back to the raw file bytes in
// that case rather than treating this as an error.
export async function extractReceiptText(base64Pdf: string): Promise<string | undefined> {
  try {
    const bytes = Buffer.from(base64Pdf, "base64");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { items } = await extractTextItems(pdf);
    const text = items
      .map((pageItems) => sortIntoReadingOrder(pageItems))
      .filter((pageText) => pageText.length > 0)
      .join("\n\n");
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}
