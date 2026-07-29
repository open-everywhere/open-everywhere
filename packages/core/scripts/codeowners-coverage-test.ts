import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const codeownersPath = join(repoRoot, ".github", "CODEOWNERS");

ok("the repo has a .github/CODEOWNERS", existsSync(codeownersPath));

const patterns = readFileSync(codeownersPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"))
  .map((l) => l.split(/\s+/)[0])
  .filter((p) => p.startsWith("/"));

ok("CODEOWNERS declares at least one owned path", patterns.length > 0);

function isOwned(repoRelPath: string): boolean {
  const abs = "/" + repoRelPath.replace(/^\/+/, "");
  return patterns.some((p) => (p.endsWith("/") ? abs.startsWith(p) : abs === p));
}

for (const line of readFileSync(codeownersPath, "utf8").split("\n")) {
  const t = line.trim();
  if (t.length === 0 || t.startsWith("#") || !t.startsWith("/")) continue;
  ok(`CODEOWNERS line "${t.split(/\s+/)[0]}" names an owner`, /\s+@\S+/.test(t));
}

const BOT_PR_TARGETS: readonly { path: string; flow: string }[] = [
  { path: "agent/access/grants.json", flow: "request_access (access/grants-codemod.ts)" },
  { path: "agent/access/credential-bindings.json", flow: "credential binding (access/credential-bindings-codemod.ts)" },
  { path: "agent/webhooks/hooks.json", flow: "declare_webhook (webhooks/hooks-codemod.ts)" },
];

for (const t of BOT_PR_TARGETS) {
  ok(
    `bot-PR target ${t.path} is CODEOWNED — the merge is the gate for ${t.flow}`,
    isOwned(t.path),
  );
}

for (const p of ["agent/memory/domains.ts", "agent/access/bundles.ts", "agent/roles/roles.ts"]) {
  ok(`access-deciding config ${p} is CODEOWNED`, isOwned(p));
}

ok("the matcher does not claim an arbitrary source file is owned", !isOwned("packages/core/agent/hooks/memory.ts"));
ok("the matcher does not claim the repo root is owned", !isOwned("README.md"));

console.log(`\n✓ codeowners coverage: ${n} assertions passed (${BOT_PR_TARGETS.length} bot-PR targets, ${patterns.length} owned paths)\n`);
