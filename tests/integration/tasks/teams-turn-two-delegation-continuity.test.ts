import { randomBytes } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  disposeLater,
  installTeamsJwksStub,
  registerScript,
  rowsSinceCursor,
  teamsActivityPost,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type RecordedRequest,
  type ScriptedHandle,
  type ScriptedStep,
  awaitProseRedriveSettled,
  awaitWindowQuiet,
} from "../harness";

const TEAMS_TENANT_ID = "it1064-teams-tenant";
const TEAMS_TEAM_ID = "it1064-teams-team";
const TEAMS_CHANNEL_ID = "it1064-teams-channel";
const TEAMS_CONVERSATION_ID = TEAMS_CHANNEL_ID;
const TEAMS_BOT_RECIPIENT_ID = "28:it1064-teams-bot";
const TEAMS_AUTHOR_ID = "it1064-teams-author";

const TURN_ONE_FACT = `ope1646-northwind-fact-${randomBytes(4).toString("hex")}`;
const TURN_TWO_ASK = "ope1646-recall-ask";
const DELEGATION_BRIEF = "ope1646-delegate-brief";

function promptText(req: RecordedRequest): string {
  return req.messages.map((m) => m.text).join("\n");
}

function mentionActivity(text: string): Record<string, unknown> {
  return {
    type: "message",
    channelId: "msteams",
    id: `ope1646-teams-act-${randomBytes(6).toString("hex")}`,
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    from: { id: TEAMS_AUTHOR_ID, name: "OPE-1646 Fixture Author" },
    recipient: { id: TEAMS_BOT_RECIPIENT_ID, name: "OE Bot" },
    conversation: { id: TEAMS_CONVERSATION_ID, conversationType: "channel", tenantId: TEAMS_TENANT_ID },
    channelData: {
      tenant: { id: TEAMS_TENANT_ID },
      team: { id: TEAMS_TEAM_ID },
      channel: { id: TEAMS_CHANNEL_ID, membershipType: "standard" },
    },
    entities: [{ type: "mention", text: "<at>OE Bot</at>", mentioned: { id: TEAMS_BOT_RECIPIENT_ID, name: "OE Bot" } }],
    text: `<at>OE Bot</at> ${text}`,
  };
}

async function pinFixtureDomain(): Promise<void> {
  const { loadDomains } = await import("../../../agent/memory/config/domains");
  const home = loadDomains().find((d) => d.name === "it-work-read-fixture-teams");
  expect(home, 'the "it-work-read-fixture-teams" domain is missing from agent/memory/config/domains.ts — no Teams activity below can reach a seat').toBeDefined();
}

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.reverse()) c();
});

async function driveTeamsTurn(input: {
  readonly text: string;
  readonly steps: readonly ScriptedStep[];
  readonly child?: readonly ScriptedStep[];
  readonly childHeld?: boolean;
}): Promise<ScriptedHandle> {
  const handle = disposeLater(
    input.child === undefined ? registerScript({ parent: [...input.steps] }) : registerScript({ parent: [...input.steps], child: [...input.child] }),
  );
  const res = await teamsActivityPost({ activity: mentionActivity(input.text) });
  expect(res.status, `the Teams front refused the "${input.text}" delivery: ${res.body.slice(0, 300)}`).toBe(200);

  await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.stepIndex === input.steps.length - 1),
    `the "${input.text}" turn's last scripted step`,
  );
  if (input.child !== undefined) {
    await waitForChildren(handle, { count: 1, lastStepIndex: input.childHeld === true ? 0 : input.child.length - 1, label: `the "${input.text}" turn's delegated worker` });
  }
  expect(handle.requests.filter((r) => r.fault !== undefined), `the "${input.text}" turn's script degraded`).toEqual([]);
  return handle;
}

