import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

import {
  auditCursor,
  awaitTaskSettlement,
  bootAgent,
  disposeLater,
  discordMentionWake,
  registerScript,
  rowsSinceCursor,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
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

const WITHHELD_OPENING = "No durable memory write is recorded for this turn";

const discord = installDiscordWebApiStub({ captureMessages: true });
afterAll(() => discord.uninstall());

test("a delegated remember-ask's settlement report posts AFTER its own memory write, and keeps its claim", async () => {
  await bootAgent({ stubbedProviderTransport: true });

  const marker = `shipit-${Date.now().toString(36)}`;
  const noteBody = `# Decisions\n\n- the release decision we made is ${marker}\n`;

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: `write the release decision ${marker} into memory` }, id: "wi-relay-delegate" }] },
        { say: "I'm recording the release decision and will confirm once the memory write is complete." },
      ],
      child: [
        { calls: [{ tool: "write_file", input: { filePath: `/workspace/memory/${SILO}/decisions.md`, content: noteBody }, id: "wi-relay-write" }] },
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
    () => dispatched.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "agent")),
    "the parent's resumed step carrying the delegation result",
  );
  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(resumed.toolResults.find((t) => t.name === "agent")!.isError).toBe(false);

  await waitForChildren(dispatched, { count: 1, lastStepIndex: 1, label: "the delegated worker to finish its last scripted step" });
  const childTerminal = dispatched.requests.filter((r) => r.role === "child").at(-1);
  if (!childTerminal) throw new Error("write-intent relay test: no child request recorded — the delegation never ran");
  expect(childTerminal.toolResults.find((t) => t.name === "write_file")!.isError).toBe(false);

  const taskId = taskIdOfDelegation(dispatched, "the memory-write delegation");
  const settlement = await awaitTaskSettlement({
    dispatched,
    taskId,
    script: { parent: [{ say: `The decision ${marker} is recorded. ${CLAIM}` }] },
    label: "the worker's completion, delivered as a new message naming the task id",
  });
  disposeLater(settlement.handle);
  expect(settlement.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const taskWake = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["unified.task_wake"]);
    return rows.find((r) => {
      const d = r.detail as { task?: string; outcome?: string };
      return d.task === taskId && d.outcome === "installed";
    });
  }, "the settlement turn's task-wake install row — the row that names the turn the report is posted on");
  const reportTurnId = (taskWake.detail as { turnId?: string }).turnId;
  expect(typeof reportTurnId).toBe("string");

  const bridgePost = await waitFor(async () => {
    const posts = (await rowsSinceCursor(cursor, ["reply.post"])).filter(
      (r) => (r.detail as { route?: string }).route === "bridge" && r.seq > taskWake.seq,
    );
    return posts.length > 0 ? posts[posts.length - 1] : undefined;
  }, "the settlement report's own reply.post row, posted through the addressed-mention bridge");

  const notePath = siloFilePath(SILO, "decisions.md");
  await waitFor(() => (existsSync(notePath) ? true : undefined), "the delegated worker's write to land on the DURABLE store");
  expect(readFileSync(notePath, "utf-8")).toContain(marker);

  const writes = (await rowsSinceCursor(cursor, ["memory.write"])).filter((r) => {
    const d = r.detail as { silo?: string; outcome?: string };
    return d.silo === SILO && d.outcome === "write-intent";
  });
  expect(writes.length).toBeGreaterThan(0);
  const earliest = writes.reduce((a: AuditRow, b: AuditRow) => (a.seq <= b.seq ? a : b));
  expect(earliest.seq).toBeGreaterThan(taskWake.seq);
  expect(earliest.seq).toBeLessThan(bridgePost.seq);
  expect((earliest.detail as { kind?: string }).kind).toBe("memory");

  const delivered = discord.messages.filter((m) => m.channelId === IT_MEMORY_RELAY_CHANNEL_ID);
  expect(delivered.length).toBeGreaterThanOrEqual(2);
  const report = delivered[delivered.length - 1]!;
  expect(report.content).toContain(CLAIM);
  expect(report.content).toContain(marker);
  expect(report.content).not.toContain(WITHHELD_OPENING);

  const withheld = (await rowsSinceCursor(cursor, ["memory.claim_withheld"])).filter((r) => r.seq > taskWake.seq);
  expect(withheld).toEqual([]);

  const { applyMemoryClaimGuard } = await import("@open-everywhere/core/agent/channels/memory-claim-guard.js");
  expect(applyMemoryClaimGuard(CLAIM, false).withheld.length).toBe(1);
  expect(applyMemoryClaimGuard(CLAIM, true).withheld.length).toBe(0);
});
