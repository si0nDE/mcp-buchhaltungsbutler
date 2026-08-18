import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createAccountsTools } from "./accounts.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("accounts tools", () => {
  it("list_accounts calls accountsGet and returns the data array", async () => {
    const client = mockClient({ success: true, rows: 1, data: [{ name: "Kasse", postingaccount_number: "1000" }] });
    const [listAccounts] = createAccountsTools(client);

    const result = await listAccounts.handler({});

    expect(client.call).toHaveBeenCalledWith("accountsGet", {});
    expect(JSON.parse(result.content[0].text)).toEqual([{ name: "Kasse", postingaccount_number: "1000" }]);
  });

  it("create_account calls accountsAdd with the given fields", async () => {
    const client = mockClient({ success: true, message: "ok" });
    const [, createAccount] = createAccountsTools(client);

    await createAccount.handler({
      type: "bank/institution",
      name: "Geschäftskonto",
      postingaccount_number: 1200,
    });

    expect(client.call).toHaveBeenCalledWith("accountsAdd", {
      type: "bank/institution",
      name: "Geschäftskonto",
      postingaccount_number: 1200,
    });
  });
});
