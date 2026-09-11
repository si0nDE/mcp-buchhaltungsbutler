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

    expect(JSON.parse(result.content[0].text)).toEqual([{ postingaccount_number: "1", name: "A" }]);
  });

  it("list_posting_accounts trims to postingaccount_number/name by default", async () => {
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
      { postingaccount_number: "6815", name: "Büromaterial" },
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

  it("list_posting_accounts caches the full catalog fetch across calls", async () => {
    const client = mockClient({ success: true, rows: 1, data: [{ postingaccount_number: "1", name: "A" }] });
    const [listPostingAccounts] = createPostingAccountsTools(client);

    await listPostingAccounts.handler({ limit: 20, offset: 0 });
    await listPostingAccounts.handler({ limit: 20, offset: 0 });

    expect(client.call).toHaveBeenCalledTimes(1);
  });

  it("list_posting_accounts bypasses the cache when refresh: true", async () => {
    const client = mockClient({ success: true, rows: 1, data: [{ postingaccount_number: "1", name: "A" }] });
    const [listPostingAccounts] = createPostingAccountsTools(client);

    await listPostingAccounts.handler({ limit: 20, offset: 0 });
    await listPostingAccounts.handler({ limit: 20, offset: 0, refresh: true });

    expect(client.call).toHaveBeenCalledTimes(2);
  });

  it("list_posting_accounts pagination reflects the full cached dataset, not just a 20-row slice", async () => {
    const data = Array.from({ length: 25 }, (_, i) => ({
      postingaccount_number: String(1000 + i),
      name: `Konto ${i}`,
    }));
    const client = mockClient({ success: true, rows: data.length, data });
    const [listPostingAccounts] = createPostingAccountsTools(client);

    const page1 = await listPostingAccounts.handler({ limit: 20, offset: 0 });
    const page2 = await listPostingAccounts.handler({ limit: 20, offset: 20 });

    expect(JSON.parse(page1.content[0].text)).toHaveLength(20);
    expect(JSON.parse(page2.content[0].text)).toHaveLength(5);
    expect(client.call).toHaveBeenCalledTimes(1);
  });

  it("list_posting_accounts filters by postingaccount_number range", async () => {
    const client = mockClient({
      success: true,
      rows: 3,
      data: [
        { postingaccount_number: "1000", name: "Kasse" },
        { postingaccount_number: "1400", name: "Forderungen" },
        { postingaccount_number: "1600", name: "Verbindlichkeiten" },
      ],
    });
    const [listPostingAccounts] = createPostingAccountsTools(client);

    const result = await listPostingAccounts.handler({
      limit: 20,
      offset: 0,
      postingaccount_number_from: 1100,
      postingaccount_number_to: 1500,
    });

    expect(JSON.parse(result.content[0].text)).toEqual([{ postingaccount_number: "1400", name: "Forderungen" }]);
  });

  it("list_posting_accounts excludes non-numeric postingaccount_number from range filtering instead of crashing", async () => {
    const client = mockClient({
      success: true,
      rows: 2,
      data: [
        { postingaccount_number: "abc", name: "Bogus" },
        { postingaccount_number: "1000", name: "Kasse" },
      ],
    });
    const [listPostingAccounts] = createPostingAccountsTools(client);

    const result = await listPostingAccounts.handler({
      limit: 20,
      offset: 0,
      postingaccount_number_from: 0,
    });

    expect(JSON.parse(result.content[0].text)).toEqual([{ postingaccount_number: "1000", name: "Kasse" }]);
  });

  it("list_posting_accounts filters by case-insensitive name search", async () => {
    const client = mockClient({
      success: true,
      rows: 2,
      data: [
        { postingaccount_number: "1576", name: "Abziehbare Vorsteuer 19 %" },
        { postingaccount_number: "1000", name: "Kasse" },
      ],
    });
    const [listPostingAccounts] = createPostingAccountsTools(client);

    const result = await listPostingAccounts.handler({ limit: 20, offset: 0, search: "vorsteuer" });

    expect(JSON.parse(result.content[0].text)).toEqual([
      { postingaccount_number: "1576", name: "Abziehbare Vorsteuer 19 %" },
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

  it("manage_posting_account create invalidates the posting-accounts cache", async () => {
    const listResult = { success: true, rows: 0, data: [] };
    const client: BBClient = { call: vi.fn().mockResolvedValue(listResult) };
    const [listPostingAccounts, managePostingAccount] = createPostingAccountsTools(client);

    await listPostingAccounts.handler({ limit: 20, offset: 0 });
    await managePostingAccount.handler({
      action: "create",
      name: "Büromaterial",
      postingaccount_number: 6815,
      parent_postingaccount_number: 6800,
    });
    await listPostingAccounts.handler({ limit: 20, offset: 0 });

    const listCalls = (client.call as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([key]) => key === "settingsGetPostingaccounts"
    );
    expect(listCalls).toHaveLength(2);
  });

  it("manage_posting_account update invalidates the posting-accounts cache", async () => {
    const listResult = { success: true, rows: 0, data: [] };
    const client: BBClient = { call: vi.fn().mockResolvedValue(listResult) };
    const [listPostingAccounts, managePostingAccount] = createPostingAccountsTools(client);

    await listPostingAccounts.handler({ limit: 20, offset: 0 });
    await managePostingAccount.handler({ action: "update", name: "Büromaterial neu", postingaccount_number: 6815 });
    await listPostingAccounts.handler({ limit: 20, offset: 0 });

    const listCalls = (client.call as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([key]) => key === "settingsGetPostingaccounts"
    );
    expect(listCalls).toHaveLength(2);
  });
});
