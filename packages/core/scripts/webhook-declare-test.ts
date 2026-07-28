
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AccessRequestsConfig } from "../agent/access/config.js";
import type { WebhookHook } from "../agent/webhooks/config.js";

const dir = join(tmpdir(), `oe-webhook-declare-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_ORG;

const { registerConfig } = await import("../agent/access/config.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { actionKind } = await import("../agent/approvals/actions.js");
await import("../agent/approvals/flow.js");
const { executeWebhookDeclare, requireWebhookDeclareConfig, declarationSentence, secretSetupLine } = await import("../agent/approvals/webhook-declare.js");
const { secretRefForHookId } = await import("../agent/tools/declare_webhook.js");
const codemod = await import("../agent/webhooks/hooks-codemod.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
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

const CODE_HOOK: WebhookHook = {
  id: "smoke-test",
  source: "oe-standard-webhook",
  secretRef: "OE_WEBHOOK_SMOKE_SECRET",
  broker: "env",
  target: "slack/T1/C1",
  readableBy: [{ level: "domain", domain: "eng" }],
  instruction: "Say the smoke test fired.",
};

const DECL: WebhookHook = {
  id: "deploy-status",
  source: "oe-standard-webhook",
  secretRef: secretRefForHookId("deploy-status"),
  broker: "env",
  target: "slack/T1/C-DEPLOYS",
  readableBy: [{ level: "domain", domain: "eng" }, { level: "domain", domain: "ops" }],
  instruction: "A CI deploy-status webhook fired. Summarise the result for the channel.",
};

const cfg = (over: Partial<AccessRequestsConfig> = {}): AccessRequestsConfig => ({
  adminChannel: "C_ADMIN",
  configRepo: "acme/agent-config",
  configBase: "main",
  baseBundles: () => [],
  baseBindings: () => [],
  baseWebhooks: () => [CODE_HOOK],
  ...over,
});

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
  loadAccessRequests: () => cfg(),
});

const ARGS = {
  org: "default",
  scopeKey: "slack/T1/C1",
  requestId: "11111111-2222-3333-4444-555555555555",
  declaration: DECL,
  requestedBy: "U_ASK",
  reason: "CI needs somewhere to report",
  channelId: "C1",
  threadTs: "1720009900.000100",
  configRepo: "acme/agent-config",
};

{
  console.log("\n1. the codemod — parse strictness:");
  eq(codemod.parseHooksFile({ hooks: [] }), { hooks: [] }, "an empty overlay parses");
  eq(codemod.parseHooksText(codemod.stringifyHooks({ hooks: [DECL] })).hooks.length, 1, "a machine-written overlay round-trips");
  rejectsWithSync(() => codemod.parseHooksFile({ hooks: [], extra: 1 }), "unknown top-level key", "an unknown top-level key is refused");
  rejectsWithSync(() => codemod.parseHooksFile({}), "needs a `hooks` array", "a missing hooks array is refused");
  rejectsWithSync(() => codemod.parseHooksText("{"), "not valid JSON", "malformed JSON is refused, loudly");
  rejectsWithSync(() => codemod.parseHooksFile({ hooks: [{ ...DECL, posture: "trigger-only" }] }), "unknown field", "a field outside the vocabulary is refused — a hand-edit that means something we do not implement must not half-load");
  rejectsWithSync(() => codemod.parseHooksFile({ hooks: [{ ...DECL, id: "hk_abc" }] }), "reserved", '🔴 an "hk_" id is refused — a config hook wins every lookup, so squatting on that namespace SHADOWS a live minted ingress');
  const { readableBy: _dropped, ...noGrant } = DECL;
  rejectsWithSync(() => codemod.parseHooksFile({ hooks: [noGrant] }), "readableBy", "🔴 an overlay hook with NO readableBy is refused — required, no default, at the JSON boundary too");
  rejectsWithSync(() => codemod.parseHooksFile({ hooks: [{ ...DECL, readableBy: [] }] }), "readableBy", "…and an EMPTY one is refused for the same reason");
  for (const field of ["source", "secretRef", "broker", "target", "instruction"] as const) {
    const { [field]: _gone, ...missing } = DECL as unknown as Record<string, unknown>;
    rejectsWithSync(() => codemod.parseHooksFile({ hooks: [missing] }), field, `a missing \`${field}\` is refused`);
  }
}

