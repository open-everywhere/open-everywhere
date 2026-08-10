import { tmpdir } from "node:os";
import { rmSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpendCheckpoints } from "../agent/spend/checkpoint.js";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();


let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function throws(fn: () => Promise<unknown> | unknown, label: string): Promise<void> {
  try {
    await fn();
  } catch {
    passed++;
    return;
  }
  console.error(`✗ ${label} (expected a throw)`);
  process.exit(1);
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
} = await import("../agent/spend/checkpoint.js");

assertSpendCheckpointsValid({});
assertSpendCheckpointsValid(defineSpendCheckpoints({ default: { sessionTokens: 1000, sessionUsd: 5 }, perSurface: { "slack/T1/C1": { sessionModelCalls: 50 } } }));
passed += 2;
await throws(() => assertSpendCheckpointsValid({ default: {} as never }), "validator: an empty entry (no threshold) is rejected");
await throws(() => assertSpendCheckpointsValid({ default: { sessionTokensX: 1 } as never }), "validator: an unknown field is rejected");
await throws(() => assertSpendCheckpointsValid({ default: { sessionTokens: 0 } }), "validator: a non-positive amount is rejected");
await throws(() => assertSpendCheckpointsValid({ default: { sessionTokens: 1.5 } }), "validator: a non-integer count is rejected");
await throws(() => assertSpendCheckpointsValid({ perWorkspace: { "bad-key": { sessionTokens: 1 } } }), "validator: a malformed perWorkspace key is rejected");
await throws(() => assertSpendCheckpointsValid({ perSurface: { "slack/T1": { sessionTokens: 1 } } }), "validator: a perSurface key missing the surface segment is rejected");

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
    loadDomains: () => [defineDomain({ name: "txn", channels: ["slack/T1/C_TXN"] })],
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
  process.env.OE_MODEL_PRICING = JSON.stringify({ "zai/glm-5.2": { inPerMtok: 1, outPerMtok: 2 } });
  const { _resetPricingCacheForTest } = await import("../agent/spend/pricing.js");
  _resetPricingCacheForTest();
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
  delete process.env.OE_MODEL_PRICING;
  _resetPricingCacheForTest();
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
  await kind!.execute({ org: "default", scopeKey: "slack/T1/C1", sessionId: memoKey }, "U-APPROVER");
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
  await throws(() => requireSessionContinuation(ctxFor(sid), "open_pull_request"), "guard: over threshold + no grant -> blocks (throws)");
  const pendingAfter = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
  ok(pendingAfter === pendingBefore + 1, "guard: a session.checkpoint card was posted once on the trip");
  const asked = await store.getSessionApproval("default", sid, CHECKPOINT_ASK_MEMO, new Date().toISOString());
  ok(asked !== null, "guard: the 'asked' marker memo was written for the session");
  const audit = await readAudit({ org: "default" });
  ok(audit.some((a) => a.action === "checkpoint.trip"), "guard: the trip is audited (checkpoint.trip)");

  await throws(() => requireSessionContinuation(ctxFor(sid), "create_skill"), "guard: a second consequential call stays blocked");
  const pendingSecond = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
  ok(pendingSecond === pendingAfter, "guard: no second card on a repeat call (card once, not per-call spam)");
}

{
  const sid = "sess-grant";
  await seed(sid, 2000);
  await throws(() => requireSessionContinuation(ctxFor(sid), "open_pull_request"), "guard: crossed session blocks before a grant");
  const now = new Date();
  await store.setSessionApproval({ org: "default", sessionId: sid, kind: CHECKPOINT_GRANT_MEMO, grantedBy: "U-OK", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3_600_000).toISOString() });
  await requireSessionContinuation(ctxFor(sid), "open_pull_request");
  passed++;
}

{
  const sid = "sess-deny";
  await seed(sid, 2000);
  await throws(() => requireSessionContinuation(ctxFor(sid), "open_pull_request"), "guard: crossed session blocks (deny scenario, first trip)");
  const pending = (await store.listPendingActions("default")).find((r) => r.kind === "session.checkpoint" && r.argsJson.includes(sid));
  ok(pending !== undefined, "guard: a pending checkpoint card exists to decide");
  await store.decidePendingAction("default", pending!.id, "rejected", "U-NO", new Date().toISOString());
  const grant = await store.getSessionApproval("default", sid, CHECKPOINT_GRANT_MEMO, new Date().toISOString());
  ok(grant === null, "guard: a rejected card writes NO continue grant");
  const pendingBefore = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
  await throws(() => requireSessionContinuation(ctxFor(sid), "purge_memory"), "guard: after a deny the session stays soft-blocked");
  const pendingAfter = (await store.listPendingActions("default")).filter((r) => r.kind === "session.checkpoint").length;
  ok(pendingAfter === pendingBefore, "guard: after a deny no fresh card is posted (deny keeps the block quietly)");
}

{
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "tools");
  const guarded = ["open_pull_request", "create_skill", "create_routine", "purge_memory", "request_access", "cancel_routine", "delete_skill"];
  const reads = ["reply", "react", "no_reply", "session_cost", "spend_report", "check_pr_status"];
  const slackToolsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "providers", "slack", "agent", "tools");
  const slackReads = ["read_slack_channel", "read_slack_thread"];
  const has = (name: string) => readFileSync(join(toolsDir, `${name}.ts`), "utf8").includes("requireSessionContinuation(");
  const hasSlack = (name: string) => readFileSync(join(slackToolsDir, `${name}.ts`), "utf8").includes("requireSessionContinuation(");
  for (const t of guarded) ok(has(t), `checkpoint guard is wired into the consequential tool ${t}`);
  for (const t of reads) ok(!has(t), `checkpoint guard is NOT wired into the read/reply tool ${t} (reads stay unaffected)`);
  for (const t of slackReads) ok(!hasSlack(t), `checkpoint guard is NOT wired into the bundle read tool ${t} (reads stay unaffected)`);
  const consequenceSrc = readFileSync(join(toolsDir, "..", "access", "consequence.ts"), "utf8");
  const memberTools = [...consequenceSrc.matchAll(/^\s{2}(\w+):\s*member\(/gmu)].map((m) => m[1]);
  ok(memberTools.length >= 8, `consequence registry lists the gate:member tools (${memberTools.length})`);
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
    await throws(() => requireSessionContinuation(fireCtx(sid, id), "purge_memory"), "fire: a crossed routine fire is still BLOCKED — the stop is the right direction and OPE-253 did not change it");
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

    await throws(() => requireSessionContinuation(fireCtx(sid, id), "open_pull_request"), "fire: a second consequential call in the same fire is still blocked");
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
    await throws(() => requireSessionContinuation(ctxFor(sid), "purge_memory"), "parity: a live human session over threshold blocks exactly as before");
    const afterRows = (await readAudit({ org: "default", limit: 1000 })).filter((a) => a.action === ROUTINE_AUDIT.stalled).length;
    ok(afterRows === beforeRows, "parity: …and records no stall — a stall is a property of an UNATTENDED fire, and a human who is right there can answer the card");
  }

  {
    const sid = "sess-fire-gone";
    await seed(sid, 5000);
    await throws(() => requireSessionContinuation(fireCtx(sid, "r-does-not-exist"), "purge_memory"), "fail-soft: a marker with no surviving routine still produces the guard's own block, not a store error");
  }
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
}

console.log(`✓ checkpoint-test: ${passed} assertions passed`);
