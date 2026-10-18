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
const MANIFEST_PATH = join(REPO_ROOT, "packages/providers/slack/agent/app-manifest.ts");
const manifestSource = readFileSync(MANIFEST_PATH, "utf8");

const REQUIRED_SCOPES: Record<string, string[]> = {
  "auth.test": [],
  "users.info": ["users:read"],
  "users.list": ["users:read"],
  "conversations.info": ["channels:read", "groups:read", "im:read", "mpim:read"],
  "conversations.history": ["channels:history", "groups:history", "im:history", "mpim:history"],
  "conversations.replies": ["channels:history", "groups:history", "im:history", "mpim:history"],
  "conversations.members": ["channels:read", "groups:read", "im:read", "mpim:read"],
  "conversations.open": ["im:write"],
  "chat.postMessage": ["chat:write"],
  "chat.update": ["chat:write"],
  "chat.postEphemeral": ["chat:write"],
  "assistant.threads.setStatus": ["chat:write"],
  "pins.list": ["pins:read"],
  "pins.add": ["pins:write"],
  "reactions.add": ["reactions:write"],
  "reactions.remove": ["reactions:write"],
  "files.getUploadURLExternal": ["files:write"],
  "files.completeUploadExternal": ["files:write"],
  "chat.getPermalink": [],
  "views.open": [],
  "chat.delete": ["chat:write"],
  "chat.scheduleMessage": ["chat:write"],
  "chat.startStream": ["chat:write"],
  "chat.appendStream": ["chat:write"],
  "chat.stopStream": ["chat:write"],
  "apps.manifest.create": [],
  "oauth.v2.access": [],
  "views.publish": [],
  "users.conversations": ["channels:read", "groups:read"],
  "files.info": ["files:read"],
  "conversations.canvases.create": ["canvases:write"],
  "canvases.edit": ["canvases:write"],
  "canvases.sections.lookup": ["canvases:read"],
  "canvases.create": ["canvases:write"],
  "slackLists.items.list": ["lists:read"],
  "slackLists.items.create": ["lists:write"],
  "slackLists.items.update": ["lists:write"],
};

