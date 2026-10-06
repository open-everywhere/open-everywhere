import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Binding, Bundle, Connection } from "../agent/access/bundle.js";
import type { ConnectorCredentials } from "../agent/access/connector-credentials.js";
import type { Group } from "../agent/identity/groups.js";
import type { Domain } from "../agent/memory/domain.js";
import type { AccessRequestsConfig } from "../agent/access/config.js";
import type { SurfaceBinding } from "../agent/identity/binding.js";
import { removeTempDir } from "./_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-access-request-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
const { resolveAccess } = await import("../agent/access/resolver.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { requestApproval, handleApprovalPayload, registerCardPoster } = await import("../agent/approvals/flow.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { executeAccessRequest, requireAccessRequestsConfig } = await import("../agent/approvals/access-request.js");
const { planRequestAccess, groupEffectiveAccess, requestTargetOf, requestingScopeFor } = await import("../agent/tools/request_access.js");
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
  { name: "linear-basket", connectors: [{ name: "linear", credential: "k", contentOrigin: "external" }] },
];
const codeBindings: Binding[] = [
  { bundle: "notion", scope: { level: "surface", surface: "slack/T1/C1" } },
  { bundle: "linear-basket", scope: { level: "surface", surface: "slack/T1/C9" } },
];

const groups: Group[] = [
  { name: "payments-team", members: ["slack/T1/U_ASK", "slack/T1/U_TWO"] },
  { name: "eng", members: [{ linkSet: "ls-1" }, "slack/T1/U_ASK"] },
];

const domains: Domain[] = [{ name: "org", match: "org", admins: ["slack/T1/U_ADMIN"] }];
const domainTargetDomains: Domain[] = [
  ...domains,
  { name: "payments", reach: ["slack/T1/C1", "teams/W1/CH1"], memory: "payments-silo" },
];

function arConfig(over: Partial<AccessRequestsConfig> = {}): AccessRequestsConfig {
  return {
    adminChannel: "C_ADMIN",
    configRepo: "acme/agent-config",
    baseBundles: () => codeBundles,
    baseBindings: () => codeBindings,
    domainRegistry: () => domainTargetDomains,
    groupRegistry: () => groups,
    ...over,
  };
}

registerConfig({
  loadBundles: () => codeBundles,
  loadBindings: () => codeBindings,
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [],
  loadGroups: () => groups,
  loadConnectorCredentials: () => catalogues,
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

const catalogues: readonly ConnectorCredentials[] = ["linear", "asana"].map((connector) => ({
  connector,
  allows: ["api-key" as const],
  credentials: [{ id: "k", type: "api-key" as const, secretRef: `SECRET_${connector}`, broker: "env" }],
}));

function planCtxFor(channel: string): PlanContext {
  return {
    scope: { level: "surface", surface: `slack/T1/${channel}` },
    access: resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel }, codeBundles, codeBindings, {}, catalogues),
    bundles: codeBundles,
    connectorCredentials: catalogues,
    groups,
  };
}

const extras = { scopeKey: "slack/T1/C1", channelId: "C1", configRepo: "acme/agent-config", domains } as const;
const domainExtras = { ...extras, domains: domainTargetDomains, requestingSurfaceKey: "slack/T1/C1" } as const;

