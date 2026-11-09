import { describe, expect, it } from "vitest";
import { attachImages, ok, withImages } from "./types.js";

describe("withImages/attachImages", () => {
  it("moves attached PNGs into MCP image content blocks after the text block", () => {
    const result = attachImages(withImages(ok({ a: 1 }), [new Uint8Array([1, 2, 3])]));
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({ type: "image", data: "AQID", mimeType: "image/png" });
    expect(result.images).toBeUndefined();
    expect(result.structuredContent).toEqual({ data: { a: 1 } });
  });

  it("leaves results without images untouched", () => {
    const plain = ok({ a: 1 });
    expect(attachImages(plain)).toBe(plain);
  });
});
