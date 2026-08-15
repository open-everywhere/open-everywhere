
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Binding, Bundle } from "../agent/access/bundle.js";
import type { Domain } from "../agent/memory/domain.js";
import type { MemorySilo } from "../agent/memory/silo.js";
import type { AccessRequestsConfig } from "../agent/access/config.js";

const dir = join(tmpdir(), `open-everywhere-agent-create-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "default";

const { registerSlackFixtureMapper, registerSlackTestBridge } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();
registerSlackTestBridge({ confirmChannelInternal: async () => true });

const { registerIdentityMapper } = await import("../agent/identity/binding.js");
registerIdentityMapper("teams", (ctx) => {
  const a = ((ctx as { session?: { auth?: { current?: { attributes?: Record<string, string> } } } }).session?.auth?.current?.attributes ?? {}) as Record<string, string>;
  return {
    workspace: a["workspace_id"],
    surface: a["conversation_id"],
    mode: "channel" as const,
    visibility: "private" as const,
    trust: "internal" as const,
    principalId: a["user_id"],
    ...(a["conversation_id"] ? { target: { channelId: a["conversation_id"] } } : {}),
  };
});
const teamsCtx = (conversationId: string) =>
  ({
    channel: { kind: "teams" },
    session: { auth: { current: { attributes: { workspace_id: "W1", conversation_id: conversationId, user_id: "U_ASK" }, principalId: "U_ASK" } } },
  }) as never;

const { registerConfig } = await import("../agent/access/config.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { requestApproval, handleApprovalPayload } = await import("../agent/approvals/flow.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { executeAgentCreate, requireAgentCreateConfig } = await import("../agent/approvals/agent-create.js");
const { applyAgentSpec, emitAgentsModule, parseAgentsModule, emptyAgentsFile, agentBundleName, agentSiloName } = await import(
  "../agent/memory/agents-codemod.js"
);
const { checkConsequenceRegistry, TOOL_CONSEQUENCE } = await import("../agent/access/consequence.js");
const { WINDOW_UNGATED_TOOLS, WINDOW_GATED_TOOLS } = await import("../agent/access/window-gate-manifest.js");
const { FIRE_PRINCIPAL_ATTR, FIRE_UNATTENDED_ATTR } = await import("../agent/identity/binding.js");
const createAgentTool = (await import("../agent/tools/create_agent.js")).default as { execute: (i: unknown, c: unknown) => unknown };
type AgentSpec = import("../agent/memory/agents-codemod.js").AgentSpec;
type AgentCreateArgs = import("../agent/approvals/agent-create.js").AgentCreateArgs;

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
async function rejectsWith(fn: () => Promise<unknown> | unknown, fragment: string, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes(fragment), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

const codeSilos: MemorySilo[] = [
  { name: "org-brain", provider: "sqlite" },
  { name: "ro-baseline", provider: "notion", readOnly: true },
  { name: "rw-silo", provider: "sqlite" },
];
const codeDomains: Domain[] = [
  { name: "org", match: "org", memory: "org-brain" },
  { name: "eng", channels: ["slack/T1/C_ENG", "teams/W1/CONV_ENG"], memory: "org-brain" },
];
const codeBundles: Bundle[] = [{ name: "base" }, { name: "has-connector", connectors: [{ name: "notion", credential: "k", contentOrigin: "external" }] }];
const codeBindings: Binding[] = [];

function arConfig(over: Partial<AccessRequestsConfig> = {}): AccessRequestsConfig {
  return {
    adminChannel: "C_ADMIN",
    configRepo: "acme/agent-config",
    baseBundles: () => codeBundles,
    baseBindings: () => codeBindings,
    baseAgents: emptyAgentsFile,
    baseDomains: () => codeDomains,
    baseSilos: () => codeSilos,
    ...over,
  };
}

const catalogues = [
  { connector: "notion", allows: ["api-key" as const], credentials: [{ id: "k", type: "api-key" as const, secretRef: "NOTION_K", broker: "env" }] },
];

registerConfig({
  loadBundles: () => codeBundles,
  loadConnectorCredentials: () => catalogues,
  loadBindings: () => codeBindings,
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => codeDomains,
  loadSilos: () => codeSilos,
  domainsForSurface: ({ workspaceKey, surface }) => codeDomains.filter((d) => d.channels?.includes(`${workspaceKey}/${surface}`)).map((d) => d.name),
  loadAccessRequests: () => arConfig({ dryRun: true }),
});

const liveCtx = (channelId: string) =>
  ({
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: channelId, channel_type: "channel", is_ext_shared: "false", trust_checked: "true" }, principalId: "U_ASK", principalType: "slack-user" } } },
  }) as never;

const fireCtx = (channelId: string) =>
  ({
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          authenticator: "app",
          principalId: "eve:app",
          principalType: "runtime",
          attributes: { team_id: "T1", channel_id: channelId, channel_type: "channel", is_ext_shared: "false", trust_checked: "true", [FIRE_UNATTENDED_ATTR]: "true", [FIRE_PRINCIPAL_ATTR]: "U_CREATOR" },
        },
      },
    },
  }) as never;

const noCardCtx = { channel: { kind: "local" }, session: { auth: { current: { attributes: {}, principalId: "U_ASK", principalType: "x" } } } } as never;

const newReadonly = { kind: "new-readonly" as const, provider: "notion" as const, container: "root-page" };
const existing = (silo: string) => ({ kind: "existing-silo" as const, silo });

await rejectsWith(
  () => createAgentTool.execute({ name: "helper", memory: newReadonly }, noCardCtx),
  "approval-card path",
  "tool: refuses off a surface with no domain to route a card through (OPE-338: the venue walk's no-domain shape)",
);
await rejectsWith(
  () => createAgentTool.execute({ name: "helper", memory: newReadonly }, teamsCtx("CONV_ENG")),
  "already belongs to the",
  "tool: 🔴 a card-less room the venue COULD route through gets the domain-collision refusal, not a redirected card — the two preconditions are mutually exclusive by construction",
);
await rejectsWith(
  () => createAgentTool.execute({ name: "helper", memory: newReadonly }, fireCtx("C_NEW")),
  "verified sender",
  "tool: refuses on a routine fire (no acting sender — standing-behaviour authorship needs a human)",
);
await rejectsWith(
  () => createAgentTool.execute({ name: "eng", memory: newReadonly }, liveCtx("C_NEW")),
  "already a memory domain",
  "tool: refuses a name that is already a domain",
);
await rejectsWith(
  () => createAgentTool.execute({ name: "helper", memory: newReadonly }, liveCtx("C_ENG")),
  "already belongs to the",
  "tool: refuses when the asking channel is already in a domain",
);
await rejectsWith(
  () => createAgentTool.execute({ name: "helper", memory: newReadonly, connectors: [{ name: "notarealthing", credential: "k" }] }, liveCtx("C_NEW")),
  "aren't defined in this deployment",
  "tool: refuses an undefined connector",
);
await rejectsWith(
  () => createAgentTool.execute({ name: "helper", memory: newReadonly, connectors: [{ name: "notion", credential: "ghost" }] }, liveCtx("C_NEW")),
  'no credential "ghost" configured',
  "tool: refuses a credential the connector does not configure",
);
await rejectsWith(
  () => createAgentTool.execute({ name: "helper", memory: existing("rw-silo"), exposed: true }, liveCtx("C_NEW")),
  "WRITABLE",
  "tool: an EXPOSED agent reading a writable silo is refused (curated-read-only invariant)",
);
let readOnlyExposureRefusal: string | undefined;
try {
  await createAgentTool.execute({ name: "helper", memory: existing("ro-baseline"), exposed: true }, liveCtx("C_NEW"));
} catch (err) {
  readOnlyExposureRefusal = err instanceof Error ? err.message : String(err);
}
ok(
  readOnlyExposureRefusal === undefined || !readOnlyExposureRefusal.includes("WRITABLE"),
  `tool: an EXPOSED agent reading a READ-ONLY silo clears the exposure guard — never refused for WRITABLE (got: ${readOnlyExposureRefusal ?? "no throw"})`,
);

const spec: AgentSpec = { name: "support-desk", title: "Support Desk", channels: ["slack/T1/C_AGENT"], memory: { kind: "new-readonly", provider: "notion", container: "root-page" }, connectors: [{ name: "notion", credential: "k" }], instructions: "Answer support questions from the handbook." };

const kind = actionKind("agent.create");
ok(kind !== undefined && kind.policy === "member", "kind: agent.create registered with member policy (the card is the injection gate, merge is the privilege gate)");
{
  const args = argsFor(spec);
  const lines = kind!.summarize(args);
  ok(lines[0].includes("provisioning a new agent") && lines[0].includes('"support-desk"'), "kind: summary names the agent");
  ok(lines.some((l: string) => l.includes("new READ-ONLY") && l.includes("notion")), "kind: summary renders the memory choice");
  ok(lines.some((l: string) => l.includes(agentBundleName(spec)) && l.includes("notion")), "kind: summary names the bundle + connector");
  ok(lines.some((l: string) => l.includes("acme/agent-config") && l.includes("nothing is provisioned until")), "kind: summary names the config repo + the merge-is-the-gate contract");
}

function argsFor(s: AgentSpec, over: Partial<AgentCreateArgs> = {}): AgentCreateArgs {
  return {
    org: "default",
    scopeKey: "slack/T1/C_AGENT",
    requestId: randomUUID(),
    spec: s,
    requestedBy: "U_ASK",
    channelId: "C_AGENT",
    threadTs: "1720009900.000100",
    configRepo: "acme/agent-config",
    agentsPath: "agent/memory/agents.generated.ts",
    ...over,
  };
}

await rejectsWith(() => requireAgentCreateConfig(arConfig({ adminChannel: undefined })), "isn't enabled", "config: missing admin channel fails closed");
await rejectsWith(() => requireAgentCreateConfig(arConfig({ configRepo: undefined })), "isn't enabled", "config: missing config repo fails closed");
await rejectsWith(() => requireAgentCreateConfig(arConfig({ baseAgents: undefined })), "code-declared agents baseline", "config: missing baseAgents baseline fails closed");

{
  const args = argsFor(spec);
  const outcome = await executeAgentCreate(args, "U_TAP", { config: arConfig({ dryRun: true }) });
  ok(outcome.startsWith("dry-run —") && outcome.includes("acme/agent-config") && outcome.includes(`agent-create/${args.requestId}`), "dry-run: reports repo/branch, no deps touched");
  const audit = await readAudit({ org: "default", limit: 5 });
  const entry = audit.find((a) => a.action === "agent.create.pr_opened");
  ok(entry !== undefined && (entry.detail as { dryRun?: boolean }).dryRun === true, "dry-run: still audited, flagged dryRun");
}

interface FakeState {
  branches: Record<string, string>;
  files: Record<string, { content: string; sha: string }>;
  puts: string[];
  prs: { title: string; body: string; head: string; base: string }[];
  posts: { method: string; body: URLSearchParams }[];
  threadNotes?: { platform: string; channelId: string; text: string; threadTs?: string | null }[];
  prExisting?: boolean;
  adminPostFails?: boolean;
}
function fakeDeps(state: FakeState) {
  return {
    resolveToken: async () => "tok_test",
    getBranchSha: async ({ branch }: { branch: string }) => state.branches[branch] ?? null,
    createBranch: async ({ branch, sha }: { branch: string; sha: string }) => {
      state.branches[branch] = sha;
      return "created" as const;
    },
    contents: {
      getFile: async (_repo: string, path: string, branch: string) => state.files[`${branch}:${path}`] ?? null,
      putFile: async (_repo: string, path: string, content: string, _msg: string, branch: string) => {
        state.files[`${branch}:${path}`] = { content, sha: `sha-${state.puts.length + 1}` };
        state.puts.push(content);
        return "commit-sha";
      },
    },
    createPr: async (opts: { title: string; body: string; head: string; base: string }) => {
      state.prs.push(opts);
      return { url: "https://github.com/acme/agent-config/pull/9", number: 9, updated: state.prExisting === true };
    },
    post: async (method: string, body: string) => {
      const params = new URLSearchParams(body);
      state.posts.push({ method, body: params });
      if (state.adminPostFails && params.get("channel") === "C_ADMIN") return { ok: false };
      return { ok: true, ts: "1.2" };
    },
    postThreadNote: async (platform: string, target: { channelId: string; text: string; threadTs?: string | null }) => {
      (state.threadNotes ??= []).push({ platform, ...target });
      return "note-ts";
    },
  };
}

{
  const args = argsFor(spec);
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  const outcome = await executeAgentCreate(args, "U_TAP", { config: arConfig(), ...fakeDeps(state) });

  const branch = `agent-create/${args.requestId}`;
  ok(state.branches[branch] === "base-sha", "execute: request branch cut from the base sha");
  ok(state.puts.length === 1, "execute: exactly one agents-overlay commit");
  ok(state.puts[0] === emitAgentsModule(applyAgentSpec(emptyAgentsFile(), spec).file), "execute: committed bytes are EXACTLY the deterministic codemod output");
  const parsed = parseAgentsModule(state.puts[0]!);
  ok(parsed.domains.length === 1 && parsed.silos.length === 1 && parsed.bundles.length === 1 && parsed.bindings.length === 1 && parsed.specs.length === 1, "execute: the committed module passes the round-trip-verifying read the drift lint runs, with all four derived structures + the spec");
  ok(parsed.silos[0]!.name === agentSiloName(spec) && parsed.silos[0]!.readOnly === true, "execute: the derived silo is the read-only one the codemod materialises");
  ok(state.prs.length === 1 && state.prs[0].head === branch && state.prs[0].base === "main", "execute: PR opened head→base");
  ok(state.prs[0].title.includes('Create agent "support-desk"'), "execute: PR title is the agent sentence");
  ok(
    state.prs[0].body.includes("U_ASK") && state.prs[0].body.includes("U_TAP") && state.prs[0].body.includes("```json") && state.prs[0].body.includes("Merging this PR provisions the agent"),
    "execute: PR body carries requester, sender, the frozen spec, and the merge-is-the-gate doctrine",
  );
  const admin = state.posts.find((p) => p.body.get("channel") === "C_ADMIN");
  ok(admin !== undefined && admin.body.get("text")!.includes("pull/9") && admin.body.get("text")!.includes("U_ASK"), "execute: plain admin-channel notification with PR link (no decide card)");
  const thread = (state.threadNotes ?? [])[0];
  ok(thread !== undefined && thread.threadTs === args.threadTs && thread.text.includes("pull/9"), "execute: requesting thread told where its PR went");
  ok(thread?.platform === "slack" && thread.channelId === "C_AGENT", "execute: …on the ASKING surface's own platform, derived from the frozen scopeKey — never assumed Slack");
  ok(
    !state.posts.some((p) => p.body.get("channel") === "C_AGENT"),
    "execute: …and the requester note does NOT ride the admin channel's Slack form any more (the bug: a Discord channel id sent to Slack's Web API)",
  );
  ok(outcome.includes("opened PR #9") && outcome.includes("merges it in GitHub"), "execute: outcome line for the decided card");
  const audit = await readAudit({ org: "default", limit: 8 });
  const entry = audit.find((a) => a.action === "agent.create.pr_opened" && (a.detail as { pr?: number }).pr === 9);
  ok(entry !== undefined && entry.principalId === "U_TAP", "execute: audited with the tapping member as principal");

  state.prExisting = true;
  const again = await executeAgentCreate(args, "U_TAP2", { config: arConfig(), ...fakeDeps(state) });
  ok(state.puts.length === 1, "execute(re-run): idempotent — no second agents-overlay commit");
  ok(again.includes("updated PR #9"), "execute(re-run): outcome reports the update, not a fresh PR");
}

