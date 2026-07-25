import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProviderSelection, type CoreSeamSource } from "@open-everywhere/core/agent/access/provider-selection-check.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const manifestSource = readFileSync(join(root, "agent/lib/providers.ts"), "utf8");
const wiringSource = readFileSync(join(root, "agent/lib/register-adapters.ts"), "utf8");

const providersRoot = join(root, "packages/providers");
const bundlesPresent = existsSync(providersRoot)
  ? readdirSync(providersRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort()
  : [];

const appStubs = new Map<string, string>();
for (const sub of ["channels", "tools"]) {
  const dir = join(root, "agent", sub);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
    appStubs.set(`${sub}/${f.replace(/\.ts$/u, "")}`, readFileSync(join(dir, f), "utf8"));
  }
}

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

const problems = checkProviderSelection({ manifestSource, wiringSource, bundlesPresent, appStubs, appDependencies, coreSeams, fullCoreSweep: true });

if (problems.length > 0) {
  console.error(`✗ provider-selection-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `✓ provider-selection-lint: the declared selection agrees with every artefact that implements it ` +
    `(${bundlesPresent.length} bundle dir(s), ${appStubs.size} app-tree stub(s), ${appDependencies.length} app dependencies) ` +
    `and every provider-plane seam across ${coreSeams.length} core sources asks the boot gate.`,
);
