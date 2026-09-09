import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deploymentOrg,
  ambientWorkspace,
  ambientSurface,
} from "@open-everywhere/core/agent/identity/deployment-identity.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed++;
}
function eq(actual: unknown, expected: unknown, label: string): void {
  assert.deepStrictEqual(actual, expected, label);
  passed++;
}

console.log("0. the declared identity, parsed from agent/identity/surfaces.ts:");
const surfacesSource = readFileSync(join(REPO, "agent/identity/surfaces.ts"), "utf8");
const block = /export const deploymentIdentity: DeploymentIdentity = \{([\s\S]*?)\n\};/.exec(surfacesSource);
ok(block !== null, "the `deploymentIdentity` declaration is still an object literal this file can read");
const field = (name: string): string | undefined => new RegExp(`\\b${name}:\\s*"([^"]*)"`).exec(block![1]!)?.[1];
const declared = { org: field("org"), workspace: field("workspace"), surface: field("surface") };
for (const [name, value] of Object.entries(declared)) {
  ok(typeof value === "string" && value.length > 0, `the declaration states a non-empty \`${name}\` (parsed: ${String(value)})`);
}

console.log("1. negative control — the register is empty before the boot import:");
eq(ambientWorkspace(), undefined, "before boot, ambientWorkspace() is undefined (nothing has registered)");
eq(ambientSurface(), undefined, "before boot, ambientSurface() is undefined (nothing has registered)");
ok(
  declared.workspace !== undefined,
  "the declared workspace is a real string, so it is distinguishable from the unregistered `undefined` above",
);

console.log("2. after importing the real boot module (agent/lib/register-config.ts):");
await import("../agent/lib/register-config.js");
eq(ambientWorkspace(), declared.workspace, "boot registers the DECLARED ambient workspace");
eq(ambientSurface(), declared.surface, "boot registers the DECLARED ambient surface");
eq(deploymentOrg(), declared.org, "boot registers the DECLARED org");

console.log(`\ndeployment-identity boot: ${passed} assertions passed.`);
