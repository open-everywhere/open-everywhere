import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-eve-approval-response-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_PLATFORM = "slack";
delete process.env.OE_ORG;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}
function eq<T>(actual: T, expected: T, label: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const require_ = createRequire(import.meta.url);
const eveRoot = dirname(require_.resolve("eve/package.json"));
const distSrc = join(eveRoot, "dist", "src");
const eveVersion = (JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")) as { version: string }).version;
const read = (rel: string): string => readFileSync(join(distSrc, rel), "utf8");

console.log(`eve-approval-response: pinning against installed eve ${eveVersion}\n`);

console.log("1. eve dist pins:");
{
  const coord = read("harness/approval-delivery-coordinator.js");

  const authStart = coord.indexOf("async function authorizeCandidate(");
  const failStart = coord.indexOf("function failCandidate(");
  ok(authStart >= 0 && failStart > authStart, "approval-delivery-coordinator.js still declares authorizeCandidate → failCandidate");
  const authorize = coord.slice(authStart, failStart);
  const dv = /(\w+)=await withAuthorizerTimeout\(/.exec(authorize)?.[1];
  ok(dv !== undefined, "authorizeCandidate still awaits the response policy through withAuthorizerTimeout");
  const rejectArm = new RegExp(`${dv as string}\\.status===\`rejected\`\\)return[^;]*finishApprovalCandidate\\(`);
  ok(rejectArm.test(authorize), "a `rejected` decision finishes only the CANDIDATE (finishApprovalCandidate) — the request stays pending");
  ok(
    !/status===`rejected`[\s\S]{0,200}settleDirectApprovalResponse\(/.test(authorize),
    "…and the rejected arm never settles the request (no eve-native final DENY — the OE decide core stays)",
  );

  const settledEventType = read("protocol/message.d.ts");
  ok(
    /outcome: "approved" \| "cancelled";/.test(settledEventType),
    "the settlement vocabulary is still `approved | cancelled` only — no `denied` outcome exists to adopt",
  );

  const coordBody = coord.slice(coord.indexOf("async function coordinateApprovalDelivery("), authStart);
  const cancelIdx = coordBody.indexOf("optionId===`cancel`");
  const candidateIdx = coordBody.indexOf("createApprovalCandidate(");
  ok(cancelIdx >= 0 && candidateIdx > cancelIdx, "the cancel branch is still reached BEFORE createApprovalCandidate");
  const betweenCancelAndCandidate = coordBody.slice(cancelIdx, candidateIdx);
  ok(
    /settleDirectApprovalResponse\(\{actor:[^}]*outcome:`cancelled`/.test(betweenCancelAndCandidate),
    "a cancel click still settles the request DIRECTLY with the raw clicker auth — the response policy is never consulted",
  );

  const timeoutStart = coord.indexOf("async function withAuthorizerTimeout(");
  ok(timeoutStart >= 0, "withAuthorizerTimeout is still the wrapper around the response policy call");
  const timeoutFn = coord.slice(timeoutStart);
  ok(/setTimeout\([^,]*,1e4\)/.test(timeoutFn), "the response-policy timeout is still 10s (1e4) and still not configurable");
  ok(/expiresAt:\w+\+6e5,/.test(coordBody), "an approval candidate still expires 600000 ms (6e5) after creation");

  const authRequiredSet = /(\w+)=new Set\(\w+\.flatMap\(\w+=>\w+\.responseAuthRequiredRequestIds\?\?\[\]\)\)/.exec(coordBody);
  ok(authRequiredSet !== null, "the coordinator still builds a Set of responseAuthRequiredRequestIds from the pending batches");
  const parkBranch = new RegExp(`${authRequiredSet?.[1] as string}\\.size>0\\)return deliveryResult\\([^;]*\`park\``);
  ok(parkBranch.test(coordBody), "a message arriving with no responses and no active candidates PARKS when the request requires response auth");
  ok(
    coordBody.includes("Please use the Approve or Cancel buttons to respond to this approval."),
    "…and the dropped message is answered with eve's use-the-buttons feedback",
  );

  const dyn = read("context/build-dynamic-tools.js");
  const brStart = dyn.indexOf("function buildReplayedApproval(");
  ok(brStart >= 0, "build-dynamic-tools.js still declares buildReplayedApproval");
  const br = dyn.slice(brStart, dyn.indexOf("function buildResponseAuthorizationTools("));
  ok(/approvalResponse`[\s\S]{0,160}?status:`rejected`/.test(br), "an unregistered response authorizer still degrades to REJECT-EVERYTHING (not to allow, not to re-ask)");
  ok(/approvalRequest`[\s\S]{0,120}?`user-approval`/.test(br), "…while the REQUEST half degrades to a harmless re-ask — the asymmetry the pre-registration exists for");

  const hookMap = read("public/definitions/hook.d.ts");
  ok(/"approval\.candidate": ProtocolEvent<"approval\.candidate">/.test(hookMap), "`approval.candidate` is still an authored-hook event");
  ok(/"approval\.settled": ProtocolEvent<"approval\.settled">/.test(hookMap), "`approval.settled` is still an authored-hook event");
}

console.log("2. response policy (adopt-part A):");
const { decideResponder, sameResponder, initiatorBoundResponsePolicy, FOREIGN_RESPONDER_REASON } = await import(
  "../agent/approvals/eve-response-policy.js"
);

const alice = { authenticator: "slack", principalId: "U_alice", principalType: "user" };
const bob = { authenticator: "slack", principalId: "U_bob", principalType: "user" };
const aliceElsewhere = { authenticator: "teams", principalId: "U_alice", principalType: "user" };
const aliceIssued = { ...alice, issuer: "https://slack.example" };

{
  eq(decideResponder(alice, alice), { status: "allowed" }, "the session initiator may approve their own request");
  eq(
    decideResponder(bob, alice),
    { reason: FOREIGN_RESPONDER_REASON, status: "rejected" },
    "a DIFFERENT principal is REJECTED — this is the standing check the adopt buys",
  );
  ok(sameResponder(bob, alice) === false, "sameResponder is FALSE for two different principals (negative control)");
  ok(sameResponder(alice, alice) === true, "sameResponder is TRUE for the same principal");
  ok(sameResponder(alice, aliceElsewhere) === false, "the same principal id on a DIFFERENT authenticator is not the same responder");
  ok(sameResponder(alice, aliceIssued) === false, "a differing `issuer` makes it a different responder (eve's own candidate-id grain)");
  ok(sameResponder(null, alice) === false, "a null responder never matches");
  ok(sameResponder(alice, undefined) === false, "an undefined initiator never matches through sameResponder");

  eq(decideResponder(bob, null), { status: "allowed" }, "with NO session initiator the policy allows (pre-adopt behaviour; a reject would deadlock the card)");
  eq(decideResponder(bob, undefined), { status: "allowed" }, "…same for an absent initiator");

  const policy = initiatorBoundResponsePolicy();
  const ctxOf = (responder: unknown, initiator: unknown): never =>
    ({ auth: {}, request: { callId: "c", requestId: "r", toolName: "post_file" }, response: { decision: "approve" }, responder, session: { id: "s", initiator, turn: {} } }) as never;
  eq(policy(ctxOf(alice, alice)), { status: "allowed" }, "the policy allows the initiator's own click through eve's ApprovalResponseContext");
  eq(policy(ctxOf(bob, alice)), { reason: FOREIGN_RESPONDER_REASON, status: "rejected" }, "…and rejects a bystander's click");

  ok(!(policy(ctxOf(alice, alice)) instanceof Promise), "the policy returns SYNCHRONOUSLY — nothing behind it can block against eve's 10s hard timeout");
}

{
  const { connectorApprovalPolicy } = await import("../agent/connections/connector-auth.js");
  const connApproval: unknown = connectorApprovalPolicy();
  ok(typeof connApproval === "function", "connectorApprovalPolicy() returns a BARE request policy — the only shape eve's connection resolver keeps");
  ok(
    typeof (connApproval as { response?: unknown }).response !== "function",
    "…and carries no response policy — a shape eve would drop",
  );
}

console.log("3. replay registration (the unapprovable-card trap):");
{
  const { replayStepNames, approvalResponseOf, preRegisterDynamicEntry } = await import("../agent/access/window-gated.js");
  const reg = (globalThis as Record<symbol, unknown>)[Symbol.for("@workflow/core//registeredSteps")] as Map<string, unknown>;
  ok(reg instanceof Map, "the @workflow/core step registry exists on globalThis");

  const names = replayStepNames("pretend_publish", "_single");
  eq(names.approvalResponse, "eve:dynamic-tool-approval-response:pretend_publish:_single", "replayStepNames derives eve's own response step name");

  ok(approvalResponseOf({ approval: () => "user-approval" }) === undefined, "a bare policy has no response half (negative control)");
  ok(approvalResponseOf({}) === undefined, "an approval-less entry has no response half");
  ok(typeof approvalResponseOf({ approval: { request: () => "user-approval", response: () => ({ status: "allowed" }) } }) === "function", "a configuration's response half is read");

  const entry = {
    description: "stub publish tool",
    inputSchema: { type: "object", properties: {} },
    approval: {
      request: () => "user-approval",
      response: (c: { responder?: unknown; session?: { initiator?: unknown } }) => decideResponder(c.responder as never, c.session?.initiator as never),
    },
    execute: () => ({ ok: true }),
  };
  preRegisterDynamicEntry("pretend_publish", "_single", entry as never);
  ok(typeof reg.get(names.approvalResponse) === "function", "preRegisterDynamicEntry registers the RESPONSE policy under eve's deterministic name");

  const keys = (await import(pathToFileURL(join(distSrc, "context/keys.js")).href)) as { SessionDynamicToolMetadataKey: unknown };
  const builder = (await import(pathToFileURL(join(distSrc, "context/build-dynamic-tools.js")).href)) as {
    buildResponseAuthorizationTools(input: { authoredTools: Map<string, unknown>; context?: { get(key: unknown): unknown } }): Map<string, { approval?: unknown }>;
  };
  const contextOf = (meta: readonly unknown[]) => ({ get: (key: unknown) => (key === keys.SessionDynamicToolMetadataKey ? meta : undefined) });
  const replayLookup = (meta: readonly unknown[]) => builder.buildResponseAuthorizationTools({ authoredTools: new Map(), context: contextOf(meta) });
  const lifecycle = (await import(pathToFileURL(join(distSrc, "context/dynamic-tool-lifecycle.js")).href)) as {
    validateDurableDynamicToolCallbacks(name: string, entry: unknown): Record<string, { closure: Record<string, unknown> }>;
  };
  const persisted = lifecycle.validateDurableDynamicToolCallbacks("pretend_publish", entry);
  ok(persisted.approvalResponse !== undefined, "resolve-time validation persists the approval RESPONSE phase preRegisterDynamicEntry described");
  ok(!("stepId" in persisted.approvalResponse!), "…as a closure-only reference — a stepId key is refused as the pre-release shape");
  const metaRow = {
    name: "pretend_publish",
    description: "stub publish tool",
    inputSchema: { type: "object", properties: {} },
    resolverSlug: "pretend_publish",
    entryKey: "_single",
    callbacks: persisted,
  };
  const replayed = replayLookup([metaRow]);
  eq(replayed.size, 1, "eve replays the pre-registered entry (no skip)");
  const replayedApproval = replayed.get("pretend_publish")?.approval as { request?: unknown; response?: (c: unknown) => Promise<unknown> } | undefined;
  ok(typeof replayedApproval === "object" && replayedApproval !== null, "eve rebuilt an approval CONFIGURATION on replay");
  ok(typeof replayedApproval?.response === "function", "…with a response policy");
  eq(
    await (replayedApproval?.response as (c: unknown) => Promise<unknown>)({ responder: alice, session: { initiator: alice } }),
    { status: "allowed" },
    "the REPLAYED response policy is OURS and ALLOWS the initiator — not eve's reject-everything fallback",
  );
  eq(
    await (replayedApproval?.response as (c: unknown) => Promise<unknown>)({ responder: bob, session: { initiator: alice } }),
    { reason: FOREIGN_RESPONDER_REASON, status: "rejected" },
    "…and rejects a bystander with OUR reason (eve's fallback reason would differ)",
  );

  const unregistered = replayLookup([{ ...metaRow, name: "never_registered_tool" }]);
  const bad = unregistered.get("never_registered_tool")?.approval as { response?: (c: unknown) => Promise<{ status?: string }> } | undefined;
  const badDecision = await bad?.response?.({ responder: alice, session: { initiator: alice } });
  eq(badDecision?.status, "rejected", "an UNREGISTERED response authorizer rejects even the initiator — the trap is real (negative control)");
}

console.log("4. settlement audit (adopt-part C):");
{
  const { registerConfig } = await import("../agent/access/config.js");
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });

  const hookMod = await import("../agent/hooks/approval-settlement.js");
  const { readAudit } = await import("../agent/audit/audit.js");
  const { EVE_APPROVAL_SETTLED_ACTION, EVE_APPROVAL_CANDIDATE_ACTION } = hookMod;
  const events = (hookMod.default as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events;
  const onCandidate = events["approval.candidate"] as (e: unknown, c: unknown) => Promise<void>;
  const onSettled = events["approval.settled"] as (e: unknown, c: unknown) => Promise<void>;
  ok(typeof onCandidate === "function" && typeof onSettled === "function", "the hook subscribes to BOTH approval.candidate and approval.settled");

  const ctx = {
    session: {
      auth: {
        current: {
          principalType: "user",
          principalId: "U_alice",
          authenticator: "slack",
          attributes: { team_id: "T_TEAM", channel_id: "C_ROOM", channel_type: "channel", user_id: "U_alice" },
        },
      },
    },
    channel: { kind: "slack" },
    agent: { name: "oe" },
  };

  await onSettled({ type: "approval.settled", data: { outcome: "approved", requestId: "req-1", responderPrincipalId: "U_alice", turnId: "t-1" } }, ctx);
  {
    const rows = await readAudit({ org: "default", action: EVE_APPROVAL_SETTLED_ACTION });
    eq(rows.length, 1, "an approved settlement writes exactly one row");
    eq(rows[0]?.detail?.outcome, "approved", "the row records the outcome");
    eq(rows[0]?.detail?.requestId, "req-1", "…the request id");
    eq(rows[0]?.detail?.responderPrincipalId, "U_alice", "…and WHO settled it");
  }

  await onSettled({ type: "approval.settled", data: { outcome: "cancelled", requestId: "req-2", responderPrincipalId: "U_bob" } }, ctx);
  {
    const rows = await readAudit({ org: "default", action: EVE_APPROVAL_SETTLED_ACTION });
    eq(rows.length, 2, "a cancelled settlement writes its own row");
    const cancelled = rows.find((r) => r.detail?.requestId === "req-2");
    eq(cancelled?.detail?.outcome, "cancelled", "the cancel row records the cancel");
    eq(cancelled?.detail?.responderPrincipalId, "U_bob", "…and the clicker who cancelled somebody else's request (the ONLY record of the cancel asymmetry)");
  }

  await onCandidate(
    { type: "approval.candidate", data: { outcome: "rejected", requestId: "req-3", candidateId: "cand-3", responderPrincipalId: "U_bob", reason: FOREIGN_RESPONDER_REASON } },
    ctx,
  );
  {
    const rows = await readAudit({ org: "default", action: EVE_APPROVAL_CANDIDATE_ACTION });
    eq(rows.length, 1, "a rejected candidate writes one candidate row");
    eq(rows[0]?.detail?.outcome, "rejected", "the row records the rejection");
    eq(rows[0]?.detail?.candidateId, "cand-3", "…the candidate id");
    eq(rows[0]?.detail?.reason, FOREIGN_RESPONDER_REASON, "…and the response policy's own refusal reason");
  }

  await onCandidate({ type: "approval.candidate", data: { outcome: "pending", requestId: "req-4", candidateId: "cand-4", responderPrincipalId: "U_alice" } }, ctx);
  eq((await readAudit({ org: "default", action: EVE_APPROVAL_CANDIDATE_ACTION })).length, 1, "a PENDING candidate writes NO row (only decisions land on the chain)");

  await onCandidate({ type: "approval.candidate", data: { outcome: "timed-out", requestId: "req-5", candidateId: "cand-5", responderPrincipalId: "U_alice" } }, ctx);
  eq((await readAudit({ org: "default", action: EVE_APPROVAL_CANDIDATE_ACTION })).length, 2, "a timed-out candidate DOES land a row");

  await onSettled({ type: "approval.settled", data: {} }, ctx);
  await onSettled(undefined, ctx);
  await onCandidate({ type: "approval.candidate" }, ctx);
  eq((await readAudit({ org: "default", action: EVE_APPROVAL_SETTLED_ACTION })).length, 2, "an event with no outcome/requestId writes nothing and throws nothing");

  const { findChainBreak } = await import("../agent/audit/chain.js");
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const chainRows = await getOperationalStore().readAuditChain("default");
  ok(chainRows.length >= 4, "the settlement rows are on the org's audit chain");
  eq(findChainBreak(chainRows), null, "…and the chain is intact after them (they are ordinary chained rows, not a side store)");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ eve-approval-response: ${passed} assertions passed`);
