import { expect, test } from "vitest";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import type { UsageEventEntry } from "@open-everywhere/core/agent/operational/store.js";
import { UNKNOWN_MODEL } from "@open-everywhere/core/agent/spend/spend.js";
import { subagentRunOf } from "@open-everywhere/core/agent/spend/subagent-runs.js";
import { SCRIPTED_MODEL_ID } from "../../../agent/model/scripted-model";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWindowQuiet,
  awaitWorkResult,
  bootAgent,
  discordMentionWake,
  disposeLater,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  readUsageWindow,
  registerScript,
  rowsSinceCursor,
  waitFor,
  waitForChildren,
  workSessionCalls,
  workTaskIdOfCall,
} from "../harness";

function org(): string {
  return deploymentOrg();
}

interface DrivenSpendTurn {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly workSessionId: string;
  readonly sinceIso: string;
  readonly parentCalls: number;
  readonly childCalls: number;
  readonly workCallId: string;
  readonly workMark: number;
}

let driven: DrivenSpendTurn | undefined;

async function driveTurn(): Promise<DrivenSpendTurn> {
  if (driven !== undefined) return driven;
  await bootAgent({ sharedSqlite: true });

  const cursor = await auditCursor();
  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "delegate please" }, id: "sp1-delegate" }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [{ delayMs: 120_000, say: "child done" }],
    }),
  );

  const sinceIso = new Date(Date.now() - 10_000).toISOString();
  const workMark = workSessionCalls().length;
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please delegate" });

  const receiptStep = await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the parent's receipt step to be served");
  const taskId = await workTaskIdOfCall(cursor, handle, "sp1-delegate", "the spend forward");
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the delegated worker's own model call" });
  await waitFor(() => (handle.holdsCutShort() === 1 ? true : undefined), "the worker's hold ended on the release, not on its 120 s backstop");
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "the seat step that read the worker's result" });
  expect(resultStep.stepIndex).toBe(0);
  expect(resultStep.turnId, "the result arrives in a seat turn of its own (OPE-2338)").not.toBe(receiptStep.turnId);

  for (const h of [handle, settlement]) {
    expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(h.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(h.resolves.length).toBe(h.requests.length);
  }

  const parentSessionId = handle.resolves.find((r) => r.role === "parent")?.sessionId;
  const childSessionId = handle.resolves.find((r) => r.role === "child")?.sessionId;
  const started = await waitFor(async () => (await rowsSinceCursor(cursor, ["delegation.task_started"])).find((r) => r.detail?.task === taskId), "W's delegation.task_started row");
  const workSessionId = typeof started.detail?.session === "string" ? started.detail.session : undefined;
  const workCallId = String(started.detail?.call);
  if (parentSessionId === undefined || childSessionId === undefined || workSessionId === undefined) {
    throw new Error(`spend-and-model test: could not recover the session ids (seat=${parentSessionId}, child=${childSessionId}, work=${workSessionId}).`);
  }
  expect(parentSessionId).not.toBe(childSessionId);
  expect(workSessionId).not.toBe(parentSessionId);
  expect(workSessionId).not.toBe(childSessionId);
  expect(settlement.resolves.every((r) => r.role !== "parent" || r.sessionId === parentSessionId), "the result-wake turn ran on the seat's own session").toBe(true);

  const parentCalls = handle.resolves.filter((r) => r.role === "parent").length + settlement.resolves.filter((r) => r.role === "parent").length;
  const childCalls = handle.resolves.filter((r) => r.role === "child").length;
  expect(parentCalls).toBe(3);
  expect(childCalls).toBe(1);
  driven = { parentSessionId, childSessionId, workSessionId, sinceIso, parentCalls, childCalls, workCallId, workMark };
  return driven;
}

