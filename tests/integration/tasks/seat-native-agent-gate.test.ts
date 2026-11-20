import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { NATIVE_AGENT_REFUSED_MESSAGE } from "@open-everywhere/core/agent/access/native-delegation-gate.js";
import {
  auditCursor,
  awaitWindowQuiet,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  rowsSinceCursor,
  waitFor,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const live = new Set<ScriptedHandle>();
afterAll(() => {
  for (const h of live) h.dispose();
  live.clear();
});

function resultById(requests: readonly RecordedRequest[], id: string): { isError: boolean; output: unknown } | undefined {
  for (const request of requests) {
    const result = request.toolResults.find((candidate) => candidate.id === id);
    if (result !== undefined) return { isError: result.isError, output: result.output };
  }
  return undefined;
}

// On eve 1.x eve mounts its built-in `agent` on every root session, and no seat-cut slot wraps it.
// The seat's per-wake `agent` verdict is `no-seat` (the seat forwards jobs with `work`). Two edges
// enforce it. The model-call cut hides `agent` (and the task-parent verbs) from the seat's model
// call, so the model never sees it. eve runs a call against the session's whole catalog, so the
// root `approval` policy also refuses a call that names `agent` anyway, before a task starts. The
// scripted model below names both hidden tools: the refusal holds, and eve's `eve__task_wait`, a
// framework action, finds no working task.
test("a channel seat is not offered eve's built-in `agent`, and a call that names it anyway is refused before a task starts", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  const handle = registerScript({
    parent: [
      { calls: [{ tool: "agent", input: { message: "do the long job natively" }, id: "gate-agent" }] },
      { calls: [{ tool: "eve__task_wait", input: { timeoutSeconds: 1 }, id: "gate-wait" }] },
      { say: NO_REPLY_SENTINEL },
    ],
    child: [{ say: "a native agent child must never run here" }],
  });
  live.add(handle);

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> run the long job yourself" });

  const waited = await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.id === "gate-wait")), "the seat's step after its eve__task_wait");
  await awaitWindowQuiet();

  const dispatch = handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  expect(dispatch.tools, "🔴 the model-call cut hides the built-in `agent` from the seat").not.toContain("agent");
  expect(dispatch.tools, "🔴 …and the task-parent verbs, since the seat's verdict is not `allow`").not.toContain("eve__task_wait");
  expect(dispatch.tools, "the seat still holds its forward verb").toContain("work");

  const agentCall = resultById(handle.requests, "gate-agent");
  expect(agentCall?.isError, `the seat's agent call was not refused: ${JSON.stringify(agentCall?.output)}`).toBe(true);
  expect(JSON.stringify(agentCall?.output)).toContain(NATIVE_AGENT_REFUSED_MESSAGE);

  expect(handle.requests.filter((r) => r.role === "child"), "no native agent child ran").toEqual([]);
  expect(await rowsSinceCursor(cursor, ["delegation.task_started"])).toEqual([]);

  const wait = resultById(handle.requests, "gate-wait");
  expect(wait?.isError).toBe(false);
  expect(JSON.stringify(wait?.output), "the refused call left the seat no working task").toContain("No tasks are working.");
  expect(waited.fault).toBeUndefined();
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});
