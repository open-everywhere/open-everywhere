import { expect, test } from "vitest";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import type { UsageEventEntry } from "@open-everywhere/core/agent/operational/store.js";
import { UNKNOWN_MODEL } from "@open-everywhere/core/agent/spend/spend.js";
import { subagentRunOf } from "@open-everywhere/core/agent/spend/subagent-runs.js";
import { SCRIPTED_MODEL_ID } from "../../../agent/model/scripted-model";
import {
  disposeLater,
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  readUsageWindow,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
} from "../harness";

function org(): string {
  return deploymentOrg();
}

interface DrivenSpendTurn {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly sinceIso: string;
  readonly totalCalls: number;
  readonly parentCalls: number;
  readonly childCalls: number;
}

let driven: DrivenSpendTurn | undefined;

async function driveTurn(): Promise<DrivenSpendTurn> {
  if (driven !== undefined) return driven;
  await bootAgent({ sharedSqlite: true });

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "delegate please" }, id: "sp1-delegate" }] },
        { say: "parent done" },
      ],
      child: [{ say: "child done" }],
    }),
  );

  const sinceIso = new Date(Date.now() - 10_000).toISOString();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please delegate" });

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the parent's terminal step to be served");
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the delegated worker's own model call" });
  const drained = await awaitTaskSettlement({
    dispatched: handle,
    taskId: taskIdOfDelegation(handle, "the spend delegation"),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: "the worker's settlement wake",
  });
  await waitFor(
    () => drained.handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0),
    "the settlement turn's own model call to be recorded",
  );
  expect(drained.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(drained.handle.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(drained.handle.resolves.length).toBe(drained.handle.requests.length);
  drained.handle.dispose();

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.resolves.length).toBe(handle.requests.length);

  const parentSessionId = handle.resolves.find((r) => r.role === "parent")?.sessionId;
  const childSessionId = handle.resolves.find((r) => r.role === "child")?.sessionId;
  if (parentSessionId === undefined || childSessionId === undefined) {
    throw new Error(`spend-and-model test: could not recover both session ids from resolves (parent=${parentSessionId}, child=${childSessionId}).`);
  }
  expect(parentSessionId).not.toBe(childSessionId);

  const parentCalls =
    handle.resolves.filter((r) => r.role === "parent").length + drained.handle.resolves.filter((r) => r.role === "parent").length;
  const childCalls = handle.resolves.filter((r) => r.role === "child").length + drained.handle.resolves.filter((r) => r.role === "child").length;
  expect(childCalls).toBe(1);
  driven = { parentSessionId, childSessionId, sinceIso, totalCalls: parentCalls + childCalls, parentCalls, childCalls };
  return driven;
}

test("a delegated turn's model calls all stamp the scripted model id, not UNKNOWN_MODEL", async () => {
  const { parentSessionId, totalCalls } = await driveTurn();

  const rows = await waitFor(async () => {
    const got = await getOperationalStore().usageForSession(org(), parentSessionId);
    return got.length >= totalCalls ? got : undefined;
  }, `at least ${totalCalls} usage_events row(s) filed under the parent session`);

  expect(rows.length).toBe(totalCalls);
  for (const row of rows) {
    expect(row.model).toBe(SCRIPTED_MODEL_ID);
    expect(row.model).not.toBe(UNKNOWN_MODEL);
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.outputTokens).toBeGreaterThanOrEqual(0);
  }

  for (const row of rows) {
    expect(row.usdMicrosMeasured).toBeUndefined();
  }
});

test("the delegated child's usage rows file under its PARENT's session, never under its own (OPE-263)", async () => {
  const { parentSessionId, childSessionId, totalCalls, parentCalls, childCalls } = await driveTurn();

  const parentRows = await waitFor(async () => {
    const got = await getOperationalStore().usageForSession(org(), parentSessionId);
    return got.length >= totalCalls ? got : undefined;
  }, "the parent session's filed rows (the parent seat's own steps + 1 delegated child)");

  const byKind = new Map<string, UsageEventEntry[]>();
  for (const r of parentRows) {
    const k = r.kind ?? "(none)";
    byKind.set(k, [...(byKind.get(k) ?? []), r]);
  }
  expect((byKind.get("supervisor") ?? []).length).toBe(parentCalls);
  expect((byKind.get("subagent") ?? []).length).toBe(childCalls);

  const delegatedRow = (byKind.get("subagent") ?? [])[0];
  const stamp = subagentRunOf(delegatedRow);
  expect(stamp).toBeDefined();
  expect(stamp!.sessionId).toBe(childSessionId);
  expect(stamp!.callId).toBe("sp1-delegate");

  const childOwnRows = await getOperationalStore().usageForSession(org(), childSessionId);
  expect(childOwnRows).toEqual([]);
});

test("GET /control/v1/usage prices the run at the scripted model id, aggregated, with no guessed $", async () => {
  const { sinceIso, totalCalls, parentSessionId } = await driveTurn();
  await waitFor(async () => {
    const got = await getOperationalStore().usageForSession(org(), parentSessionId);
    return got.length >= totalCalls ? true : undefined;
  }, "the ledger to settle before reading the HTTP window");

  const window = await readUsageWindow({ sinceIso, workspaceKeys: [`discord/${DISCORD_GUILD_ID}`] });
  const row = window.rows.find((r) => r.model === SCRIPTED_MODEL_ID);
  expect(row).toBeDefined();
  expect(row!.calls).toBe(totalCalls);
  expect(row!.surfaceKey).toBe(`discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`);
  expect(row!.estimatedUsd).toBeUndefined();
  expect(window.unpricedModels).toContain(SCRIPTED_MODEL_ID);
});
