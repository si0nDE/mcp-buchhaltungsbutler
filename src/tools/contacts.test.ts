import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { createContactsTools } from "./contacts.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("contacts tools", () => {
  it("list_contacts routes debtor to settingsGetDebtors with limit/offset defaults", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [listContacts] = createContactsTools(client);

    await listContacts.handler({ contact_type: "debtor" });

    expect(client.call).toHaveBeenCalledWith("settingsGetDebtors", { limit: 20, offset: 0 });
  });

  it("list_contacts routes creditor to settingsGetCreditors", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [listContacts] = createContactsTools(client);

    await listContacts.handler({ contact_type: "creditor", limit: 5, offset: 10 });

    expect(client.call).toHaveBeenCalledWith("settingsGetCreditors", { limit: 5, offset: 10 });
  });

  it("list_contacts returns full records when full: true", async () => {
    const client = mockClient({
      success: true,
      rows: 1,
      data: [{ postingaccount_number: "10001", name: "Kunde GmbH", email: "a@b.de", city: "Berlin", iban: "DE00" }],
    });
    const [listContacts] = createContactsTools(client);

    const result = await listContacts.handler({ contact_type: "debtor", full: true });

    expect(JSON.parse(result.content[0].text)).toEqual([
      { postingaccount_number: "10001", name: "Kunde GmbH", email: "a@b.de", city: "Berlin", iban: "DE00" },
    ]);
  });

  it("create_contacts rejects an empty contacts array via its Zod schema", () => {
    const [, createContacts] = createContactsTools(mockClient({}));

    expect(() =>
      z.object(createContacts.inputSchema).parse({ contact_type: "debtor", contacts: [] })
    ).toThrow();
  });

  it("create_contacts routes debtor batch to settingsAddBatchDebtors", async () => {
    const client = mockClient({ success: true });
    const [, createContacts] = createContactsTools(client);

    await createContacts.handler({
      contact_type: "debtor",
      contacts: [{ name: "Kunde GmbH" }],
    });

    expect(client.call).toHaveBeenCalledWith("settingsAddBatchDebtors", {
      debtors: [{ name: "Kunde GmbH" }],
    });
  });

  it("create_contacts routes creditor batch to settingsAddBatchCreditors", async () => {
    const client = mockClient({ success: true });
    const [, createContacts] = createContactsTools(client);

    await createContacts.handler({
      contact_type: "creditor",
      contacts: [{ name: "Lieferant AG", due_in_days: 14 }],
    });

    expect(client.call).toHaveBeenCalledWith("settingsAddBatchCreditors", {
      creditors: [{ name: "Lieferant AG", due_in_days: 14 }],
    });
  });

  it("update_contact routes debtor to settingsUpdateDebtor", async () => {
    const client = mockClient({ success: true });
    const [, , updateContact] = createContactsTools(client);

    await updateContact.handler({
      contact_type: "debtor",
      postingaccount_number: 10001,
      city: "Berlin",
    });

    expect(client.call).toHaveBeenCalledWith("settingsUpdateDebtor", {
      postingaccount_number: 10001,
      city: "Berlin",
    });
  });

  it("update_contact forwards customer_number for debtor but drops due_in_days", async () => {
    const client = mockClient({ success: true });
    const [, , updateContact] = createContactsTools(client);

    await updateContact.handler({
      contact_type: "debtor",
      postingaccount_number: 10001,
      customer_number: "K-100",
      due_in_days: 30,
    });

    expect(client.call).toHaveBeenCalledWith("settingsUpdateDebtor", {
      postingaccount_number: 10001,
      customer_number: "K-100",
    });
  });

  it("update_contact forwards due_in_days for creditor but drops customer_number", async () => {
    const client = mockClient({ success: true });
    const [, , updateContact] = createContactsTools(client);

    await updateContact.handler({
      contact_type: "creditor",
      postingaccount_number: 20001,
      due_in_days: 14,
      customer_number: "K-100",
    });

    expect(client.call).toHaveBeenCalledWith("settingsUpdateCreditor", {
      postingaccount_number: 20001,
      due_in_days: 14,
    });
  });
});