{
  const teamsArgs = planRequestAccess(slackBinding({ platform: "teams" }), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", credential: "k" }, extras);
  ok(teamsArgs.delta.kind === "grant-connector", "plan: 🔴 PLANS on a card-less surface — the authorization posture is decidable from the inputs, and it was the only thing this layer could honestly answer");
  registerCardPoster("discord", async () => undefined);
  const args = planRequestAccess(slackBinding({ platform: "discord" }), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", credential: "k" }, extras);
  ok(typeof args.scopeKey === "string", "plan: a surface that REGISTERS a card poster plans exactly as Slack does");
}
await rejectsWith(
  () => planRequestAccess(slackBinding({ mode: "dm" }), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", credential: "k" }, extras),
  "not a DM",
  "plan: refuses in a DM (grants bind to channel scopes)",
);
await rejectsWith(
  () => planRequestAccess(slackBinding({ trust: "external" }), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", credential: "k" }, extras),
  "externally shared",
  "plan: refuses on an external-trust surface",
);
await rejectsWith(
  () => planRequestAccess(slackBinding({ principalId: undefined }), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", credential: "k" }, extras),
  "verified sender",
  "plan: refuses without a verified sender",
);
await rejectsWith(
  () => planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "grant-connector", connector: "notarealthing", credential: "k" }, extras),
  "an admin needs to PR this by hand",
  "plan: out-of-vocabulary asks carry the human-PR fallback",
);

await rejectsWith(
  () => planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "grant-connector", connector: "linear" }, extras),
  "needs the credential to reach",
  "plan: an ask with NO credential is refused — every grant names its identity",
);
await rejectsWith(
  () => planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", credential: "  " }, extras),
  "needs the credential to reach",
  "plan: a BLANK credential is the same refusal — whitespace is not an identity",
);
await rejectsWith(
  () => planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", credential: "not-configured" }, extras),
  "has no credential \"not-configured\" configured",
  "plan: a credential this deployment does not configure is OUT OF VOCABULARY — the ask cannot mint one",
);
{
  let message = "";
  try {
    await planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", credential: "nope" }, extras);
  } catch (err) {
    message = String(err);
  }
  ok(message.includes("configured: k"), "plan: …and the refusal lists the configured credential ids");
}
await rejectsWith(
  () => planRequestAccess(
    slackBinding(),
    { ...planCtxFor("C1"), connectorCredentials: undefined },
    { kind: "grant-connector", connector: "linear", credential: "k" },
    extras,
  ),
  "configured: none",
  "plan: 🔴 FAIL-CLOSED — with NO catalogues in the context, every credential is unconfigured; absent never reads as 'anything goes'",
);
{
  const okArgs = planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", credential: "k" }, extras);
  ok(
    okArgs.delta.kind === "grant-connector" && okArgs.delta.credential === "k",
    "plan: NEGATIVE CONTROL — a configured credential plans, and the id rides into the frozen delta",
  );
}

const args: RequestAccessArgs = planRequestAccess(
  slackBinding(),
  planCtxFor("C1"),
  { kind: "grant-connector", connector: "linear", credential: "k", reason: "  triage needs Linear  " },
  { ...extras, permalink: "https://acme.slack.com/archives/C1/p1720000000000100" },
);
ok(args.delta.kind === "grant-connector" && args.delta.kind === "grant-connector" && args.delta.connector === "linear", "plan: delta planned from the ask");
ok(args.delta.scope.level === "surface" && args.delta.scope.surface === "slack/T1/C1", "plan: delta scope is the REQUESTING surface key (from the resolve request, not model input)");
ok(args.requestedBy === "U_ASK" && args.org === "default" && args.scopeKey === "slack/T1/C1", "plan: requester/org/scopeKey frozen from the binding");
ok(/^[0-9a-f-]{36}$/.test(args.requestId), "plan: a host-minted requestId (uuid) names the PR branch");
ok(args.reason === "triage needs Linear", "plan: reason trimmed into the frozen args");
ok(args.threadTs === "1720009900.000100" && args.channelId === "C1" && args.permalink?.includes("slack.com") === true, "plan: thread anchor + permalink frozen for the PR body");

const widenArgs = planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "widen-connection", connection: "notion-rest", add_methods: ["PATCH"] }, extras);
ok(
  widenArgs.delta.kind === "widen-connection" && widenArgs.delta.baseConnection.secretRef === "NOTION_API_KEY" && widenArgs.delta.addMethods.join() === "PATCH",
  "plan: widen ask freezes the effective base connection into the delta",
);

{
  const derived = requestingScopeFor("channel", slackBinding(), "slack/T1/C1", {}, domainTargetDomains);
  ok(derived.level === "domain" && derived.domain === "payments", "domain target: canonical domain is derived server-side from the requesting surface");
  const standalone = requestingScopeFor(
    "channel",
    slackBinding({ surface: "C_OUT", target: { channelId: "C_OUT" } }),
    "slack/T1/C_OUT",
    {},
    domainTargetDomains,
  );
  ok(standalone.level === "surface" && standalone.surface === "slack/T1/C_OUT", "domain target: a standalone room remains surface-scoped");
  const planned = planRequestAccess(
    slackBinding(),
    { ...planCtxFor("C1"), scope: derived, domains: domainTargetDomains },
    { kind: "grant-connector", connector: "linear", credential: "k" },
    domainExtras,
  );
  ok(planned.delta.scope.level === "domain" && planned.delta.scope.domain === "payments", "domain target: the frozen request carries the domain scope");
  ok(
    planned.universe?.includes('Domain grant for "payments"') === true && planned.universe.includes("every current and future room"),
    "domain target: the proposal explicitly discloses the full domain assignment",
  );
  const generated = applyDelta(emptyGrantsFile(), planned.delta);
  ok(
    generated.grants.bindings[0]?.scope.level === "domain" && generated.grants.bindings[0]?.scope.domain === "payments",
    "domain target: request → generated binding stays at domain level",
  );
}

const dmBinding = (over: Partial<SurfaceBinding> = {}): SurfaceBinding =>
  slackBinding({ mode: "dm", surface: "D_ASK", target: { channelId: "D_ASK" }, threadTs: undefined, visibility: "private", ...over });

function personalCtx(principal = "slack/T1/U_ASK"): PlanContext {
  return {
    scope: { level: "principal", principal },
    access: resolveAccess({ mode: "dm", platform: "slack", workspace: "T1", channel: "D_ASK", principalId: "U_ASK" }, codeBundles, codeBindings),
    bundles: codeBundles,
    connectorCredentials: catalogues,
    groups,
  };
}

const dmExtras = { ...extras, scopeKey: "slack/T1/D_ASK", channelId: "D_ASK" } as const;

