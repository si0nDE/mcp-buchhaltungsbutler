import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z, ZodRawShape } from "zod";

export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  // The MCP SDK's CallToolResult (from CallToolResultSchema) allows arbitrary
  // extra properties; without this index signature, TS rejects assigning our
  // handlers to `server.registerTool`'s callback parameter.
  [x: string]: unknown;
}

export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  // Every tool sets readOnlyHint/destructiveHint explicitly (never left
  // unset) because the MCP spec's own defaults for an unannotated tool are
  // readOnlyHint: false, destructiveHint: true — silence here would make
  // every non-read tool look destructive to a spec-compliant host.
  annotations: Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint">;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>;
}

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function defineTool<Shape extends ZodRawShape>(tool: ToolDef<Shape>): ToolDef {
  return tool as unknown as ToolDef;
}
