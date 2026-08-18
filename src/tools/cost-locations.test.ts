import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createCostLocationsTools } from "./cost-locations.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("cost locations tools", () => {
  it("list_cost_locations trims to code/name by default", async () => {
    const client = mockClient({
      success: true,
      rows: 1,
      data: [{ code: "CL1", name: "Marketing", internal: "x" }],
    });
    const [listCostLocations] = createCostLocationsTools(client);

    const result = await listCostLocations.handler({ full: false });

    expect(JSON.parse(result.content[0].text)).toEqual([{ code: "CL1", name: "Marketing" }]);
  });

  it("manage_cost_location create calls costLocationsAdd", async () => {
    const client = mockClient({ success: true });
    const [, manageCostLocation] = createCostLocationsTools(client);

    await manageCostLocation.handler({ action: "create", code: "CL1", name: "Marketing" });

    expect(client.call).toHaveBeenCalledWith("costLocationsAdd", { code: "CL1", name: "Marketing" });
  });

  it("manage_cost_location update calls costLocationsUpdate", async () => {
    const client = mockClient({ success: true });
    const [, manageCostLocation] = createCostLocationsTools(client);

    await manageCostLocation.handler({ action: "update", code: "CL1", name: "Vertrieb" });

    expect(client.call).toHaveBeenCalledWith("costLocationsUpdate", { code: "CL1", name: "Vertrieb" });
  });

  it("manage_cost_location delete calls costLocationsDelete with only code", async () => {
    const client = mockClient({ success: true });
    const [, manageCostLocation] = createCostLocationsTools(client);

    await manageCostLocation.handler({ action: "delete", code: "CL1" });

    expect(client.call).toHaveBeenCalledWith("costLocationsDelete", { code: "CL1" });
  });

  it("list_cost_locations with full: true returns complete records", async () => {
    const client = mockClient({
      success: true,
      rows: 1,
      data: [{ code: "CL1", name: "Marketing", internal: "x", extra: "field" }],
    });
    const [listCostLocations] = createCostLocationsTools(client);

    const result = await listCostLocations.handler({ full: true });

    expect(JSON.parse(result.content[0].text)).toEqual([
      { code: "CL1", name: "Marketing", internal: "x", extra: "field" },
    ]);
  });

  it("manage_cost_location create without name throws error", async () => {
    const client = mockClient({ success: true });
    const [, manageCostLocation] = createCostLocationsTools(client);

    await expect(
      manageCostLocation.handler({ action: "create", code: "CL1" })
    ).rejects.toThrow('"name" is required for action "create"');
  });

  it("manage_cost_location update without name throws error", async () => {
    const client = mockClient({ success: true });
    const [, manageCostLocation] = createCostLocationsTools(client);

    await expect(
      manageCostLocation.handler({ action: "update", code: "CL1" })
    ).rejects.toThrow('"name" is required for action "update"');
  });

  it("manage_cost_location delete ignores provided name parameter", async () => {
    const client = mockClient({ success: true });
    const [, manageCostLocation] = createCostLocationsTools(client);

    await manageCostLocation.handler({ action: "delete", code: "CL1", name: "should be ignored" });

    expect(client.call).toHaveBeenCalledWith("costLocationsDelete", { code: "CL1" });
    expect(client.call).not.toHaveBeenCalledWith("costLocationsDelete", { code: "CL1", name: "should be ignored" });
  });
});
