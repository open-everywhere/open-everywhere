import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  afterThisTest,
  disposeLater,
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  rowsSinceCursor,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type AuditCursor,
  type AuditRow,
} from "../harness";

const REQUESTER_HEADING = "Requester's visible messages:";
const EARLIER_HEADING = "Requester's messages from EARLIER turns";
const QUOTE_HEADING = "The person's own words";
const STARTER_ROUTINE_RULE = "routine-reports-here";

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

function currentSection(prompt: string): string[] {
  const lines = prompt.split("\n");
  const start = lines.indexOf(REQUESTER_HEADING);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("> ")) break;
    out.push(line.slice(2));
  }
  return out;
}

async function armJudge(askNonce?: string): Promise<{ prompts: string[] }> {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });
  expect(settings.getSettings().approvals.judgeMode).toBe("enforce");

  const judge = await import("@open-everywhere/core/agent/access/approval-judge.js");
  const prompts: string[] = [];
  judge.registerApprovalJudgeCompletion(async (prompt, pass) => {
    if (pass === "scrutiny") return "YES";
    prompts.push(prompt);
    const asked = askNonce !== undefined && currentSection(prompt).some((line) => line.includes(askNonce));
    return asked
      ? `VERDICT: allow\nREASON: the requester asked for this routine in this turn\nRULE: ${STARTER_ROUTINE_RULE}`
      : "VERDICT: ask\nREASON: no verified requester message from this turn asks for this";
  });
  afterThisTest(() => judge.resetApprovalJudgeCompletion());
  return { prompts };
}

async function routineApprovalRows(cursor: AuditCursor, terminal: "approval.autoapproved" | "approval.requested"): Promise<AuditRow[]> {
  return waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["approval.chain", "approval.judge.verdict", "approval.autoapproved", "approval.requested"]);
    return rows.some((r) => r.action === "approval.judge.verdict" && r.detail?.tool === "create_routine") && rows.some((r) => r.action === terminal) ? rows : undefined;
  }, `this leg's approval.judge.verdict row for create_routine and its ${terminal} row`);
}

async function driveForwardedProposal(input: { readonly ids: string; readonly askText: string; readonly briefNonce: string; readonly earlierTurnText?: string }) {
  if (input.earlierTurnText !== undefined) {
    const earlier = disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] }));
    await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: input.earlierTurnText });
    await waitFor(() => earlier.requests.find((r) => r.role === "parent" && r.stepIndex === 0), `${input.ids}: the earlier turn's one seat step`);
    expect(earlier.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    earlier.dispose();
  }

  const cursor = await auditCursor();
  const delegateId = `rmc-delegate-${input.ids}`;
  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: `${input.briefNonce} set up the routine` }, id: delegateId }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [{ delayMs: 120_000, calls: [routineCall(`rmc-routine-${input.ids}`)] }, { say: "proposed" }],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: input.askText });

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${input.ids}: the parent's receipt step to be served`);
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, handle, delegateId, `${input.ids}: the forward`);
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `${input.ids}: the delegated child's own terminal step` });

  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: `${input.ids}: the seat's step that read the child's result` });
  expect(resultStep.stepIndex).toBe(0);
  expect(handle.holdsCutShort(), "the child's hold ended on the release, not on its 120 s backstop").toBe(1);
  for (const h of [handle, settlement]) {
    expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(h.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  }

  const childRequests = handle.requests.filter((r) => r.role === "child");
  expect(childRequests.length).toBeGreaterThanOrEqual(1);
  const parentFirst = handle.requests[0];
  expect(parentFirst.role).toBe("parent");
  expect(parentFirst.tools).toContain("work");
  const childOpening = childRequests[0].messages.filter((m) => m.role === "user").map((m) => m.text).join("\n");
  expect(childOpening).toContain(input.briefNonce);
  return { cursor, childOpening };
}

