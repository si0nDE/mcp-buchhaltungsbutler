// Lesbare Belegreferenz für Ausgaben: "Rg. <Rechnungsnummer> · <Gegenpartei> · TT.MM.JJJJ · 22,70 €". Die BHB-Oberfläche sucht man nach
// Rechnungsnummer, nicht nach id_by_customer. Ein Deeplink fehlt bewusst: das URL-Schema der Oberfläche ist nicht belegt.

const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

function formatDate(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(v));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
}

function formatAmount(v: unknown): string {
  const n = Number(text(v).replace(",", "."));
  if (text(v) === "" || !Number.isFinite(n)) return "";
  return `${n.toFixed(2).replace(".", ",")} €`;
}

export function receiptDisplayRef(receipt: Record<string, unknown>): string {
  const invoicenumber = text(receipt.invoicenumber);
  const id = text(receipt.id_by_customer);
  const head = invoicenumber ? `Rg. ${invoicenumber}` : id ? `Beleg #${id} (ohne Rechnungsnummer)` : "";
  return [head, text(receipt.counterparty), formatDate(receipt.date), formatAmount(receipt.amount)].filter((p) => p !== "").join(" · ");
}