{
  const discordSpec: AgentSpec = { name: "discord-desk", channels: ["discord/G1/C_DISCORD"], memory: newReadonly };
  const args = argsFor(discordSpec, { scopeKey: "discord/G1/C_DISCORD", channelId: "C_DISCORD" });
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  const outcome = await executeAgentCreate(args, "U_TAP", { config: arConfig(), ...fakeDeps(state) });

  const thread = (state.threadNotes ?? [])[0];
  ok(
    thread !== undefined && thread.platform === "discord" && thread.channelId === "C_DISCORD" && thread.text.includes("pull/9"),
    "execute(discord-origin): the requesting thread's note dispatches via the platform-aware poster with platform 'discord', not the Slack client",
  );
  ok(
    !state.posts.some((p) => p.body.get("channel") === "C_DISCORD"),
    "execute(discord-origin): 🔴 …and NO Slack chat.postMessage call carries the Discord channel id (the OPE-303-class bug, now closed for agent.create)",
  );
  const admin = state.posts.find((p) => p.body.get("channel") === "C_ADMIN");
  ok(admin !== undefined, "execute(discord-origin): the admin-channel note still rides the Slack `post` (adminChannel is Slack by construction)");
  ok(outcome.includes("opened PR #9") && outcome.includes("merges it in GitHub"), "execute(discord-origin): outcome line unaffected by the transport split");
}

