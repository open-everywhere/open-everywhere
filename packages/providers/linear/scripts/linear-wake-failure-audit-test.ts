import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-linear-wake-failure-audit-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;

const { registerLinearProvider } = await import("../agent/register.js");
registerLinearProvider();
const { liveLinearSupervisorDeps } = await import("../agent/channels/linear.js");
const { getOperationalStore, deploymentOrg, RUN_KEY_FETCH_MARKER, HTTP_404_MARKER, PRUNED_DEPLOYMENT_AUDIT_ACTION } = await import(
  "@open-everywhere/core/agent/adapter-api.js"
);

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, `${label}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
  n++;
};

const ORG_ID = "org_acme";
const TEAM_ID = "team_widgets";
const SURFACE = `linear/${ORG_ID}/${TEAM_ID}`;

const noopSend = (async () => ({})) as unknown as Parameters<typeof liveLinearSupervisorDeps>[0];

{
  const boom = new Error("socket hang up");
  const failingTo = ((_channel: unknown, _target: unknown) => ({
    async send(): Promise<never> {
      throw boom;
    },
  })) as unknown as Parameters<typeof liveLinearSupervisorDeps>[3];

  const deps = liveLinearSupervisorDeps(noopSend, TEAM_ID, ORG_ID, failingTo);

  let threw: unknown;
  try {
    await deps.wake({
      token: "tok1",
      auth: { attributes: {} } as never,
      message: "<wake>hi</wake>",
      context: [],
      window: { wakeId: "w1", origin: { platform: "linear", agentSessionId: "as1", issueId: "iss1", parentId: "iss1", organizationId: ORG_ID } },
    });
  } catch (err) {
    threw = err;
  }
  ok(threw === boom, "🔴 the divert failure still PROPAGATES unchanged — this is an audit ADDITION, not a swallow");

  const rows = (await getOperationalStore().readAudit({ org: deploymentOrg(), action: "surface.wake_failed" })).filter(
    (row) => (row.detail as { wakeId?: unknown } | undefined)?.wakeId === "w1",
  );
  eq(rows.length, 1, "🔴 the ambient wake's divert failure writes exactly ONE `surface.wake_failed` row — previously it wrote NONE");
  eq(rows[0]!.platform, "linear", "…on the linear platform");
  eq(rows[0]!.workspace, ORG_ID, "…keyed to the organization as workspace");
  eq(rows[0]!.surface, SURFACE, "…and to the compound `linear/org/team` surface, matching this file's OWN convention for every other audit row it writes");
  const detail = (rows[0]!.detail ?? {}) as Record<string, unknown>;
  ok(String(detail.message).includes("socket hang up"), "…and the row names the real failure");
  eq(detail.wakeId, "w1", "…and the wake id, so the row is joinable to a specific delivery attempt");
}

{
  const received: unknown[] = [];
  const okTo = ((_channel: unknown, _target: unknown) => ({
    async send(message: string, opts: unknown) {
      received.push({ message, opts });
      return {};
    },
  })) as unknown as Parameters<typeof liveLinearSupervisorDeps>[3];

  const deps = liveLinearSupervisorDeps(noopSend, TEAM_ID, ORG_ID, okTo);
  await deps.wake({
    token: "tok2",
    auth: { attributes: {} } as never,
    message: "<wake>hi again</wake>",
    context: [],
    window: { wakeId: "w2", origin: { platform: "linear", agentSessionId: "as2", issueId: "iss1", parentId: "iss1", organizationId: ORG_ID } },
  });
  eq(received.length, 1, "the divert delivered normally");
  const rows = (await getOperationalStore().readAudit({ org: deploymentOrg(), action: "surface.wake_failed" })).filter(
    (row) => (row.detail as { wakeId?: unknown } | undefined)?.wakeId === "w2",
  );
  eq(rows.length, 0, "negative control: a successful divert writes NO `surface.wake_failed` row (scoped to wakeId \"w2\", this call's own)");
}

{
  const org = deploymentOrg();
  await getOperationalStore().rotateChannelSession(org, SURFACE, "seed-tok", "2026-08-22T00:00:00.000Z");
  const before = await getOperationalStore().getChannelSession(org, SURFACE);
  ok(before?.rotateMarkedAt == null, "wiring precondition: the team's seat starts UNMARKED (so a green below cannot be vacuous)");

  const boom = new Error(`${RUN_KEY_FETCH_MARKER} for wrun_TEST (deployment dpl_TEST): ${HTTP_404_MARKER} Not Found`);
  const failingSend = (async () => {
    throw boom;
  }) as unknown as Parameters<typeof liveLinearSupervisorDeps>[0];
  const deps = liveLinearSupervisorDeps(failingSend, TEAM_ID, ORG_ID, undefined);

  let threw: unknown;
  try {
    await deps.wake({
      token: "native-tok",
      auth: { attributes: {} } as never,
      message: "<wake>hi</wake>",
      context: [],
    });
  } catch (err) {
    threw = err;
  }
  ok(threw === boom, "the native send failure still PROPAGATES unchanged");

  const after = await getOperationalStore().getChannelSession(org, SURFACE);
  ok(after?.rotateMarkedAt != null, "🔴 OPE-971: the NATIVE (flag-off) wake heal MARKED the team's own seat for rotation — linearGrainFor's registryKey === surfaceKey flag-off");
  const strandRows = (await getOperationalStore().readAudit({ org, action: PRUNED_DEPLOYMENT_AUDIT_ACTION })).filter(
    (row) => (row.detail as { token?: unknown } | undefined)?.token === "native-tok",
  );
  eq(strandRows.length, 1, "…and wrote exactly ONE strand audit row for this token");
  eq(strandRows[0]!.workspace, ORG_ID, "…workspace is the organizationId, not `unknown`");
  eq((strandRows[0]!.detail as Record<string, unknown>).registryKey, SURFACE, "…the row names the registryKey it marked");
}

{
  const org = deploymentOrg();
  const before = await getOperationalStore().getChannelSession(org, SURFACE);
  const transient = new Error("socket hang up");
  const failingSend = (async () => {
    throw transient;
  }) as unknown as Parameters<typeof liveLinearSupervisorDeps>[0];
  const deps = liveLinearSupervisorDeps(failingSend, TEAM_ID, ORG_ID, undefined);

  await deps.wake({
    token: "transient-tok",
    auth: { attributes: {} } as never,
    message: "<wake>hi</wake>",
    context: [],
  }).catch(() => undefined);

  const after = await getOperationalStore().getChannelSession(org, SURFACE);
  eq(after?.rotateMarkedAt, before?.rotateMarkedAt, "negative control: a TRANSIENT native send failure changes NOTHING about the seat's mark state");
  const strandRows = (await getOperationalStore().readAudit({ org, action: PRUNED_DEPLOYMENT_AUDIT_ACTION })).filter(
    (row) => (row.detail as { token?: unknown } | undefined)?.token === "transient-tok",
  );
  eq(strandRows.length, 0, "…and writes no strand audit row either");
}

{
  let calls = 0;
  const retryingSend = (async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("refused"), { name: "TooManyRequestsError", retryAfter: 0 });
    return {};
  }) as unknown as Parameters<typeof liveLinearSupervisorDeps>[0];
  const deps = liveLinearSupervisorDeps(retryingSend, TEAM_ID, ORG_ID, undefined);
  await deps.wake({ token: "native-retry-tok", auth: { attributes: {} } as never, message: "<wake>retry</wake>", context: [] });
  eq(calls, 2, "🔴 OPE-1881: Linear's real native launch retries one proven 429 and delivers");
  const rows = (await getOperationalStore().readAudit({ org: deploymentOrg(), action: "surface.wake_retry" })).filter((row) => row.surface === SURFACE);
  eq(rows.length, 1, "🔴 OPE-1881: Linear records the native refusal under the real team surface");
  ok(!("wakeId" in ((rows[0]?.detail ?? {}) as Record<string, unknown>)), "🔴 the native Linear row does not fabricate a wakeId");
}

{
  let calls = 0;
  const refusingSend = (async () => {
    calls += 1;
    throw Object.assign(new Error("refused"), { name: "TooManyRequestsError", retryAfter: 0 });
  }) as unknown as Parameters<typeof liveLinearSupervisorDeps>[0];
  const deps = liveLinearSupervisorDeps(refusingSend, TEAM_ID, ORG_ID, undefined);
  let threw: unknown;
  try {
    await deps.wake({ token: "exhaust-tok", auth: { attributes: {} } as never, message: "<wake>retry</wake>", context: [] });
  } catch (err) {
    threw = err;
  }
  eq(calls, 4, "🔴 Linear's native adapter stops at the shared four-attempt bound");
  ok(threw instanceof Error && threw.name === "RateLimitExhaustedError", "🔴 Linear propagates named retry exhaustion through its existing strand-heal catch");
}

console.log(`✓ linear-wake-failure-audit: ${n} assertions passed (wake failure audit/heal + native 429 retry + controls)`);