{
  console.log("\n2. the codemod — determinism, idempotence, add-only:");
  const once = codemod.applyHookDeclaration(codemod.emptyHooksFile(), DECL, ["smoke-test"]);
  ok(once.changed, "a fresh declaration lands");
  const bytes = codemod.stringifyHooks(once.hooks);
  eq(codemod.stringifyHooks(codemod.applyHookDeclaration(codemod.emptyHooksFile(), DECL, []).hooks), bytes, "same inputs ⇒ byte-identical output");
  eq(codemod.stringifyHooks(codemod.parseHooksText(bytes)), bytes, "parse∘stringify is a fixed point — what the PR-update path leans on");
  ok(bytes.endsWith("}\n"), "canonical bytes end with a trailing newline");
  ok(bytes.indexOf('"id"') < bytes.indexOf('"readableBy"') && bytes.indexOf('"readableBy"') < bytes.indexOf('"instruction"'), "fields are in declaration order, so the read grant sits where a reviewer looks");

  const twice = codemod.applyHookDeclaration(once.hooks, DECL, []);
  ok(!twice.changed && codemod.stringifyHooks(twice.hooks) === bytes, "re-applying the SAME declaration is a no-op — no divergent second diff on a re-request");
  const reordered = { instruction: DECL.instruction, readableBy: [...DECL.readableBy].reverse(), target: DECL.target, broker: DECL.broker, secretRef: DECL.secretRef, source: DECL.source, id: DECL.id } as WebhookHook;
  ok(!codemod.applyHookDeclaration(once.hooks, reordered, []).changed, "…and so is one that differs only in field / readableBy ORDER (canonical comparison, not object identity)");

  rejectsWithSync(
    () => codemod.applyHookDeclaration(once.hooks, { ...DECL, target: "slack/T1/C-ELSEWHERE" }, []),
    "only ADDS",
    "🔴 re-declaring an existing id with DIFFERENT settings is REFUSED — redirecting an already-authenticated sender is a human edit, not a chat request",
  );
  rejectsWithSync(
    () => codemod.applyHookDeclaration(codemod.emptyHooksFile(), { ...DECL, id: "smoke-test" }, ["smoke-test"]),
    "already declared in code",
    "🔴 colliding with a CODE-declared hook is refused up front — the overlay cannot edit code, so the collision would otherwise be a post-merge boot failure",
  );
}

{
  console.log("\n3. the secret that is never there:");
  eq(secretRefForHookId("deploy-status"), "OE_WEBHOOK_DEPLOY_STATUS_SECRET", "the env var name is DERIVED from the hook id");
  eq(secretRefForHookId("my.ci-2"), "OE_WEBHOOK_MY_CI_2_SECRET", "…including through punctuation");
  const schema = (await import("../agent/tools/declare_webhook.js")).default as unknown as { inputSchema: { shape: Record<string, unknown> } };
  ok(!("secretRef" in schema.inputSchema.shape), "🔴 the tool has NO secretRef parameter — a caller cannot aim a new hook at somebody else's credential");
  ok(!("broker" in schema.inputSchema.shape), "…nor a broker parameter");
  ok(secretSetupLine(DECL).includes("OE_WEBHOOK_DEPLOY_STATUS_SECRET") && /never appear/.test(secretSetupLine(DECL)), "the operator's follow-up step names the ref and states the never-in-a-diff rule");
}

{
  console.log("\n4. the ActionKind:");
  const kind = actionKind("webhook.declare");
  ok(kind !== undefined && kind.policy === "member", "webhook.declare is registered at member policy — the card is the injection gate, the MERGE is the privilege gate");
  ok(kind!.beneficiaryClicker !== true, "🔴 it is NOT beneficiaryClicker: approving reveals nothing to the clicker (no secret is minted or delivered), so the OPE-185 floor correctly does not apply");
  const card = kind!.summarize(ARGS).join("\n");
  ok(card.includes("deploy-status") && card.includes("slack/T1/C-DEPLOYS"), "the card names the hook and where it fires");
  ok(card.includes(DECL.instruction), "🔴 the card shows the EXACT standing instruction — it is the thing being armed, and a card that hid it would be asking for a click on an unread prompt");
  ok(/runs with .* full existing access/.test(card), "…and states the authority that instruction runs with");
  ok(card.includes('domain "eng"') && card.includes('domain "ops"'), "the card names every domain that will be able to read the hook's events");
  ok(/No secret is created or shown/.test(card), "the card says outright that nothing secret happens here");
  ok(card.includes("acme/agent-config") && /nothing is declared/.test(card), "…and that a PR, not this click, is what changes anything");

  await rejectsWith(() => requireWebhookDeclareConfig({ ...cfg(), adminChannel: undefined }), "aren't enabled", "config: a missing admin channel fails closed");
  await rejectsWith(() => requireWebhookDeclareConfig({ ...cfg(), configRepo: undefined }), "aren't enabled", "config: a missing config repo fails closed");
  await rejectsWith(() => requireWebhookDeclareConfig({ ...cfg(), baseWebhooks: undefined }), "baseWebhooks", "🔴 config: NO code baseline fails closed — a candidate that cannot be validated against what it merges alongside must not become a PR");
}

{
  console.log("\n5. execute — dry-run:");
  const outcome = await executeWebhookDeclare(ARGS, "U_TAP", { config: cfg({ dryRun: true }) });
  ok(outcome.startsWith("dry-run —") && outcome.includes(`webhook-declare/${ARGS.requestId}`), "dry-run reports repo/branch and touches no deps");
  const audit = await readAudit({ org: "default", limit: 5 });
  const entry = audit.find((a) => a.action === "webhook.declare.pr_opened");
  ok(entry !== undefined && (entry.detail as { dryRun?: boolean }).dryRun === true, "…and is still audited, flagged dryRun");
}

