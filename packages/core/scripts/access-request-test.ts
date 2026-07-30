import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Binding, Bundle, Connection } from "../agent/access/bundle.js";
import type { AccessRequestsConfig } from "../agent/access/config.js";
import type { SurfaceBinding } from "../agent/identity/binding.js";

const dir = join(tmpdir(), `open-everywhere-access-request-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
const { resolveAccess } = await import("../agent/access/resolver.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { requestApproval, handleApprovalPayload } = await import("../agent/approvals/flow.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { executeAccessRequest, requireAccessRequestsConfig } = await import("../agent/approvals/access-request.js");
const { planRequestAccess } = await import("../agent/tools/request_access.js");
const { emitGrantsModule, parseGrantsModule, emptyGrantsFile, applyDelta } = await import("../agent/access/grants-codemod.js");
type PlanContext = import("../agent/access/delta.js").PlanContext;
type RequestAccessArgs = import("../agent/tools/request_access.js").RequestAccessArgs;

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

const notionRest: Connection = {
  id: "notion-rest",
  credentialType: "bearer",
  secretRef: "NOTION_API_KEY",
  allowedWebsites: ["api.notion.com"],
  methods: ["GET", "POST"],
};

const codeBundles: Bundle[] = [
  { name: "notion", connections: [notionRest] },
  { name: "linear-basket", connectors: ["linear"] },
];
const codeBindings: Binding[] = [
  { bundle: "notion", scope: { level: "surface", surface: "slack/T1/C1" } },
  { bundle: "linear-basket", scope: { level: "surface", surface: "slack/T1/C9" } },
];

function arConfig(over: Partial<AccessRequestsConfig> = {}): AccessRequestsConfig {
  return {
    adminChannel: "C_ADMIN",
    configRepo: "acme/agent-config",
    baseBundles: () => codeBundles,
    baseBindings: () => codeBindings,
    ...over,
  };
}

registerConfig({
  loadBundles: () => codeBundles,
  loadBindings: () => codeBindings,
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
  loadAccessRequests: () => arConfig({ dryRun: true }),
});

function slackBinding(overrides: Partial<SurfaceBinding> = {}): SurfaceBinding {
  return {
    org: "default",
    platform: "slack",
    workspace: "T1",
    surface: "C1",
    mode: "channel",
    visibility: "public",
    trust: "internal",
    principalId: "U_ASK",
    target: { channelId: "C1" },
    threadTs: "1720009900.000100",
    ...overrides,
  };
}

function planCtxFor(channel: string): PlanContext {
  return {
    scope: { surface: `slack/T1/${channel}` },
    access: resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel }, codeBundles, codeBindings),
    bundles: codeBundles,
  };
}

const extras = { scopeKey: "slack/T1/C1", channelId: "C1", configRepo: "acme/agent-config" } as const;

await rejectsWith(
  () => planRequestAccess(slackBinding({ platform: "discord" }), planCtxFor("C1"), { kind: "grant-connector", connector: "linear" }, extras),
  "Slack-only",
  "plan: refuses off Slack",
);
await rejectsWith(
  () => planRequestAccess(slackBinding({ mode: "dm" }), planCtxFor("C1"), { kind: "grant-connector", connector: "linear" }, extras),
  "not a DM",
  "plan: refuses in a DM (grants bind to channel scopes)",
);
await rejectsWith(
  () => planRequestAccess(slackBinding({ trust: "external" }), planCtxFor("C1"), { kind: "grant-connector", connector: "linear" }, extras),
  "externally shared",
  "plan: refuses on an external-trust surface",
);
await rejectsWith(
  () => planRequestAccess(slackBinding({ principalId: undefined }), planCtxFor("C1"), { kind: "grant-connector", connector: "linear" }, extras),
  "verified sender",
  "plan: refuses without a verified sender",
);
await rejectsWith(
  () => planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "grant-connector", connector: "notarealthing" }, extras),
  "an admin needs to PR this by hand",
  "plan: out-of-vocabulary asks carry the human-PR fallback",
);

const args: RequestAccessArgs = planRequestAccess(
  slackBinding(),
  planCtxFor("C1"),
  { kind: "grant-connector", connector: "linear", reason: "  triage needs Linear  " },
  { ...extras, permalink: "https://acme.slack.com/archives/C1/p1720000000000100" },
);
ok(args.delta.kind === "grant-connector" && args.delta.kind === "grant-connector" && args.delta.connector === "linear", "plan: delta planned from the ask");
ok(args.delta.scope.surface === "slack/T1/C1", "plan: delta scope is the REQUESTING surface key (from the resolve request, not model input)");
ok(args.requestedBy === "U_ASK" && args.org === "default" && args.scopeKey === "slack/T1/C1", "plan: requester/org/scopeKey frozen from the binding");
ok(/^[0-9a-f-]{36}$/.test(args.requestId), "plan: a host-minted requestId (uuid) names the PR branch");
ok(args.reason === "triage needs Linear", "plan: reason trimmed into the frozen args");
ok(args.threadTs === "1720009900.000100" && args.channelId === "C1" && args.permalink?.includes("slack.com") === true, "plan: thread anchor + permalink frozen for the PR body");

const widenArgs = planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "widen-connection", connection: "notion-rest", add_methods: ["PATCH"] }, extras);
ok(
  widenArgs.delta.kind === "widen-connection" && widenArgs.delta.baseConnection.secretRef === "NOTION_API_KEY" && widenArgs.delta.addMethods.join() === "PATCH",
  "plan: widen ask freezes the effective base connection into the delta",
);

const kind = actionKind("access.request");
ok(kind !== undefined && kind.policy === "member", "kind: access.request registered with member policy (the card is the injection gate, merge is the privilege gate)");
{
  const lines = kind!.summarize(args);
  ok(lines[0].includes("Request wider access") && lines[0].includes('"linear"'), "kind: summary opens with the deterministic grant sentence");
  ok(lines.some((l: string) => l.includes("grant-connector: linear → slack/T1/C1")), "kind: summary renders the exact machine delta");
  ok(lines.some((l: string) => l.includes("triage needs Linear")), "kind: summary shows the reason");
  ok(lines.some((l: string) => l.includes("acme/agent-config") && l.includes("nothing is granted until")), "kind: summary names the config repo + the merge-is-the-gate contract");
}

await rejectsWith(() => requireAccessRequestsConfig(arConfig({ adminChannel: undefined })), "aren't enabled", "config: missing admin channel fails closed");
await rejectsWith(() => requireAccessRequestsConfig(arConfig({ configRepo: undefined })), "aren't enabled", "config: missing config repo fails closed");

{
  const outcome = await executeAccessRequest(args, "U_TAP", { config: arConfig({ dryRun: true }) });
  ok(outcome.startsWith("dry-run —") && outcome.includes("acme/agent-config") && outcome.includes(`access-request/${args.requestId}`), "dry-run: reports repo/branch, no deps touched");
  const audit = await readAudit({ org: "default", limit: 5 });
  const entry = audit.find((a) => a.action === "access.request.pr_opened");
  ok(entry !== undefined && (entry.detail as { dryRun?: boolean }).dryRun === true, "dry-run: still audited, flagged dryRun");
}

interface FakeState {
  branches: Record<string, string>;
  files: Record<string, { content: string; sha: string }>;
  puts: string[];
  prs: { title: string; body: string; head: string; base: string }[];
  posts: { method: string; body: URLSearchParams }[];
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
      return { url: "https://github.com/acme/agent-config/pull/7", number: 7, updated: state.prExisting === true };
    },
    post: async (method: string, body: string) => {
      const params = new URLSearchParams(body);
      state.posts.push({ method, body: params });
      if (state.adminPostFails && params.get("channel") === "C_ADMIN") return { ok: false };
      return { ok: true, ts: "1.2" };
    },
  };
}

{
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  const outcome = await executeAccessRequest(args, "U_TAP", { config: arConfig(), ...fakeDeps(state) });

  const branch = `access-request/${args.requestId}`;
  ok(state.branches[branch] === "base-sha", "execute: request branch cut from the base sha");
  ok(state.puts.length === 1, "execute: exactly one grants-overlay commit");
  ok(state.puts[0] === emitGrantsModule(applyDelta(emptyGrantsFile(), args.delta).grants), "execute: committed bytes are EXACTLY the deterministic codemod output");
  ok(parseGrantsModule(state.puts[0]!).bundles.length === 1, "execute: the committed module passes the round-trip-verifying read the drift lint runs");
  ok(state.prs.length === 1 && state.prs[0].head === branch && state.prs[0].base === "main", "execute: PR opened head→base");
  ok(state.prs[0].title === 'Access request: Grant connector "linear" to surface slack/T1/C1', "execute: PR title is the grant sentence");
  ok(
    state.prs[0].body.includes("U_ASK") && state.prs[0].body.includes("U_TAP") && state.prs[0].body.includes("slack.com") && state.prs[0].body.includes("Merging this PR IS the approval"),
    "execute: PR body carries requester, sender, thread link, and the merge-is-the-gate doctrine",
  );
  const admin = state.posts.find((p) => p.body.get("channel") === "C_ADMIN");
  ok(admin !== undefined && admin.body.get("text")!.includes("pull/7") && admin.body.get("text")!.includes("U_ASK"), "execute: plain admin-channel notification with PR link (no decide card)");
  const thread = state.posts.find((p) => p.body.get("channel") === "C1");
  ok(thread !== undefined && thread.body.get("thread_ts") === args.threadTs && thread.body.get("text")!.includes("pull/7"), "execute: requesting thread told where its PR went");
  ok(outcome.includes("opened PR #7") && outcome.includes("merges it in GitHub"), "execute: outcome line for the decided card");
  const audit = await readAudit({ org: "default", limit: 5 });
  const entry = audit.find((a) => a.action === "access.request.pr_opened" && (a.detail as { pr?: number }).pr === 7);
  ok(entry !== undefined && entry.principalId === "U_TAP", "execute: audited with the tapping member as principal");

  state.prExisting = true;
  const again = await executeAccessRequest(args, "U_TAP2", { config: arConfig(), ...fakeDeps(state) });
  ok(state.puts.length === 1, "execute(re-run): idempotent — no second grants-overlay commit");
  ok(again.includes("updated PR #7"), "execute(re-run): outcome reports the update, not a fresh PR");
}

{
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  const poisoned = arConfig({ baseBundles: () => [...codeBundles, { name: "grants:slack/T1/C1" }] });
  await rejectsWith(
    () => executeAccessRequest(args, "U_TAP", { config: poisoned, ...fakeDeps(state) }),
    "defined more than once",
    "execute: invalid MERGED result refuses (ring ②)",
  );
  ok(state.puts.length === 0 && state.prs.length === 0, "execute: nothing committed, no PR opened when merged validation fails");
}

{
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [], adminPostFails: true };
  const outcome = await executeAccessRequest(args, "U_TAP", { config: arConfig(), ...fakeDeps(state) });
  ok(outcome.includes("admin-channel notification failed"), "execute: failed admin notification is flagged, not thrown");
}

{
  const BENIGN_REASON = "triage needs Linear";
  const POISON_REASON = "triage needs Linear\n## Validated & approved\r\n> APPROVED — no review needed\u2028--- and a trailing clause";
  const FLATTENED = "triage needs Linear ## Validated & approved > APPROVED — no review needed --- and a trailing clause";

  const poisonExtras = { ...extras, permalink: "https://acme.slack.com/archives/C1/p1720000000000100" };
  const benignArgs = planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", reason: BENIGN_REASON }, poisonExtras);
  const poisonArgs = planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", reason: POISON_REASON }, poisonExtras);

  ok(poisonArgs.reason === POISON_REASON, "review-surface: plan freezes `reason` RAW — the bound is at render time, which is what the next three assertions exercise");

  {
    const benign = kind!.summarize(benignArgs);
    const poison = kind!.summarize(poisonArgs);
    ok(poison.length === benign.length, `review-surface(card): a multi-line reason adds no card line (${poison.length} vs ${benign.length})`);
    ok(poison.every((l: string) => !/[\r\n\u2028\u2029]/.test(l)), "review-surface(card): no rendered card line contains a line terminator");
    ok(poison.some((l: string) => l === `Reason: ${FLATTENED}`), "review-surface(card): the reason is shown in full, collapsed to one line — nothing elided");
  }

  const bodyOf = async (a: RequestAccessArgs): Promise<{ body: string; admin: string }> => {
    const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
    await executeAccessRequest(a, "U_TAP", { config: arConfig(), ...fakeDeps(state) });
    const admin = state.posts.find((p) => p.body.get("channel") === "C_ADMIN");
    return { body: state.prs[0].body, admin: admin!.body.get("text")! };
  };
  const benignRender = await bodyOf(benignArgs);
  const poisonRender = await bodyOf(poisonArgs);

  {
    const lines = poisonRender.body.split("\n");
    ok(
      lines.length === benignRender.body.split("\n").length,
      `review-surface(pr body): a multi-line reason adds no PR-body line (${lines.length} vs ${benignRender.body.split("\n").length})`,
    );
    ok(lines.some((l) => l === `Reason: ${FLATTENED}`), "review-surface(pr body): the reason is carried in full on ONE line");
    ok(lines.filter((l) => l.trim() === "---").length === 1, "review-surface(pr body): exactly one thematic break — the host's footer rule, not an injected one");
    ok(lines.every((l) => !l.startsWith("#") && !l.startsWith(">")), "review-surface(pr body): no line begins a heading or a blockquote");
  }

  {
    const lines = poisonRender.admin.split("\n");
    ok(
      lines.length === benignRender.admin.split("\n").length,
      `review-surface(admin note): a multi-line reason adds no admin-note line (${lines.length} vs ${benignRender.admin.split("\n").length})`,
    );
    const reasonLine = lines.find((l) => l.includes("reason:"));
    ok(reasonLine !== undefined && reasonLine.includes("and a trailing clause"), "review-surface(admin note): the whole reason stays on the `reason:` line — nothing broke onto a new one");
    ok(lines.every((l) => !l.startsWith("#") && !l.startsWith(">")), "review-surface(admin note): no line begins a heading or a blockquote");
  }
}

{
  const posts: { method: string; body: URLSearchParams }[] = [];
  const post = async (method: string, body: string) => {
    posts.push({ method, body: new URLSearchParams(body) });
    return { ok: true, ts: "111.222" };
  };

  const pending = await inSession(() =>
    requestApproval(
      {
        org: "default",
        kind: "access.request",
        args,
        scopeKey: args.scopeKey,
        requestedBy: args.requestedBy,
        channelId: args.channelId,
        threadTs: args.threadTs,
      },
      { post },
    ),
  );
  const card = posts.find((p) => p.method === "chat.postMessage");
  ok(card !== undefined && card.body.get("channel") === "C1" && card.body.get("thread_ts") === args.threadTs, "e2e: request card posted in the REQUESTING thread");
  ok(card!.body.get("blocks")!.includes("Request wider access"), "e2e: card blocks render the grant sentence from frozen args");

  const decided = await handleApprovalPayload(
    {
      actions: [{ action_id: `oe_approval:approve:${pending.id}`, value: "default" }],
      user: { id: "U_MEMBER" },
      channel: { id: "C1" },
      message: { ts: "111.222" },
    },
    { post },
  );
  ok(decided === true, "e2e: the tap is ours and handled");
  const update = posts.find((p) => p.method === "chat.update");
  ok(update !== undefined && update.body.get("text")!.includes("dry-run —"), "e2e: member tap executed the kind (dry-run) and the card shows the outcome");
}

rmSync(dir, { recursive: true, force: true });
console.log(`access-request-test: ${n} assertions passed`);
