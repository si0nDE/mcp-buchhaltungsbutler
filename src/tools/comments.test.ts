import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createCommentsTools } from "./comments.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("comments tools", () => {
  it("add_comment calls commentsAdd with the given fields", async () => {
    const client = mockClient({ success: true, message: "ok" });
    const [addComment] = createCommentsTools(client);

    await addComment.handler({ comment_text: "geprüft", receipt_id_by_customer: 7 });

    expect(client.call).toHaveBeenCalledWith("commentsAdd", {
      comment_text: "geprüft",
      receipt_id_by_customer: 7,
    });
  });
});