{
  const personalArgs = planRequestAccess(dmBinding(), personalCtx(), { kind: "grant-connector", target: "personal", connector: "linear", credential: "k" }, dmExtras);
  ok(
    personalArgs.delta.scope.level === "principal" && personalArgs.delta.scope.principal === "slack/T1/U_ASK",
    "personal: the delta targets the asker's OWN platform-qualified key, composed from the binding",
  );
  ok(personalArgs.universe?.includes("Personal DM grant for `slack/T1/U_ASK`") === true, "personal: a frozen universe note names whose DM this lands in");

  await rejectsWith(
    () => planRequestAccess(dmBinding(), personalCtx("slack/T1/U_SOMEONE_ELSE"), { kind: "grant-connector", target: "personal", connector: "linear", credential: "k" }, dmExtras),
    "self-service only",
    "personal: a scope naming SOMEONE ELSE's key refuses (self-only, whatever produced the scope)",
  );
  await rejectsWith(
    () => planRequestAccess(slackBinding(), personalCtx(), { kind: "grant-connector", target: "personal", connector: "linear", credential: "k" }, extras),
    "has to come from our DM",
    "personal: refused from a channel — the personal universe is asked for where it lands",
  );
  await rejectsWith(
    () => planRequestAccess(dmBinding({ principalId: undefined }), personalCtx(), { kind: "grant-connector", target: "personal", connector: "linear", credential: "k" }, dmExtras),
    "verified sender",
    "personal: no acting sender (a routine fire) refuses before any self-comparison",
  );
  await rejectsWith(
    () => planRequestAccess(dmBinding(), planCtxFor("C1"), { kind: "grant-connector", target: "personal", connector: "linear", credential: "k" }, dmExtras),
    "wiring bug",
    "personal: a surface-level scope handed to a personal target refuses (level agreement)",
  );
  await rejectsWith(
    () => planRequestAccess(dmBinding(), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", credential: "k" }, dmExtras),
    "target=personal",
    "personal: asking for a CHANNEL grant from a DM refuses and names the personal target",
  );
  await rejectsWith(
    () =>
      planRequestAccess(
        dmBinding({ mode: "mpim", surface: "G_ASK", target: { channelId: "G_ASK" } }),
        planCtxFor("C1"),
        { kind: "grant-connector", connector: "linear", credential: "k" },
        dmExtras,
      ),
    "ask again from that channel",
    "channel: a CHANNEL grant asked from a GROUP DM refuses too — the rule is the binding's mode, not the DM surface",
  );
  {
    const planned = planRequestAccess(
      slackBinding({ surface: "C1", target: { channelId: "C1" } }),
      planCtxFor("C1"),
      { kind: "grant-connector", connector: "linear", credential: "k" },
      extras,
    );
    ok(planned.delta.scope.level === "surface", "🔴 NEGATIVE CONTROL: the same ask FROM the channel plans a surface-level delta — the venue is what refuses, not the ask");
  }
}

function groupCtx(name: string): PlanContext {
  return {
    scope: { level: "group", group: name },
    access: groupEffectiveAccess(name, "slack", "T1", codeBundles, codeBindings),
    bundles: codeBundles,
    connectorCredentials: catalogues,
    groups,
  };
}

const adminBinding = (over: Partial<SurfaceBinding> = {}): SurfaceBinding => slackBinding({ principalId: "U_ADMIN", ...over });

{
  await rejectsWith(
    () => planRequestAccess(slackBinding(), groupCtx("payments-team"), { kind: "grant-connector", target: "group", group: "payments-team", connector: "linear", credential: "k" }, extras),
    "org-admin action",
    "group: a non-admin's group request refuses (standing gate)",
  );
  await rejectsWith(
    () =>
      planRequestAccess(
        slackBinding(),
        groupCtx("payments-team"),
        { kind: "grant-connector", target: "group", group: "payments-team", connector: "linear", credential: "k" },
        { ...extras, domains: [] },
      ),
    "org-admin action",
    "group: no admin roster configured ⇒ nobody has standing (fail-closed, not fail-open)",
  );
  const groupArgs = planRequestAccess(
    adminBinding(),
    groupCtx("payments-team"),
    { kind: "grant-connector", target: "group", group: "payments-team", connector: "linear", credential: "k" },
    extras,
  );
  ok(groupArgs.delta.scope.level === "group" && groupArgs.delta.scope.group === "payments-team", "group: an org admin's request plans a group-scoped delta");
  ok(
    groupArgs.universe?.includes('Group grant for "payments-team" — 2 member(s), link-set members: no') === true,
    "group: the frozen universe note names the member count and whether membership can grow by itself",
  );
  ok(groupArgs.delta.allowBroad === undefined, "group: a narrow group needs no acknowledgement");

  await rejectsWith(
    () => planRequestAccess(adminBinding(), groupCtx("payments-team"), { kind: "grant-connector", target: "group", group: "eng", connector: "linear", credential: "k" }, extras),
    "wiring bug",
    "group: a mismatch between the named group and the addressed scope refuses",
  );
  await rejectsWith(
    () => planRequestAccess(adminBinding(), groupCtx("ghosts"), { kind: "grant-connector", target: "group", group: "ghosts", connector: "linear", credential: "k" }, extras),
    "isn't a declared person-group",
    "group: an undeclared group refuses at propose time",
  );

  await rejectsWith(
    () => planRequestAccess(adminBinding(), groupCtx("eng"), { kind: "grant-connector", target: "group", group: "eng", connector: "linear", credential: "k" }, extras),
    "needs a reason",
    "group: a broad group request with no reason refuses (CI would refuse the PR it opened)",
  );
  const broadArgs = planRequestAccess(
    adminBinding(),
    groupCtx("eng"),
    { kind: "grant-connector", target: "group", group: "eng", connector: "linear", credential: "k", reason: "eng shares the read-only Linear key" },
    extras,
  );
  ok(broadArgs.delta.allowBroad === "eng shares the read-only Linear key", "group: the reason is written through as the binding's allowBroad");
  ok(broadArgs.universe?.includes("link-set members: yes (1)") === true, "group: the universe note flags link-set membership (the reach that grows without a diff)");

  const fromDm = planRequestAccess(
    adminBinding({ mode: "dm", surface: "D_ADMIN", target: { channelId: "D_ADMIN" }, threadTs: undefined }),
    groupCtx("payments-team"),
    { kind: "grant-connector", target: "group", group: "payments-team", connector: "linear", credential: "k" },
    { ...extras, channelId: "D_ADMIN" },
  );
  ok(fromDm.delta.scope.level === "group", "group: an org admin may request from a DM as well as a channel");

  ok(requestTargetOf({ target: undefined }) === "channel", "target: absent means channel (the original behaviour)");
  await rejectsWith(() => requestTargetOf({ target: "everyone" }), "unknown request target", "target: an unrecognised target refuses rather than defaulting");
  ok(requestingScopeFor("personal", dmBinding(), "slack/T1/D_ASK", {}).level === "principal", "target: the personal scope is derived, not taken from input");
}

{
  const personalBundles: Bundle[] = [...codeBundles, { name: "mine", connectors: [{ name: "asana", credential: "k", contentOrigin: "external" }] }];
  const personalBindings: Binding[] = [...codeBindings, { bundle: "mine", scope: { level: "principal", principal: "slack/T1/U_ADMIN" } }];
  const access = groupEffectiveAccess("payments-team", "slack", "T1", personalBundles, personalBindings);
  ok(!access.connectors.includes("asana"), "group access: the asker's OWN personal grant does not read as the group's");
  const withGroupGrant = groupEffectiveAccess("payments-team", "slack", "T1", personalBundles, [
    ...personalBindings,
    { bundle: "mine", scope: { level: "group", group: "payments-team" } },
  ]);
  ok(withGroupGrant.connectors.includes("asana"), "group access: what the GROUP is bound to does");
}

const kind = actionKind("access.request");
ok(kind !== undefined && kind.policy === "member", "kind: access.request registered with member policy (the card is the injection gate, merge is the privilege gate)");
{
  const lines = kind!.summarize(args);
  ok(lines[0].includes("Request wider access") && lines[0].includes('"linear"'), "kind: summary opens with the deterministic grant sentence");
  ok(lines.some((l: string) => l.includes("grant-connector: linear (credential k) → slack/T1/C1")), "kind: summary renders the exact machine delta");
  ok(lines.some((l: string) => l.includes("triage needs Linear")), "kind: summary shows the reason");
  ok(lines.some((l: string) => l.includes("acme/agent-config") && l.includes("nothing is granted until")), "kind: summary names the config repo + the merge-is-the-gate contract");

  const domainScope = requestingScopeFor("channel", slackBinding(), "slack/T1/C1", {}, domainTargetDomains);
  const domainArgs = planRequestAccess(
    slackBinding(),
    { ...planCtxFor("C1"), scope: domainScope, domains: domainTargetDomains },
    { kind: "grant-connector", connector: "linear", credential: "k" },
    domainExtras,
  );
  const domainLines = kind!.summarize(domainArgs);
  ok(domainLines[0]?.includes('domain "payments" (every room it admits)') === true, "kind(domain): the card grant sentence names the whole domain");
  ok(domainLines.some((line: string) => line.includes("every current and future room")), "kind(domain): the card includes the frozen full-domain assignment");
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
      return { url: "https://github.com/acme/agent-config/pull/7", number: 7, updated: state.prExisting === true };
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
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  const outcome = await executeAccessRequest(args, "U_TAP", { config: arConfig(), ...fakeDeps(state) });

  const branch = `access-request/${args.requestId}`;
  ok(state.branches[branch] === "base-sha", "execute: request branch cut from the base sha");
  ok(state.puts.length === 1, "execute: exactly one grants-overlay commit");
  ok(state.puts[0] === emitGrantsModule(applyDelta(emptyGrantsFile(), args.delta).grants), "execute: committed bytes are EXACTLY the deterministic codemod output");
  ok(parseGrantsModule(state.puts[0]!).bundles.length === 1, "execute: the committed module passes the round-trip-verifying read the drift lint runs");
  ok(state.prs.length === 1 && state.prs[0].head === branch && state.prs[0].base === "main", "execute: PR opened head→base");
  ok(state.prs[0].title === 'Access request: Grant connector "linear" (as credential "k") to surface slack/T1/C1', "execute: PR title is the grant sentence");
  ok(
    state.prs[0].body.includes("U_ASK") && state.prs[0].body.includes("U_TAP") && state.prs[0].body.includes("slack.com") && state.prs[0].body.includes("Merging this PR IS the approval"),
    "execute: PR body carries requester, sender, thread link, and the merge-is-the-gate doctrine",
  );
  const admin = state.posts.find((p) => p.body.get("channel") === "C_ADMIN");
  ok(admin !== undefined && admin.body.get("text")!.includes("pull/7") && admin.body.get("text")!.includes("U_ASK"), "execute: plain admin-channel notification with PR link (no decide card)");
  const thread = (state.threadNotes ?? [])[0];
  ok(thread !== undefined && thread.threadTs === args.threadTs && thread.text.includes("pull/7"), "execute: requesting thread told where its PR went");
  ok(thread?.platform === "slack" && thread.channelId === "C1", "execute: …on the ASKING surface's own platform, derived from the frozen scopeKey — never assumed Slack");
  ok(
    !state.posts.some((p) => p.body.get("channel") === "C1"),
    "execute: …and the requester note does NOT ride the admin channel's Slack form any more (the bug: a Discord channel id sent to Slack's Web API)",
  );
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
  const domainScope = requestingScopeFor("channel", slackBinding(), "slack/T1/C1", {}, domainTargetDomains);
  const domainArgs = planRequestAccess(
    slackBinding(),
    { ...planCtxFor("C1"), scope: domainScope, domains: domainTargetDomains },
    { kind: "grant-connector", connector: "linear", credential: "k" },
    domainExtras,
  );
  const domainState: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  await executeAccessRequest(domainArgs, "U_ASK", { config: arConfig(), ...fakeDeps(domainState) });
  ok(domainState.prs[0]?.title.includes('domain "payments" (every room it admits)') === true, "execute(domain): the PR title names the whole domain");
  ok(domainState.prs[0]?.body.includes("every current and future room admitted by that domain's reach rules") === true, "execute(domain): the PR body carries the frozen full-domain assignment");
  ok(
    parseGrantsModule(domainState.puts[0]!).bindings[0]?.scope.level === "domain" &&
      parseGrantsModule(domainState.puts[0]!).bindings[0]?.scope.domain === "payments",
    "execute(domain): the committed overlay carries the canonical domain binding",
  );

  const staleDomain: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  await rejectsWith(
    () => executeAccessRequest(domainArgs, "U_ASK", { config: arConfig({ domainRegistry: () => domains }), ...fakeDeps(staleDomain) }),
    'frozen domain "payments" is no longer declared',
    "execute(domain): approval refuses when the domain frozen at proposal has been deleted or renamed",
  );
  ok(
    staleDomain.puts.length === 0 && staleDomain.prs.length === 0 && Object.keys(staleDomain.branches).join(",") === "main",
    "execute(domain): stale domain creates no branch, file write or PR",
  );
  const missingDomainRegistry: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  await rejectsWith(
    () => executeAccessRequest(domainArgs, "U_ASK", { config: arConfig({ domainRegistry: undefined }), ...fakeDeps(missingDomainRegistry) }),
    "doesn't expose its merged domain registry",
    "execute(domain): approval fails closed when the current canonical roster cannot be read",
  );
  ok(
    Object.keys(missingDomainRegistry.branches).join(",") === "main" && missingDomainRegistry.puts.length === 0 && missingDomainRegistry.prs.length === 0,
    "execute(domain): unreadable registry creates no branch, file write or PR",
  );

  const personalArgs = planRequestAccess(dmBinding(), personalCtx(), { kind: "grant-connector", target: "personal", connector: "linear", credential: "k" }, dmExtras);
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  await executeAccessRequest(personalArgs, "U_ASK", { config: arConfig(), ...fakeDeps(state) });
  ok(state.prs[0].title === 'Access request: Grant connector "linear" (as credential "k") to the personal DM universe of slack/T1/U_ASK', "execute(personal): the PR title names the universe, not a channel");
  ok(state.prs[0].body.includes("Personal DM grant for `slack/T1/U_ASK`"), "execute(personal): the PR body says which universe the grant lands in");
  ok(parseGrantsModule(state.puts[0]!).bindings[0].scope.level === "principal", "execute(personal): the committed overlay carries a principal-level binding");

  const groupArgs = planRequestAccess(
    adminBinding(),
    groupCtx("eng"),
    { kind: "grant-connector", target: "group", group: "eng", connector: "linear", credential: "k", reason: "eng shares the read-only Linear key" },
    extras,
  );
  const gstate: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  await executeAccessRequest(groupArgs, "U_ADMIN", { config: arConfig(), ...fakeDeps(gstate) });
  ok(gstate.prs[0].body.includes('Group grant for "eng" — 2 member(s), link-set members: yes (1)'), "execute(group): the PR body names the group, its size and whether membership can grow by itself");
  ok(gstate.prs[0].body.includes("allowBroad: eng shares the read-only Linear key"), "execute(group): the acknowledgement the binding carries is in the body the admin merges");
  const committed = parseGrantsModule(gstate.puts[0]!);
  ok(committed.bindings[0].scope.level === "group" && committed.bindings[0].allowBroad === "eng shares the read-only Linear key", "execute(group): the committed overlay binding carries the acknowledgement");

  const stale: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  await rejectsWith(
    () => executeAccessRequest(groupArgs, "U_ADMIN", { config: arConfig({ groupRegistry: () => [groups[0]] }), ...fakeDeps(stale) }),
    "is not a declared person-group",
    "execute(group): pre-PR re-validation catches a group the merged config would not know",
  );
  ok(stale.puts.length === 0 && stale.prs.length === 0, "execute(group): nothing committed, no PR opened when the group is unknown");

  const bad: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  await rejectsWith(
    () =>
      executeAccessRequest(
        { ...personalArgs, delta: { ...personalArgs.delta, scope: { level: "principal", principal: "U_ASK" } } as typeof personalArgs.delta },
        "U_ASK",
        { config: arConfig(), ...fakeDeps(bad) },
      ),
    "well-formed principal key",
    "execute(personal): a malformed principal key refuses before any commit (the codemod re-validates its own input)",
  );
  ok(bad.puts.length === 0 && bad.prs.length === 0, "execute(personal): nothing committed on a malformed key");
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
  const benignArgs = planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", credential: "k", reason: BENIGN_REASON }, poisonExtras);
  const poisonArgs = planRequestAccess(slackBinding(), planCtxFor("C1"), { kind: "grant-connector", connector: "linear", credential: "k", reason: POISON_REASON }, poisonExtras);

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
        chain: { unattended: false },
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

{
  const { registerSurfaceMessageOps, resolveMessagePermalink } = await import("../agent/channels/surface-message-ops.js");

  ok((await resolveMessagePermalink("nowhere", { channelId: "C1", messageId: "M1" })) === undefined, "permalink: an unregistered surface resolves undefined — the PR body has always treated the link as optional");

  registerSurfaceMessageOps({
    platform: "nowhere",
    postText: async () => "m1",
    editMessage: async () => undefined,
    postFiles: async () => undefined,
    permalink: async (ref) => `https://nowhere.example/${ref.workspace ?? "-"}/${ref.channelId}/${ref.messageId}`,
  });
  ok(
    (await resolveMessagePermalink("nowhere", { channelId: "C1", messageId: "M1", workspace: "W1" })) === "https://nowhere.example/W1/C1/M1",
    "permalink: 🔴 a surface that REGISTERS one carries the flow — the whole ref (workspace included) reaches its composer",
  );

  registerSurfaceMessageOps({ platform: "linkless", postText: async () => "m1", editMessage: async () => undefined, postFiles: async () => undefined });
  ok((await resolveMessagePermalink("linkless", { channelId: "C1", messageId: "M1" })) === undefined, "permalink: a registered surface with no permalink op resolves undefined, never throws");

  registerSurfaceMessageOps({
    platform: "brokenlink",
    postText: async () => "m1",
    editMessage: async () => undefined,
    postFiles: async () => undefined,
    permalink: async () => {
      throw new Error("permalink service down");
    },
  });
  ok((await resolveMessagePermalink("brokenlink", { channelId: "C1", messageId: "M1" })) === undefined, "permalink: a THROWING composer degrades to undefined — it is display-only and may not fail the request");
}

{
  const { domainExposureLines } = await import("../agent/approvals/domain-exposure.js");
  const { wideningSubject } = await import("../agent/tools/request_access.js");
  const { summarizeFrozenRow } = await import("../agent/approvals/actions.js");

  const LISTED_ROOMS = ["slack/T1/C1", "teams/W1/CH1"];
  const withDomain = (over: Partial<Domain> = {}) => {
    domains.push({ name: "payments", title: "Payments", reach: LISTED_ROOMS, memory: "payments-silo", ...over } as Domain);
    return () => {
      domains.pop();
    };
  };
  const noReach = async () => [];
  const connectorSubject = { label: "the Notion connector", reachTags: ["connector:notion"], opaqueSources: ["Notion"] };

  {
    const undo = withDomain();
    const text = (await domainExposureLines({ org: "default", domain: "payments", subject: connectorSubject, reachOf: noReach })).join("\n");
    ok(text.includes('This lands in the "Payments" domain, which lists 2 rooms on Slack and Microsoft Teams.'), `exposure: names how far the domain reaches, in surface names not keys (${text})`);
    ok(text.includes("share one memory"), "exposure: says the rooms share one memory when the domain declares a silo");
    ok(text.includes("No room in this domain can reach the Notion connector today, so this widens the domain itself."), "exposure: flags an addition no room in the domain holds");
    ok(text.includes("The agent cannot list who else can read Notion"), "exposure: states the audience it CANNOT enumerate — the honest half");
    ok(!/slack\/T1\/C1|teams\/W1/u.test(text), "exposure: no raw surface keys reach the card copy");
    undo();
  }
  {
    const undo = withDomain();
    const reachOf = async (room: string) => (room === "slack/T1/C1" ? ["connector:notion"] : []);
    const text = (await domainExposureLines({ org: "default", domain: "payments", subject: connectorSubject, reachOf })).join("\n");
    ok(text.includes("1 room in this domain can already reach the Notion connector."), `exposure: counts the rooms that already hold it (${text})`);
    ok(!text.includes("widens the domain itself"), "exposure: negative control — no widening claim when another room already holds the reach");
    undo();
  }
  {
    const undo = withDomain({ memory: undefined });
    const text = (await domainExposureLines({ org: "default", domain: "payments", subject: connectorSubject, reachOf: noReach })).join("\n");
    ok(!text.includes("share one memory"), "exposure: negative control — a domain that declares no silo makes no shared-memory claim");
    undo();
    const undo2 = withDomain({ memory: "payments-silo", ambientSupervisor: false } as Partial<Domain>);
    const text2 = (await domainExposureLines({ org: "default", domain: "payments", subject: connectorSubject, reachOf: noReach })).join("\n");
    ok(text2.includes("share one memory"), "exposure: a domain with a silo shares memory whatever the window topology says");
    undo2();
  }
  {
    const undo = withDomain({ reach: ["slack/T1"] });
    const text = (await domainExposureLines({ org: "default", domain: "payments", subject: connectorSubject, reachOf: noReach })).join("\n");
    ok(text.includes("lists no rooms — it admits every room in a whole workspace on Slack by a rule"), `exposure: a claim-only domain says its rooms cannot be listed, and names the claim's grain (${text})`);
    ok(!/\b0 rooms\b/u.test(text), "exposure: it never prints a room count it could not enumerate");
    ok(!text.includes("widens the domain itself"), "exposure: and never the widening claim that count would have produced");
    ok(text.includes("Every room it admits shares one memory"), "exposure: the shared-memory fact still lands — it is declared, not counted");
    undo();
    const undo2 = withDomain({ reach: ["slack/T1/proj-*"] });
    const globbed = (await domainExposureLines({ org: "default", domain: "payments", subject: connectorSubject, reachOf: noReach })).join("\n");
    ok(globbed.includes("lists no rooms — it admits every room matching a pattern on Slack by a rule"), `exposure: a pattern is not an enumerable room — it is a container entry, and the card names its grain (${globbed})`);
    ok(!/\b0 rooms\b/u.test(globbed), "exposure: …and a pattern-only domain still never prints a room count");
    undo2();
    const undo3 = withDomain({ reach: [] });
    const silent = (await domainExposureLines({ org: "default", domain: "payments", subject: connectorSubject, reachOf: noReach })).join("\n");
    ok(silent.includes("does not list its rooms"), `exposure: a domain with no reach entries gets the short form (${silent})`);
    ok(!silent.includes("by a rule"), "exposure: negative control — and claims nothing by a rule");
    undo3();
  }
  {
    const undo = withDomain({ reach: [...LISTED_ROOMS, "slack/T1"] });
    const text = (await domainExposureLines({ org: "default", domain: "payments", subject: connectorSubject, reachOf: noReach })).join("\n");
    ok(text.includes("lists 2 rooms on Slack and Microsoft Teams"), `exposure: a mixed domain still reports the rooms it does list (${text})`);
    ok(text.includes("It also admits every room in a whole workspace on Slack by a rule") && text.includes("the count above is a floor"), `exposure: and says the count is a floor because of the claim (${text})`);
    ok(text.includes("No room this domain LISTS can reach the Notion connector today."), "exposure: the uniqueness sentence is scoped to the listed rooms");
    ok(!text.includes("widens the domain itself"), "exposure: and withholds the domain-wide widening verdict a partial set cannot earn");
    undo();
    const undo2 = withDomain({ reach: [...LISTED_ROOMS, "slack/T1"] });
    const held = async (room: string) => (room === "slack/T1/C1" ? ["connector:notion"] : []);
    const text2 = (await domainExposureLines({ org: "default", domain: "payments", subject: connectorSubject, reachOf: held })).join("\n");
    ok(text2.includes("1 of the rooms it lists can already reach the Notion connector."), `exposure: a holder count on a mixed domain is scoped to the listed rooms (${text2})`);
    ok(!text2.includes("1 room of the rooms it lists"), "exposure: …and the singular reads as a sentence, not as a count spliced into a partitive");
    undo2();
    const undo3 = withDomain({ reach: [...LISTED_ROOMS, "github/acme/payments-*"] });
    const text3 = (await domainExposureLines({ org: "default", domain: "payments", subject: connectorSubject, reachOf: noReach })).join("\n");
    ok(text3.includes("every room matching a pattern on GitHub by a rule"), `exposure: a glob claim is described by its shape, never as the raw entry — and the sentence says "by a rule" once (${text3})`);
    ok(!/github\/acme/u.test(text3), "exposure: the claim entry itself never reaches the card");
    undo3();
  }
  {
    const lines = await domainExposureLines({ org: "default", domain: null, subject: connectorSubject, reachOf: noReach });
    ok(lines[0].includes("in no memory domain"), "exposure: a room in no domain gets the complete short answer, not a failure");
  }
  {
    const lines = await domainExposureLines({ org: "default", domain: "payments", subject: connectorSubject, landsOnARoom: false, reachOf: noReach });
    ok(lines.length === 1 && lines[0].includes("cannot list who else can read Notion"), `exposure: a grant that lands in DMs states only the not-enumerable half (${lines.join(" | ")})`);
  }
  {
    const text = (await domainExposureLines({ org: "default", domain: "no-such-domain", subject: connectorSubject, reachOf: noReach })).join("\n");
    ok(text.includes("could not read the rooms"), `exposure: an unreadable domain states that plainly (${text})`);
    ok(text.includes("The agent cannot list who else can read Notion"), "exposure: the not-enumerable statement survives a failed read");
  }
  {
    const undo = withDomain();
    const brokenReach = async () => {
      throw new Error("resolver unavailable");
    };
    const text = (await domainExposureLines({ org: "default", domain: "payments", subject: connectorSubject, reachOf: brokenReach })).join("\n");
    ok(text.includes("could not check which rooms already reach the Notion connector"), `exposure: a failed reach check says so (${text})`);
    ok(!text.includes("widens the domain itself"), "exposure: a failed reach check never asserts the widening it could not verify");
    ok(text.includes("lists 2 rooms"), "exposure: a failed reach check keeps the facts it DID prove");
    undo();
  }

  {
    const connector = wideningSubject({ kind: "grant-connector", scope: { level: "surface", surfaceKey: "slack/T1/C1" }, connector: "notion", credential: "notion-workspace" } as never);
    ok(connector.reachTags.join() === "connector:notion", "wideningSubject: a grant-connector ask compares on the connector's own reach tag");
    ok(connector.label === "the Notion connector" && connector.opaqueSources.join() === "Notion", "wideningSubject: it names the connector for a person, through the one surface namer");
    const widen = wideningSubject({ kind: "widen-connection", scope: { level: "surface", surfaceKey: "slack/T1/C1" }, connectionId: "notion-rest", addMethods: [], addPathPrefixes: ["/v1/pages"], baseConnection: notionRest } as never);
    const expectedHosts = notionRest.allowedWebsites.map((h) => h.trim().toLowerCase());
    ok(widen.reachTags.join() === expectedHosts.map((h) => `host:${h}`).join(), `wideningSubject: a widen-connection ask compares on the connection's hosts, tag for tag (${widen.reachTags.join()})`);
    ok(widen.opaqueSources.join() === expectedHosts.join(), "wideningSubject: those hosts are the audiences it cannot enumerate");
    const shouty = wideningSubject({
      kind: "widen-connection",
      scope: { level: "surface", surfaceKey: "slack/T1/C1" },
      connectionId: "notion-rest",
      addMethods: [],
      addPathPrefixes: [],
      baseConnection: { ...notionRest, allowedWebsites: [" API.Notion.com "] },
    } as never);
    ok(shouty.reachTags.join() === "host:api.notion.com", `wideningSubject: host tags are trimmed and lower-cased, as the resolver compares them (${shouty.reachTags.join()})`);
    ok(shouty.label === "api.notion.com", "wideningSubject: the label a person reads is the normalised host too");
  }

  {
    const rendered = summarizeFrozenRow({
      kind: "access.request",
      argsJson: JSON.stringify({
        org: "default",
        scopeKey: "slack/T1/C1",
        requestId: "r1",
        delta: { kind: "grant-connector", scope: { level: "surface", surfaceKey: "slack/T1/C1" }, connector: "notion", credential: "notion-workspace" },
        requestedBy: "U1",
        channelId: "C1",
        threadTs: null,
        configRepo: "acme/config",
        exposure: ["EXPOSURE-LINE-ONE", "EXPOSURE-LINE-TWO"],
      }),
    } as never).join("\n");
    ok(rendered.includes("EXPOSURE-LINE-ONE") && rendered.includes("EXPOSURE-LINE-TWO"), `access.request card: the frozen exposure lines render on the card (${rendered})`);
  }
}

await removeTempDir(dir);
console.log(`access-request-test: ${n} assertions passed`);
