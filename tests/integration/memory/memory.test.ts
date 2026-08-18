import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type ScriptedHandle,
} from "../harness";

async function resolveApprovalClickDynamic(input: {
  org: string;
  id: string;
  decision: "approve" | "reject" | "approve_session";
  clickerId: string;
}) {
  const { resolveApprovalClick } = await import("@open-everywhere/core/agent/approvals/flow.js");
  return resolveApprovalClick(input);
}

async function ensureConfigRegistered(): Promise<void> {
  await import("../../../agent/lib/register-config.js");
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ egress: { allowUnenforced: true } });
}

const IT_MEMORY_CHANNEL_ID = "1300000001500000001";
const IT_MEMORY_PURGE_CHANNEL_ID = "1300000001500000003";
const DISCORD_BOT_ID = "9000000000000000001";

const perTest: (() => void)[] = [];
afterEach(() => {
  for (const c of perTest.splice(0)) c();
});

function disposeLater(handle: ScriptedHandle): ScriptedHandle {
  perTest.push(() => handle.dispose());
  return handle;
}

const ORG = "default";

function siloFilePath(silo: string, rel: string): string {
  const dir = process.env.OE_MEMORY_DIR;
  if (!dir) throw new Error("memory test: OE_MEMORY_DIR is not set — call siloFilePath() after bootAgent().");
  return join(dir, ORG, "@silos", silo, rel);
}

async function frozenSiloFilePath(silo: string, rel: string): Promise<string> {
  const { storeRoot } = await import("@open-everywhere/core/agent/memory/store.js");
  return join(storeRoot(), ORG, "@silos", silo, rel);
}

test("session.started seeds the domain's own silo at the expected path and body, never a sibling domain's silo, and a delegated write_file call does not error", async () => {
  await bootAgent({ sharedSqlite: true });

  const sinceIso = new Date(Date.now() - 1_000).toISOString();
  const marker = `IT-MEMORY-FACT-${Date.now()}`;
  const content = `# Notes\n\n- ${marker}: integration coverage sentinel for OPE-551\n`;

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "note this down" }, id: "m1-delegate" }] },
        { say: "the worker reported back" },
      ],
      child: [{ calls: [{ tool: "write_file", input: { filePath: "/workspace/memory/it-memory-brain/notes.md", content }, id: "m1-write" }] }, { say: "noted" }],
    }),
  );

  await discordMentionWake({ channelId: IT_MEMORY_CHANNEL_ID, text: `<@${DISCORD_BOT_ID}> please note this` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the parent's terminal step to be served");
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: "the delegated worker's own terminal step" });

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.resolves.filter((r) => r.fault !== undefined)).toEqual([]);

  const writeResult = handle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "write_file");
  expect(writeResult).toBeDefined();
  expect(writeResult!.isError).toBe(false);

  const taskId = taskIdOfDelegation(handle, "the note-taking delegation");
  const settlement = await awaitTaskSettlement({
    dispatched: handle,
    taskId,
    script: {
      parent: [{ calls: [{ tool: "task_peek", input: { taskIds: [taskId] }, id: "m1-peek" }] }, { say: "noted" }],
    },
    label: "the worker's completion, delivered as a new message naming the task id",
  });
  perTest.push(() => settlement.handle.dispose());
  const peeked = await waitFor(
    () => settlement.handle.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "task_peek")),
    "the parent's step carrying the task_peek result — the edge the settlement flush hangs off",
  );
  expect(peeked.toolResults.find((t) => t.name === "task_peek")!.isError).toBe(false);
  expect(settlement.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const notesPath = siloFilePath("it-memory-brain", "notes.md");
  await waitFor(() => (existsSync(notesPath) ? true : undefined), "the delegated child's write_file to land on the DURABLE store via the settlement flush");
  expect(readFileSync(notesPath, "utf-8")).toContain(marker);

  const writeRows = await readAuditRows({ actions: ["memory.write"], sinceIso });
  const settled = writeRows.filter((r) => (r.detail as { outcome?: string; silo?: string }).outcome === "settled" && (r.detail as { silo?: string }).silo === "it-memory-brain");
  expect(settled.length).toBeGreaterThan(0);

  const seedPath = siloFilePath("it-memory-brain", "MEMORY.md");
  await waitFor(() => (existsSync(seedPath) ? true : undefined), "the it-memory-brain silo's seed to land on the durable store");
  const seedBody = readFileSync(seedPath, "utf-8");
  expect(seedBody).toContain('# Memory silo — "it-memory-brain"');
  expect(seedBody).toContain("A shared brain.");

  const bDir = siloFilePath("it-memory-b-brain", "");
  expect(existsSync(bDir)).toBe(false);

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});

