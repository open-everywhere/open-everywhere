import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  disposeLater,
  discordMentionWake,
  registerScript,
  rowsSinceCursor,
  seatReply,
  WAKE_FROM_ENVELOPE,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type AuditRow,
} from "../harness";
import { installDiscordWebApiStub } from "../discord-web-api";

const IT_MEMORY_RELAY_CHANNEL_ID = "1300000001500000011";
const DISCORD_BOT_ID = "9000000000000000001";
const ORG = "default";
const SILO = "it-memory-brain";

function siloFilePath(silo: string, rel: string): string {
  const dir = process.env.OE_MEMORY_DIR;
  if (!dir) throw new Error("write-intent relay test: OE_MEMORY_DIR is not set — call siloFilePath() after bootAgent().");
  return join(dir, ORG, "@silos", silo, rel);
}

const CLAIM = "It's now in durable notes and the curated memory index.";

const WITHHELD_OPENING = "I can't confirm that's saved yet";

const discord = installDiscordWebApiStub({ captureMessages: true });
afterAll(() => discord.uninstall());

test("a delegated remember-ask's settlement report posts AFTER its own memory write, and keeps its claim", async () => {
  await bootAgent({ stubbedProviderTransport: true });

  const marker = `shipit-${Date.now().toString(36)}`;
  const noteBody = `# Decisions\n\n- the release decision we made is ${marker}\n`;

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: `write the release decision ${marker} into memory` }, id: "wi-relay-delegate" }] },
        {
          calls: [
            {
              tool: "reply",
              input: {
                text: "I'm recording the release decision and will confirm once the memory write is complete.",
                wake: WAKE_FROM_ENVELOPE,
                done: false,
              },
              id: "wi-relay-interim",
            },
          ],
        },
        { say: "NO_REPLY" },
      ],
      child: [
        { delayMs: 120_000, calls: [{ tool: "write_file", input: { filePath: `/workspace/memory/${SILO}/decisions.md`, content: noteBody }, id: "wi-relay-write" }] },
        { say: "the decision is written" },
      ],
    }),
  );

  const cursor = await auditCursor();
  await discordMentionWake({
    channelId: IT_MEMORY_RELAY_CHANNEL_ID,
    text: `<@${DISCORD_BOT_ID}> remember: the release decision we made is ${marker}`,
  });

  const resumed = await waitFor(
    () => dispatched.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "work")),
    "the parent's resumed step carrying the forward receipt",
  );
  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(resumed.toolResults.find((t) => t.name === "work")!.isError).toBe(false);

  const interim = await waitFor(
    () => dispatched.requests.flatMap((r) => r.toolResults).find((t) => t.id === "wi-relay-interim"),
    "the interim reply's own result",
  );
  expect(interim.isError, `the interim reply was refused: ${JSON.stringify(interim.output)}`).toBe(false);
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the worker to enter its hold" });
  const settlement = disposeLater(armSettlement(dispatched, { parent: [seatReply(`The decision ${marker} is recorded. ${CLAIM}`, "wi-relay-report"), { say: "NO_REPLY" }] }));
  const taskId = await workTaskIdOfCall(cursor, dispatched, "wi-relay-delegate", "the memory-write forward");
  dispatched.releaseHolds();

  await waitForChildren(dispatched, { count: 1, lastStepIndex: 1, label: "the delegated worker to finish its last scripted step" });
  const childTerminal = dispatched.requests.filter((r) => r.role === "child").at(-1);
  if (!childTerminal) throw new Error("write-intent relay test: no child request recorded — the delegation never ran");
  expect(childTerminal.toolResults.find((t) => t.name === "write_file")!.isError).toBe(false);

  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "the seat's result-wake step" });
  expect(resultStep.fault).toBeUndefined();
  expect(resultStep.turnId, "the result arrives in a NEW seat turn: the dispatch turn ended at the receipt").not.toBe(resumed.turnId);
  expect(resultStep.stepIndex, "the report is served WITH the result, at step 0 of the result-wake turn").toBe(0);

  const settledRow = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["delegation.task_settled"])).find((r) => (r.detail as { task?: string }).task === taskId),
    "the task's delegation.task_settled row — the lower bound of the report",
  );

  const reportPost = await waitFor(async () => {
    const posts = (await rowsSinceCursor(cursor, ["reply.post"])).filter(
      (r) => (r.detail as { route?: string }).route === "tool" && r.seq > settledRow.seq,
    );
    return posts.length > 0 ? posts[posts.length - 1] : undefined;
  }, "the report's own reply.post row, posted through the reply tool");

  const notePath = siloFilePath(SILO, "decisions.md");
  await waitFor(() => (existsSync(notePath) ? true : undefined), "the delegated worker's write to land on the DURABLE store");
  expect(readFileSync(notePath, "utf-8")).toContain(marker);

  const writes = (await rowsSinceCursor(cursor, ["memory.write"])).filter((r) => {
    const d = r.detail as { silo?: string };
    return d.silo === SILO && r.seq > settledRow.seq;
  });
  expect(writes.length).toBeGreaterThan(0);
  const earliest = writes.reduce((a: AuditRow, b: AuditRow) => (a.seq <= b.seq ? a : b));
  expect(earliest.seq).toBeGreaterThan(settledRow.seq);
  expect(earliest.seq).toBeLessThan(reportPost.seq);
  expect((earliest.detail as { kind?: string }).kind).toBe("memory");

  const delivered = discord.messages.filter((m) => m.channelId === IT_MEMORY_RELAY_CHANNEL_ID);
  expect(delivered.length).toBeGreaterThanOrEqual(2);
  const report = delivered[delivered.length - 1]!;
  expect(report.content).toContain(CLAIM);
  expect(report.content).toContain(marker);
  expect(report.content).not.toContain(WITHHELD_OPENING);

  const withheld = (await rowsSinceCursor(cursor, ["memory.claim_withheld"])).filter((r) => r.seq > settledRow.seq);
  expect(withheld).toEqual([]);

  const { applyMemoryClaimGuard } = await import("@open-everywhere/core/agent/channels/memory-claim-guard.js");
  expect(applyMemoryClaimGuard(CLAIM, false).withheld.length).toBe(1);
  expect(applyMemoryClaimGuard(CLAIM, true).withheld.length).toBe(0);
});
