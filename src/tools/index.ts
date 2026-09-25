import type { BBClient } from "../bb-client/client.js";
import { createAccountsTools } from "./accounts.js";
import { createCommentsTools } from "./comments.js";
import { createContactsTools } from "./contacts.js";
import { createCostLocationsTools } from "./cost-locations.js";
import { createEntertainmentReceiptTools } from "./entertainment-receipt.js";
import { createInvoicesTools } from "./invoices.js";
import { createPostingAccountsTools } from "./posting-accounts.js";
import { createPostingsTools } from "./postings.js";
import { createReceiptsTools } from "./receipts.js";
import { createTransactionsTools } from "./transactions.js";
import type { ToolDef } from "./types.js";

export function createAllTools(client: BBClient): ToolDef[] {
  return [
    ...createAccountsTools(client),
    ...createCommentsTools(client),
    ...createCostLocationsTools(client),
    ...createContactsTools(client),
    ...createEntertainmentReceiptTools(),
    ...createPostingAccountsTools(client),
    ...createReceiptsTools(client),
    ...createTransactionsTools(client),
    ...createPostingsTools(client),
    ...createInvoicesTools(client),
  ];
}
