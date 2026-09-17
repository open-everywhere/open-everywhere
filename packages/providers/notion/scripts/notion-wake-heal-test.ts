import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-notion-wake-heal-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;

const { registerNotionProvider } = await import("../agent/register.js");
registerNotionProvider();
const { liveNotionSupervisorDeps } = await import("../agent/channels/notion.js");
const { createNotionWebhookTiming } = await import("../agent/channels/notion-webhook-timing.js");
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

const SURFACE = "notion/workspace_acme/page_widgets";
const STATE = { discussionId: null, pageId: null, workspaceId: null } as const;

{
  const org = deploymentOrg();
  await getOperationalStore().rotateChannelSession(org, SURFACE, "seed-tok", "2026-08-22T00:00:00.000Z");
  const before = await getOperationalStore().getChannelSession(org, SURFACE);
  ok(before?.rotateMarkedAt == null, "wiring precondition: the page's seat starts UNMARKED (so a green below cannot be vacuous)");

  const boom = new Error(`${RUN_KEY_FETCH_MARKER} for wrun_TEST (deployment dpl_TEST): ${HTTP_404_MARKER} Not Found`);
  const failingSend = (async () => {
    throw boom;
  }) as unknown as Parameters<typeof liveNotionSupervisorDeps>[0];
  const deps = liveNotionSupervisorDeps(failingSend, SURFACE, undefined);

  let threw: unknown;
  try {
    await deps.wake({
      token: "native-tok",
      auth: { attributes: {} } as never,
      message: "<wake>hi</wake>",
      context: [],
      state: STATE,
    });
  } catch (err) {
    threw = err;
  }
  ok(threw === boom, "🔴 the native send failure still PROPAGATES unchanged — this is an audit ADDITION, not a swallow");

  const after = await getOperationalStore().getChannelSession(org, SURFACE);
  ok(after?.rotateMarkedAt != null, "🔴 OPE-971: the NATIVE (flag-off) wake heal MARKED the page's own seat for rotation — notionGrainFor's registryKey === surfaceKey flag-off");
  const strandRows = (await getOperationalStore().readAudit({ org, action: PRUNED_DEPLOYMENT_AUDIT_ACTION })).filter(
    (row) => (row.detail as { token?: unknown } | undefined)?.token === "native-tok",
  );
  eq(strandRows.length, 1, "…and wrote exactly ONE strand audit row for this token");
  eq(strandRows[0]!.workspace, "workspace_acme", "…workspace is the surfaceKey's own second segment, not `unknown`");
  eq((strandRows[0]!.detail as Record<string, unknown>).registryKey, SURFACE, "…the row names the registryKey it marked");
}

{
  const org = deploymentOrg();
  const before = await getOperationalStore().getChannelSession(org, SURFACE);
  const transient = new Error("socket hang up");
  const failingSend = (async () => {
    throw transient;
  }) as unknown as Parameters<typeof liveNotionSupervisorDeps>[0];
  const deps = liveNotionSupervisorDeps(failingSend, SURFACE, undefined);

  await deps
    .wake({
      token: "transient-tok",
      auth: { attributes: {} } as never,
      message: "<wake>hi</wake>",
      context: [],
      state: STATE,
    })
    .catch(() => undefined);

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
  }) as unknown as Parameters<typeof liveNotionSupervisorDeps>[0];
  const deps = liveNotionSupervisorDeps(retryingSend, SURFACE, undefined);
  await deps.wake({ token: "native-retry-tok", auth: { attributes: {} } as never, message: "<wake>retry</wake>", context: [], state: STATE });
  eq(calls, 2, "🔴 OPE-1881: Notion's real native launch retries one proven 429 and delivers");
  const rows = (await getOperationalStore().readAudit({ org: deploymentOrg(), action: "surface.wake_retry" })).filter((row) => row.surface === SURFACE);
  eq(rows.length, 1, "🔴 OPE-1881: Notion records the native refusal under the real page surface");
  ok(!("wakeId" in ((rows[0]?.detail ?? {}) as Record<string, unknown>)), "🔴 the native Notion row does not fabricate a wakeId");
}

{
  let calls = 0;
  const refusingSend = (async () => {
    calls += 1;
    throw Object.assign(new Error("refused"), { name: "TooManyRequestsError", retryAfter: 0 });
  }) as unknown as Parameters<typeof liveNotionSupervisorDeps>[0];
  const deps = liveNotionSupervisorDeps(refusingSend, SURFACE, undefined);
  let threw: unknown;
  try {
    await deps.wake({ token: "exhaust-tok", auth: { attributes: {} } as never, message: "<wake>retry</wake>", context: [], state: STATE });
  } catch (err) {
    threw = err;
  }
  eq(calls, 4, "🔴 Notion's native adapter stops at the shared four-attempt bound");
  ok(threw instanceof Error && threw.name === "RateLimitExhaustedError", "🔴 Notion propagates named retry exhaustion through its existing strand-heal catch");
}

{
  let at = 0;
  let calls = 0;
  const timing = createNotionWebhookTiming(() => at);
  const send = (async () => {
    calls += 1;
    at += 17;
  }) as unknown as Parameters<typeof liveNotionSupervisorDeps>[0];
  const deps = liveNotionSupervisorDeps(send, SURFACE, undefined, undefined, timing);
  await deps.wake({ token: "timed-tok", auth: { attributes: {} } as never, message: "<wake>timed</wake>", context: [], state: STATE });
  const detail = timing.detail("dispatched");
  eq(calls, 1, "OPE-1929: the timing drive reached the live native send exactly once");
  eq(detail.eveSendMs, 17, "🔴 OPE-1929: the live adapter attributes the injected native send delay to Eve delivery");
  eq(detail.dispatchPreflightCatchUpMs, undefined, "OPE-1929: the nested adapter measure does not manufacture an outer dispatch span");
}

console.log(`✓ notion-wake-heal: ${n} assertions passed (OPE-971 heal + native 429 retry + control)`);
