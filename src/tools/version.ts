import type { BBClient } from "../bb-client/client.js";
import { compareVersions, GITHUB_REPO, VERSION } from "../version.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

const TAG_PATTERN = /^v?(\d{4}\.\d{2}\.\d{2}\.\d{3})$/;

export function createVersionTools(_client?: BBClient): [ToolDef] {
  const checkForUpdate = defineTool({
    name: "check_for_update",
    description:
      "Report the running connector version (CalVer yyyy.mm.dd.count) and check whether a newer release exists on GitHub " +
      `(${GITHUB_REPO}, release tags vYYYY.MM.DD.NNN). Read-only; does not touch BuchhaltungsButler. Updating itself is ` +
      "not possible from here: the user has to pull the new Docker image / rebuild and restart the connector, then start a new session.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {},
    handler: async () => {
      const result: Record<string, unknown> = { current_version: VERSION };
      try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=100`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "mcp-buchhaltungsbutler" },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
        const tags = (await res.json()) as Array<{ name: string }>;
        const versions = tags
          .map((t) => TAG_PATTERN.exec(t.name)?.[1])
          .filter((v): v is string => !!v)
          .sort(compareVersions);
        const latest = versions.at(-1);
        result.latest_version = latest ?? null;
        result.update_available = latest ? compareVersions(latest, VERSION) > 0 : false;
        if (!latest) result.note = "No release tags found on GitHub yet.";
      } catch (e) {
        result.latest_version = null;
        result.update_available = null;
        result.note = `Update check failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      return ok(result);
    },
  });
  return [checkForUpdate];
}
