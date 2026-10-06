import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  auditCursor,
  bootAgent,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  seatReply,
  waitFor,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const TEAM = "T0EXAMPLE";
const CHANNEL = "C0EXCHAN003";
const SURFACE_KEY = `slack/${TEAM}/${CHANNEL}`;
const CREATOR = "slack:U0OPE2342CRT";

const CHILD_RESULT = "ope2342 the digest: 3 widgets, 2 gadgets";
const POSTED = "ope2342 routine digest posted by the seat";

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

function promptOf(request: RecordedRequest): string {
  return request.messages.map((m) => m.text).join("\n");
}

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

async function seedRoutine(prompt: string, silent: boolean): Promise<string> {
  const { addRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const id = `r-it-2342-${randomBytes(4).toString("hex")}`;
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  await addRoutine(
    { org: "default", platform: "slack", workspace: TEAM, surface: CHANNEL, workspaceKey: `slack/${TEAM}`, surfaceKey: SURFACE_KEY, domainKey: SURFACE_KEY, key: SURFACE_KEY },
    {
      id,
      org: "default",
      surfaceKey: SURFACE_KEY,
      target: { channelId: CHANNEL },
      trigger: { kind: "once", at: dueAt },
      prompt,
      createdBy: CREATOR,
      status: "active",
      nextRunAt: dueAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      promptGeneration: 1,
      consecutiveFailures: 0,
      ...(silent ? { report: { kind: "silent" as const } } : {}),
    },
  );
  return id;
}

function spendLimitResult(handle: ScriptedHandle): { isError: boolean; output: unknown } | undefined {
  for (const req of handle.requests.filter((r) => r.role === "child")) {
    const hit = req.toolResults.find((t) => t.name === "set_spend_limit");
    if (hit) return { isError: hit.isError, output: hit.output };
  }
  return undefined;
}

async function forwardedRowFor(cursor: Awaited<ReturnType<typeof auditCursor>>, routineId: string): Promise<AuditRow> {
  return waitFor(async () => (await rowsSinceCursor(cursor, ["work.forwarded"], { limit: 100 })).find((r) => detailOf(r).routineId === routineId), `the work.forwarded row for routine ${routineId}`, 150_000);
}

async function foldRowFor(cursor: Awaited<ReturnType<typeof auditCursor>>, routineId: string): Promise<AuditRow> {
  return waitFor(async () => (await rowsSinceCursor(cursor, ["routine.fire"], { limit: 100 })).find((r) => detailOf(r).routineId === routineId), `the routine.fire fold row for routine ${routineId}`, 150_000);
}

test("a fire runs no seat turn, starts its task in W under the unattended stamp, and its result wakes the seat, which posts it", async () => {
  await bootAgent({ sharedSqlite: true });
  const cursor = await auditCursor();
  const handle = disposeLater(
    registerScript({
      parent: [seatReply(POSTED, "ope2342-post"), { say: NO_REPLY_SENTINEL }],
      child: [{ calls: [{ tool: "set_spend_limit", input: { monthlyUsd: 12.5, reason: "ope2342 unattended probe" }, id: "ope2342-probe" }] }, { say: CHILD_RESULT }],
    }),
  );
  const routineId = await seedRoutine("ope2342 gather the numbers and post the digest", false);
  await runRoutineDispatchTick();

  const forwarded = await forwardedRowFor(cursor, routineId);
  expect([detailOf(forwarded).fire, detailOf(forwarded).owesRoom], "the forward is not marked as a fire that owes the room").toEqual([true, true]);
  expect(String(detailOf(forwarded).workToken), "the fire was not forwarded to a work-session token").toContain(":win:w/");
  const requestId = detailOf(forwarded).requestId;
  const keyed = await waitFor(async () => (await rowsSinceCursor(cursor, ["work.task_keyed"], { limit: 100 })).find((r) => detailOf(r).requestId === requestId), "the work.task_keyed row for the fire's task");
  expect([detailOf(keyed).verdict, detailOf(keyed).requester], "🔴 the fire's task is not keyed to NOBODY").toEqual(["keyed", "oe/unverified"]);

  const probe = await waitFor(() => spendLimitResult(handle), "the child's set_spend_limit result", 150_000);
  expect(probe.isError, "🔴 the child's proposal was NOT refused — the fire's unattended stamp did not reach it").toBe(true);
  expect(JSON.stringify(probe.output)).toContain("no acting sender");

  const reply = await waitFor(async () => (await rowsSinceCursor(cursor, ["reply.post"], { limit: 100 })).find((r) => detailOf(r).chars === POSTED.length && String(r.surface ?? "").length > 0), "the seat's reply.post row for the fire's result", 150_000);
  const seatSteps = handle.requests.filter((r) => r.role === "parent");
  expect(seatSteps.length, "no seat step was served").toBeGreaterThan(0);
  expect(promptOf(seatSteps[0]!), "🔴 the first seat step holds no result — a seat turn ran for the fire itself").toContain(CHILD_RESULT);
  expect(new Set(seatSteps.map((r) => r.turnId)).size, "the seat took more than one turn for one fire").toBe(1);
  expect(String(reply.surface), "the post came from a thread seat, not the domain seat").not.toContain("s/");
  expect(detailOf(reply).creatorId, "the seat's reply for a fire does not name the routine's creator").toBe(CREATOR);
  expect(reply.principalId, "the seat's reply for a fire is not authored by the schedule principal").toBe("eve:app");
  expect(reply.surface, "the seat's reply for a fire did not file under the routine's channel").toBe(CHANNEL);
  const wake = await waitFor(async () => (await rowsSinceCursor(cursor, ["work.result_wake"], { limit: 100 })).find((r) => detailOf(r).requestId === requestId), "the fire's work.result_wake row");
  expect([detailOf(wake).outcome, detailOf(wake).fire], "the fire's result did not wake the seat").toEqual(["delivered", true]);
  const fold = await foldRowFor(cursor, routineId);
  expect(detailOf(fold).outcome, "the fire's run did not fold `ok` onto its routine").toBe("ok");
  expect(typeof detailOf(fold).sessionId, "the fold row names no session").toBe("string");
  assertNoFault(handle, "the fire");
});

test("a SILENT routine's fire runs in W and wakes no seat, and its run still folds", async () => {
  await bootAgent({ sharedSqlite: true });
  const cursor = await auditCursor();
  const handle = disposeLater(registerScript({ parent: [seatReply("ope2342 a silent routine must not speak", "ope2342-silent-post"), { say: NO_REPLY_SENTINEL }], child: [{ say: "ope2342 silent result" }] }));
  const routineId = await seedRoutine("ope2342 watch quietly", true);
  await runRoutineDispatchTick();

  const forwarded = await forwardedRowFor(cursor, routineId);
  expect([detailOf(forwarded).fire, detailOf(forwarded).owesRoom], "the forward is not marked as a silent fire").toEqual([true, false]);
  const requestId = detailOf(forwarded).requestId;
  const wake = await waitFor(async () => (await rowsSinceCursor(cursor, ["work.result_wake"], { limit: 100 })).find((r) => detailOf(r).requestId === requestId), "the silent fire's work.result_wake row", 150_000);
  expect(detailOf(wake).outcome, "🔴 a silent routine's result woke the seat").toBe("silent-fire");
  const fold = await foldRowFor(cursor, routineId);
  expect(detailOf(fold).outcome, "the silent fire's run did not fold onto its routine").toBe("ok");
  await new Promise((r) => setTimeout(r, 3_000));
  expect(handle.requests.filter((r) => r.role === "parent"), "🔴 a seat model call was served for a silent routine").toEqual([]);
  expect(handle.requests.filter((r) => r.role === "child").length, "the silent routine's child never ran").toBeGreaterThan(0);
  assertNoFault(handle, "the silent fire");
});
