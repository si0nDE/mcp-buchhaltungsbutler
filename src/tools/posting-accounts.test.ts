import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createPostingAccountsTools } from "./posting-accounts.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("posting accounts tools", () => {
  it("list_posting_accounts calls settingsGetPostingaccounts without params (API rejects any filter param)", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [listPostingAccounts] = createPostingAccountsTools(client);

    await listPostingAccounts.handler({ limit: 20, offset: 0, exclude_debtors: true });

    expect(client.call).toHaveBeenCalledWith("settingsGetPostingaccounts", {});
  });

  it("list_posting_accounts applies exclude_* filters and limit/offset client-side", async () => {
    const client = mockClient({
      success: true,
      rows: 3,
      data: [
        { postingaccount_number: "1", name: "A", type: "postingaccount" },
        { postingaccount_number: "2", name: "B", type: "debtor" },
        { postingaccount_number: "3", name: "C", type: "creditor" },
      ],
    });
    const [listPostingAccounts] = createPostingAccountsTools(client);

    const result = await listPostingAccounts.handler({
      limit: 20,
      offset: 0,
      exclude_debtors: true,
      exclude_creditors: true,
    });

    expect(JSON.parse(result.content[0].text)).toEqual([
      { postingaccount_number: "1", name: "A", type: "postingaccount" },
    ]);
  });

  it("list_posting_accounts trims to summary fields by default", async () => {
    const client = mockClient({
      success: true,
      rows: 1,
      data: [
        {
          postingaccount_number: "6815",
          name: "Büromaterial",
          type: "expense",
          subtype: "operating",
          parent_postingaccount_number: "6800",
          parent_name: "Betriebsausgaben",
        },
      ],
    });
    const [listPostingAccounts] = createPostingAccountsTools(client);

    const result = await listPostingAccounts.handler({ limit: 20, offset: 0 });

    expect(JSON.parse(result.content[0].text)).toEqual([
      {
        postingaccount_number: "6815",
        name: "Büromaterial",
        type: "expense",
        parent_postingaccount_number: "6800",
      },
    ]);
  });

  it("list_posting_accounts returns full records when full: true", async () => {
    const client = mockClient({
      success: true,
      rows: 1,
      data: [{ postingaccount_number: "6815", name: "Büromaterial", type: "expense", subtype: "operating" }],
    });
    const [listPostingAccounts] = createPostingAccountsTools(client);

    const result = await listPostingAccounts.handler({ limit: 20, offset: 0, full: true });

    expect(JSON.parse(result.content[0].text)).toEqual([
      { postingaccount_number: "6815", name: "Büromaterial", type: "expense", subtype: "operating" },
    ]);
  });

  it("manage_posting_account create without parent_postingaccount_number throws", async () => {
    const client = mockClient({ success: true });
    const [, managePostingAccount] = createPostingAccountsTools(client);

    await expect(
      managePostingAccount.handler({ action: "create", name: "Büromaterial", postingaccount_number: 6815 })
    ).rejects.toThrow(/parent_postingaccount_number/);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("manage_posting_account create calls settingsAddPostingaccount", async () => {
    const client = mockClient({ success: true });
    const [, managePostingAccount] = createPostingAccountsTools(client);

    await managePostingAccount.handler({
      action: "create",
      name: "Büromaterial",
      postingaccount_number: 6815,
      parent_postingaccount_number: 6800,
    });

    expect(client.call).toHaveBeenCalledWith("settingsAddPostingaccount", {
      name: "Büromaterial",
      postingaccount_number: 6815,
      parent_postingaccount_number: 6800,
    });
  });

  it("manage_posting_account update calls settingsUpdatePostingaccount", async () => {
    const client = mockClient({ success: true });
    const [, managePostingAccount] = createPostingAccountsTools(client);

    await managePostingAccount.handler({ action: "update", name: "Büromaterial neu", postingaccount_number: 6815 });

    expect(client.call).toHaveBeenCalledWith("settingsUpdatePostingaccount", {
      name: "Büromaterial neu",
      postingaccount_number: 6815,
    });
  });
});
