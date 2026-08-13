import { randomBytes } from "node:crypto";
import { afterAll, afterEach, expect, test } from "vitest";
import {
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  waitFor,
  type ScriptedHandle,
} from "../harness";

const REQUESTER_HEADING = "Requester's visible messages:";

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

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

function routineCall(id: string) {
  return {
    tool: "create_routine",
    input: {
      prompt: "summarise the numbers every weekday morning",
      trigger: { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" },
    },
    id,
  };
}

async function armJudge(): Promise<{ prompts: string[] }> {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });
  expect(settings.getSettings().approvals.judgeMode).toBe("enforce");

  const judge = await import("@open-everywhere/core/agent/access/approval-judge.js");
  const prompts: string[] = [];
  judge.registerApprovalJudgeCompletion(async (prompt, pass) => {
    prompts.push(prompt);
    return pass === "scrutiny" ? "YES" : "VERDICT: deny\nREASON: injected by the integration test";
  });
  cleanups.push(() => judge.resetApprovalJudgeCompletion());
  return { prompts };
}

test("a native child's model-authored brief never reaches the approval judge as a requester message", async () => {
  await bootAgent();
  const { prompts } = await armJudge();

  const humanNonce = `human-${randomBytes(4).toString("hex")}`;
  const briefNonce = `brief-${randomBytes(4).toString("hex")}`;

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: `${briefNonce} set up the routine` }, id: "rmc-delegate-1" }] },
        { say: "the worker reported back" },
      ],
      child: [{ calls: [routineCall("rmc-routine")] }, { say: "proposed" }],
    }),
  );

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: `<@9000000000000000001> ${humanNonce} please set things up`,
  });

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the parent's terminal step to be served");
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const childRequests = handle.requests.filter((r) => r.role === "child");
  expect(childRequests.length).toBeGreaterThanOrEqual(1);
  const parentFirst = handle.requests[0];
  expect(parentFirst.role).toBe("parent");
  expect(parentFirst.tools).toContain("agent");
  const childOpening = childRequests[0].messages.filter((m) => m.role === "user").map((m) => m.text).join("\n");
  expect(childOpening).toContain(briefNonce);

  const judged = await waitFor(
    () => (prompts.some((p) => p.includes("Action: create_routine")) ? [...prompts] : undefined),
    "the judge to be consulted for the child's create_routine proposal",
  );

  for (const p of judged) expect(p).not.toContain(briefNonce);
  for (const p of judged) expect(p).not.toContain(humanNonce);
  for (const p of judged) expect(p).not.toContain(REQUESTER_HEADING);
});
test("negative control: a proposal on the seat the human woke DOES carry the requester's words to the judge", async () => {
  await bootAgent();
  const { prompts } = await armJudge();

  const humanNonce = `human-${randomBytes(4).toString("hex")}`;
  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [routineCall("rmc-seat-routine")] }, { say: "proposed" }],
    }),
  );

  await discordMentionWake({
    channelId: freshUnlistedChannelId(),
    text: `<@9000000000000000001> ${humanNonce} please set up the routine`,
  });

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's terminal step to be served");
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.requests[0].tools).toContain("create_routine");

  const forRoutine = await waitFor(() => {
    const hits = prompts.filter((p) => p.includes("Action: create_routine"));
    return hits.length > 0 ? hits : undefined;
  }, "the judge to be consulted for the seat's create_routine proposal");

  for (const p of forRoutine) {
    expect(p).toContain(REQUESTER_HEADING);
    expect(p).toContain(humanNonce);
  }
});
