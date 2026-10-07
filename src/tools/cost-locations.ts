import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, LIST_OUTPUT_SHAPE, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

const SUMMARY_FIELDS = ["code", "name"] as const;

// /cost-locations/get takes limit/offset (max 1000 per request), so page until
// a short page signals the end instead of trusting the API's default limit.
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

export function createCostLocationsTools(client: BBClient): [ToolDef, ToolDef] {
  const listShape = {
    full: z.boolean().default(false),
  };

  const listCostLocations = defineTool({
    name: "list_cost_locations",
    description:
      "List all cost locations (Kostenstellen / Projekte). Kostenstellen must be switched on in the settings first (UI: Einstellungen, " +
      "Kostenstellen / Projektverwaltung). Kostenstelle 1 (cost_location) is a number plus project name; Kostenstelle 2 " +
      "(cost_location_two) is free text and only reaches the DATEV export, not BuchhaltungsButler's own BWA/EÜR. A BWA/EÜR " +
      "broken down by Kostenstelle exists only as a CSV export in the UI.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: LIST_OUTPUT_SHAPE,
    inputSchema: listShape,
    async handler(args) {
      const rows: Record<string, unknown>[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await client.call<BBListResult>("costLocationsGet", {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        });
        rows.push(...result.data);
        if (result.data.length < PAGE_SIZE) break;
      }
      return ok(trimList(rows, SUMMARY_FIELDS, args.full));
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
      "Create, update, or delete a cost location (Kostenstelle/Projekt). 'name' is required for create/update and ignored for delete. " +
      "Kostenstellen must be activated in the settings first; under SKR42 (Vereine) the KSt 1-4 and 9 (ideeller Bereich, Vermögensverwaltung, " +
      "Zweckbetrieb, wirtschaftlicher Geschäftsbetrieb, Sammelposten) are preset.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    outputSchema: OBJECT_OUTPUT_SHAPE,
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
