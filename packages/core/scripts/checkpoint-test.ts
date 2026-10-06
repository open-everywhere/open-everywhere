import { tmpdir } from "node:os";
import { rmSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpendCheckpoints } from "../agent/spend/checkpoint.js";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { getSettings, overrideSettingsForTest } from "../agent/settings/settings.js";
registerSlackFixtureMapper();


let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function rejectsWith(fn: () => Promise<unknown> | unknown, fragment: string, label: string): Promise<void> {
  let threw = false;
  let error: unknown;
  try {
    await fn();
  } catch (err) {
    threw = true;
    error = err;
  }
  if (!threw) {
    console.error(`✗ ${label} (expected a throw, got none)`);
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(fragment)) {
    console.error(`✗ ${label} (threw, but not the refusal under test — expected "${fragment}", got: ${message})`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-checkpoint-test-${process.pid}`);
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
}
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_EGRESS_SPOOF = "1";

const {
  assertSpendCheckpointsValid,
  defineSpendCheckpoints,
  checkCheckpoint,
  checkpointConfigured,
  resolveCheckpoint,
  sessionUsage,
  requireSessionContinuation,
  checkpointCardLines,
  checkpointBlockMessage,
  checkpointCardFailureClass,
} = await import("../agent/spend/checkpoint.js");

assertSpendCheckpointsValid({});
assertSpendCheckpointsValid(defineSpendCheckpoints({ default: { sessionTokens: 1000, sessionUsd: 5 }, perSurface: { "slack/T1/C1": { sessionModelCalls: 50 } } }));
passed += 2;
await rejectsWith(() => assertSpendCheckpointsValid({ default: {} as never }), "spend checkpoint default sets no threshold at all", "validator: an empty entry (no threshold) is rejected");
await rejectsWith(() => assertSpendCheckpointsValid({ default: { sessionTokensX: 1 } as never }), 'spend checkpoint default has unknown field "sessionTokensX"', "validator: an unknown field is rejected");
await rejectsWith(() => assertSpendCheckpointsValid({ default: { sessionTokens: 0 } }), "spend checkpoint default.sessionTokens must be a finite number > 0, got 0", "validator: a non-positive amount is rejected");
await rejectsWith(() => assertSpendCheckpointsValid({ default: { sessionTokens: 1.5 } }), "spend checkpoint default.sessionTokens must be an integer count, got 1.5", "validator: a non-integer count is rejected");
await rejectsWith(() => assertSpendCheckpointsValid({ perWorkspace: { "bad-key": { sessionTokens: 1 } } }), 'spend checkpoint perWorkspace key must be "platform/workspace", got "bad-key"', "validator: a malformed perWorkspace key is rejected");
await rejectsWith(() => assertSpendCheckpointsValid({ perSurface: { "slack/T1": { sessionTokens: 1 } } }), 'spend checkpoint perSurface key must be "platform/workspace/surface", got "slack/T1"', "validator: a perSurface key missing the surface segment is rejected");

ok(!checkCheckpoint({ tokens: 999, modelCalls: 5 }, { sessionTokens: 1000 }).crossed, "checkCheckpoint: under the token threshold -> not crossed");
{
  const v = checkCheckpoint({ tokens: 1000, modelCalls: 5 }, { sessionTokens: 1000 });
  ok(v.crossed && typeof v.reason === "string" && v.reason.includes("tokens"), "checkCheckpoint: at the token threshold -> crossed with a reason");
}
ok(checkCheckpoint({ tokens: 0, modelCalls: 50 }, { sessionModelCalls: 50 }).crossed, "checkCheckpoint: at the model-call threshold -> crossed");
ok(checkCheckpoint({ tokens: 0, modelCalls: 0, usd: 5 }, { sessionUsd: 5 }).crossed, "checkCheckpoint: at the $ threshold -> crossed");
ok(!checkCheckpoint({ tokens: 0, modelCalls: 0 }, { sessionUsd: 5 }).crossed, "checkCheckpoint: undefined $ reads as $0 -> under a $ threshold");
ok(!checkCheckpoint({ tokens: 99999, modelCalls: 99999, usd: 99999 }, {}).crossed, "checkCheckpoint: an empty checkpoint never crosses");
ok(!checkpointConfigured({}), "checkpointConfigured: empty -> false");
ok(checkpointConfigured({ sessionUsd: 1 }), "checkpointConfigured: any component -> true");

{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const checkpoints: SpendCheckpoints = {
    default: { sessionTokens: 10 },
    perWorkspace: { "slack/T1": { sessionTokens: 20 } },
    perDomain: { txn: { sessionTokens: 30 } },
    perSurface: { "slack/T1/C1": { sessionTokens: 40 } },
  };
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "txn", reach: ["slack/T1/C_TXN"] })],
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadSpendCheckpoints: () => checkpoints,
  });
  ok(resolveCheckpoint("slack/T1", "slack/T1/C1").sessionTokens === 40, "resolveCheckpoint: perSurface wins over everything");
  ok(resolveCheckpoint("slack/T1", "slack/T1/C9", "txn").sessionTokens === 30, "resolveCheckpoint: perDomain wins over perWorkspace/default");
  ok(resolveCheckpoint("slack/T1", "slack/T1/C9").sessionTokens === 20, "resolveCheckpoint: perWorkspace wins over default");
  ok(resolveCheckpoint("slack/T2", "slack/T2/C9").sessionTokens === 10, "resolveCheckpoint: default is the last resort");
  ok(Object.keys(resolveCheckpoint("slack/T9", "slack/T9/C9", undefined)).length === 1, "resolveCheckpoint: default reached when nothing narrower matches");
}
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
    loadSpendCheckpoints: () => ({}),
  });
  ok(Object.keys(resolveCheckpoint("slack/T1", "slack/T1/C1")).length === 0, "resolveCheckpoint: an empty registry resolves to {} (uncapped)");
}

{
  const { registerModelPricing, _resetModelPricingForTest } = await import("../agent/spend/pricing.js");
  registerModelPricing({ "zai/glm-5.2": { inPerMtok: 1, outPerMtok: 2 } });
  const usageEvents = await import("../agent/spend/usage-events.js");
  const sid = "sess-usage";
  await usageEvents.appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C1", sessionId: sid, kind: "channel", model: "zai/glm-5.2", inputTokens: 1_000_000, outputTokens: 500_000 });
  await usageEvents.appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C1", sessionId: sid, kind: "channel", model: "zai/glm-5.2", inputTokens: 0, outputTokens: 250_000 });
  await usageEvents.appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C1", sessionId: sid, kind: "sandbox", detail: { sandboxSeconds: 30 } });
  const u = await sessionUsage("default", sid);
  ok(u.tokens === 1_750_000, "sessionUsage: sums input+output tokens across the session");
  ok(u.modelCalls === 2, "sessionUsage: counts non-sandbox rows as model calls (sandbox row excluded)");
  ok(u.usd !== undefined && Math.abs(u.usd - 2.5) < 1e-9, "sessionUsage: prices per-row USD (evidence-only)");
  const empty = await sessionUsage("default", "sess-none");
  ok(empty.tokens === 0 && empty.modelCalls === 0, "sessionUsage: a session with no rows is zero");
  _resetModelPricingForTest();
}

{
  await import("../agent/approvals/session-checkpoint.js");
  const { actionKind } = await import("../agent/approvals/actions.js");
  const { CHECKPOINT_KIND, CHECKPOINT_GRANT_MEMO } = await import("../agent/approvals/session-checkpoint.js");
  const kind = actionKind(CHECKPOINT_KIND);
  ok(kind !== undefined && kind.policy === "member", "session.checkpoint: registered as a member-policy ActionKind");
  const store = (await import("../agent/operational/provider.js")).getOperationalStore();
  const memoKey = "win-grant-1";
  const before = await store.getSessionApproval("default", memoKey, CHECKPOINT_GRANT_MEMO, new Date().toISOString());
  ok(before === null, "session.checkpoint: no grant memo before approval");
  const answer = await kind!.execute({ org: "default", scopeKey: "slack/T1/C1", sessionId: memoKey }, "U-APPROVER");
  ok(
    answer === "cost checkpoint cleared — the agent may do consequential work again in this session for up to 24 h",
    "session.checkpoint execute: the answer names the 24 h clock the grant carries (OPE-2161)",
  );
  ok(
    kind!.summarize({ org: "default", scopeKey: "slack/T1/C1", sessionId: memoKey }).includes("Approving lets it continue in this session for up to 24 h."),
    "session.checkpoint card: a LIVE session's card names the clock BEFORE the click (OPE-2161)",
  );
  const shippedCheckpointTtl = getSettings().approvals.checkpointTtlHours;
  overrideSettingsForTest({ approvals: { checkpointTtlHours: 6 } });
  const answer6 = await kind!.execute({ org: "default", scopeKey: "slack/T1/C1", sessionId: "win-grant-6h" }, "U-APPROVER");
  const lines6 = kind!.summarize({ org: "default", scopeKey: "slack/T1/C1", sessionId: "win-grant-6h" });
  overrideSettingsForTest({ approvals: { checkpointTtlHours: shippedCheckpointTtl } });
  ok(String(answer6).endsWith("for up to 6 h"), "session.checkpoint execute: a 6-hour deployment's answer says 6 h — it reads the setting");
  ok(lines6.includes("Approving lets it continue in this session for up to 6 h."), "session.checkpoint card: …and so does the card");
  const after = await store.getSessionApproval("default", memoKey, CHECKPOINT_GRANT_MEMO, new Date().toISOString());
  ok(after !== null && after.grantedBy === "U-APPROVER", "session.checkpoint execute: writes the continue grant memo attributed to the approver");
  const { readAudit } = await import("../agent/audit/audit.js");
  const audit = await readAudit({ org: "default" });
  ok(audit.some((a) => a.action === "checkpoint.continue"), "session.checkpoint execute: audits a checkpoint.continue row");
}

const ctxFor = (sessionId: string) =>
  ({
    channel: { kind: "slack" },
    session: { id: sessionId, auth: { current: { attributes: { team_id: "T1", channel_id: "C1" }, principalId: "U1", principalType: "slack-user" } } },
  }) as never;

const store = (await import("../agent/operational/provider.js")).getOperationalStore();
const usageEvents = await import("../agent/spend/usage-events.js");
const { registerConfig } = await import("../agent/access/config.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { CHECKPOINT_GRANT_MEMO, CHECKPOINT_ASK_MEMO } = await import("../agent/approvals/session-checkpoint.js");

const withCheckpoints = (cp: SpendCheckpoints) =>
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadSpendCheckpoints: () => cp,
  });

const seed = (sessionId: string, tokens: number) =>
  usageEvents.appendUsageEvent({ org: "default", surfaceKey: "slack/T1/C1", sessionId, kind: "channel", inputTokens: tokens });

withCheckpoints({});
await seed("sess-noconfig", 10_000_000);
await requireSessionContinuation(ctxFor("sess-noconfig"), "open_pull_request");
passed++;

withCheckpoints({ default: { sessionTokens: 1000 } });
await seed("sess-under", 500);
await requireSessionContinuation(ctxFor("sess-under"), "open_pull_request");
passed++;

{
  const sid = "sess-over";
  await seed(sid, 2000);
  const pendingBefore = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
  await rejectsWith(() => requireSessionContinuation(ctxFor(sid), "open_pull_request"), "Paused: this session reached its cost checkpoint", "guard: over threshold + no grant -> blocks (throws)");
  const pendingAfter = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
  ok(pendingAfter === pendingBefore + 1, "guard: a session.checkpoint card was posted once on the trip");
  const asked = await store.getSessionApproval("default", sid, CHECKPOINT_ASK_MEMO, new Date().toISOString());
  ok(asked !== null, "guard: the 'asked' marker memo was written for the session");
  const audit = await readAudit({ org: "default" });
  ok(audit.some((a) => a.action === "checkpoint.trip"), "guard: the trip is audited (checkpoint.trip)");

  await rejectsWith(() => requireSessionContinuation(ctxFor(sid), "create_skill"), "Paused: this session reached its cost checkpoint", "guard: a second consequential call stays blocked");
  const pendingSecond = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
  ok(pendingSecond === pendingAfter, "guard: no second card on a repeat call (card once, not per-call spam)");
}

{
  const sid = "sess-grant";
  await seed(sid, 2000);
  await rejectsWith(() => requireSessionContinuation(ctxFor(sid), "open_pull_request"), "Paused: this session reached its cost checkpoint", "guard: crossed session blocks before a grant");
  const now = new Date();
  await store.setSessionApproval({ org: "default", sessionId: sid, kind: CHECKPOINT_GRANT_MEMO, grantedBy: "U-OK", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3_600_000).toISOString() });
  await requireSessionContinuation(ctxFor(sid), "open_pull_request");
  passed++;
}

{
  const sid = "sess-deny";
  await seed(sid, 2000);
  await rejectsWith(() => requireSessionContinuation(ctxFor(sid), "open_pull_request"), "Paused: this session reached its cost checkpoint", "guard: crossed session blocks (deny scenario, first trip)");
  const pending = (await store.listPendingActions("default")).find((r) => r.kind === "session.checkpoint" && r.argsJson.includes(sid));
  ok(pending !== undefined, "guard: a pending checkpoint card exists to decide");
  await store.decidePendingAction("default", pending!.id, "rejected", "U-NO", new Date().toISOString());
  const grant = await store.getSessionApproval("default", sid, CHECKPOINT_GRANT_MEMO, new Date().toISOString());
  ok(grant === null, "guard: a rejected card writes NO continue grant");
  const pendingBefore = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
  await rejectsWith(() => requireSessionContinuation(ctxFor(sid), "purge_memory"), "Paused: this session reached its cost checkpoint", "guard: after a deny the session stays soft-blocked");
  const pendingAfter = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
  ok(pendingAfter === pendingBefore, "guard: after a deny no fresh card is posted (deny keeps the block quietly)");
}

{
  const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");
  const { ROUTINE_PERMISSION_NO_EXPIRY } = await import("../agent/routines/declared-permissions.js");
  const { CHECKPOINT_KIND } = await import("../agent/approvals/session-checkpoint.js");
  const { actionKind } = await import("../agent/approvals/actions.js");
  const jobCtx = (sessionId: string) =>
    ({
      channel: { kind: "slack" },
      session: {
        id: sessionId,
        auth: {
          current: {
            attributes: {
              team_id: "T1",
              channel_id: "C1",
              [ROUTINE_MARKER.id]: "job-1",
              [ROUTINE_MARKER.surface]: "slack/T1/C1",
              [ROUTINE_MARKER.org]: "default",
            },
            principalId: "U1",
            principalType: "slack-user",
          },
        },
      },
    }) as never;

  const sid = "sess-job";
  await seed(sid, 2000);
  await rejectsWith(() => requireSessionContinuation(jobCtx(sid), "open_pull_request"), "Paused: this session reached its cost checkpoint", "OPE-261: a job's first crossing blocks and cards");
  const pending = (await store.listPendingActions("default")).find((r) => r.kind === CHECKPOINT_KIND && r.argsJson.includes(sid));
  ok(pending !== undefined, "OPE-261: the job's crossing posted a card to decide");
  const frozen = JSON.parse(pending!.argsJson) as { durableSession?: true };
  ok(frozen.durableSession === true, "OPE-261: the frozen args mark the memo key as a durable session");

  const { DURABLE_GRANT_DISCLOSURE } = await import("../agent/approvals/session-checkpoint.js");
  const planOf = (over: Record<string, unknown>) =>
    ({
      decision: "block",
      org: "default",
      surfaceKey: "slack/T1/C1",
      workspaceKey: "slack/T1",
      domain: null,
      memoKey: sid,
      usage: { tokens: 2000, modelCalls: 1 },
      checkpoint: { sessionTokens: 1000 },
      reason: "r",
      durable: false,
      ...over,
    }) as never;
  const firstDurable = checkpointCardLines(planOf({ durable: true }), "#proj-chat").join("\n");
  ok(firstDurable.includes(DURABLE_GRANT_DISCLOSURE), `OPE-261: the FIRST durable card discloses that the approval does not lapse (${firstDurable})`);
  ok(checkpointCardLines(planOf({ durable: true, approvedAt: new Date().toISOString() }), "#proj-chat").join("\n").includes(DURABLE_GRANT_DISCLOSURE), "OPE-261: so does the rebased durable card");
  ok(checkpointCardLines(planOf({}), "#proj-chat").includes("Approving lets it continue in this session for up to 24 h."), "OPE-2161: a LIVE session's posted card names the grant's clock before the click");
  {
    const shipped = getSettings().approvals.checkpointTtlHours;
    overrideSettingsForTest({ approvals: { checkpointTtlHours: 6 } });
    const posted6 = checkpointCardLines(planOf({}), "#proj-chat");
    overrideSettingsForTest({ approvals: { checkpointTtlHours: shipped } });
    ok(posted6.includes("Approving lets it continue in this session for up to 6 h."), "OPE-2161: a 6-hour deployment's POSTED card says 6 h — it reads the setting");
  }
  ok(!checkpointCardLines(planOf({ durable: true }), "#proj-chat").join("\n").includes("for up to"), "OPE-2161 control: a DURABLE session's card names no clock — its grant has none");
  ok(!checkpointCardLines(planOf({}), "#proj-chat").join("\n").includes(DURABLE_GRANT_DISCLOSURE), "OPE-261 control: a LIVE session's card carries no no-expiry disclosure — it grants nothing that lasts");
  ok(firstDurable.includes("In #proj-chat.") && !firstDurable.includes("slack/T1/C1"), "checkpoint card: the room's NAME, never the raw scope key, when a label resolved");
  ok(checkpointCardLines(planOf({ durable: true })).join("\n").includes("In slack/T1/C1."), "checkpoint card: the raw key is the fail-open fallback when no label resolved");
  ok(actionKind(CHECKPOINT_KIND)!.summarize(frozen as never).some((l) => l === DURABLE_GRANT_DISCLOSURE), "OPE-261: summarize() carries the same disclosure, word for word");

  await store.decidePendingAction("default", pending!.id, "approved", "U-APPROVER", new Date().toISOString());
  await actionKind(CHECKPOINT_KIND)!.execute(frozen as never, "U-APPROVER");
  const cardsAfterApproval = (await store.listPendingActions("default")).filter((r) => r.kind === CHECKPOINT_KIND).length;

  const wayLater = new Date(Date.now() + 365 * 24 * 3_600_000).toISOString();
  const grantRow = await store.getSessionApproval("default", sid, CHECKPOINT_GRANT_MEMO, wayLater);
  ok(grantRow !== null, "OPE-261: a routine fire's continue grant is still live long past the checkpoint TTL");
  ok(grantRow!.expiresAt === ROUTINE_PERMISSION_NO_EXPIRY, "OPE-261: it carries the no-expiry sentinel, not a wall-clock TTL");

  await requireSessionContinuation(jobCtx(sid), "open_pull_request");
  passed++;
  ok(
    (await store.listPendingActions("default")).filter((r) => r.kind === CHECKPOINT_KIND).length === cardsAfterApproval,
    "OPE-261: an approved job with no fresh spend posts no new card",
  );

  await seed(sid, 2000);
  await rejectsWith(() => requireSessionContinuation(ctxFor(sid), "open_pull_request"), "Paused: this session spent another checkpoint's worth since a member approved it", "OPE-261: a fresh increment blocks again — and a NON-routine turn on the job's memo key is held to the same rebase");
  const cardsAfterSecondCrossing = (await store.listPendingActions("default")).filter((r) => r.kind === CHECKPOINT_KIND).length;
  ok(cardsAfterSecondCrossing === cardsAfterApproval + 1, "OPE-261: the fresh crossing posts a NEW card rather than stalling silently");
  const reCard = (await store.listPendingActions("default")).find((r) => r.kind === CHECKPOINT_KIND && r.argsJson.includes(sid));
  ok((JSON.parse(reCard!.argsJson) as { durableSession?: true }).durableSession === true, "OPE-261: the re-card stays marked durable, so answering it cannot restore the daily re-block");

  const liveSid = "sess-live-grant";
  await seed(liveSid, 2000);
  await rejectsWith(() => requireSessionContinuation(ctxFor(liveSid), "open_pull_request"), "Paused: this session reached its cost checkpoint", "OPE-261 control: a live session's first crossing blocks");
  const livePending = (await store.listPendingActions("default")).find((r) => r.kind === CHECKPOINT_KIND && r.argsJson.includes(liveSid));
  const liveArgs = JSON.parse(livePending!.argsJson) as { durableSession?: true };
  ok(liveArgs.durableSession === undefined, "OPE-261 control: a live session's frozen args carry no durable mark");
  ok(!actionKind(CHECKPOINT_KIND)!.summarize(liveArgs as never).some((l) => l === DURABLE_GRANT_DISCLOSURE), "OPE-261 control: nor does summarize() disclose a no-expiry grant for a live session's row");
  await store.decidePendingAction("default", livePending!.id, "approved", "U-APPROVER", new Date().toISOString());
  await actionKind(CHECKPOINT_KIND)!.execute(liveArgs as never, "U-APPROVER");
  const liveGrant = await store.getSessionApproval("default", liveSid, CHECKPOINT_GRANT_MEMO, new Date().toISOString());
  ok(liveGrant !== null && liveGrant.expiresAt !== ROUTINE_PERMISSION_NO_EXPIRY, "OPE-261 control: a live session's grant keeps its wall-clock TTL");
  await seed(liveSid, 2000);
  await requireSessionContinuation(ctxFor(liveSid), "open_pull_request");
  passed++;
}

{
  const sid = "sess-since";
  await seed(sid, 100);
  const mark = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  await seed(sid, 250);
  const whole = await sessionUsage("default", sid);
  const after = await sessionUsage("default", sid, mark);
  ok(whole.tokens === 350, "sessionUsage: unbounded still sums the whole session");
  ok(after.tokens === 250 && after.modelCalls === 1, "sessionUsage: a `since` bound counts only the rows stamped after it");
  ok((await sessionUsage("default", sid, new Date(Date.now() + 60_000).toISOString())).tokens === 0, "sessionUsage: a bound in the future counts nothing");
  ok((await sessionUsage("default", sid, "not-a-date")).tokens === 350, "sessionUsage: an unparseable bound counts every row (the wide, safe answer)");

  const whole261 = checkCheckpoint({ tokens: 10, modelCalls: 0 }, { sessionTokens: 10 });
  ok(whole261.reason!.includes("this session reached its cost checkpoint"), "checkCheckpoint: the default subject names the whole session");
  const since261 = checkCheckpoint({ tokens: 10, modelCalls: 0 }, { sessionTokens: 10 }, "spent more since approval");
  ok(since261.reason!.startsWith("spent more since approval ("), "checkCheckpoint: a supplied subject replaces the clause and keeps the numbers");
}

{
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "tools");
  const guarded = ["open_pull_request", "create_skill", "create_routine", "purge_memory", "request_access", "cancel_routine", "delete_skill"];
  const reads = ["reply", "react", "no_reply", "session_cost", "spend_report", "check_pr_status"];
  const has = (name: string) => readFileSync(join(toolsDir, `${name}.ts`), "utf8").includes("requireSessionContinuation(");
  for (const t of guarded) ok(has(t), `checkpoint guard is wired into the consequential tool ${t}`);
  for (const t of reads) ok(!has(t), `checkpoint guard is NOT wired into the read/reply tool ${t} (reads stay unaffected)`);
  const consequenceSrc = readFileSync(join(toolsDir, "..", "access", "consequence.ts"), "utf8");
  const memberTools = [...consequenceSrc.matchAll(/^\s{2}(\w+):.*\bmember\(/gmu)].map((m) => m[1]);
  ok(memberTools.length >= 17, `consequence registry lists the gate:member tools, wrappers and all (${memberTools.length})`);
  const toolFiles = new Set(readdirSync(toolsDir).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/u, "")));
  for (const t of memberTools) {
    if (!toolFiles.has(t)) continue;
    ok(has(t), `every gate:member authored tool carries the checkpoint guard — ${t}`);
  }
}

{
  const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");
  const { ROUTINE_AUDIT } = await import("../agent/routines/fire-audit.js");
  const routineStore = await import("../agent/routines/store.js");
  const SURFACE = "slack/T1/C1";

  const fireCtx = (sessionId: string, routineId: string, extra: Record<string, string> = {}) =>
    ({
      channel: { kind: "slack" },
      session: {
        id: sessionId,
        auth: {
          current: {
            attributes: {
              team_id: "T1",
              channel_id: "C1",
              [ROUTINE_MARKER.id]: routineId,
              [ROUTINE_MARKER.surface]: SURFACE,
              [ROUTINE_MARKER.org]: "default",
              ...extra,
            },
            principalId: "eve:app",
            principalType: "runtime",
          },
        },
      },
    }) as never;

  const addJob = async (id: string) =>
    routineStore.addRoutine({} as never, {
      id,
      org: "default",
      surfaceKey: SURFACE,
      target: { channelId: "C1" },
      trigger: { kind: "interval", everyMinutes: 15 },
      prompt: "Chase the migration until it is done.",
      createdAt: "2026-07-01T00:00:00.000Z",
      status: "active",
      consecutiveFailures: 0,
      sessionMode: "job",
      bound: { maxFires: 200 },
      fireCount: 4,
    } as never);

  withCheckpoints({ default: { sessionTokens: 1000 } });

  {
    const sid = "sess-fire";
    const id = "r-fire";
    await addJob(id);
    await seed(sid, 5000);
    const pendingBefore = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
    await rejectsWith(() => requireSessionContinuation(fireCtx(sid, id), "purge_memory"), "Paused: this session reached its cost checkpoint", "fire: a crossed routine fire is still BLOCKED — the stop is the right direction and OPE-253 did not change it");
    const pendingAfter = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
    ok(pendingAfter === pendingBefore + 1, "fire: THE CARD STILL POSTS — whether an unattended fire should card at all is a doctrine question about the approvals plane, deliberately left alone");

    const row = await routineStore.getRoutine("default", SURFACE, id);
    ok(
      typeof row?.lastStallAt === "string",
      "🔴 THE RECORD: a blocked fire stamps the stall on its OWN routine row — remove the recordCheckpointStall call and 'waiting on a human click' is indistinguishable from 'running fine' on every surface OE ships, while the OPE-248 ceiling burns down underneath it",
    );
    const rows = (await readAudit({ org: "default", limit: 1000 })).filter((a) => a.action === ROUTINE_AUDIT.stalled && (a.detail as { routineId?: string } | undefined)?.routineId === id);
    ok(rows.length === 1, "🔴 THE ROW: one routine.stalled forensic row, written at the MOMENT of the block — checkpoint.trip is once per SESSION, and a durable job's session spans every fire, so without this the 2nd..200th blocked fire wrote nothing at all");
    ok((rows[0]?.detail as { tool?: string }).tool === "purge_memory", "fire: the row names the tool that was refused");

    await rejectsWith(() => requireSessionContinuation(fireCtx(sid, id), "open_pull_request"), "Paused: this session reached its cost checkpoint", "fire: a second consequential call in the same fire is still blocked");
    const after = (await readAudit({ org: "default", limit: 1000 })).filter((a) => a.action === ROUTINE_AUDIT.stalled && (a.detail as { routineId?: string } | undefined)?.routineId === id);
    ok(after.length === 1, "fire: …and records nothing extra — one stalled FIRE, not one per refused tool");
  }

  {
    const sid = "sess-fire-open";
    const id = "r-open";
    await addJob(id);
    await seed(sid, 5000);
    const ctx = {
      channel: { kind: "slack" },
      session: {
        id: sid,
        auth: {
          current: {
            attributes: { team_id: "T1", [ROUTINE_MARKER.id]: id, [ROUTINE_MARKER.surface]: SURFACE, [ROUTINE_MARKER.org]: "default" },
            principalId: "eve:app",
            principalType: "runtime",
          },
        },
      },
    } as never;
    await requireSessionContinuation(ctx, "purge_memory");
    passed++;
    const row = await routineStore.getRoutine("default", SURFACE, id);
    ok(
      row?.lastStallAt === undefined,
      "🔴 POSITION: nothing is recorded on the guard's FAIL-OPEN exit — move the recorder above the canAsk branch and every fire on a surface with no card path is logged as stalled, retiring healthy jobs after three runs",
    );
    ok(
      (await readAudit({ org: "default", limit: 1000 })).filter((a) => a.action === ROUTINE_AUDIT.stalled && (a.detail as { routineId?: string } | undefined)?.routineId === id).length === 0,
      "position: …and no forensic row either",
    );
  }

  {
    const sid = "sess-human";
    await seed(sid, 5000);
    const beforeRows = (await readAudit({ org: "default", limit: 1000 })).filter((a) => a.action === ROUTINE_AUDIT.stalled).length;
    await rejectsWith(() => requireSessionContinuation(ctxFor(sid), "purge_memory"), "Paused: this session reached its cost checkpoint", "parity: a live human session over threshold blocks exactly as before");
    const afterRows = (await readAudit({ org: "default", limit: 1000 })).filter((a) => a.action === ROUTINE_AUDIT.stalled).length;
    ok(afterRows === beforeRows, "parity: …and records no stall — a stall is a property of an UNATTENDED fire, and a human who is right there can answer the card");
  }

  {
    const sid = "sess-fire-gone";
    await seed(sid, 5000);
    await rejectsWith(() => requireSessionContinuation(fireCtx(sid, "r-does-not-exist"), "purge_memory"), "Paused: this session reached its cost checkpoint", "fail-soft: a marker with no surviving routine still produces the guard's own block, not a store error");
  }
}

{
  const msgPosted = checkpointBlockMessage("crossed", "open_pull_request", "posted");
  const msgAsked = checkpointBlockMessage("crossed", "open_pull_request", "already-asked");
  const msgFailed = checkpointBlockMessage("crossed", "open_pull_request", "post-failed", "rate limited");
  ok(msgPosted.includes("confirms on the card just posted"), "copy: a card that really posted still points at it (unchanged)");
  ok(msgAsked.includes("confirms continuing") && !msgAsked.includes("card just posted"), "copy: a repeat block with a live ask marker still says 'confirms continuing' (unchanged)");
  ok(!msgFailed.includes("card just posted"), "🔴 copy: a FAILED post never claims a card was posted");
  ok(msgFailed.includes("could NOT be posted"), "copy: it says plainly that the card did not reach the room");
  ok(msgFailed.includes("rate limited"), "copy: it names the reason CLASS it was handed");
  ok(msgFailed.includes("confirm directly"), "copy: it tells the member how to confirm without a card");
  ok(msgFailed.includes("posted again on the next consequential attempt"), "copy: …and that the agent retries, which is what the un-set ask marker really does");

  ok(checkpointCardFailureClass(new Error("ratelimited")) === "rate limited", "class: a rate-limit refusal");
  ok(checkpointCardFailureClass(new Error("invalid_auth")) === "the credential was refused", "class: a dead token");
  ok(checkpointCardFailureClass(new Error("is_archived")) === "the room is unreachable", "class: an archived channel");
  ok(
    checkpointCardFailureClass(new Error("no bot token is configured, or the request never reached the surface")) === "no credential is configured, or the surface could not be reached",
    "class: 🔴 the composite cause names BOTH — reading it as a dead token sends an operator to rotate a credential that is fine",
  );
  ok(checkpointCardFailureClass(new Error("something nobody has seen")) === "the surface reported no reason this deployment recognises", "class: an unrecognised reason says so, never guesses");

  const roomNamed = new Error('requestApproval: failed to post the approval card for "session.checkpoint" (slack/T1/is_archived) — ratelimited; marked expired.');
  (roomNamed as unknown as Record<string, unknown>).oeCardPostReason = "ratelimited";
  ok(checkpointCardFailureClass(roomNamed) === "rate limited", "class: the attached reason wins over a scope key that reads like one");
  const noReason = new Error("a throw from somewhere other than the card post");
  ok(checkpointCardFailureClass(noReason) === "the surface reported no reason this deployment recognises", "class: an error carrying no attached reason degrades to the message, honestly");

  const spoof = process.env.OE_EGRESS_SPOOF;
  delete process.env.OE_EGRESS_SPOOF;
  try {
    const sid = "sess-card-post-failed";
    await seed(sid, 2000);
    const pendingBefore = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
    let thrown = "";
    try {
      await requireSessionContinuation(ctxFor(sid), "open_pull_request");
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    ok(thrown.length > 0, "failed post: the action is still held — a card that did not post never widens what may run");
    ok(!thrown.includes("card just posted"), "🔴 failed post: the thrown message does NOT tell the member to approve a card that does not exist");
    ok(thrown.includes("could NOT be posted"), "failed post: it says the card did not reach the room");
    ok(thrown.includes("confirm directly"), "failed post: it tells the member how to confirm another way");
    ok(thrown.includes("no credential is configured, or the surface could not be reached"), "failed post: it names the reason class the transport reported");

    const trips = (await readAudit({ org: "default", limit: 1000 })).filter(
      (a) => a.action === "checkpoint.trip" && (a.detail as { note?: unknown } | undefined)?.note === "card post failed",
    );
    ok(trips.length === 1, "failed post: the failure writes its own checkpoint.trip row");
    const detail = trips[0]!.detail as { carded?: unknown; reasonClass?: unknown };
    ok(detail.carded === false, "failed post: the row records carded:false, as it always did");
    ok(detail.reasonClass === "no credential is configured, or the surface could not be reached", "🔴 failed post: the row carries the SAME reason class the sentence names — one answer, not two");

    const asked = await store.getSessionApproval("default", sid, CHECKPOINT_ASK_MEMO, new Date().toISOString());
    ok(asked === null, "failed post: no ask marker is written, so the card really is retried next time");
    const pendingAfter = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
    ok(pendingAfter === pendingBefore, "failed post: the unseeable pending was expired rather than left awaiting a click");
  } finally {
    if (spoof !== undefined) process.env.OE_EGRESS_SPOOF = spoof;
  }

  {
    const sid = "sess-marker-write-failed";
    await seed(sid, 2000);
    const realSet = store.setSessionApproval.bind(store);
    (store as unknown as Record<string, unknown>).setSessionApproval = async () => {
      throw new Error("the ask marker could not be written");
    };
    let thrown = "";
    try {
      await requireSessionContinuation(ctxFor(sid), "open_pull_request");
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    } finally {
      (store as unknown as Record<string, unknown>).setSessionApproval = realSet;
    }
    ok(thrown.includes("confirms on the card just posted"), "🔴 marker write failed: the card DID land, so the message still points at it");
    ok(!thrown.includes("could NOT be posted"), "marker write failed: it never calls a delivered card undelivered");
    const rows = (await readAudit({ org: "default", limit: 1000 })).filter(
      (a) => a.action === "checkpoint.trip" && (a.detail as { note?: unknown } | undefined)?.note === "ask marker not recorded",
    );
    ok(rows.length === 1, "marker write failed: it writes its own row, naming what was lost");
    ok((rows[0]!.detail as { carded?: unknown }).carded === true, "marker write failed: the row says carded:true — the record agrees with the sentence");
    const asked = await store.getSessionApproval("default", sid, CHECKPOINT_ASK_MEMO, new Date().toISOString());
    ok(asked === null, "marker write failed: no marker exists, so the next attempt cards again — a duplicate card, never a missing one");
  }
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
}

console.log(`✓ checkpoint-test: ${passed} assertions passed`);