async function settledRows(d: DrivenSpendTurn): Promise<{ seat: UsageEventEntry[]; work: UsageEventEntry[]; workCalls: number }> {
  await waitFor(async () => {
    const seat = await getOperationalStore().usageForSession(org(), d.parentSessionId);
    const work = await getOperationalStore().usageForSession(org(), d.workSessionId);
    return seat.length >= d.parentCalls && work.filter((r) => r.kind === "subagent").length >= d.childCalls ? true : undefined;
  }, `the seat's ${d.parentCalls} row(s) and the worker's ${d.childCalls} row(s) on the ledger`);
  await awaitWindowQuiet();
  const workCalls = workSessionCalls()
    .slice(d.workMark)
    .filter((c) => c.sessionId === d.workSessionId).length;
  await waitFor(async () => {
    const work = await getOperationalStore().usageForSession(org(), d.workSessionId);
    return work.filter((r) => r.kind !== "subagent").length >= workCalls ? true : undefined;
  }, `the work session's ${workCalls} own row(s) on the ledger`);
  return {
    seat: await getOperationalStore().usageForSession(org(), d.parentSessionId),
    work: await getOperationalStore().usageForSession(org(), d.workSessionId),
    workCalls,
  };
}

test("a delegated turn's model calls all stamp the scripted model id, not UNKNOWN_MODEL", async () => {
  const driven = await driveTurn();
  const { seat, work, workCalls } = await settledRows(driven);

  expect(seat.length).toBe(driven.parentCalls);
  expect(work.filter((r) => r.kind === "subagent").length).toBe(driven.childCalls);
  expect(workCalls, "the work session made no model call of its own in this arc").toBeGreaterThan(0);
  expect(work.filter((r) => r.kind !== "subagent").length, "the work session's own rows are not one per model call").toBe(workCalls);
  for (const row of [...seat, ...work]) {
    expect(row.model).toBe(SCRIPTED_MODEL_ID);
    expect(row.model).not.toBe(UNKNOWN_MODEL);
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.outputTokens).toBeGreaterThanOrEqual(0);
  }

  for (const row of [...seat, ...work]) {
    expect(row.usdMicrosMeasured).toBeUndefined();
  }
});

test("the delegated child's usage rows file under its PARENT's session, never under its own (OPE-263)", async () => {
  const driven = await driveTurn();
  const { parentSessionId, childSessionId, workSessionId, childCalls, parentCalls } = driven;
  const { seat, work } = await settledRows(driven);

  const byKind = (rows: UsageEventEntry[]) => {
    const m = new Map<string, UsageEventEntry[]>();
    for (const r of rows) m.set(r.kind ?? "(none)", [...(m.get(r.kind ?? "(none)") ?? []), r]);
    return m;
  };
  const seatKinds = byKind(seat);
  expect((seatKinds.get("supervisor") ?? []).length).toBe(parentCalls);
  expect((seatKinds.get("subagent") ?? []).length, "the worker's usage filed on the SEAT").toBe(0);
  const workKinds = byKind(work);
  expect((workKinds.get("subagent") ?? []).length).toBe(childCalls);

  const delegatedRow = (workKinds.get("subagent") ?? [])[0];
  const stamp = subagentRunOf(delegatedRow);
  expect(stamp).toBeDefined();
  expect(stamp!.sessionId).toBe(childSessionId);
  expect(stamp!.callId).toBe(driven.workCallId);
  expect(stamp!.rootSessionId).toBe(workSessionId);
  expect(delegatedRow.rootSessionId).toBe(workSessionId);

  const childOwnRows = await getOperationalStore().usageForSession(org(), childSessionId);
  expect(childOwnRows).toEqual([]);
});

test("GET /control/v1/usage prices the run at the scripted model id, aggregated, with no guessed $", async () => {
  const driven = await driveTurn();
  const { sinceIso } = driven;
  const { workCalls } = await settledRows(driven);
  const totalCalls = driven.parentCalls + driven.childCalls + workCalls;

  const window = await readUsageWindow({ sinceIso, workspaceKeys: [`discord/${DISCORD_GUILD_ID}`] });
  const row = window.rows.find((r) => r.model === SCRIPTED_MODEL_ID);
  expect(row).toBeDefined();
  expect(row!.calls).toBe(totalCalls);
  expect(row!.surfaceKey).toBe(`discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`);
  expect(row!.estimatedUsd).toBeUndefined();
  expect(window.unpricedModels).toContain(SCRIPTED_MODEL_ID);
});
