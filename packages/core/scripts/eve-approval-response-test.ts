import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";
import { PROSE_READ_ON, citedDeclaration } from "./_eve-pruned-declaration.js";
import { setPlatformStandInForTest } from "../agent/identity/binding.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-eve-approval-response-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
setPlatformStandInForTest("slack");
_setDeploymentIdentityForTest({ org: undefined });

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

console.log("1. eve dist pins (the Interaction model's responders):");
{
  const responders = read("harness/hitl/responders.js");
  ok(
    /if\(\w+\.responseAuthRequiredRequestIds\?\.includes\(\w+\.interactionId\)!==!0\)\{/.test(responders),
    "a request WITHOUT a response policy takes eve's own requester-only path",
  );
  ok(
    /if\(\w+!==null&&\w+!==null&&!sameResponder\(\w+,\w+\)\)\{\w+\.push\(\{reason:REQUESTER_ONLY_FEEDBACK,/.test(responders),
    "🔴 …which refuses every responder who is not the requester (0.72.0: no response policy means requester-only)",
  );
  ok(
    /if\(\w+!==null&&\w+===null\)\{\w+\.push\(\{reason:UNAUTHENTICATED_FEEDBACK,/.test(responders),
    "…and refuses an unauthenticated responder whenever a requester exists",
  );
  ok(
    /function decisionOf\((\w)\)\{if\(\1\.optionId===`approve`\)return`approve`;if\(\1\.optionId===`deny`\)return`deny`\}/.test(responders),
    "an answer's decision is `approve` or `deny` (0.84.0 renamed `cancel`); any other option is refused before a policy runs",
  );
  ok(/let \w+=\w+\.value\?\.optionId===`approve`\?`approve`:`deny`;/.test(responders), "the decision a response policy weighs is `approve` or `deny`");
  ok(
    /case`refused`:\w+\.push\(responseSettled\(\w+,`refused`,\w+\.reason\)\);break;/.test(responders),
    "a `rejected` policy decision settles only the RESPONSE as refused — the interaction stays open for the requester",
  );
  ok(
    /request:\{callId:[^}]*principal:\w+\.step\.requester\?\?null,/.test(responders),
    "the policy receives the requester as `request.principal`",
  );
  ok(/response:\{decision:\w+\.decision,principal:\w+\.pending\.responder\}/.test(responders), "…and the responder as `response.principal`");
  ok(
    /let \w+=\w+!==void 0&&typeof \w+!=`function`\?\w+\.response:void 0;if\(\w+===void 0\)return\{kind:`failed`,reason:TEMPORARILY_UNAVAILABLE_REASON\}/.test(responders),
    "a weighed response whose restored tool has no response policy FAILS — it is never admitted by default",
  );
  ok(/setTimeout\([^,]*,1e4\)/.test(responders), "the response-policy timeout is still 10s (1e4) and still not configurable");
  ok(/expiresAt:\w+\+6e5,/.test(responders), "a weighed response still expires 600000 ms (6e5) after it arrives");

  const hitl = read("harness/hitl/index.js");
  ok(
    /responseAuthRequiredRequestIds:responsePolicyRequestIds\(/.test(hitl) &&
      /function responsePolicyRequestIds\((\w),(\w)\)\{return \2\.filter\(\w=>\{let (\w)=\1\.get\(\w\.call\.toolName\)\?\.approval;return \3!==void 0&&typeof \3!=`function`&&\3\.response!==void 0\}\)/.test(hitl),
    "🔴 eve sends a request to the response-policy path exactly when its tool declares a response policy (the set §1b sets by hand)",
  );
  ok(/function currentRequester\((\w)\)\{return \1\.ctx\.get\(AuthKey\)\?\?\1\.ctx\.get\(SessionKey\)\?\.auth\.current\?\?null\}/.test(hitl), "the requester is the turn's authenticated caller, or none");

  const requesterOnly = read("approval/requester-only.js");
  ok(
    /function sameResponder\((\w),(\w)\)\{return \1\.authenticator===\2\.authenticator&&\(\1\.issuer\?\?``\)===\(\2\.issuer\?\?``\)&&\1\.principalType===\2\.principalType&&\1\.principalId===\2\.principalId\}/.test(requesterOnly),
    "eve's sameResponder keys on the same four fields as OE's (authenticator, issuer, principal type, principal id)",
  );

  const approvals = read("harness/hitl/approvals.js");
  ok(
    /let \w+=\w+\.requester\?\.principalType===`anonymous`\?null:\w+\.requester;/.test(approvals),
    "an ANONYMOUS requester is recorded as no requester, so eve's default admits any responder (OE's policy falls back to the session initiator)",
  );

  const executor = read("harness/call-executor.js");
  ok(/approval:\{responder:\w+\.responder\}/.test(executor), "an approved call reads its approver as `ctx.approval.responder` (0.78.0)");
  // eve 1.0.1 stopped shipping this declaration. While it is absent, citedDeclaration requires the
  // approved-calls module the sentence was read on, and throws when it changed.
  const approvedCalls = citedDeclaration(distSrc, "harness/hitl/approved-calls.d.ts");
  ok(
    !approvedCalls.shipped || /it still runs as the requester/.test(approvedCalls.text),
    "…and still runs as the requester (0.79.1)" +
      (approvedCalls.shipped ? "" : ` (carried: ${JSON.stringify(approvedCalls.carriedBy)} unchanged since the eve ${PROSE_READ_ON} read)`),
  );
  if (!approvedCalls.shipped) console.log(`· approved-calls.d.ts is not shipped; its citation is carried by ${JSON.stringify(approvedCalls.carriedBy)} (prose last read on eve ${PROSE_READ_ON})`);

  const def = read("approval/definition.d.ts");
  ok(/readonly decision: "approve" \| "deny";/.test(def), "eve's ApprovalResponse carries `decision: \"approve\" | \"deny\"`");
  ok(/interface ApprovalRequest[\s\S]{0,700}readonly principal: SessionAuthContext \| null;/.test(def), "eve's ApprovalRequest carries the requester as `principal`");
  ok(!/approvedTools/.test(def), "eve's ApprovalContext carries no `approvedTools` set (0.84.0)");
  const statusUnion = /export type ApprovalStatus =([^;]*);/.exec(def)?.[1];
  ok(statusUnion !== undefined, "eve still declares the request-time `ApprovalStatus` union");
  for (const member of ['"denied"', '"user-approval"', '"approved"', '"not-applicable"']) {
    ok((statusUnion as string).includes(member), `…and ${member} is still one of its members`);
  }
  ok(
    /readonly type: "denied";/.test(def) && /readonly type: "user-approval";/.test(def),
    "…and `denied` is a SEPARATE decision from `user-approval`, in the object form too",
  );

  const hookMap = read("public/definitions/hook.d.ts");
  for (const event of ["response.submitted", "response.settled", "interaction.settled"]) {
    ok(new RegExp(`readonly "${event.replace(".", "\\.")}": false;`).test(hookMap), `\`${event}\` is still an authored-hook event`);
  }
}

console.log("1b. eve's real responder check, driven with a requester and a bystander:");
{
  const { checkResponders, weighResponders } = (await import(pathToFileURL(join(distSrc, "harness/hitl/responders.js")).href)) as {
    checkResponders(state: unknown, input: unknown, now: number): { admit: string[]; refused: { reason: string; responseId: string }[]; weigh: Record<string, unknown> };
    weighResponders(state: unknown, input: unknown): Promise<{ events: { type: string; data: Record<string, unknown> }[] }>;
  };
  const { REQUESTER_ONLY_FEEDBACK } = (await import(pathToFileURL(join(distSrc, "approval/requester-only.js")).href)) as { REQUESTER_ONLY_FEEDBACK: string };
  const requester = { authenticator: "slack", principalId: "U_req", principalType: "user" };
  const bystander = { authenticator: "slack", principalId: "U_by", principalType: "user" };
  const pending = (withPolicy: boolean): Record<string, any> => ({
    projection: { view: { responses: {} } },
    turn: {
      id: "turn-1",
      suspended: [
        {
          requester,
          requests: [{ interactionId: "int-1", call: { callId: "call-1", toolName: "pretend_publish", input: {} } }],
          responseAuthRequiredRequestIds: withPolicy ? ["int-1"] : [],
        },
      ],
    },
    responders: {},
  });
  const answer = (responder: unknown, optionId = "approve") => ({ answers: [{ responseId: "resp-1", interactionId: "int-1", optionId, responder }] });

  const foreign = checkResponders(pending(false), answer(bystander), 0);
  eq(foreign.admit, [], "🔴 a requester-only card (no response policy): a NON-REQUESTER's approve is NOT admitted");
  eq(foreign.refused, [{ reason: REQUESTER_ONLY_FEEDBACK, responseId: "resp-1" }], "…it is refused with eve's requester-only reason");
  eq(checkResponders(pending(false), answer(bystander, "deny"), 0).admit, [], "🔴 …and a non-requester's DENY is not admitted either");
  eq(checkResponders(pending(false), answer(requester), 0).admit, ["resp-1"], "the requester's own answer is admitted (negative control)");
  eq(
    checkResponders(pending(false), answer(bystander, "cancel"), 0).refused.map((r) => r.reason),
    ["Respond to this approval with Approve or Cancel."],
    "the retired `cancel` option is refused before any responder check",
  );
  ok(Object.keys(checkResponders(pending(true), answer(bystander), 0).weigh).length === 1, "a request WITH a response policy is sent to be weighed, not admitted");

  const { requesterBoundResponsePolicy, FOREIGN_RESPONDER_REASON: approveRefusal, FOREIGN_DENY_REASON: denyRefusal } = await import(
    "../agent/approvals/eve-response-policy.js"
  );
  const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(distSrc, "context/container.js")).href)) as {
    ContextContainer: new () => { set(key: unknown, value: unknown): void };
    contextStorage: { run<T>(store: unknown, fn: () => T): T };
  };
  const { SessionKey } = (await import(pathToFileURL(join(distSrc, "context/keys.js")).href)) as { SessionKey: unknown };
  const tools = async () => new Map([["pretend_publish", { approval: { request: () => "user-approval", response: requesterBoundResponsePolicy() } }]]);
  const weigh = async (responder: unknown, optionId: string) => {
    const state = pending(true);
    state.responders = { "resp-1": { expiresAt: Date.now() + 60_000, responder } };
    state.projection.view.responses = { "resp-1": { status: "submitted", interactionId: "int-1", introducedAt: 1, responseId: "resp-1", value: { optionId } } };
    const container = new ContextContainer();
    container.set(SessionKey, { sessionId: "sess-1", auth: { current: requester, initiator: requester }, turn: { id: "turn-1" } });
    return (await contextStorage.run(container, () => weighResponders(state, { now: Date.now(), tools }))).events;
  };
  eq(
    await weigh(bystander, "approve"),
    [{ data: { outcome: "refused", reason: approveRefusal, responseId: "resp-1" }, type: "response.settled" }],
    "🔴 eve's own weighing runs OE's policy: a bystander's APPROVE settles refused with OE's reason, and the interaction stays open",
  );
  eq(
    await weigh(bystander, "deny"),
    [{ data: { outcome: "refused", reason: denyRefusal, responseId: "resp-1" }, type: "response.settled" }],
    "🔴 …and a bystander's DENY is refused too: a bystander cannot kill the requester's pending action",
  );
  eq(await weigh(requester, "approve"), [{ type: "response.admitted", data: { responseId: "resp-1" } }], "the requester's approve is admitted (negative control)");
}

console.log("2. response policy (adopt-part A):");
const { decideResponder, sameResponder, requesterBoundResponsePolicy, FOREIGN_RESPONDER_REASON, FOREIGN_DENY_REASON } = await import(
  "../agent/approvals/eve-response-policy.js"
);

const alice = { authenticator: "slack", principalId: "U_alice", principalType: "user" };
const bob = { authenticator: "slack", principalId: "U_bob", principalType: "user" };
const aliceElsewhere = { authenticator: "teams", principalId: "U_alice", principalType: "user" };
const aliceIssued = { ...alice, issuer: "https://slack.example" };

{
  eq(decideResponder(alice, alice), { status: "allowed" }, "the requester may approve their own request");
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
  ok(sameResponder(alice, undefined) === false, "an undefined bound principal never matches through sameResponder");

  eq(decideResponder(bob, null), { status: "allowed" }, "with NO bound principal the policy allows (pre-adopt behaviour; a reject would deadlock the card)");
  eq(decideResponder(bob, undefined), { status: "allowed" }, "…same for an absent bound principal");

  eq(decideResponder(bob, alice, "deny"), { reason: FOREIGN_DENY_REASON, status: "rejected" }, "🔴 a foreign responder's DENY is refused — a bystander cannot kill the requester's pending action");
  eq(decideResponder(alice, alice, "deny"), { status: "allowed" }, "the requester's own DENY is allowed (negative control)");
  eq(decideResponder(bob, null, "deny"), { status: "allowed" }, "with NO bound principal a deny is allowed too, on the same deadlock reasoning");
  ok((FOREIGN_DENY_REASON as string) !== FOREIGN_RESPONDER_REASON && /deny/.test(FOREIGN_DENY_REASON), "the deny refusal names the deny leg");

  const policy = requesterBoundResponsePolicy();
  const ctxOf = (responder: unknown, requester: unknown, initiator: unknown, decision: "approve" | "deny" = "approve"): never =>
    ({
      auth: {},
      request: { callId: "c", requestId: "r", toolName: "post_file", principal: requester },
      response: { decision, principal: responder },
      session: { id: "s", initiator, turn: {} },
    }) as never;
  eq(policy(ctxOf(alice, alice, alice)), { status: "allowed" }, "the policy allows the requester's own click through eve's ApprovalResponseContext");
  eq(policy(ctxOf(bob, alice, alice)), { reason: FOREIGN_RESPONDER_REASON, status: "rejected" }, "…and rejects a bystander's click");
  eq(policy(ctxOf(bob, alice, alice, "deny")), { reason: FOREIGN_DENY_REASON, status: "rejected" }, "🔴 …and rejects a bystander's DENY through the real context shape");
  eq(policy(ctxOf(alice, alice, alice, "deny")), { status: "allowed" }, "…and allows the requester's own DENY");

  eq(policy(ctxOf(bob, bob, alice)), { status: "allowed" }, "🔴 the REQUESTER (request.principal) may answer in a session somebody else initiated");
  eq(policy(ctxOf(alice, bob, alice)), { reason: FOREIGN_RESPONDER_REASON, status: "rejected" }, "🔴 the session INITIATOR cannot answer a request somebody else made");
  eq(policy(ctxOf(alice, bob, alice, "deny")), { reason: FOREIGN_DENY_REASON, status: "rejected" }, "…and cannot deny it either");
  eq(policy(ctxOf(bob, null, alice)), { reason: FOREIGN_RESPONDER_REASON, status: "rejected" }, "no requester ⇒ the session initiator binds the click (the fallback never widens)");
  eq(policy(ctxOf(alice, null, alice)), { status: "allowed" }, "no requester ⇒ the initiator may answer");
  eq(policy(ctxOf(bob, null, null)), { status: "allowed" }, "no requester and no initiator ⇒ allowed (the deadlock leg)");

  ok(!(policy(ctxOf(alice, alice, alice)) instanceof Promise), "the policy returns SYNCHRONOUSLY — nothing behind it can block against eve's 10s hard timeout");
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

console.log("3. the response policy rides the live dynamic tool (no replay registration):");
{
  const { approvalResponseOf, evaluateDynamic, sessionMountedTool } = await import("../agent/access/window-gated.js");
  ok(approvalResponseOf({ approval: () => "user-approval" }) === undefined, "a bare policy has no response half (negative control)");
  ok(approvalResponseOf({}) === undefined, "an approval-less entry has no response half");
  ok(typeof approvalResponseOf({ approval: { request: () => "user-approval", response: () => ({ status: "allowed" }) } }) === "function", "a configuration's response half is read");

  const { defineTool } = await import("eve/tools");
  const entry = defineTool({
    description: "stub publish tool",
    inputSchema: { type: "object", properties: {} },
    approval: {
      request: () => "user-approval",
      response: (c: { response?: { principal?: unknown }; request?: { principal?: unknown } }) => decideResponder(c.response?.principal as never, c.request?.principal as never),
    },
    execute: () => ({ ok: true }),
  } as never);
  const dynamic = sessionMountedTool("pretend_publish", entry as never);
  const resolved = await evaluateDynamic(dynamic, { session: { id: "sess-eve-approval-response" } });
  const { contributeTools } = (await import(pathToFileURL(join(distSrc, "definitions/tools.js")).href)) as {
    contributeTools(def: { logicalPath: string; slug: string }, value: unknown, ctx: unknown): { live?: { name: string; approval?: unknown }[] };
  };
  const { ContextContainer } = (await import(pathToFileURL(join(distSrc, "context/container.js")).href)) as { ContextContainer: new () => unknown };
  const live = contributeTools({ logicalPath: "agent/tools/pretend_publish.ts", slug: "pretend_publish" }, resolved, new ContextContainer()).live ?? [];
  eq(live.map((t) => t.name), ["pretend_publish"], "eve mounts the dynamic tool from the resolver's result");
  const liveApproval = live[0]?.approval as { request?: unknown; response?: (c: unknown) => Promise<unknown> | unknown } | undefined;
  ok(typeof liveApproval?.response === "function", "…and carries the approval CONFIGURATION with its response policy: a fresh process rebuilds it from the definition, so no card can lose its authorizer");
  eq(
    await liveApproval?.response?.({ request: { principal: alice }, response: { decision: "approve", principal: alice } }),
    { status: "allowed" },
    "the live response policy is OURS and ALLOWS the requester",
  );
  eq(
    await liveApproval?.response?.({ request: { principal: alice }, response: { decision: "approve", principal: bob } }),
    { reason: FOREIGN_RESPONDER_REASON, status: "rejected" },
    "…and rejects a bystander with OUR reason",
  );
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
  const events = (hookMod.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void>> }).events;
  const onSubmitted = events["response.submitted"]!;
  const onCandidate = events["response.settled"]!;
  const onSettled = events["interaction.settled"]!;
  ok(typeof onSubmitted === "function" && typeof onCandidate === "function" && typeof onSettled === "function", "the hook subscribes to response.submitted, response.settled and interaction.settled");

  const { interactionView, viewOf, ev, turnEvents } = await import("./_hook-view.js");
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
  const withDelivery = (interactionId: string, deliveryId: string, principalId: string) =>
    viewOf([
      ev("session.started", {}),
      ev("delivery.admitted", { deliveryId, principal: { id: principalId, type: "user" } }),
      ...turnEvents("t-1"),
      ev("interaction.opened", { interactionId, subject: { turnId: "t-1" }, request: { kind: "approval", prompt: "?" } }, { turnId: "t-1" }),
    ]);
  const { FakeEveContext, inEveContext } = await import("./_eve-context-stub.js");
  const session = new FakeEveContext();
  const inSession = <T>(fn: () => Promise<T>): Promise<T> => inEveContext(session, fn);

  await inSession(async () => {
    await onSubmitted({ type: "response.submitted", data: { responseId: "resp-1", interactionId: "req-1", deliveryId: "d-1" } }, { ...ctx, view: withDelivery("req-1", "d-1", "U_alice") });
    await onCandidate({ type: "response.settled", data: { responseId: "resp-1", outcome: "applied" } }, { ...ctx, view: interactionView("approval", "req-1") });
    await onSettled({ type: "interaction.settled", data: { interactionId: "req-1", outcome: "accepted", cause: { responseId: "resp-1" } } }, { ...ctx, view: interactionView("approval", "req-1", "accepted", "t-1") });
  });
  {
    const rows = await readAudit({ org: "default", action: EVE_APPROVAL_SETTLED_ACTION });
    eq(rows.length, 1, "an accepted approval writes exactly one row");
    eq(rows[0]?.detail?.outcome, "accepted", "the row records the outcome");
    eq(rows[0]?.detail?.requestId, "req-1", "…the request id");
    eq(rows[0]?.detail?.responderPrincipalId, "U_alice", "🔴 …and WHO settled it, even though eve settles the applied response first, in the same commit");
  }

  await inSession(async () => {
    await onSubmitted({ type: "response.submitted", data: { responseId: "resp-2", interactionId: "req-2", deliveryId: "d-2" } }, { ...ctx, view: withDelivery("req-2", "d-2", "U_bob") });
    await onCandidate({ type: "response.settled", data: { responseId: "resp-2", outcome: "applied" } }, { ...ctx, view: interactionView("approval", "req-2") });
    await onSettled({ type: "interaction.settled", data: { interactionId: "req-2", outcome: "declined", cause: { responseId: "resp-2" } } }, { ...ctx, view: interactionView("approval", "req-2", "declined", "t-1") });
  });
  {
    const rows = await readAudit({ org: "default", action: EVE_APPROVAL_SETTLED_ACTION });
    eq(rows.length, 2, "a declined approval writes its own row");
    const declined = rows.find((r) => r.detail?.requestId === "req-2");
    eq(declined?.detail?.outcome, "declined", "the decline row records the decline");
    eq(declined?.detail?.responderPrincipalId, "U_bob", "…and the clicker who declined somebody else's request (the ONLY record of a bystander deny)");
  }

  await inSession(async () => {
    await onSubmitted({ type: "response.submitted", data: { responseId: "cand-3", interactionId: "req-3", deliveryId: "d-3" } }, { ...ctx, view: withDelivery("req-3", "d-3", "U_bob") });
    await onCandidate({ type: "response.settled", data: { responseId: "cand-3", outcome: "refused", reason: FOREIGN_RESPONDER_REASON } }, { ...ctx, view: interactionView("approval", "req-3") });
  });
  {
    const rows = await readAudit({ org: "default", action: EVE_APPROVAL_CANDIDATE_ACTION });
    eq(rows.length, 1, "a refused response writes one candidate row");
    eq(rows[0]?.detail?.outcome, "refused", "the row records the refusal");
    eq(rows[0]?.detail?.candidateId, "cand-3", "…the candidate id");
    eq(rows[0]?.detail?.requestId, "req-3", "…the request it answered");
    eq(rows[0]?.detail?.responderPrincipalId, "U_bob", "…who sent it");
    eq(rows[0]?.detail?.reason, FOREIGN_RESPONDER_REASON, "…and the response policy's own refusal reason");
  }

  await inSession(async () => {
    await onCandidate({ type: "response.settled", data: { responseId: "cand-4", outcome: "applied" } }, { ...ctx, view: interactionView("approval", "req-4") });
  });
  eq((await readAudit({ org: "default", action: EVE_APPROVAL_CANDIDATE_ACTION })).length, 1, "an APPLIED response writes NO candidate row (the settled row records the decision)");

  await inSession(async () => {
    await onCandidate({ type: "response.settled", data: { responseId: "cand-5", outcome: "expired" } }, { ...ctx, view: interactionView("approval", "req-5") });
  });
  {
    const rows = await readAudit({ org: "default", action: EVE_APPROVAL_CANDIDATE_ACTION });
    eq(rows.length, 2, "an expired response DOES land a row, even when this session never saw it submitted");
    const unread = rows.find((r) => r.detail?.candidateId === "cand-5");
    eq(unread?.detail?.requestUnread, true, "…and it says the request is unread rather than inventing one");
    eq(unread?.detail?.interactionKind, "unknown", "…and that its interaction kind is unknown, so a reader never counts it as a refused APPROVAL");
  }

  const questionView = viewOf([
    ev("session.started", {}),
    ev("delivery.admitted", { deliveryId: "d-q", principal: { id: "U_bob", type: "user" } }),
    ...turnEvents("t-1"),
    ev("interaction.opened", { interactionId: "q-1", subject: { turnId: "t-1" }, request: { kind: "question", prompt: "which repo?" } }, { turnId: "t-1" }),
  ]);
  await inSession(async () => {
    await onSubmitted({ type: "response.submitted", data: { responseId: "resp-q", interactionId: "q-1", deliveryId: "d-q" } }, { ...ctx, view: questionView });
    await onCandidate({ type: "response.settled", data: { responseId: "resp-q", outcome: "refused" } }, { ...ctx, view: questionView });
  });
  eq((await readAudit({ org: "default", action: EVE_APPROVAL_CANDIDATE_ACTION })).length, 2, "🔴 a refused answer to a QUESTION writes no approval candidate row");

  await inSession(async () => {
    await onSettled({ type: "interaction.settled", data: {} }, { ...ctx, view: interactionView("approval", "req-x") });
    await onCandidate({ type: "response.settled" }, ctx);
  });
  eq((await readAudit({ org: "default", action: EVE_APPROVAL_SETTLED_ACTION })).length, 2, "an event with no outcome/request id writes nothing and throws nothing");

  const { findChainBreak } = await import("../agent/audit/chain.js");
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const chainRows = await getOperationalStore().readAuditChain("default");
  ok(chainRows.length >= 4, "the settlement rows are on the org's audit chain");
  eq(findChainBreak(chainRows), null, "…and the chain is intact after them (they are ordinary chained rows, not a side store)");
}

await removeTempDir(tmp);
console.log(`\n✓ eve-approval-response: ${passed} assertions passed`);

// proves: AP-MOD-core-approvals-eve-response-policy
// proves: approval.eve_candidate