const NOT_SLACK_METHODS: Record<string, string> = {
  "chat.dm": "an OE action id (approvals/chat-dm.ts), not a Web API method",
  "chat.post": "an OE action id (approvals/chat-post.ts), not a Web API method",
  "files.slack.com": "the Slack file HOST (access/slack-attachment-fetch.ts) — its scope is in NON_METHOD_SCOPES",
  "files.pythonhosted.org": "a PyPI host (access/bundle.ts)",
  "api.github.com": "a GitHub host",
  "api.deepinfra.com": "the DeepInfra transcription host the sovereignty report names (ops/sovereignty-facts.ts)",
  "api.vendor.com": "an example host in a doc string (access/credential-endpoints.ts)",
  "api.apiBaseUrl": "eve's channel-config option path in an error label (eve transport.js), not a Web API method",
  "api.fileBaseUrl": "eve's channel-config option path in an error label (eve transport.js), not a Web API method",
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
  /callSlackWebApi\(\{[^}]*operation:\s*"([a-zA-Z.]+)"/g,
  /callSlackRead\(\s*"([a-zA-Z.]+)"/g,
  /bridgeSlackReadCall\(\s*"([a-zA-Z.]+)"/g,
  /\bcall\(\s*"([a-zA-Z.]+)"/g,
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

const SLACK_METHOD_FAMILIES =
  "(?:api|apps|assistant|auth|bookmarks|bots|calls|canvases|chat|conversations|dialog|dnd|emoji|files|oauth|pins|reactions|reminders|rtm|search|slackLists|stars|team|usergroups|users|views|workflows)";
const SLACK_METHOD_BODY = String.raw`(${SLACK_METHOD_FAMILIES}\.[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*)`;
const SLACK_METHOD_LITERAL_TS = new RegExp(`["']${SLACK_METHOD_BODY}["']`, "g");
const SLACK_METHOD_LITERAL_JS = new RegExp("[\"'`]" + SLACK_METHOD_BODY + "[\"'`]", "g");
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
const EVE_SLACK_DIR = join(REPO_ROOT, "node_modules/eve/dist/src/public/channels/slack");
const eveSlackFiles = readdirSync(EVE_SLACK_DIR).filter((f) => f.endsWith(".js")).map((f) => join(EVE_SLACK_DIR, f));
ok(eveSlackFiles.length >= 10, `scan sanity: eve's Slack channel has at least 10 .js files at ${EVE_SLACK_DIR} (found ${eveSlackFiles.length})`);
const wideFiles = [
  ...tsFiles(join(REPO_ROOT, "packages/providers/slack/agent")),
  ...tsFiles(join(REPO_ROOT, "packages/core/agent")),
  ...eveSlackFiles,
].filter((f) => !f.split(sep).includes("generated") && !f.endsWith("docs-generated.ts"));
const wideFound = new Map<string, string>();
const eveFound = new Set<string>();
for (const file of wideFiles) {
  const pattern = file.startsWith(EVE_SLACK_DIR) ? SLACK_METHOD_LITERAL_JS : SLACK_METHOD_LITERAL_TS;
  for (const m of stripComments(readFileSync(file, "utf8")).matchAll(pattern)) {
    const literal = m[1] as string;
    if (literal in NOT_SLACK_METHODS) continue;
    if (!wideFound.has(literal)) wideFound.set(literal, file.slice(REPO_ROOT.length + 1));
    if (file.startsWith(EVE_SLACK_DIR)) eveFound.add(literal);
  }
}
ok(eveFound.size >= 5, `scan sanity: eve's Slack channel names at least 5 Slack methods (found ${[...eveFound].sort().join(", ")})`);
for (const literal of wideFound.keys()) found.add(literal);

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

const codeOnly = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
const botBlock = /\bbot:\s*\[([\s\S]*?)\]/.exec(codeOnly(manifestSource));
ok(botBlock !== null, `packages/providers/slack/agent/app-manifest.ts still declares its bot scopes as a literal \`bot: [ … ]\` array`);
const manifestScopes = [...(botBlock?.[1] ?? "").matchAll(/"([a-z_]+:[a-z_]+)"/g)].map((m) => m[1] as string);
ok(
  manifestScopes.length >= 10,
  `parse sanity: the app manifest declares at least 10 bot scopes (found ${manifestScopes.length}) — ` +
    `a near-empty result means the text parse broke, not that the manifest stopped requesting scopes`,
);

for (const scope of manifestScopes) {
  ok(
    runbook.includes(`\`${scope}\``),
    `docs/deploy/surfaces/slack.md documents "${scope}" (requested by the bundle's app manifest, ` +
      `packages/providers/slack/agent/app-manifest.ts) as a backtick-quoted Bot Token Scope bullet — the manifest may ` +
      `request FEWER scopes than the runbook, never ones the runbook doesn't explain`,
  );
}

const ROSTER_METHODS = ["conversations.info", "conversations.members"] as const;
ok(
  manifestSource.includes('"message.im"'),
  `the app manifest still subscribes \`message.im\` — RULE B's justification is that the minimal ` +
    `starter ships DMs ON; if that changed, re-derive the rule instead of deleting it`,
);
for (const method of ROSTER_METHODS) {
  ok(found.has(method), `scan sanity: "${method}" is still called in the tree (RULE B is about its scopes)`);
  for (const scope of REQUIRED_SCOPES[method] ?? []) {
    ok(
      manifestScopes.includes(scope),
      `the bundle's app manifest (packages/providers/slack/agent/app-manifest.ts) requests "${scope}" — required by ` +
        `"${method}", which the governance roster calls on every room an approval card or a member-tier ` +
        `click lands in, DMs and group DMs included. Omitting it makes approvals in DMs fail on an ` +
        `unresolvable roster while ordinary chat keeps working (OPE-332).`,
    );
  }
}

const NON_METHOD_SCOPES: readonly { file: string; marker: string; scopes: readonly string[]; why: string }[] = [
  {
    file: "packages/providers/slack/agent/access/slack-attachment-fetch.ts",
    marker: "export async function fetchSlackAttachment(",
    scopes: ["files:read"],
    why: "the bot-token download of a file's url_private (describe_image); Slack serves it only to an app with files:read",
  },
];
const OPTIONAL_SCOPES: readonly string[] = ["chat:write.customize"];
const codeNeededScopes = new Map<string, string>();
for (const method of found) {
  for (const scope of REQUIRED_SCOPES[method] ?? []) codeNeededScopes.set(scope, `the Web API method "${method}"`);
}
for (const site of NON_METHOD_SCOPES) {
  const src = readFileSync(join(REPO_ROOT, site.file), "utf8");
  ok(src.includes(site.marker), `NON_METHOD_SCOPES entry is live: ${site.file} still contains "${site.marker}"`);
  for (const scope of site.scopes) codeNeededScopes.set(scope, `${site.file} (${site.why})`);
}
ok(codeNeededScopes.size >= 15, `RULE C sanity: the code needs at least 15 distinct scopes (found ${codeNeededScopes.size})`);
for (const [scope, neededBy] of codeNeededScopes) {
  if (OPTIONAL_SCOPES.includes(scope)) continue;
  ok(
    manifestScopes.includes(scope),
    `the manifest (packages/providers/slack/agent/app-manifest.ts) requests "${scope}" — needed by ${neededBy}. ` +
      `Without it the feature fails on every install made from the manifest. If the scope is genuinely ` +
      `optional, add it to OPTIONAL_SCOPES with the fallback named.`,
  );
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
    `🔴 the bundle's app manifest (packages/providers/slack/agent/app-manifest.ts) must NOT request "${scope}" — ` +
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
    `runbook; ${manifestScopes.length} app-manifest scopes checked both ways; self-admission fence over ` +
    `${SELF_ADMISSION_SCOPES.length} scope(s) + ${SELF_ADMISSION_METHODS.length} method(s) across ${prodFiles.length} production files)`,
);