test("purge_memory proposes a card under the egress spoof and redacts the fact on the approval-equivalent decide path, leaving only digests behind", async () => {
  await bootAgent({ sharedSqlite: true });
  await ensureConfigRegistered();

  rmSync(await frozenSiloFilePath("it-memory-brain", ""), { recursive: true, force: true });

  const bullet = "- PURGE-TARGET-p1: the sentinel fact for OPE-551's redaction proof";
  const fixture = `# Purge fixture\n\n${bullet}\n`;

  const hostPath = siloFilePath("it-memory-brain", "purge-fixture.md");
  mkdirSync(dirname(hostPath), { recursive: true });
  writeFileSync(hostPath, fixture, "utf-8");

  const frozenHostPath = await frozenSiloFilePath("it-memory-brain", "purge-fixture.md");
  mkdirSync(dirname(frozenHostPath), { recursive: true });
  writeFileSync(frozenHostPath, fixture, "utf-8");

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "erase that test fact" }, id: "m2-delegate" }] },
        { say: "the worker reported back" },
      ],
      child: [{ calls: [{ tool: "purge_memory", input: { match: "PURGE-TARGET-p1" }, id: "m2-purge" }] }, { say: "purge requested" }],
    }),
  );

  const wakeAt = Date.now();
  await discordMentionWake({ channelId: IT_MEMORY_PURGE_CHANNEL_ID, text: `<@${DISCORD_BOT_ID}> please erase that test fact` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the parent's terminal step to be served");
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: "the purging worker's own terminal step" });
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.resolves.filter((r) => r.fault !== undefined)).toEqual([]);

  const purgeResult = handle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "purge_memory");
  expect(purgeResult).toBeDefined();
  expect(purgeResult!.isError).toBe(false);
  const output = (purgeResult!.output ?? {}) as Record<string, unknown>;
  expect(output["requested"]).toBe(true);
  expect(output["autoApproved"]).toBeUndefined();
  const pendingId = output["pendingId"];
  expect(typeof pendingId).toBe("string");

  const drained = await awaitTaskSettlement({
    dispatched: handle,
    taskId: taskIdOfDelegation(handle, "the purge delegation"),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: "the purging worker's settlement wake",
  });
  expect(drained.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  drained.handle.dispose();

  const sinceIso = new Date(wakeAt - 1_000).toISOString();

  const requested = await waitFor(async () => {
    const got = await readAuditRows({ actions: ["approval.requested", "approval.expired"], sinceIso, limit: 50 });
    return got.find((r) => r.ts && new Date(r.ts).getTime() >= wakeAt && r.action === "approval.requested" && r.detail?.kind === "memory.purge");
  }, "the approval.requested row for memory.purge to land");
  expect(requested!.detail?.id).toBe(pendingId);
  const expiredRows = await readAuditRows({ actions: ["approval.expired"], sinceIso, limit: 50 });
  expect(expiredRows.filter((r) => new Date(r.ts).getTime() >= wakeAt).map((r) => r.detail?.cause)).toEqual([]);

  expect(readFileSync(hostPath, "utf-8")).toContain("PURGE-TARGET-p1");

  const resolution = await resolveApprovalClickDynamic({
    org: ORG,
    id: String(pendingId),
    decision: "approve",
    clickerId: "discord/9000000000000000042",
  });
  expect(resolution.outcome).toBe("decided");
  if (resolution.outcome !== "decided") throw new Error("unreachable — asserted above");
  expect(resolution.outcomeLine).toContain("purged 1 line(s)");
  expect(resolution.outcomeLine).toContain("silo:it-memory-brain/purge-fixture.md");

  const afterPurge = readFileSync(frozenHostPath, "utf-8");
  expect(afterPurge).not.toContain("PURGE-TARGET-p1");
  expect(afterPurge).not.toContain(bullet);
  expect(afterPurge).toContain("# Purge fixture");

  const purgeRows = await readAuditRows({ actions: ["memory.purge", "approval.approved"], sinceIso, limit: 50 });
  const thisTurn = purgeRows.filter((r) => new Date(r.ts).getTime() >= wakeAt);
  expect(thisTurn.length).toBeGreaterThan(0);
  for (const row of thisTurn) {
    const blob = JSON.stringify(row.detail ?? {});
    expect(blob).not.toContain("PURGE-TARGET-p1");
    expect(blob).not.toContain("the sentinel fact for OPE-551");
    if (row.action === "memory.purge") {
      const bullets = row.detail?.bullets as { sha256?: string }[] | undefined;
      expect(bullets?.length).toBeGreaterThan(0);
      expect(typeof bullets?.[0]?.sha256).toBe("string");
    }
  }
});

