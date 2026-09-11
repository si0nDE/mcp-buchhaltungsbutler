import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

export function createCommentsTools(client: BBClient): [ToolDef] {
  const addCommentShape = {
    comment_text: z.string(),
    transaction_id_by_customer: z.number().int().optional(),
    receipt_id_by_customer: z.number().int().optional(),
  };

  const addComment = defineTool({
    name: "add_comment",
    description:
      "Add a comment to a transaction or a receipt (provide the matching id). No endpoint exists to " +
      "list, edit, or delete comments afterward — they're visible only in the BuchhaltungsButler web app.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: addCommentShape,
    async handler(args) {
      const result = await client.call("commentsAdd", args);
      return ok(result);
    },
  });

  return [addComment];
}
