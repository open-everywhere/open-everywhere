import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const dir = join(tmpdir(), `oe-webhook-prov-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_ORG;
const ORG = "default";
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.OE_INTAKE_PAGE_SIGNING_KEY = randomBytes(32).toString("base64");
process.env.OE_PUBLIC_BASE_URL = "https://oe.example.test";

const vocab = await import("../agent/webhooks/source-vocabulary.js");
const rh = await import("../agent/webhooks/runtime-hook.js");
const ri = await import("../agent/webhooks/runtime-ingress.js");
const revealMod = await import("../agent/webhooks/reveal-page.js");
const { hasPrivateDeliveryPath } = await import("../agent/tools/create_webhook.js");
const { hasApprovalCardPath } = await import("../agent/tools/set_spend_limit.js");
const { registerCardPoster } = await import("../agent/approvals/flow.js");
const { setRevealDeliveryDepsForTest } = await import("../agent/approvals/webhook.js");
const { actionKind } = await import("../agent/approvals/actions.js");
await import("../agent/approvals/flow.js");
const { encryptedKvVault } = await import("../agent/credentials/kv-vault.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { TOOL_CONSEQUENCE } = await import("../agent/access/consequence.js");
const { WINDOW_UNGATED_TOOLS, JOB_WAKE_TOOLS } = await import("../agent/access/window-gate-manifest.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const store = getOperationalStore();
const vault = encryptedKvVault();
const SURFACE = "slack/T1/C1";
const REQUESTER = "U-ASKER";
const DECIDER = "U-ADMIN";

const delivered: { channelId: string; userId: string; text: string }[] = [];
setRevealDeliveryDepsForTest({
  postPrivate: async (channelId, userId, text) => {
    delivered.push({ channelId, userId, text });
    return true;
  },
});

const createKind = actionKind("webhook.create")!;
const rotateKind = actionKind("webhook.rotate")!;
const revokeKind = actionKind("webhook.revoke")!;

{
  console.log("\n1. source vocabulary (OPE-159):");
  const V = () => ["github", "notion", "oe-hmac"];
  const N = () => ["github", "notion", "linear"];
  eq(vocab.runtimeHookSourceVocabulary({ verifiers: V, normalizers: N, declared: () => undefined }), ["github", "notion"], "the vocabulary is the INTERSECTION of verifiers ∩ normalizers");
  ok(!vocab.runtimeHookSourceVocabulary({ verifiers: V, normalizers: N, declared: () => undefined }).includes("oe-hmac"), "a source with a verifier but NO normalizer is not mintable (nothing could subscribe)");
  ok(!vocab.runtimeHookSourceVocabulary({ verifiers: V, normalizers: N, declared: () => undefined }).includes("linear"), "a source with a normalizer but NO verifier is not mintable (it would 401 forever)");
  eq(vocab.runtimeHookSourceVocabulary({ verifiers: V, normalizers: N, declared: () => ["notion"] }), ["notion"], "the operator's declared list NARROWS the intersection");
  eq(vocab.runtimeHookSourceVocabulary({ verifiers: V, normalizers: N, declared: () => ["stripe"] }), [], "the declared list can NEVER ADD a source with no verifier (narrowing-only)");
  eq(vocab.runtimeHookSourceVocabulary({ verifiers: () => [], normalizers: N, declared: () => undefined }), [], "no verifiers ⇒ nothing is mintable");

  const refusal = vocab.unknownSourceRefusal("stripe", ["github", "notion"]);
  ok(refusal.includes("github, notion"), "🔴 the refusal NAMES the legal set — the error message IS the vocabulary");
  ok(/PR|merge/i.test(refusal), "…and names the PR path (an 'ask an admin' with no WHAT is a dead end)");
  ok(vocab.unknownSourceRefusal("stripe", []).includes("No sources are available"), "an empty vocabulary refuses honestly rather than naming an empty list");

  eq(rh.runtimeHookSourceDefect("notion"), null, "a plain lowercase token is a valid source");
  ok(rh.runtimeHookSourceDefect("Notion") !== null, "uppercase is refused (the tool lowercases first; the grammar is the floor)");
  ok(rh.runtimeHookSourceDefect("no tion") !== null, "whitespace is refused");
  ok(rh.runtimeHookSourceDefect("") !== null, "empty is refused");
  ok(rh.runtimeHookSourceDefect("a".repeat(65)) !== null, "an over-long source is refused");
}

{
  console.log("\n2. tiers + manifests:");
  eq(createKind.policy, "member", "webhook.create is MEMBER (OPE-159 supersedes the OPE-150 flat admin tier)");
  eq(rotateKind.policy, "member", "webhook.rotate is MEMBER");
  eq(revokeKind.policy, "member", "webhook.revoke is MEMBER (narrowing-only fast lane)");
  eq(vocab.runtimeHookTier("trigger-only"), "member", "tier table: trigger-only, in vocabulary ⇒ member");
  eq(vocab.runtimeHookTier("content-bearing"), "member", "tier table: content-bearing, in vocabulary ⇒ member (the control is the fence + taint, not a second approver)");

  for (const t of ["create_webhook", "rotate_webhook", "revoke_webhook"]) {
    ok(TOOL_CONSEQUENCE[t] !== undefined, `${t} has a consequence row`);
    ok(WINDOW_UNGATED_TOOLS.has(t), `${t} mounts on every grain (its control is consequence, not hands)`);
    ok(!JOB_WAKE_TOOLS.has(t), `🔴 ${t} is NOT in the job-wake kit — an unattended wake must not mint or rotate an ingress`);
  }
  ok(TOOL_CONSEQUENCE["list_webhooks"] !== undefined, "list_webhooks has a consequence row");
  ok(WINDOW_UNGATED_TOOLS.has("list_webhooks") && JOB_WAKE_TOOLS.has("list_webhooks"), "list_webhooks is a read and is available everywhere");
}

{
  console.log("\n3. private-delivery precondition:");
  ok(hasPrivateDeliveryPath("slack"), "Slack has a private delivery path (chat.postEphemeral)");
  ok(!hasPrivateDeliveryPath("discord"), "🔴 Discord does NOT — its ephemeral needs an interaction token core cannot reach");
  for (const p of ["teams", "github", "linear", "notion"]) ok(!hasPrivateDeliveryPath(p), `${p} has no private delivery path`);
  registerCardPoster("discord", async () => undefined);
  ok(hasApprovalCardPath("discord") && !hasPrivateDeliveryPath("discord"), "🔴 the two predicates already DISAGREE, so neither can be silently reused for the other");
  ok(revealMod.revealPageAvailable(), "the reveal page is armed in this test deployment");
}

let createdId = "";
{
  console.log("\n4. webhook.create — the mint:");
  const args = { org: ORG, source: "notion", posture: "content-bearing" as const, surfaceKey: SURFACE, requestedBy: REQUESTER, platform: "slack", channelId: "C1" };

  const card = createKind.summarize(args).join("\n");
  ok(card.includes("notion"), "the card names the source");
  ok(/CONTENT-BEARING/.test(card), "🔴 the card spells out the content-bearing exposure — this is the human's one chance to notice");
  ok(card.includes("ONE-TIME") || card.includes("one-time") || card.includes("ONE-TIME link") || /once/i.test(card), "the card says the secret is shown once");
  const triggerCard = createKind.summarize({ ...args, posture: "trigger-only" }).join("\n");
  ok(/TRIGGER-ONLY/.test(triggerCard) && !/CONTENT-BEARING/.test(triggerCard), "a trigger-only card says the payload is discarded");

  delivered.length = 0;
  const outcome = await createKind.execute(args, DECIDER);

  const hook = await store.getWebhookHookBySource(ORG, "notion");
  ok(hook !== null, "the hook row exists after the click");
  createdId = hook!.id;
  ok(rh.RUNTIME_HOOK_ID_RE.test(createdId), "the id was minted host-side, in the right grammar");
  eq(hook!.createdBy, DECIDER, "🔴 the hook is attributed to the DECIDER, not the asker (only the decider read the card)");
  eq(hook!.status, "active", "armed active");
  eq(hook!.secretRef, rh.runtimeHookSecretRef(createdId), "the row points at the vault, and carries no value");

  const secret = await vault.read(hook!.secretRef);
  ok(typeof secret === "string" && secret.length >= 40, "a real secret was minted into the vault");
  ok(!outcome.includes(secret!), "🔴 the PUBLIC decided-card outcome line does NOT contain the secret");
  ok(!JSON.stringify(hook).includes(secret!), "🔴 the stored row does NOT contain the secret");
  ok(!card.includes(secret!), "🔴 the card does not contain the secret");
  const rows = await readAudit({ org: ORG, action: "webhook.created" });
  eq(rows.length, 1, "one webhook.created audit row");
  ok(!JSON.stringify(rows[0]).includes(secret!), "🔴 the AUDIT row does not contain the secret");
  eq((rows[0]!.detail as Record<string, unknown>).revealDelivered, true, "the audit records that the reveal was delivered");

  eq(delivered.length, 1, "exactly one private delivery");
  eq(delivered[0]!.userId, DECIDER, "🔴 delivered to the DECIDER");
  eq(delivered[0]!.channelId, "C1", "…in the frozen channel");
  ok(delivered[0]!.text.includes(`${revealMod.REVEAL_PAGE_PATH}?t=`), "the private message carries the one-time LINK");
  ok(!delivered[0]!.text.includes(secret!), "🔴 even the PRIVATE message carries only the link, never the secret itself");

  const idRe = /hk_[a-z2-7]{26}/;
  ok(!idRe.test(card), "🔴 the pending card contains no hook id");
  ok(!idRe.test(outcome), "🔴 the decided outcome line contains no hook id");
  ok(!idRe.test(delivered[0]!.text.split("?t=")[0]!), "the private message's prose carries no bare id (only the opaque token)");
}

{
  console.log("\n5. list_webhooks projection (the id-invisibility invariant):");
  const hooks = await store.listWebhookHooks(ORG);
  const projected = hooks.map((h) => ({ source: h.source, posture: h.posture, status: h.status, createdBy: h.createdBy, createdAt: h.createdAt, description: rh.describeRuntimeHook(h) }));
  const blob = JSON.stringify(projected);
  ok(!/hk_[a-z2-7]{26}/.test(blob), "🔴 the projection contains NO hook id");
  ok(!blob.includes("hook:"), "🔴 …and no secret ref");
  ok(!blob.includes("/webhooks/"), "🔴 …and no endpoint URL");
  ok(blob.includes("notion"), "…but it does name the source, which is the handle every other tool uses");
  ok(rh.describeRuntimeHook({ source: "notion", posture: "trigger-only", status: "active" }).includes("payload discarded"), "the description explains the posture in consequences");
  ok(rh.describeRuntimeHook({ source: "notion", posture: "content-bearing", status: "revoked" }).includes("REVOKED"), "a revoked hook says so");
}

{
  console.log("\n6. webhook.rotate:");
  const before = (await vault.read(rh.runtimeHookSecretRef(createdId)))!;
  delivered.length = 0;
  const outcome = await rotateKind.execute(
    { org: ORG, id: createdId, source: "notion", posture: "content-bearing" as const, surfaceKey: SURFACE, requestedBy: REQUESTER, platform: "slack", channelId: "C1" },
    DECIDER,
  );
  const after = (await vault.read(rh.runtimeHookSecretRef(createdId)))!;
  ok(after !== before, "the current secret changed");
  eq(await vault.read(rh.runtimeHookPrevSecretRef(createdId)), before, "the SUPERSEDED secret is preserved at the :prev ref for the overlap");

  const row = (await store.getWebhookHookById(createdId))!;
  ok(row.prevSecretRef === rh.runtimeHookPrevSecretRef(createdId), "the row records the overlap ref");
  ok(typeof row.prevExpiresAt === "string", "…and its expiry");
  const overlapMs = Date.parse(row.prevExpiresAt!) - Date.now();
  ok(overlapMs > 23 * 3_600_000 && overlapMs <= 24 * 3_600_000 + 5_000, "🔴 the overlap is the HOST-CLAMPED 24h default (not model-chosen)");
  eq(rh.activeSecretRefs(row, Date.now()), [row.secretRef, row.prevSecretRef], "during the overlap both refs are active, current first");
  eq(rh.activeSecretRefs(row, Date.parse(row.prevExpiresAt!) + 1), [row.secretRef], "after the overlap only the current ref is");

  ok(!outcome.includes(after), "🔴 the public outcome line does not contain the new secret");
  eq(delivered.length, 1, "one fresh private delivery");
  ok(!delivered[0]!.text.includes(after), "…carrying only the link");

  const exported = Object.keys(revealMod);
  ok(!exported.some((k) => /reReveal|showSecret|revealAgain/i.test(k)), "🔴 no re-reveal export exists in the reveal module");
  const provisioning = Object.keys(await import("../agent/approvals/webhook.js"));
  ok(!provisioning.some((k) => /reveal(Again)?Existing|showSecret/i.test(k)), "🔴 no re-reveal ActionKind is registered");
  ok(actionKind("webhook.reveal") === undefined, "🔴 there is deliberately no `webhook.reveal` kind — rotation IS the recovery path");
}

{
  console.log("\n7. webhook.revoke:");
  const liveSecret = (await vault.read(rh.runtimeHookSecretRef(createdId)))!;
  ok((await ri.resolveRuntimeHook(createdId)) !== undefined, "before: the endpoint resolves");

  const outcome = await revokeKind.execute({ org: ORG, id: createdId, source: "notion", surfaceKey: SURFACE, requestedBy: REQUESTER }, DECIDER);
  ok(outcome.includes("revoked"), "the outcome line says so");

  const row = (await store.getWebhookHookById(createdId))!;
  eq(row.status, "revoked", "the row is revoked (RETAINED, so the refusal stays auditable)");
  eq(row.revokedBy, DECIDER, "attributed to the clicker");
  eq(await ri.resolveRuntimeHook(createdId), undefined, "🔴 the endpoint no longer resolves — 404, indistinguishable from never-existed");

  const nowStored = await vault.read(rh.runtimeHookSecretRef(createdId));
  ok(nowStored !== liveSecret, "🔴 the vault ref was OVERWRITTEN with fresh random that is never revealed");
  ok((await vault.read(rh.runtimeHookPrevSecretRef(createdId))) !== null, "the overlap ref was scrubbed too, not left holding a live key");

  const rows = await readAudit({ org: ORG, action: "webhook.revoked" });
  eq(rows.length, 1, "one webhook.revoked audit row");
  ok(!JSON.stringify(rows[0]).includes(liveSecret), "the audit row carries no secret");

  const again = await revokeKind.execute({ org: ORG, id: createdId, source: "notion", surfaceKey: SURFACE, requestedBy: REQUESTER }, DECIDER);
  ok(typeof again === "string", "a second revoke returns an outcome line rather than throwing");
  const rot = await rotateKind.execute(
    { org: ORG, id: createdId, source: "notion", posture: "content-bearing" as const, surfaceKey: SURFACE, requestedBy: REQUESTER, platform: "slack", channelId: "C1" },
    DECIDER,
  );
  ok(/no active/.test(rot), "🔴 rotating a REVOKED hook is refused — it never comes back to life");
  eq((await store.getWebhookHookById(createdId))!.status, "revoked", "…and it stays revoked");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n✅ webhook-provisioning: ${n} checks passed`);