test("OPE-727 — a dispatch handle left registered past its own turn FAULTS a second, different turn's call, never mints a phantom dispatch", async () => {
  await bootAgent({ sharedSqlite: true });

  const handle = registerScript({
    parent: [{ calls: [{ tool: "agent", input: { message: "do the thing" }, id: "stale-delegate" }] }, { say: "dispatched" }],
    child: [{ say: "done" }],
  });

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@${DISCORD_BOT_ID}> please do the thing` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the dispatch turn's own terminal step to be served");
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the delegated worker's own (single) step" });

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const dispatchTurnId = handle.requests[0]?.turnId;
  const taskId = taskIdOfDelegation(handle, "the dispatch");

  const phantom = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.turnId !== dispatchTurnId && r.messages.some((m) => m.text.includes(taskId))),
    "a settlement-turn request to land on the still-registered dispatch handle",
    90_000,
  );

  expect(phantom.fault).toBeDefined();
  expect(phantom.fault).toContain("stale script");
  expect(phantom.fault).toContain(`turn "${dispatchTurnId}"`);
  expect(phantom.fault).toContain(`turn "${phantom.turnId}"`);
  expect(phantom.stepIndex).toBe(-1);

  const agentTaskIds = new Set(
    handle.requests
      .flatMap((r) => r.toolResults)
      .filter((t) => t.name === "agent")
      .map((t) => (t.output as { taskId?: unknown } | undefined)?.taskId),
  );
  expect(agentTaskIds).toEqual(new Set([taskId]));
  expect(handle.requests.filter((r) => r.turnId === phantom.turnId)).toHaveLength(1);

  handle.dispose();
});

test("OPE-727 negative control — the documented dispose-and-re-register pattern (awaitTaskSettlement's own shape) is unaffected by the guard", async () => {
  await bootAgent({ sharedSqlite: true });

  const dispatched = registerScript({
    parent: [{ calls: [{ tool: "agent", input: { message: "do the thing" }, id: "proper-delegate" }] }, { say: "dispatched" }],
    child: [{ say: "done" }],
  });

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@${DISCORD_BOT_ID}> please do the thing, properly this time` });
  await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the dispatch turn's own terminal step to be served");
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the delegated worker's own (single) step" });
  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const taskId = taskIdOfDelegation(dispatched, "the dispatch");

  dispatched.dispose();
  const settlement = registerScript({ parent: [{ calls: [{ tool: "task_peek", input: { taskIds: [taskId] }, id: "proper-peek" }] }, { say: "noted" }] });
  const settled = await waitFor(
    () => settlement.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes(taskId))),
    "the settlement notification to be served by the freshly-registered entry",
  );
  expect(settled.fault).toBeUndefined();
  expect(settled.stepIndex).toBe(0);
  expect(settlement.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  settlement.dispose();
});
