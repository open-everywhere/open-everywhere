import { afterAll, expect, test } from "vitest";

import {
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  taskIdOfDelegation,
  waitFor,
  type ScriptedHandle,
} from "../harness";

const live = new Set<ScriptedHandle>();
afterAll(() => {
  for (const h of live) h.dispose();
  live.clear();
});
function open(handle: ScriptedHandle): ScriptedHandle {
  live.add(handle);
  return handle;
}
function close(handle: ScriptedHandle): void {
  handle.dispose();
  live.delete(handle);
}

const QUESTION_PROMPT = "the runbook says to write into the shared bucket — should I use staging instead?";
const ANSWER_TEXT = "use staging, never the shared bucket";
const CHILD_DONE = "understood, wrote it to staging and finished";

test("a worker's question reaches the room, and the room's answer reaches the worker", async () => {
  await bootAgent();
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  const asking = open(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "write the report into the bucket" }, id: "t4-delegate" }] }, { say: "handing this off" }],
      child: [
        {
          calls: [
            {
              tool: "ask_question",
              input: { prompt: QUESTION_PROMPT, options: [{ id: "staging", label: "Use staging" }, { id: "shared", label: "Use the shared bucket" }] },
              id: "t4-ask",
            },
          ],
        },
      ],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please write the report into the bucket" });

  await waitFor(
    () => asking.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "agent")),
    "the parent's resumed step carrying the delegation receipt",
  );
  expect(asking.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const taskId = taskIdOfDelegation(asking, "the worker-question delegation");

  const childCall = await waitFor(() => asking.requests.find((r) => r.role === "child" && r.stepIndex === 0), "the worker's own first model call");
  expect(childCall.tools).toContain("ask_question");

  const bridged = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["turn.question_bridged"], sinceIso });
    return rows.length > 0 ? rows : undefined;
  }, "the question bridge's turn.question_bridged row — the worker's question posted into the room");
  const requestId = String(bridged[0]!.detail?.requestId ?? "");
  expect(requestId.startsWith(`${taskId}:`)).toBe(true);
  expect(JSON.stringify(bridged)).not.toContain(QUESTION_PROMPT);
  expect(await readAuditRows({ actions: ["turn.question_dropped"], sinceIso })).toEqual([]);

  close(asking);
  const answering = open(registerScript({ parent: [{ say: "acknowledged" }], child: [{ say: CHILD_DONE }] }));

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> ${ANSWER_TEXT}` });

  const routed = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["input_response.routed"], sinceIso });
    return rows.length > 0 ? rows : undefined;
  }, "the input_response.routed row — the room's message delivered as an answer");
  expect(routed).toHaveLength(1);
  expect(routed[0]!.detail?.requestId).toBe(requestId);
  expect(routed[0]!.detail?.taskId).toBe(taskId);
  expect(typeof routed[0]!.detail?.floor).toBe("string");
  expect(String(routed[0]!.detail?.floor).length).toBeGreaterThan(0);
  expect(JSON.stringify(routed)).not.toContain(ANSWER_TEXT);
  expect(await readAuditRows({ actions: ["input_response.denied"], sinceIso })).toEqual([]);
  expect(await readAuditRows({ actions: ["input_response.dropped"], sinceIso })).toEqual([]);

  const resumedChild = await waitFor(
    () => answering.requests.find((r) => r.role === "child" && r.toolResults.some((t) => t.name === "ask_question")),
    "the worker's resumed step — the turn that left input_required",
  );
  const answered = resumedChild.toolResults.find((t) => t.name === "ask_question");
  expect(answered).toBeDefined();
  expect(answered!.isError).toBe(false);
  expect((answered!.output as { status?: unknown }).status).toBe("answered");
  expect(JSON.stringify(answered!.output)).toContain(ANSWER_TEXT);

  await waitFor(
    () => answering.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes(taskId))),
    "the answered worker's completion, delivered as a new message naming the task id",
  );

  const parentCalls = [...asking.requests, ...answering.requests].filter((r) => r.role === "parent");
  expect(parentCalls.filter((r) => r.messages.some((m) => m.text.includes(ANSWER_TEXT)))).toEqual([]);
  const delegatedTasks = new Set(
    parentCalls.flatMap((r) => r.toolResults.filter((t) => t.name === "agent")).map((t) => String((t.output as { taskId?: unknown } | undefined)?.taskId)),
  );
  expect([...delegatedTasks]).toEqual([taskId]);

  expect(asking.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(answering.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});
