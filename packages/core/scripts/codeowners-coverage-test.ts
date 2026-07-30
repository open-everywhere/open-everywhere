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

const lines = readFileSync(codeownersPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"));

const specific = lines.map((l) => l.split(/\s+/)[0]).filter((p) => p.startsWith("/"));
const catchAlls = lines.map((l) => l.split(/\s+/)[0]).filter((p) => p === "*");

ok("CODEOWNERS declares at least one specifically-owned path", specific.length > 0);
ok(
  "CODEOWNERS has a repo-wide catch-all, so an unlisted path is still review-gated",
  catchAlls.length > 0,
);
ok(
  "the catch-all comes FIRST, so every specific line below overrides it (CODEOWNERS is last-match-wins)",
  lines.findIndex((l) => l.split(/\s+/)[0] === "*") === 0,
);

function isSpecificallyOwned(repoRelPath: string): boolean {
  const abs = "/" + repoRelPath.replace(/^\/+/, "");
  return specific.some((p) => (p.endsWith("/") ? abs.startsWith(p) : abs === p));
}

for (const t of lines) {
  if (!t.startsWith("/") && t !== "*") continue;
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
    isSpecificallyOwned(t.path),
  );
}

for (const p of ["agent/memory/domains.ts", "agent/access/bundles.ts", "agent/roles/roles.ts"]) {
  ok(`access-deciding config ${p} is SPECIFICALLY codeowned (not merely catch-all)`, isSpecificallyOwned(p));
}

ok("an arbitrary source file is not SPECIFICALLY owned", !isSpecificallyOwned("packages/core/agent/hooks/memory.ts"));
ok("a root doc is not SPECIFICALLY owned", !isSpecificallyOwned("README.md"));

console.log(`\n✓ codeowners coverage: ${n} assertions passed (${BOT_PR_TARGETS.length} bot-PR targets, ${specific.length} specific paths, ${catchAlls.length} catch-all)\n`);
