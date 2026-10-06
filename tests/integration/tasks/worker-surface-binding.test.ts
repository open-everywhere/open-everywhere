import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  afterThisTest,
  armSettlement,
  auditCursor,
  disposeLater,
  awaitWorkResult,
  bootAgent,
  discordMentionWake,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  rowsSinceCursor,
  toolSessionIdentity,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  wrapToolExecute,
  type ToolSessionIdentity,
} from "../harness";

interface SeenBinding {
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly channelId: unknown;
  readonly identity: ToolSessionIdentity | undefined;
}

test("a delegated worker's post_file resolves the dispatching conversation's channel", async () => {
  await bootAgent();

  const seen: SeenBinding[] = [];
  const { bindFrom } = await import("@open-everywhere/core/agent/identity/binding.js");
  afterThisTest(
    wrapToolExecute("post_file", async (_input: unknown, ctx: unknown) => {
      const b = bindFrom(ctx as Parameters<typeof bindFrom>[0]);
      seen.push({
        platform: b.platform,
        workspace: b.workspace,
        surface: b.surface,
        channelId: b.target?.["channelId"],
        identity: toolSessionIdentity(),
      });
      return { posted: true, count: 1, platform: b.platform };
    }),
  );

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "write flip-probe.txt and post it here" }, id: "ope602-delegate" }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [
        {
          delayMs: 120_000,
          calls: [
            {
              tool: "post_file",
              input: { files: [{ source: { path: "flip-probe.txt" }, filename: "flip-probe.txt" }], comment: "here it is" },
              id: "ope602-post",
            },
          ],
        },
        { say: "posted the file" },
      ],
    }),
  );

  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> write a file and post it" });

  const receiptStep = await waitFor(
    () => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    "the dispatch turn's receipt step to be served",
  );
  const settlement = disposeLater(armSettlement(dispatched, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, dispatched, "ope602-delegate", "the OPE-602 forward");
  dispatched.releaseHolds();
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 1, label: "the delegated worker to serve its whole arm" });
  await waitFor(() => (dispatched.holdsCutShort() === 1 ? true : undefined), "the worker's hold ended on the release, not on its 120 s backstop");
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "the seat step that read the worker's result" });
  expect(resultStep.stepIndex).toBe(0);
  expect(resultStep.turnId, "the result arrives in a seat turn of its own (OPE-2338)").not.toBe(receiptStep.turnId);
  for (const h of [dispatched, settlement]) {
    expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(h.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  }

  expect(seen.length).toBe(1);
  const worker = seen[0]!;
  expect(worker.platform).toBe("discord");
  expect(worker.workspace).toBe(DISCORD_GUILD_ID);
  expect(worker.surface).toBe(DISCORD_LISTED_CHANNEL_ID);
  expect(worker.channelId).toBe(DISCORD_LISTED_CHANNEL_ID);

  const identity = worker.identity;
  expect(
    identity,
    "toolSessionIdentity() returned undefined inside the worker's post_file call — the harness reach " +
      "into eve's context container is broken, not the product. Check harness.ts's " +
      "sandboxIdentityKeyNames against eve's context/keys.js.",
  ).toBeDefined();
  const dispatchStep = dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  const seatSessionId = String(dispatchStep.sessionId);
  const started = (await rowsSinceCursor(cursor, ["delegation.task_started"], { limit: 200 })).find((r) => r.detail?.task === taskId);
  const workSessionId = String(started?.detail?.session);
  expect(typeof started?.detail?.session).toBe("string");
  expect(workSessionId).not.toBe(seatSessionId);
  expect(identity!.sessionId).not.toBe(seatSessionId);
  expect(identity!.sessionId).not.toBe(workSessionId);
  expect(identity!.parentSessionId).toBe(workSessionId);
});
