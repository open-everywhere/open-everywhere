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

console.log(`✓ notion-wake-heal: ${n} assertions passed (OPE-971 native flag-off pruned-deployment heal + negative control)`);
