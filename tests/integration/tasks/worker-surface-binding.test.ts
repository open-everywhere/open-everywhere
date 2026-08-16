import { afterAll, afterEach, expect, test } from "vitest";
import {
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  waitForChildren,
  wrapToolExecute,
  type ScriptedHandle,
} from "../harness";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

const perTest: (() => void)[] = [];
afterEach(() => {
  for (const c of perTest.splice(0)) c();
});

function disposeLater(handle: ScriptedHandle): ScriptedHandle {
  perTest.push(() => handle.dispose());
  return handle;
}

interface SeenBinding {
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly channelId: unknown;
}

test("a delegated worker's post_file resolves the dispatching conversation's channel", async () => {
  await bootAgent();

  const seen: SeenBinding[] = [];
  const { bindFrom } = await import("@open-everywhere/core/agent/identity/binding.js");
  cleanups.push(
    wrapToolExecute("post_file", async (_input: unknown, ctx: unknown) => {
      const b = bindFrom(ctx as Parameters<typeof bindFrom>[0]);
      seen.push({ platform: b.platform, workspace: b.workspace, surface: b.surface, channelId: b.target?.["channelId"] });
      return { posted: true, count: 1, platform: b.platform };
    }),
  );

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "write flip-probe.txt and post it here" }, id: "ope602-delegate" }] },
        { say: "handing this off" },
      ],
      child: [
        {
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

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> write a file and post it" });

  await waitForChildren(dispatched, { count: 1, lastStepIndex: 1, label: "the delegated worker to serve its whole arm" });
  const taskId = taskIdOfDelegation(dispatched, "the OPE-602 delegation");
  const { handle: drain } = await awaitTaskSettlement({
    dispatched,
    taskId,
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: "the settled worker's completion wake",
  });
  perTest.push(() => drain.dispose());
  expect(drain.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  expect(seen.length).toBe(1);
  const worker = seen[0]!;
  expect(worker.platform).toBe("discord");
  expect(worker.workspace).toBe(DISCORD_GUILD_ID);
  expect(worker.surface).toBe(DISCORD_LISTED_CHANNEL_ID);
  expect(worker.channelId).toBe(DISCORD_LISTED_CHANNEL_ID);
});
