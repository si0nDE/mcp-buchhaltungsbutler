// CalVer yyyy.mm.dd.count (count = running number of releases on that day).
// Maintained by `npm run release` (scripts/release.ts); do not edit by hand.
export const VERSION = "2026.10.10.006";

export const GITHUB_REPO = "si0nDE/mcp-buchhaltungsbutler";

/** Compares two CalVer strings numerically; negative if a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