interface FakeState {
  branches: Record<string, string>;
  files: Record<string, { content: string; sha: string }>;
  puts: string[];
  prs: { title: string; body: string; head: string; base: string }[];
  posts: { method: string; body: URLSearchParams }[];
  prExisting?: boolean;
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
      state.posts.push({ method, body: new URLSearchParams(body) });
      return { ok: true, ts: "1.2" };
    },
  };
}

{
  console.log("\n6. execute — the real path, injected edges:");
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  const outcome = await executeWebhookDeclare(ARGS, "U_TAP", { config: cfg(), ...fakeDeps(state) });

  const branch = `webhook-declare/${ARGS.requestId}`;
  ok(state.branches[branch] === "base-sha", "the declaration branch is cut from the base sha");
  eq(state.puts.length, 1, "exactly one hooks.json commit");
  eq(state.puts[0], codemod.stringifyHooks(codemod.applyHookDeclaration(codemod.emptyHooksFile(), DECL, []).hooks), "🔴 the committed bytes are EXACTLY the deterministic codemod's output — no model authored any part of the diff");
  ok(Object.keys(state.files)[0]!.endsWith(":agent/webhooks/hooks.json"), "…written to the hooks overlay path, not the grants one");
  eq(state.prs.length, 1, "one PR");
  ok(state.prs[0].head === branch && state.prs[0].base === "main", "PR opened head→base");
  eq(state.prs[0].title, declarationSentence(DECL), "the PR title is the one deterministic sentence the card also renders");
  const body = state.prs[0].body;
  ok(body.includes("U_ASK") && body.includes("U_TAP"), "the PR body carries requester and sender");
  ok(body.includes('domain "eng"') && /whole confidentiality boundary/.test(body), "…names who may read its events, and says that IS the boundary");
  ok(/does NOT make it live/.test(body) && body.includes("OE_WEBHOOK_DEPLOY_STATUS_SECRET"), "…and states plainly that merging is not enough, naming the operator's exact next step");
  ok(/no model authored any/.test(body), "…and carries the determinism claim the codemod actually makes true");

  const everything = [state.puts.join("\n"), body, state.prs[0].title, outcome, JSON.stringify(state.posts.map((p) => p.body.get("text")))].join("\n");
  ok(!/whsec_/.test(everything), "🔴 no minted-secret material anywhere in the committed bytes, the PR, the notifications or the outcome");
  ok(everything.includes("OE_WEBHOOK_DEPLOY_STATUS_SECRET"), "…only the REF, which is a pointer and is meant to be public");

  const admin = state.posts.find((p) => p.body.get("channel") === "C_ADMIN");
  ok(admin !== undefined && admin.body.get("text")!.includes("pull/9"), "the admin channel is told, with the PR link");
  const thread = state.posts.find((p) => p.body.get("channel") === "C1");
  ok(thread !== undefined && thread.body.get("thread_ts") === ARGS.threadTs, "the asking thread is told, in the thread it asked from");
  ok(outcome.includes("opened PR #9") && /operator sets its secret/.test(outcome), "the outcome names both remaining steps — merge, then secret");

  const audit = await readAudit({ org: "default", limit: 8 });
  const entry = audit.find((a) => a.action === "webhook.declare.pr_opened" && (a.detail as { pr?: number }).pr === 9);
  ok(entry !== undefined && entry.principalId === "U_TAP", "audited with the tapping member as principal");
  ok((entry!.detail as { readableBy?: string }).readableBy?.includes("eng") === true, "…and the audit row records the read grant in words");
  ok(!JSON.stringify(entry).includes("whsec_"), "🔴 …and carries no secret material");

  state.prExisting = true;
  const again = await executeWebhookDeclare(ARGS, "U_TAP2", { config: cfg(), ...fakeDeps(state) });
  eq(state.puts.length, 1, "re-run: idempotent — no second commit");
  ok(again.includes("updated PR #9"), "re-run: the outcome reports an update, not a fresh PR");
}

{
  console.log("\n7. merged-result validation (ring ②):");
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  await rejectsWith(
    () => executeWebhookDeclare({ ...ARGS, declaration: { ...DECL, target: "C-DEPLOYS" } }, "U_TAP", { config: cfg(), ...fakeDeps(state) }),
    "must be a fully-qualified",
    "🔴 an invalid MERGED result refuses BEFORE any commit or PR exists",
  );
  eq(state.puts.length, 0, "…and nothing was committed");
  eq(state.prs.length, 0, "…and no PR was opened");

  const state2: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  await rejectsWith(
    () => executeWebhookDeclare({ ...ARGS, declaration: { ...DECL, id: "smoke-test" } }, "U_TAP", { config: cfg(), ...fakeDeps(state2) }),
    "already declared in code",
    "a candidate colliding with a code hook refuses, with nothing written",
  );
  eq(state2.puts.length + state2.prs.length, 0, "…nothing committed, no PR");
}

function rejectsWithSync(fn: () => unknown, fragment: string, label: string): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes(fragment), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n✅ webhook-declare (OPE-208): ${n} checks passed`);
