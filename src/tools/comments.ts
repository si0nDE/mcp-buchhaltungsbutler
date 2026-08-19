import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { defineTool, ok, type ToolDef } from "./types.js";

export function createCommentsTools(client: BBClient): [ToolDef] {
  const addCommentShape = {
    comment_text: z.string(),
    transaction_id_by_customer: z.number().int().optional(),
    receipt_id_by_customer: z.number().int().optional(),
  };

  const addComment = defineTool({
    name: "add_comment",
    description: "Add a comment to a transaction or a receipt (provide the matching id).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: addCommentShape,
    async handler(args) {
      const result = await client.call("commentsAdd", args);
      return ok(result);
    },
  });

  return [addComment];
}
