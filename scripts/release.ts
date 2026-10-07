// Usage: npm run release
// Bumps to the next CalVer yyyy.mm.dd.NNN (NNN = existing tags of today + 1), writes src/version.ts and
// package.json/package-lock.json (semver form yyyy.mmdd.N, since npm rejects leading zeros), commits and tags.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

const now = new Date();
const yyyy = String(now.getFullYear());
const mm = String(now.getMonth() + 1).padStart(2, "0");
const dd = String(now.getDate()).padStart(2, "0");
const prefix = `v${yyyy}.${mm}.${dd}.`;

const count = git("tag", "--list", `${prefix}*`).split("\n").filter(Boolean).length + 1;
const version = `${yyyy}.${mm}.${dd}.${String(count).padStart(3, "0")}`;
const semver = `${yyyy}.${mm}${dd}.${count}`;

writeFileSync(
  "src/version.ts",
  readFileSync("src/version.ts", "utf8").replace(/VERSION = "[^"]+"/, `VERSION = "${version}"`)
);
for (const file of ["package.json", "package-lock.json"]) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.version = semver;
  if (json.packages?.[""]) json.packages[""].version = semver;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

git("add", "src/version.ts", "package.json", "package-lock.json");
git("commit", "-m", `release: v${version}`);
git("tag", `v${version}`);
console.log(`Released v${version}. Publish with: git push && git push origin v${version}`);
