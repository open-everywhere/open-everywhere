import { afterAll, beforeAll, expect, test } from "vitest";
import {
  auditCursor,
  bootAgent,
  disposeLater,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  seedDueRoutine,
  taskIdOfDelegation,
  awaitTaskSettlement,
  SETTLEMENT_DRAIN_SCRIPT,
  waitFor,
  waitForAuditRows,
  waitForChildren,
  SLACK_TEAM_ID,
  type AuditCursor,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";

const ORG = "default";
const TRIGGER = { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } as const;

const cleanups: (() => void)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0)) c();
  await setHalt(false);
});

async function setHalt(on: boolean): Promise<void> {
  const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
  const store = getOperationalStore();
  if (on) await store.setHalt(ORG, { orgWide: true }, { setBy: "U-operator" });
  else await store.clearHalt(ORG, { orgWide: true }, { clearedBy: "U-operator" });
  const active = await store.activeHalts(ORG);
  expect(active.some((r) => r.address.orgWide === true)).toBe(on);
}

beforeAll(async () => {
  await bootAgent({ sharedSqlite: true });
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ approvals: { judgeMode: "off" } });
  expect(settings.getSettings().approvals.judgeMode).toBe("off");
  await setHalt(false);
});

interface Driven {
  readonly handle: ScriptedHandle;
  readonly cursor: AuditCursor;
}

async function driveProposal(ids: string, prompt: string): Promise<Driven> {
  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "set up the routine I asked for" }, id: `${ids}-delegate` }] },
        { say: "the worker reported back" },
      ],
      child: [{ calls: [{ tool: "create_routine", input: { prompt, trigger: TRIGGER }, id: `${ids}-routine` }] }, { say: "proposed" }],
    }),
  );
  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please set up the routine" });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${ids}: the parent's terminal step`);
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `${ids}: the worker's terminal step` });
  const drained = await awaitTaskSettlement({
    dispatched: handle,
    taskId: taskIdOfDelegation(handle, `the ${ids} delegation`),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: `${ids}: the worker's settlement wake`,
  });
  drained.handle.dispose();
  return { handle, cursor };
}

async function chainRow(cursor: AuditCursor): Promise<AuditRow> {
  return waitForAuditRows({
    probe: async () => {
      const rows = await rowsSinceCursor(cursor, ["approval.chain"]);
      return rows.find((r) => r.detail?.["tool"] === "create_routine");
    },
    label: "the approval.chain row for create_routine",
    actions: ["approval.chain"],
    cursor,
    kind: "routine.create",
  });
}

test("① under an active halt, a real turn's gated propose is DENIED by the mode:HALT arrow — no card, no routine", async () => {
  await setHalt(true);
  const { cursor } = await driveProposal("halted", `halted proposal ${Date.now()}`);

  const row = await chainRow(cursor);
  expect(row.detail?.["verdict"]).toBe("deny");
  const transforms = row.detail?.["transforms"] as { name: string; reason?: string }[] | undefined;
  expect(transforms?.some((t) => t.name === "mode:HALT" && t.reason === "halt")).toBe(true);

  const requested = await rowsSinceCursor(cursor, ["approval.requested"]);
  expect(requested.filter((r) => r.detail?.["kind"] === "routine.create")).toEqual([]);
});

test("② NEGATIVE CONTROL: with the halt cleared, the identical proposal is not denied by the halt", async () => {
  await setHalt(false);
  const { cursor } = await driveProposal("clear", `clear proposal ${Date.now()}`);

  const row = await chainRow(cursor);
  const transforms = row.detail?.["transforms"] as { name: string }[] | undefined;
  expect(transforms?.some((t) => t.name === "mode:HALT")).toBe(false);
  expect(row.detail?.["verdict"]).not.toBe("deny");
});

test("③ under an active halt, a DUE routine does not fire on the clock leg, and the skip is audited `halted`", async () => {
  await setHalt(true);
  const surfaceKey = `slack/${SLACK_TEAM_ID}/C-halt-clock`;
  const cursor = await auditCursor();
  const id = await seedDueRoutine({
    surfaceKey,
    channelId: "C-halt-clock",
    prompt: "the halted routine",
    createdBy: "U1",
    org: ORG,
  });

  const sessions = await runRoutineDispatchTick();
  expect(sessions).toEqual([]);

  const { ROUTINE_AUDIT } = await import("@open-everywhere/core/agent/routines/fire-audit.js");
  const skip = await waitForAuditRows({
    probe: async () => {
      const rows = await rowsSinceCursor(cursor, [ROUTINE_AUDIT.skip]);
      return rows.find((r) => r.detail?.["routineId"] === id);
    },
    label: `the ${ROUTINE_AUDIT.skip} row for the halted fire`,
    actions: [ROUTINE_AUDIT.skip],
    cursor,
  });
  expect(skip.detail?.["reason"]).toBe("halted");
});

test("④ NEGATIVE CONTROL: the same due routine fires once the halt is lifted", async () => {
  await setHalt(false);
  const surfaceKey = `slack/${SLACK_TEAM_ID}/C-halt-clock2`;
  const id = await seedDueRoutine({
    surfaceKey,
    channelId: "C-halt-clock2",
    prompt: "the resumed routine",
    createdBy: "U1",
    org: ORG,
  });
  disposeLater(registerScript({ parent: [{ say: "fired" }] }));

  const cursor = await auditCursor();
  const sessions = await runRoutineDispatchTick();
  expect(sessions.length).toBeGreaterThan(0);
  const { ROUTINE_AUDIT } = await import("@open-everywhere/core/agent/routines/fire-audit.js");
  const fired = await waitForAuditRows({
    probe: async () => {
      const rows = await rowsSinceCursor(cursor, [ROUTINE_AUDIT.fire, ROUTINE_AUDIT.skip], { limit: 100 });
      return rows.find((r) => r.detail?.["routineId"] === id);
    },
    label: `an audit row for the resumed routine ${id}`,
    actions: [ROUTINE_AUDIT.fire, ROUTINE_AUDIT.skip],
    cursor,
  });
  expect(fired.action).toBe(ROUTINE_AUDIT.fire);
});

test("⑤ the control plane's own transport and the operational store SURVIVE an egress halt", async () => {
  await setHalt(true);
  const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
  expect((await getOperationalStore().activeHalts(ORG)).some((r) => r.address.orgWide)).toBe(true);

  const rows = await readAuditRows({ actions: ["approval.chain"], sinceIso: new Date(Date.now() - 3_600_000).toISOString(), limit: 100 });
  expect(rows.some((r) => r.detail?.["tool"] === "create_routine")).toBe(true);

  await setHalt(false);
  expect((await getOperationalStore().activeHalts(ORG)).some((r) => r.address.orgWide)).toBe(false);
});
