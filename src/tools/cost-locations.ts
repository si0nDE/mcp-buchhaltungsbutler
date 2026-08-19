import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, ok, type ToolDef } from "./types.js";

const SUMMARY_FIELDS = ["code", "name"] as const;

export function createCostLocationsTools(client: BBClient): [ToolDef, ToolDef] {
  const listShape = {
    full: z.boolean().default(false),
  };

  const listCostLocations = defineTool({
    name: "list_cost_locations",
    description: "List all cost locations (Kostenstellen).",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: listShape,
    async handler(args) {
      const result = await client.call<BBListResult>("costLocationsGet", {});
      return ok(trimList(result.data, SUMMARY_FIELDS, args.full));
    },
  });

  const manageShape = {
    action: z.enum(["create", "update", "delete"]),
    code: z.string(),
    name: z.string().optional(),
  };

  const manageCostLocation = defineTool({
    name: "manage_cost_location",
    description:
      "Create, update, or delete a cost location. 'name' is required for create/update and ignored for delete.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: manageShape,
    async handler(args) {
      if (args.action === "delete") {
        const result = await client.call("costLocationsDelete", { code: args.code });
        return ok(result);
      }
      if (!args.name) {
        throw new Error(`"name" is required for action "${args.action}"`);
      }
      const endpointKey = args.action === "create" ? "costLocationsAdd" : "costLocationsUpdate";
      const result = await client.call(endpointKey, { code: args.code, name: args.name });
      return ok(result);
    },
  });

  return [listCostLocations, manageCostLocation];
}
