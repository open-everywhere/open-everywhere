import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";

import { auditCursor, bootAgent, disposeLater, registerScript, rowsSinceCursor, runRoutineDispatchTick, waitFor, type AuditRow } from "../harness";
import { installSlackWebApiStub } from "../slack-web-api";

const TEAM = "T0EXAMPLE";
const CHANNEL = "C0EXCHAN003";
const SURFACE_KEY = `slack/${TEAM}/${CHANNEL}`;
const CREATOR = "U0OPE2515CRT";
const ROOT_TS = "1760009420.253000";
const PROBE_REASON = "ope2515 this call must be blocked";
const ANSWER = "ope2515 the open incident count is 3";

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

test("a requested test fires into its own thread, blocks the run's write, posts the summary, and moves nothing on the routine", async () => {
  const slack = installSlackWebApiStub((method) => (method === "chat.postMessage" ? { ok: true, ts: ROOT_TS, channel: CHANNEL } : undefined));
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  try {
    const cursor = await auditCursor();
    const handle = disposeLater(
      registerScript({
        parent: [{ calls: [{ tool: "report_run_failed", input: { reason: PROBE_REASON }, id: "ope2515-probe" }] }, { say: ANSWER }],
      }),
    );
    const { addRoutine, getRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
    const id = `r-it-2515-${randomBytes(4).toString("hex")}`;
    const testId = `t-${randomBytes(4).toString("hex")}`;
    const nextRunAt = new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString();
    await addRoutine(
      { org: "default", platform: "slack", workspace: TEAM, surface: CHANNEL, workspaceKey: `slack/${TEAM}`, surfaceKey: SURFACE_KEY, domainKey: SURFACE_KEY, key: SURFACE_KEY },
      {
        id,
        org: "default",
        surfaceKey: SURFACE_KEY,
        target: { channelId: CHANNEL },
        trigger: { kind: "interval", everyMinutes: 60 },
        prompt: "ope2515 post the open incident count",
        createdBy: CREATOR,
        status: "active",
        nextRunAt,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        promptGeneration: 1,
        consecutiveFailures: 0,
        testRun: { id: testId, requestedBy: CREATOR, requestedAt: new Date().toISOString() },
      },
    );

    await runRoutineDispatchTick();

    const fired = await waitFor(async () => (await rowsSinceCursor(cursor, ["routine.test_fired"], { limit: 100 })).find((r) => detailOf(r).test === testId), "the routine.test_fired row");
    expect(detailOf(fired).started, `🔴 the test did not start (${String(detailOf(fired).reason)})`).toBe(true);
    const root = slack.calls.find((c) => c.method === "chat.postMessage" && c.params.get("channel") === CHANNEL && !c.params.get("thread_ts"));
    expect(root?.params.get("text") ?? "", "🔴 no test thread root was posted in the routine's channel").toContain("🧪 Test run of");

    const blocked = await waitFor(
      async () => (await rowsSinceCursor(cursor, ["routine.test_blocked"], { limit: 100 })).find((r) => detailOf(r).test === testId),
      "the routine.test_blocked row for the probe write",
      150_000,
    );
    expect(detailOf(blocked).tool, "🔴 the blocked call is not the run's write").toBe("report_run_failed");
    const probeResult = await waitFor(async () => handle.requests.flatMap((r) => r.toolResults).find((t) => t.id === "ope2515-probe"), "the probe write's result in the run's next model call", 150_000);
    expect(probeResult?.isError, "🔴 the probe write was NOT refused — the fence did not reach the fired turn").toBe(true);
    expect(JSON.stringify(probeResult?.output ?? ""), "the refusal does not tell the run it is a test").toContain("TEST RUN");

    const summary = await waitFor(
      async () => slack.calls.find((c) => c.method === "chat.postMessage" && c.params.get("thread_ts") === ROOT_TS && (c.params.get("text") ?? "").includes("finished")),
      "the summary post in the test thread",
      150_000,
    );
    expect(summary.params.get("text") ?? "", "the summary does not name the blocked write").toContain("report run failed");

    const after = await getRoutine("default", SURFACE_KEY, id);
    expect(after?.lastFailureReason, "🔴 the blocked write reached the routine row").toBeUndefined();
    expect([after?.nextRunAt, after?.lastRunAt, after?.consecutiveFailures, after?.testRun], "the test moved the routine's schedule, history or streak").toEqual([nextRunAt, undefined, 0, undefined]);
    const folds = (await rowsSinceCursor(cursor, ["routine.fire"], { limit: 100 })).filter((r) => detailOf(r).routineId === id);
    expect(folds, "🔴 a test fire folded an outcome onto the routine").toEqual([]);
  } finally {
    slack.uninstall();
  }
});