{
  const clashSpec: AgentSpec = { name: "rival-agent", channels: ["slack/T1/C_SHARED"], memory: { kind: "new-readonly", provider: "notion" } };
  const rivalDomains: Domain[] = [...codeDomains, { name: "rival-domain", channels: ["slack/T1/C_SHARED"], memory: "org-brain" }];
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  await rejectsWith(
    () => executeAgentCreate(argsFor(clashSpec), "U_TAP", { config: arConfig({ baseDomains: () => rivalDomains }), ...fakeDeps(state) }),
    "at most one memory domain",
    "execute: invalid MERGED result refuses on channel exclusivity (ring ②)",
  );
  ok(state.puts.length === 0 && state.prs.length === 0, "execute: nothing committed, no PR opened when channel-exclusivity validation fails");
}

{
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  const poisoned = arConfig({ baseBundles: () => [...codeBundles, { name: agentBundleName(spec) }] });
  await rejectsWith(
    () => executeAgentCreate(argsFor(spec), "U_TAP", { config: poisoned, ...fakeDeps(state) }),
    "defined more than once",
    "execute: invalid MERGED result refuses on bundle collision (ring ②)",
  );
  ok(state.puts.length === 0 && state.prs.length === 0, "execute: nothing committed, no PR opened when bundle validation fails");
}

