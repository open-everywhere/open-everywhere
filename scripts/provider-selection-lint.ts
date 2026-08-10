import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProviderSelection, type CoreSeamSource } from "@open-everywhere/core/agent/access/provider-selection-check.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const manifestPath = join(root, "agent/lib/providers.generated.ts");
if (!existsSync(manifestPath)) {
  console.error("✗ provider-selection-lint: agent/lib/providers.generated.ts does not exist — run `npm run oe:build` first (it is build output, not a tracked file).");
  process.exit(1);
}
const manifestSource = readFileSync(manifestPath, "utf8");
const wiringSource = readFileSync(join(root, "agent/lib/register-adapters.ts"), "utf8");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const appDependencies = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];

const coreAgentRoot = join(root, "packages/core/agent");
function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}
const coreSeams: CoreSeamSource[] = tsFiles(coreAgentRoot).map((f) => ({
  path: f.slice(coreAgentRoot.length + 1),
  source: readFileSync(f, "utf8"),
}));

const problems = checkProviderSelection({ manifestSource, wiringSource, appDependencies, coreSeams, fullCoreSweep: true });

if (problems.length > 0) {
  console.error(`✗ provider-selection-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `✓ provider-selection-lint: the generated selection agrees with the artefacts that are still authored ` +
    `(${appDependencies.length} app dependencies, the boot wiring) and every provider-plane seam across ` +
    `${coreSeams.length} core sources asks the boot gate.`,
);
