import { expect, test } from "vitest";
import { bootAgent, disposeLater, registerScript, runRoutineDispatchTick, waitFor } from "../harness";
import {
  EVE_PATCH_PARTS,
  _resetEvePatchTurnCheckForTest,
  evePatchTurnCheckHasPassed,
} from "@open-everywhere/core/agent/access/eve-patch-probe.js";

async function seedDueRoutine(surfaceKey: string, channelId: string): Promise<string> {
  if (process.env.OE_OPERATIONAL_PROVIDER !== "sqlite") {
    throw new Error("this test needs bootAgent({ sharedSqlite: true }) — PGlite is single-writer.");
  }
  const { addRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const { randomBytes } = await import("node:crypto");
  const id = `r-it-epg-${randomBytes(4).toString("hex")}`;
  const [platform = "slack", workspace = "", surface = ""] = surfaceKey.split("/");
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  await addRoutine(
    {
      org: "default",
      platform,
      workspace,
      surface,
      workspaceKey: `${platform}/${workspace}`,
      surfaceKey,
      domainKey: surfaceKey,
      key: surfaceKey,
    },
    {
      id,
      org: "default",
      surfaceKey,
      target: { channelId },
      trigger: { kind: "once", at: dueAt },
      prompt: "say nothing of consequence; this fire exists to drive one turn",
      createdBy: "U0EVEPATCHGATE",
      status: "active",
      nextRunAt: dueAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      consecutiveFailures: 0,
    },
  );
  return id;
}

test("§1 the turn gate's hook RUNS when a real fire drives a turn", async () => {
  await bootAgent({ sharedSqlite: true });
  disposeLater(registerScript({ parent: [{ say: "eve patch gate probe turn" }] }));

  const routineId = await seedDueRoutine("slack/T0EVEPATCH/C0EVEPATCH", "C0EVEPATCH");
  expect(routineId).toMatch(/^r-it-epg-/);

  _resetEvePatchTurnCheckForTest();
  expect(evePatchTurnCheckHasPassed(), "the trace is clear before the fire — otherwise §1 proves nothing").toBe(false);

  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length, "the dispatch tick started at least one session").toBeGreaterThan(0);

  await waitFor(
    async () => evePatchTurnCheckHasPassed() || undefined,
    "hooks/eve-patch-gate.ts's turn.started handler to run on the real host. Never true means the hook " +
      "is not mounted or not reached, so the unpatched-eve refusal is unreachable at the turn edge",
  );
  expect(evePatchTurnCheckHasPassed()).toBe(true);
});

test("§2 the gate passes on THIS host because eve's own installed bytes publish every marker", async () => {
  await bootAgent({ sharedSqlite: true });
  const missing = EVE_PATCH_PARTS.filter((p) => (globalThis as Record<string, unknown>)[p.marker] !== true);
  expect(missing.map((p) => `part ${p.part}/${p.marker}`), "every live patch part publishes its marker on this host").toEqual([]);
  expect(EVE_PATCH_PARTS.map((p) => p.part), "exactly parts 1 and 4 are declared live").toEqual([1, 4]);
});
