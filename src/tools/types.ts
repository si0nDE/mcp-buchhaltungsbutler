import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";

export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  // The MCP SDK's CallToolResult (from CallToolResultSchema) allows arbitrary
  // extra properties; without this index signature, TS rejects assigning our
  // handlers to `server.registerTool`'s callback parameter.
  [x: string]: unknown;
}

// Every tool wraps its payload as { data } for structuredContent, so the SDK's
// output-schema validation (which requires structuredContent once outputSchema
// is set at all) has one fixed shape to check regardless of whether a given
// tool's data happens to be a list or a single record.
export const LIST_OUTPUT_SHAPE = { data: z.array(z.record(z.string(), z.unknown())) };
export const OBJECT_OUTPUT_SHAPE = { data: z.record(z.string(), z.unknown()) };

export interface ToolDef<
  Shape extends ZodRawShape = ZodRawShape,
  OutputShape extends ZodRawShape = ZodRawShape,
> {
  name: string;
  description: string;
  inputSchema: Shape;
  // Every tool sets readOnlyHint/destructiveHint explicitly (never left
  // unset) because the MCP spec's own defaults for an unannotated tool are
  // readOnlyHint: false, destructiveHint: true — silence here would make
  // every non-read tool look destructive to a spec-compliant host.
  annotations: Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint">;
  // LIST_OUTPUT_SHAPE for tools whose ok() payload is an array, OBJECT_OUTPUT_SHAPE
  // otherwise — must match what the handler actually passes to ok(), since the
  // SDK validates structuredContent against this schema on every successful call.
  outputSchema: OutputShape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>;
}

export function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: { data: data as Record<string, unknown> },
  };
}

export function defineTool<Shape extends ZodRawShape, OutputShape extends ZodRawShape>(
  tool: ToolDef<Shape, OutputShape>
): ToolDef {
  return tool as unknown as ToolDef;
}
