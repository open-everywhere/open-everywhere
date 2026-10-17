import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileIfChanged } from "./write-if-changed.js";
import { assertPackageDistFresh } from "./core-dist-freshness.js";
import { renderGithubAppManifestDocs } from "@open-everywhere/provider-github/agent/app-manifest.js";

assertPackageDistFresh("packages/core", "@open-everywhere/core");
assertPackageDistFresh("packages/providers/github", "@open-everywhere/provider-github");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const PAGE = "docs/deploy/surfaces/github.md";
const BEGIN = "<!-- BEGIN GENERATED: github-app-permissions (scripts/github-app-manifest-docs.ts) -->";
const END = "<!-- END GENERATED: github-app-permissions -->";

const pagePath = join(root, PAGE);
const page = readFileSync(pagePath, "utf8");
const beginAt = page.indexOf(BEGIN);
const endAt = page.indexOf(END);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
  console.error(`✗ github-app-manifest-docs: ${PAGE} is missing the generated-section markers.\n  Expected a block delimited by:\n    ${BEGIN}\n    ${END}`);
  process.exit(1);
}

const block = renderGithubAppManifestDocs()
  .split("\n")
  .map((line) => (line === "" ? line : `   ${line}`))
  .join("\n");
const next = `${page.slice(0, beginAt)}${BEGIN}\n\n${block}\n\n   ${END}${page.slice(endAt + END.length)}`;

if (check) {
  if (next !== page) {
    console.error(
      `✗ github-app-manifest-docs: ${PAGE} does not match the GitHub App manifest's permissions and events.\n` +
        "  Run `npx tsx scripts/github-app-manifest-docs.ts` (or `npm run docs:generate`) and commit the result.",
    );
    process.exit(1);
  }
  console.log(`✓ github-app-manifest-docs: ${PAGE} matches the manifest`);
} else {
  writeFileIfChanged(pagePath, next);
  console.log(`✓ github-app-manifest-docs: wrote ${PAGE}`);
}