{
  const entry = TOOL_CONSEQUENCE["create_agent"];
  ok(entry !== undefined && entry.tier === "gate:member" && entry.via.kind === "action-kind" && entry.via.action === "agent.create", "governance: create_agent is gate:member via ActionKind agent.create in the consequence registry");
  const source = `approval: never(),\nasync execute() { await requestApproval({ kind: "agent.create" }); }`;
  const problems = checkConsequenceRegistry([{ name: "create_agent", source }], [], (a) => (a === "agent.create" ? "member" : undefined), { create_agent: entry! });
  ok(problems.length === 0, `governance: create_agent passes checkConsequenceRegistry (got: ${JSON.stringify(problems)})`);
  ok(WINDOW_UNGATED_TOOLS.has("create_agent") && !Object.prototype.hasOwnProperty.call(WINDOW_GATED_TOOLS, "create_agent"), "governance: create_agent is WINDOW_UNGATED (its control is the merge, not hands) and carries exactly one posture");
}

{
  const args = argsFor(spec);
  const posts: { method: string; body: URLSearchParams }[] = [];
  const post = async (method: string, body: string) => {
    posts.push({ method, body: new URLSearchParams(body) });
    return { ok: true, ts: "111.222" };
  };
  const pending = await inSession(() =>
    requestApproval(
      { org: "default", kind: "agent.create", args, scopeKey: args.scopeKey, requestedBy: args.requestedBy, channelId: args.channelId, threadTs: args.threadTs, chain: { unattended: false } },
      { post },
    ),
  );
  const card = posts.find((p) => p.method === "chat.postMessage");
  ok(card !== undefined && card.body.get("channel") === "C_AGENT" && card.body.get("thread_ts") === args.threadTs, "e2e: request card posted in the REQUESTING thread");
  ok(card!.body.get("blocks")!.includes("provisioning a new agent"), "e2e: card blocks render the agent sentence from frozen args");

  const decided = await handleApprovalPayload(
    { actions: [{ action_id: `oe_approval:approve:${pending.id}`, value: "default" }], user: { id: "U_MEMBER" }, channel: { id: "C_AGENT" }, message: { ts: "111.222" } },
    { post },
  );
  ok(decided === true, "e2e: the tap is ours and handled");
  const update = posts.find((p) => p.method === "chat.update");
  ok(update !== undefined && update.body.get("text")!.includes("dry-run —"), "e2e: member tap executed the kind (dry-run) and the card shows the outcome");
}

rmSync(dir, { recursive: true, force: true });
console.log(`agent-create-test: ${n} assertions passed`);