test("a person's ask on the seat reaches the judge of the work-session child that proposes the act, and the starter rule allows it — the brief never does", async () => {
  await bootAgent();
  const humanNonce = `human-${randomBytes(4).toString("hex")}`;
  const briefNonce = `brief-${randomBytes(4).toString("hex")}`;
  const { prompts } = await armJudge(humanNonce);

  const { cursor, childOpening } = await driveForwardedProposal({
    ids: "fwd",
    askText: `<@9000000000000000001> ${humanNonce} please set up a routine that summarises the numbers every weekday morning`,
    briefNonce,
  });
  const quoteAt = childOpening.indexOf(QUOTE_HEADING);
  expect(quoteAt, "precondition: the child's opening carries the host's quote of the person's words").toBeGreaterThan(-1);
  expect(childOpening.slice(quoteAt), "…and the person's nonce sits inside that quote").toContain(humanNonce);
  expect(childOpening.slice(0, quoteAt), "…and nowhere before it: the seat's brief did not carry it").not.toContain(humanNonce);

  const judged = await waitFor(() => (prompts.some((p) => p.includes("Action: create_routine")) ? [...prompts] : undefined), "the judge to be consulted for the child's create_routine proposal");
  const forRoutine = judged.filter((p) => p.includes("Action: create_routine"));

  for (const p of forRoutine) {
    expect(p).toContain(REQUESTER_HEADING);
    expect(currentSection(p).some((line) => line.includes(humanNonce))).toBe(true);
    expect(p).not.toContain(EARLIER_HEADING);
  }
  for (const p of judged) expect(p).not.toContain(briefNonce);
  for (const p of judged) expect(p).not.toContain(QUOTE_HEADING);
  for (const p of forRoutine) expect(p).not.toContain("<wake");

  const rows = await routineApprovalRows(cursor, "approval.autoapproved");
  const verdict = rows.find((r) => r.action === "approval.judge.verdict" && r.detail?.tool === "create_routine");
  expect(verdict?.detail?.verdict).toBe("allow");
  expect(verdict?.detail?.enforcedVerdict).toBe("allow");
  const chain = rows.find((r) => r.action === "approval.chain" && r.detail?.tool === "create_routine");
  expect(chain?.detail?.verdict).toBe("allow");
  expect(chain?.detail?.resolvedBy).toBe("judge");
  expect(chain?.detail?.unattended).toBe(false);
  expect(rows.some((r) => r.action === "approval.autoapproved")).toBe(true);
  expect(rows.filter((r) => r.action === "approval.requested")).toEqual([]);
});

test("an ask from an EARLIER seat turn is not carried: the judge sees only the forwarding turn's words, and the act gets a card", async () => {
  await bootAgent();
  const earlierNonce = `earlier-${randomBytes(4).toString("hex")}`;
  const laterNonce = `later-${randomBytes(4).toString("hex")}`;
  const briefNonce = `brief-${randomBytes(4).toString("hex")}`;
  const { prompts } = await armJudge(earlierNonce);

  const { cursor } = await driveForwardedProposal({
    ids: "stale",
    earlierTurnText: `<@9000000000000000001> ${earlierNonce} please set up a routine that summarises the numbers every weekday morning`,
    askText: `<@9000000000000000001> ${laterNonce} thanks, go ahead`,
    briefNonce,
  });

  const judged = await waitFor(() => (prompts.some((p) => p.includes("Action: create_routine")) ? [...prompts] : undefined), "the judge to be consulted for the stale-ask proposal");
  const forRoutine = judged.filter((p) => p.includes("Action: create_routine"));
  for (const p of forRoutine) expect(currentSection(p).some((line) => line.includes(laterNonce))).toBe(true);
  for (const p of judged) expect(p).not.toContain(earlierNonce);
  for (const p of judged) expect(p).not.toContain(briefNonce);

  const rows = await routineApprovalRows(cursor, "approval.requested");
  const verdict = rows.find((r) => r.action === "approval.judge.verdict" && r.detail?.tool === "create_routine");
  expect(verdict?.detail?.verdict).toBe("ask");
  expect(rows.some((r) => r.action === "approval.autoapproved")).toBe(false);
  expect(rows.some((r) => r.action === "approval.requested")).toBe(true);
});

test("negative control: a proposal on the seat the human woke DOES carry the requester's words to the judge", async () => {
  await bootAgent();
  const { prompts } = await armJudge();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const topologyBefore = settings.getSettings().window.topology;
  afterThisTest(() => settings.overrideSettingsForTest({ window: { topology: topologyBefore } }));
  settings.overrideSettingsForTest({ window: { topology: false } });
  expect(settings.getSettings().window.topology).toBe(false);

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
