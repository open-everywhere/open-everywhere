import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
} from "../harness";

const ORG = "default";
const CHANNEL_ID = "1300000001500000013";
const SILO = "it-work-memory-brain";

function siloFilePath(rel: string): string {
  const dir = process.env.OE_MEMORY_DIR;
  if (!dir) throw new Error("work-settlement-flush: OE_MEMORY_DIR is not set — call siloFilePath() after bootAgent().");
  return join(dir, ORG, "@silos", SILO, rel);
}

test("W persists a job's memory edit at the job's settlement, before the result wake leaves for the seat", async () => {
  await bootAgent({ sharedSqlite: true });
  const cursor = await auditCursor();
  const marker = `OPE2341-W-FLUSH-${Date.now()}`;
  const file = `ope2341-${marker.toLowerCase()}.md`;
  const callId = "ope2341-flush-forward";

  const job = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "note this fact in the brain" }, id: callId }] }, { say: NO_REPLY_SENTINEL }],
      child: [
        { delayMs: 120_000, calls: [{ tool: "write_file", input: { filePath: `/workspace/memory/${SILO}/${file}`, content: `# Note\n\n- ${marker}\n` }, id: "ope2341-flush-write" }] },
        { say: "noted" },
      ],
    }),
  );
  await discordMentionWake({ channelId: CHANNEL_ID, text: "<@9000000000000000001> remember this fact", messageId: "ope2341-flush-wake" });
  await waitFor(() => job.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's receipt step");
  const settle = disposeLater(armSettlement(job, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  job.releaseHolds();
  await waitForChildren(job, { count: 1, lastStepIndex: 1, label: "the child to serve its whole arm" });
  const taskId = await workTaskIdOfCall(cursor, job, callId, "flush");
  await awaitWorkResult({ handle: settle, taskId, label: "the seat's result-wake step" });

  const flushRow = await waitFor(async () => (await rowsSinceCursor(cursor, ["memory.settlement_flush"])).find((r) => r.detail?.["edge"] === "task-settled" && r.detail?.["outcome"] === "flushed"), "a task-settled flush row");
  expect(Number((flushRow.detail?.["flush"] as { changed?: unknown } | undefined)?.changed ?? 0)).toBeGreaterThan(0);

  const wake = await waitFor(async () => (await rowsSinceCursor(cursor, ["work.result_wake"])).find((r) => r.detail?.["taskId"] === taskId), "the job's result-wake row");
  expect(wake.detail?.["outcome"]).toBe("delivered");
  const writes = (await rowsSinceCursor(cursor, ["memory.write"])).filter((r) => r.detail?.["silo"] === SILO && r.detail?.["outcome"] === "settled");
  expect(writes.length, "the settlement persist wrote the silo").toBeGreaterThan(0);
  const earliest = writes.reduce((a, b) => (a.seq <= b.seq ? a : b));
  expect(earliest.seq, "the job's memory write precedes its result wake").toBeLessThan(wake.seq);

  const path = siloFilePath(file);
  await waitFor(() => (existsSync(path) ? true : undefined), "the child's memory edit on the durable store");
  expect(readFileSync(path, "utf-8")).toContain(marker);
  for (const h of [job, settle]) expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});
