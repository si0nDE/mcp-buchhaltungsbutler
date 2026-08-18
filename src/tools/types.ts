import type { z, ZodRawShape } from "zod";

export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>;
}

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function defineTool<Shape extends ZodRawShape>(tool: ToolDef<Shape>): ToolDef {
  return tool as unknown as ToolDef;
}