test("a Teams seat's SECOND turn reads the first turn, its worker reads only the brief, and the dispatch is audited as a fresh delegation", async () => {
  await bootAgent();
  await pinFixtureDomain();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ identity: { blanketTrust: "internal" } });
  cleanups.push(() => {
    settings.overrideSettingsForTest({ identity: { blanketTrust: "none" } });
  });
  settings.overrideSettingsForTest({ window: { topology: true } });

  const jwks = installTeamsJwksStub();
  cleanups.push(() => jwks.uninstall());

  const cursorOne = await auditCursor();
  const one = await driveTeamsTurn({ text: TURN_ONE_FACT, steps: [{ say: `noted: ${TURN_ONE_FACT}` }] });
  const seatOne = one.requests.filter((r) => r.role === "parent");
  const seatOneFirst = seatOne[0];
  await awaitProseRedriveSettled(cursorOne, "turn 1");
  one.dispose();
  await awaitWindowQuiet();

  const cursor = await auditCursor();
  const two = await driveTeamsTurn({
    text: TURN_TWO_ASK,
    steps: [
      { calls: [{ tool: "work", input: { message: DELEGATION_BRIEF }, id: "ope1646-delegate" }] },
      { say: NO_REPLY_SENTINEL },
    ],
    child: [{ delayMs: 120_000, say: "reported" }],
    childHeld: true,
  });
  const settlement = disposeLater(armSettlement(two, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, two, "ope1646-delegate", "the OPE-1646 turn-2 forward");
  two.releaseHolds();

  const seatTwo = two.requests.filter((r) => r.role === "parent");
  const worker = two.requests.filter((r) => r.role === "child");
  expect(seatOneFirst, "turn 1 served no seat model call, so nothing below measures anything").toBeDefined();
  expect(seatTwo.length, "turn 2 served no seat model call, so nothing below measures anything").toBeGreaterThan(0);
  expect(worker.length, "turn 2's delegation served no worker model call").toBeGreaterThan(0);

  const seatOnePrompt = promptText(seatOneFirst!);
  const seatTwoPrompt = promptText(seatTwo[0]!);

  expect(seatTwoPrompt, "the request measured below is not turn 2's own model call").toContain(TURN_TWO_ASK);

  expect(seatTwoPrompt, "turn 2's seat call does NOT carry turn 1's message — the seat lost its own history").toContain(TURN_ONE_FACT);

  expect(seatOnePrompt, "turn 1's call already held turn 2's text, so ① proves nothing about continuity").not.toContain(TURN_TWO_ASK);

  expect(seatOneFirst!.sessionId, "the scripted model recorded no session id, so ③ would compare two undefineds").toBeTypeOf("string");
  expect(seatTwo[0]!.sessionId, "turn 2 landed on a different session, so the domain stopped keying one standing seat").toBe(seatOneFirst!.sessionId);

  const workerPrompt = promptText(worker[0]!);
  expect(workerPrompt, "the worker did not read its own brief, so the arm below would pass on an empty prompt").toContain(DELEGATION_BRIEF);
  expect(workerPrompt, "the worker read the parent's turn-1 message — the worker posture is leaking the seat's history").not.toContain(TURN_ONE_FACT);
  expect(worker[0]!.sessionId, "the worker ran on the seat's own session, so it is not a delegated child at all").not.toBe(seatTwo[0]!.sessionId);

  const started = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["delegation.task_started"])).find((r) => r.detail?.task === taskId),
    "turn 2's delegation.task_started row",
  );
  expect(started.detail?.session, "the row names no session").toBeTypeOf("string");
  expect(started.detail?.session, "the task started on the SEAT's session — a forwarding seat runs no child").not.toBe(seatTwo[0]!.sessionId);
  expect(String(started.detail?.call ?? ""), "the row carries no call id, so it is not a dispatch record").not.toBe("");
  expect(
    started.detail?.continuation,
    "`continuation` is not `false` on a first dispatch — a fresh dispatch was recorded as a continuation (hooks/delegation-settlement.ts `noteTaskStarted`)",
  ).toBe(false);
  expect(JSON.stringify(started.detail), "the delegation audit row carries the brief's text").not.toContain(DELEGATION_BRIEF);

  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "the OPE-1646 seat step that read the worker's result" });
  expect(resultStep.fault).toBeUndefined();
  for (const h of [two, settlement]) {
    expect(h.requests.filter((r) => r.fault !== undefined), "a straggling call faulted on turn 2's handles").toEqual([]);
  }
  two.dispose();
}, 420_000);
