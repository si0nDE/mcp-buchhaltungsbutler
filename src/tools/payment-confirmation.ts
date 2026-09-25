// Helpers for confirm_payment: closing out a receipt against a bank
// transaction requires two independent BuchhaltungsButler calls
// (transactionsAssignBatchReceipt, then postingsAddBatchTransactions) that
// neither tool's description says depend on each other — assigning alone
// creates no posting and leaves the creditor/debtor balance untouched, which
// an LLM trusting `success: true` from the assignment call alone can easily
// mistake for "payment settled".

// A decimal-string amount difference tolerance, not a percentage — same
// rounding-tolerance reasoning as the Bewirtungskosten 70/30 check.
const AMOUNT_TOLERANCE_EUR = 0.01;

// BuchhaltungsButler returns a receipt's amount as a positive decimal string
// and a bank transaction's amount signed by direction (negative for money
// leaving the account), so the comparison is on absolute value.
export function amountsMatch(receiptAmount: string, transactionAmount: string, toleranceEur = AMOUNT_TOLERANCE_EUR): boolean {
  return Math.abs(Math.abs(Number(receiptAmount)) - Math.abs(Number(transactionAmount))) <= toleranceEur;
}

export function buildSettlementPostingText(
  receipt: { invoicenumber?: string; counterparty?: string },
  receiptId: number
): string {
  const ref = receipt.invoicenumber || String(receiptId);
  return receipt.counterparty ? `Ausgleich Beleg ${ref} - ${receipt.counterparty}` : `Ausgleich Beleg ${ref}`;
}
