import type { BBClient } from "../bb-client/client.js";
import { createAccountsTools } from "./accounts.js";
import { createBookingGuideTools } from "./booking-guide.js";
import { createCommentsTools } from "./comments.js";
import { createContactsTools } from "./contacts.js";
import { createControllingTools } from "./controlling.js";
import { createLiquidityTools } from "./liquidity.js";
import { createStabilityTools } from "./stability.js";
import { createBankOverviewTools } from "./bank-overview.js";
import { createTaxPositionTools } from "./tax-position.js";
import { createCostLocationsTools } from "./cost-locations.js";
import { createEntertainmentReceiptTools } from "./entertainment-receipt.js";
import { createTravelExpenseTools } from "./travel-expense-report.js";
import { createInvoicesTools } from "./invoices.js";
import { createMonthEndTools } from "./month-end.js";
import { createPostingAccountsTools } from "./posting-accounts.js";
import { createPostingsTools } from "./postings.js";
import { createReceiptFieldsTools } from "./receipt-fields.js";
import { createReceiptFamilyTools } from "./receipt-family.js";
import { createReceiptsTools } from "./receipts.js";
import { createReportsTools } from "./reports.js";
import { createTransactionsTools } from "./transactions.js";
import { createUstVaTools } from "./ustva-mapping.js";
import { createPolicyTools } from "./policy.js";
import { createVatAuditTools } from "./vat-audit.js";
import { createVatPreviewTools } from "./vat-preview.js";
import { createVersionTools } from "./version.js";
import type { ToolDef } from "./types.js";

export function createAllTools(client: BBClient): ToolDef[] {
  return [
    ...createAccountsTools(client),
    ...createCommentsTools(client),
    ...createCostLocationsTools(client),
    ...createContactsTools(client),
    ...createEntertainmentReceiptTools(client),
    ...createTravelExpenseTools(client),
    ...createPostingAccountsTools(client),
    ...createReceiptsTools(client),
    ...createReceiptFamilyTools(client),
    ...createReceiptFieldsTools(client),
    ...createTransactionsTools(client),
    ...createPostingsTools(client),
    ...createInvoicesTools(client),
    ...createReportsTools(client),
    ...createControllingTools(client),
    ...createLiquidityTools(client),
    ...createStabilityTools(client),
    ...createBankOverviewTools(client),
    ...createTaxPositionTools(client),
    ...createBookingGuideTools(),
    ...createMonthEndTools(client),
    ...createUstVaTools(),
    ...createVatPreviewTools(client),
    ...createPolicyTools(),
    ...createVatAuditTools(client),
    ...createVersionTools(),
  ];
}
