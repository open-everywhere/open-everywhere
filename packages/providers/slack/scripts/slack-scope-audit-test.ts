import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let n = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  n++;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const RUNBOOK_PATH = join(REPO_ROOT, "docs/deploy/surfaces/slack.md");
const runbook = readFileSync(RUNBOOK_PATH, "utf8");

const REQUIRED_SCOPES: Record<string, string[]> = {
  "auth.test": [],
  "users.info": ["users:read"],
  "conversations.info": ["channels:read", "groups:read"],
  "conversations.history": ["channels:history", "groups:history", "im:history", "mpim:history"],
  "conversations.replies": ["channels:history", "groups:history", "im:history", "mpim:history"],
  "conversations.members": ["channels:read", "groups:read"],
  "conversations.open": ["im:write"],
  "chat.postMessage": ["chat:write"],
  "chat.update": ["chat:write"],
  "assistant.threads.setStatus": ["chat:write"],
  "pins.list": ["pins:read"],
  "pins.add": ["pins:write"],
  "reactions.add": ["reactions:write"],
  "reactions.remove": ["reactions:write"],
  "files.getUploadURLExternal": ["files:write"],
  "files.completeUploadExternal": ["files:write"],
};

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(p));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const SCAN_ROOTS = [join(REPO_ROOT, "packages/providers/slack/agent"), join(REPO_ROOT, "packages/core/agent/tools")];

const CALL_PATTERNS: RegExp[] = [
  /slackForm\(\s*"([a-zA-Z.]+)"/g,
  /\.slack\.request\(\s*"([a-zA-Z.]+)"/g,
  /callSlackApi\(\{[^}]*operation:\s*"([a-zA-Z.]+)"/g,
  /callSlackRead\(\s*"([a-zA-Z.]+)"/g,
  /bridgeSlackReadCall\(\s*"([a-zA-Z.]+)"/g,
];

const found = new Set<string>();
for (const root of SCAN_ROOTS) {
  for (const file of tsFiles(root)) {
    const src = readFileSync(file, "utf8");
    for (const pattern of CALL_PATTERNS) {
      for (const m of src.matchAll(pattern)) found.add(m[1]);
    }
  }
}

ok(
  found.size >= 10,
  `scan sanity: found at least 10 distinct Slack Web API methods across the tree (found ${found.size}) — ` +
    `a near-empty result means the scan roots/patterns broke (e.g. a file move), not that the Slack ` +
    `bundle stopped calling Slack`,
);

for (const method of found) {
  ok(
    method in REQUIRED_SCOPES,
    `every called Slack method has a REQUIRED_SCOPES entry — "${method}" does not. Add it with the ` +
      `scope(s) Slack's own docs (docs.slack.dev/reference/methods/${method}) require, then add any ` +
      `new scope to docs/deploy/surfaces/slack.md's Bot Token Scopes list.`,
  );
}

for (const method of found) {
  const scopes = REQUIRED_SCOPES[method] ?? [];
  for (const scope of scopes) {
    ok(
      runbook.includes(`\`${scope}\``),
      `docs/deploy/surfaces/slack.md documents "${scope}" (required by "${method}") as a backtick-quoted ` +
        `Bot Token Scope bullet`,
    );
  }
}

console.log(`✓ slack-scope-audit: ${n} assertions passed (${found.size} distinct Slack Web API methods checked against the runbook)`);
