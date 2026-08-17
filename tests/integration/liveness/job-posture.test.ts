import { afterEach, expect, test } from "vitest";
import { bootAgent, readAuditRows, registerScript, runRoutineDispatchTick, waitFor, type ScriptedHandle } from "../harness";

const perTest: (() => void)[] = [];
afterEach(() => {
  for (const c of perTest.splice(0)) c();
});
function disposeLater(handle: ScriptedHandle): ScriptedHandle {
  perTest.push(() => handle.dispose());
  return handle;
}

async function seedRoutine(input: {
  readonly surfaceKey: string;
  readonly channelId: string;
  readonly prompt: string;
  readonly sessionMode?: "job";
}): Promise<string> {
  if (process.env.OE_OPERATIONAL_PROVIDER !== "sqlite") {
    throw new Error("this test needs bootAgent({ sharedSqlite: true }) — PGlite is single-writer.");
  }
  const { addRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const { randomBytes } = await import("node:crypto");
  const id = `r-it-jp-${randomBytes(4).toString("hex")}`;
  const [platform = "slack", workspace = "", surface = ""] = input.surfaceKey.split("/");
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  await addRoutine(
    {
      org: "default",
      platform,
      workspace,
      surface,
      workspaceKey: `${platform}/${workspace}`,
      surfaceKey: input.surfaceKey,
      domainKey: input.surfaceKey,
      key: input.surfaceKey,
    },
    {
      id,
      org: "default",
      surfaceKey: input.surfaceKey,
      target: { channelId: input.channelId },
      trigger: { kind: "once", at: dueAt },
      prompt: input.prompt,
      createdBy: "U0JOBPOSTURE",
      status: "active",
      nextRunAt: dueAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      consecutiveFailures: 0,
      ...(input.sessionMode !== undefined ? { sessionMode: input.sessionMode } : {}),
    },
  );
  return id;
}

test("a durable-JOB fire, un-escalated, narrows and writes the turn.tool_gated(job-wake) row", async () => {
  await bootAgent({ sharedSqlite: true });
  const TEAM = "T0JOBPOST1";
  const CHANNEL = "C0JOBPOST1";
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  disposeLater(registerScript({ parent: [{ say: "job fire ran, nothing to report" }] }));

  const routineId = await seedRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "check the queue and note anything stuck",
    sessionMode: "job",
  });

  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length).toBeGreaterThan(0);

  const surfaceKey = `slack/${TEAM}/${CHANNEL}`;
  const gated = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["turn.tool_gated"], sinceIso });
    return rows.find((r) => r.workspace === surfaceKey && (r.detail as { reason?: unknown } | undefined)?.reason === "job-wake");
  }, "a turn.tool_gated row with reason=job-wake for the job fire");

  const detail = gated.detail as { withheld?: readonly string[]; withheldCount?: number; grain?: string; sessionId?: unknown };
  expect(Array.isArray(detail.withheld)).toBe(true);
  expect((detail.withheld ?? []).length).toBeGreaterThan(0);
  expect(detail.withheldCount).toBe((detail.withheld ?? []).length);
  expect(routineId).toMatch(/^r-it-jp-/);
});

test("NEGATIVE CONTROL — an ORDINARY (non-job) fire, same tick shape, never writes reason=job-wake", async () => {
  await bootAgent({ sharedSqlite: true });
  const TEAM = "T0JOBPOST2";
  const CHANNEL = "C0JOBPOST2";
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  disposeLater(registerScript({ parent: [{ say: "ordinary fire ran, nothing to report" }] }));

  const routineId = await seedRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "check the queue and note anything stuck",
  });

  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length).toBeGreaterThan(0);

  await waitFor(
    async () => (await readAuditRows({ actions: ["routine.fire"], sinceIso })).find((r) => (r.detail as { routineId?: unknown } | undefined)?.routineId === routineId),
    "a routine.fire outcome row for the ordinary fire — proof the turn actually ran",
  );
  const surfaceKey = `slack/${TEAM}/${CHANNEL}`;
  const gated = await readAuditRows({ actions: ["turn.tool_gated"], sinceIso });
  expect(gated.find((r) => r.workspace === surfaceKey && (r.detail as { reason?: unknown } | undefined)?.reason === "job-wake")).toBeUndefined();
});
