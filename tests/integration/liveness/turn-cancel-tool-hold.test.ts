import { expect, test } from "vitest";

import {
  afterThisTest,
  auditCursor,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  discordOeCommandPost,
  discordOeStopInteraction,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  sleep,
  waitFor,
  wrapToolExecute,
} from "../harness";

const STOPPER_ID = "9000000000000000078";

const RAN_TOOL = "todo";

const HELD_TOOL = "update_status";

const HOLD_MS = 90_000;

const SETTLE_MS = 500;

test("a stop that lands while the second tool of a step is still running still names the first", async () => {
  await bootAgent();
  const cursor = await auditCursor();

  let heldEnteredAt: number | undefined;
  let released = false;
  afterThisTest(() => {
    released = true;
  });
  afterThisTest(
    wrapToolExecute(HELD_TOOL, async (...args: unknown[]) => {
      heldEnteredAt = Date.now();
      const signal = (args[1] as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      const deadline = Date.now() + HOLD_MS;
      while (!released && Date.now() < deadline && signal?.aborted !== true) await sleep(50);
      return { updated: true, state: "working" };
    }),
  );

  const handle = disposeLater(
    registerScript({
      parent: [
        {
          calls: [
            { tool: RAN_TOOL, input: { todos: [{ content: "ope-772 finished work", priority: "high", status: "in_progress" }] }, id: "ope772-ran" },
            { tool: HELD_TOOL, input: { state: "working", summary: "ope-772 work that is still running" }, id: "ope772-held" },
          ],
        },
        { say: "this sentence is never posted — the turn is cancelled inside step 0" },
      ],
    }),
  );

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> run both of those",
    messageId: "ope772-hold-wake",
  });

  const enteredAt = await waitFor(() => heldEnteredAt, `the ${HELD_TOOL} execution held open — the state the stop must land in`);
  expect(handle.requests).toHaveLength(1);
  expect(handle.requests[0]!.stepIndex).toBe(0);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.requests[0]!.tools).toContain(RAN_TOOL);
  expect(handle.requests[0]!.tools).toContain(HELD_TOOL);
  while (Date.now() - enteredAt < SETTLE_MS) await sleep(50);

  const stop = await discordOeCommandPost(discordOeStopInteraction({ channelId: DISCORD_LISTED_CHANNEL_ID, userId: STOPPER_ID }));
  expect(stop.status).toBe(200);
  expect(stop.body).toContain("Standing down");
  expect(stop.body).not.toContain("Nothing running here right now");

  const cancelled = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.cancelled"]);
    return rows.length > 0 ? rows : undefined;
  }, "the turn.cancelled row — written from the cancelled turn's OWN process");
  expect(cancelled).toHaveLength(1);
  const detail = cancelled[0]!.detail!;
  expect(detail.accounted).toBe(true);
  expect(detail.ran).toEqual([RAN_TOOL]);
  expect(detail.ran).not.toContain(HELD_TOOL);
  expect(detail.steps).toBe(0);

  released = true;

  const requested = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.cancel_requested"]);
    return rows.length > 0 ? rows : undefined;
  }, "the turn.cancel_requested row the ingress writes");
  expect(requested).toHaveLength(1);
  expect(requested[0]!.principalId).toBe(STOPPER_ID);
  expect(requested[0]!.detail?.outcome).toBe("requested");

  handle.dispose();
  const after = disposeLater(registerScript({ parent: [{ say: "understood — I will not redo that" }] }));
  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> what happened?",
    messageId: "ope772-hold-followup",
  });
  const next = await waitFor(
    () => after.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes("was CANCELLED"))),
    "the next turn's prompt carrying the cancel reconstruction",
  );
  const prompt = next.messages.map((m) => m.text).join("\n");
  expect(prompt).toContain(`\`${RAN_TOOL}\``);
  expect(prompt).toContain(`was CANCELLED by \`${STOPPER_ID}\``);
  expect(prompt).not.toContain("The cancel also discarded the record of what you had already done");
  expect(prompt).not.toContain("No tool had finished running");
  expect(prompt).not.toContain(`\`${HELD_TOOL}\``);
  expect(after.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});
