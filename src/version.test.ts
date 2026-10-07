import { describe, expect, it } from "vitest";
import { compareVersions, VERSION } from "./version.js";

describe("version", () => {
  it("is CalVer yyyy.mm.dd.NNN", () => {
    expect(VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d{3}$/);
  });
  it("compares numerically", () => {
    expect(compareVersions("2026.10.07.002", "2026.10.07.001")).toBeGreaterThan(0);
    expect(compareVersions("2026.10.07.001", "2026.11.01.001")).toBeLessThan(0);
    expect(compareVersions("2026.10.07.001", "2026.10.07.001")).toBe(0);
  });
});
