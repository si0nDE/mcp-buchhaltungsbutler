import type { BBClient } from "../bb-client/client.js";
import { createAccountsTools } from "./accounts.js";
import { createBookingGuideTools } from "./booking-guide.js";
import { createCommentsTools } from "./comments.js";
import { createContactsTools } from "./contacts.js";
import { createCostLocationsTools } from "./cost-locations.js";
import { createEntertainmentReceiptTools } from "./entertainment-receipt.js";
import { createInvoicesTools } from "./invoices.js";
import { createMonthEndTools } from "./month-end.js";
import { createPostingAccountsTools } from "./posting-accounts.js";
import { createPostingsTools } from "./postings.js";
import { createReceiptFamilyTools } from "./receipt-family.js";
import { createReceiptsTools } from "./receipts.js";
import { createReportsTools } from "./reports.js";
import { createTransactionsTools } from "./transactions.js";
import { createUstVaTools } from "./ustva-mapping.js";
import { createVersionTools } from "./version.js";
import type { ToolDef } from "./types.js";

export function createAllTools(client: BBClient): ToolDef[] {
  return [
    ...createAccountsTools(client),
    ...createCommentsTools(client),
    ...createCostLocationsTools(client),
    ...createContactsTools(client),
    ...createEntertainmentReceiptTools(client),
    ...createPostingAccountsTools(client),
    ...createReceiptsTools(client),
    ...createReceiptFamilyTools(client),
    ...createTransactionsTools(client),
    ...createPostingsTools(client),
    ...createInvoicesTools(client),
    ...createReportsTools(client),
    ...createBookingGuideTools(),
    ...createMonthEndTools(client),
    ...createUstVaTools(),
    ...createVersionTools(),
  ];
}
