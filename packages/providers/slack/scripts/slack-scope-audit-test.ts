import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let n = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  n++;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const RUNBOOK_PATH = join(REPO_ROOT, "docs/deploy/surfaces/slack.md");
const runbook = readFileSync(RUNBOOK_PATH, "utf8");
const WIZARD_PATH = join(REPO_ROOT, "packages/create/src/steps/slack.ts");
const wizard = readFileSync(WIZARD_PATH, "utf8");

const REQUIRED_SCOPES: Record<string, string[]> = {
  "auth.test": [],
  "users.info": ["users:read"],
  "conversations.info": ["channels:read", "groups:read", "im:read", "mpim:read"],
  "conversations.history": ["channels:history", "groups:history", "im:history", "mpim:history"],
  "conversations.replies": ["channels:history", "groups:history", "im:history", "mpim:history"],
  "conversations.members": ["channels:read", "groups:read", "im:read", "mpim:read"],
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

const botBlock = /\bbot:\s*\[([\s\S]*?)\]/.exec(wizard);
ok(botBlock !== null, `packages/create/src/steps/slack.ts still declares its bot scopes as a literal \`bot: [ … ]\` array`);
const manifestScopes = [...(botBlock?.[1] ?? "").matchAll(/"([a-z_]+:[a-z_]+)"/g)].map((m) => m[1] as string);
ok(
  manifestScopes.length >= 10,
  `parse sanity: the wizard manifest declares at least 10 bot scopes (found ${manifestScopes.length}) — ` +
    `a near-empty result means the text parse broke, not that the wizard stopped requesting scopes`,
);

for (const scope of manifestScopes) {
  ok(
    runbook.includes(`\`${scope}\``),
    `docs/deploy/surfaces/slack.md documents "${scope}" (requested by the install wizard's manifest, ` +
      `packages/create/src/steps/slack.ts) as a backtick-quoted Bot Token Scope bullet — the manifest may ` +
      `request FEWER scopes than the runbook, never ones the runbook doesn't explain`,
  );
}

const ROSTER_METHODS = ["conversations.info", "conversations.members"] as const;
ok(
  wizard.includes('"message.im"'),
  `the wizard manifest still subscribes \`message.im\` — RULE B's justification is that the minimal ` +
    `starter ships DMs ON; if that changed, re-derive the rule instead of deleting it`,
);
for (const method of ROSTER_METHODS) {
  ok(found.has(method), `scan sanity: "${method}" is still called in the tree (RULE B is about its scopes)`);
  for (const scope of REQUIRED_SCOPES[method] ?? []) {
    ok(
      manifestScopes.includes(scope),
      `the install wizard's manifest (packages/create/src/steps/slack.ts) requests "${scope}" — required by ` +
        `"${method}", which the governance roster calls on every room an approval card or a member-tier ` +
        `click lands in, DMs and group DMs included. Omitting it makes approvals in DMs fail on an ` +
        `unresolvable roster while ordinary chat keeps working (OPE-332).`,
    );
  }
}

const SELF_ADMISSION_SCOPES = ["channels:join"] as const;
for (const scope of SELF_ADMISSION_SCOPES) {
  ok(
    !runbook.includes(`\`${scope}\``),
    `🔴 docs/deploy/surfaces/slack.md must NOT document "${scope}" as a Bot Token Scope. It is the scope ` +
      `conversations.join requires, i.e. the one that lets the bot ADD ITSELF to a channel — and we publish ` +
      `that the agent can only read rooms it was put into and cannot put itself into one. Adding it would ` +
      `silently falsify that claim. See this section's header before changing anything here.`,
  );
  ok(
    !manifestScopes.includes(scope),
    `🔴 the install wizard's manifest (packages/create/src/steps/slack.ts) must NOT request "${scope}" — ` +
      `it is what a deployer actually grants on Slack's consent screen, so a scope here is a scope the bot ` +
      `really holds. See this section's header.`,
  );
}

const PROD_SCAN_ROOTS = [join(REPO_ROOT, "packages"), join(REPO_ROOT, "agent")];
const prodFiles = PROD_SCAN_ROOTS.flatMap(tsFiles).filter(
  (f) => !f.split(sep).includes("scripts") && !f.split(sep).includes("generated") && !f.endsWith("docs-generated.ts"),
);
ok(
  prodFiles.length >= 100,
  `scan sanity: the production .ts scan found at least 100 files (found ${prodFiles.length}) — a near-empty ` +
    `result means the roots/filters broke, not that the fence below is satisfied`,
);

const SELF_ADMISSION_METHODS = ["conversations.join", "channels.join"] as const;
for (const method of SELF_ADMISSION_METHODS) {
  const callers = prodFiles.filter((f) => new RegExp(`["'\`]${method.replace(".", "\\.")}["'\`]`).test(readFileSync(f, "utf8")));
  ok(
    callers.length === 0,
    `🔴 no production file may call "${method}" — it is how a Slack app adds ITSELF to a channel, and we ` +
      `publish that the agent cannot do that. Found in: ${callers.join(", ")}. See this section's header.`,
  );
}

const slackTokenEnvVars = new Set<string>();
for (const f of prodFiles) {
  for (const m of readFileSync(f, "utf8").matchAll(/SLACK_[A-Z0-9_]*TOKEN/g)) slackTokenEnvVars.add(m[0]);
}
ok(
  slackTokenEnvVars.size === 1 && slackTokenEnvVars.has("SLACK_BOT_TOKEN"),
  `🔴 production code may read exactly ONE Slack token env var, SLACK_BOT_TOKEN — found ` +
    `{${[...slackTokenEnvVars].sort().join(", ")}}. A Slack USER token is the one credential that CAN read ` +
    `public channels the app was never added to, which is precisely what we publish the agent cannot do. ` +
    `If a second token is genuinely needed, prove it is not a user token and update this section's header.`,
);

const slackRead = readFileSync(join(REPO_ROOT, "packages/providers/slack/agent/channels/slack-read.ts"), "utf8");
ok(
  slackRead.includes("SLACK_BOT_TOKEN"),
  `the Slack read chokepoint (agent/channels/slack-read.ts callSlackRead) still resolves SLACK_BOT_TOKEN — ` +
    `the bot-token-only property is what makes Slack return not_in_channel for unjoined public channels`,
);
const READ_METHODS = ["conversations.history", "conversations.replies"] as const;
for (const method of READ_METHODS) {
  ok(found.has(method), `scan sanity: "${method}" is still a called read method (the self-admission fence is about its reach)`);
}

console.log(
  `✓ slack-scope-audit: ${n} assertions passed (${found.size} distinct Slack Web API methods checked against the ` +
    `runbook; ${manifestScopes.length} wizard-manifest scopes checked both ways; self-admission fence over ` +
    `${SELF_ADMISSION_SCOPES.length} scope(s) + ${SELF_ADMISSION_METHODS.length} method(s) across ${prodFiles.length} production files)`,
);
