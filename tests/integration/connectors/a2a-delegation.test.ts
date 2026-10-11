import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { registerA2aAgents } from "@open-everywhere/core/agent/a2a/agents.js";

import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackDmWake,
  slackInteractivityPost,
  slackTs,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type AuditRow,
} from "../harness";
import { installHostFetchStub } from "../fetch-stub";
import { createReferenceAgent } from "../../../packages/core/scripts/a2a-reference-agent";

const OPERATOR_ID = "U0EXOWNER";
const DM_CHANNEL_ID = "D0IT2425OPERATOR";
const BOT_USER_ID = "U0IT2425BOT";
const AGENT_NAME = "reference";
const AGENT_ORIGIN = "https://a2a-reference.oe-it.test";
const TASK_TEXT = "it2425 hello reference agent, please summarise the open tickets";
const FIRST_CALL_ID = "it2425-delegate-first";
const SECOND_CALL_ID = "it2425-delegate-second";
const CHECK_CALL_ID = "it2425-check-foreign";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.reverse()) c();
});
let tsCounter = 0;

function armProxyRoute(): void {
  const names = ["https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY"] as const;
  const saved = names.map((n) => [n, process.env[n]] as const);
  process.env.https_proxy = "http://oe-it-a2a-proxy.invalid:3128";
  process.env.HTTPS_PROXY = "http://oe-it-a2a-proxy.invalid:3128";
  delete process.env.no_proxy;
  delete process.env.NO_PROXY;
  cleanups.push(() => {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  });
}

function armSlackStub(): { readonly calls: readonly { method: string; params: URLSearchParams }[]; uninstall(): void } {
  return installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: "B0IT2425BOT", team_id: SLACK_TEAM_ID };
      case "users.info": {
        const id = params.get("user") ?? "";
        return {
          ok: true,
          user: {
            id,
            name: "it2425-operator",
            team_id: SLACK_TEAM_ID,
            is_bot: false,
            is_restricted: false,
            is_ultra_restricted: false,
            is_stranger: false,
            profile: { display_name: "it2425-operator", real_name: "IT 2425 Operator" },
          },
        };
      }
      case "conversations.members":
        return { ok: true, members: [], response_metadata: { next_cursor: "" } };
      case "conversations.info":
        return { ok: true, channel: { id: params.get("channel"), name: "it2425-dm", is_im: true, is_channel: false, is_private: true, num_members: 2 } };
      case "conversations.open":
        return { ok: true, channel: { id: DM_CHANNEL_ID } };
      case "conversations.history":
        return { ok: true, messages: [] };
      case "chat.postMessage":
        return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
      case "chat.update":
      case "chat.postEphemeral":
        return { ok: true };
      default:
        return undefined;
    }
  });
}

const isDelegateCard = (r: AuditRow): boolean => r.detail?.kind === "a2a.delegate";

test("a delegation to a real A2A agent is carded first, and only the approved second call sends the exact task with the asker's identity", async () => {
  await bootAgent({ sharedSqlite: true });
  armProxyRoute();
  const slack = armSlackStub();
  cleanups.push(() => slack.uninstall());

  const reference = createReferenceAgent({ origin: AGENT_ORIGIN });
  const agentNet = installHostFetchStub(AGENT_ORIGIN, (url, init) => reference.handle(new Request(url, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body ?? null })));
  cleanups.push(() => agentNet.uninstall());
  registerA2aAgents([{ name: AGENT_NAME, cardUrl: reference.cardUrl, description: "The A2A project's sample agent." }]);
  cleanups.push(() => registerA2aAgents([]));

  const org = deploymentOrg();
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  const store = provider.getOperationalStore();
  const cursor = await auditCursor();

  const first = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "ask the reference agent to summarise the open tickets" }, id: "it2425-forward" }] }, { say: NO_REPLY_SENTINEL }],
      child: [
        { delayMs: 120_000, calls: [{ tool: "delegate_to_agent", input: { agent: AGENT_NAME, message: TASK_TEXT }, id: FIRST_CALL_ID }] },
        { say: "reported: the delegation waits for approval" },
      ],
    }),
  );
  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackDmWake({ channelId: DM_CHANNEL_ID, userId: OPERATOR_ID, text: "it2425 ask the reference agent", ts, eventId: `EvIT2425${ts.replace(".", "")}` });
  expect(res.status, `the DM wake POST was refused: ${res.body.slice(0, 200)}`).toBe(200);
  await waitFor(() => first.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "it2425: the DM seat's receipt step");
  await waitForChildren(first, { count: 1, lastStepIndex: 0, label: "it2425: the first child to enter its hold" });
  const firstTask = await workTaskIdOfCall(cursor, first, "it2425-forward", "it2425: the first forward");
  const seatSession = first.requests.find((r) => r.role === "parent" && typeof r.sessionId === "string")?.sessionId;
  expect(seatSession, "the DM seat served no step").toBeDefined();
  const childTools = first.requests.find((r) => r.role === "child")?.tools ?? [];
  expect(childTools, "delegate_to_agent is not offered to the worker").toContain("delegate_to_agent");
  expect(childTools, "check_agent_task is not offered to the worker").toContain("check_agent_task");
  const firstSettlement = disposeLater(armSettlement(first, { parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }));
  first.releaseHolds();
  await waitForChildren(first, { count: 1, lastStepIndex: 1, label: "it2425: the first child's report step" });
  await awaitWorkResult({ handle: firstSettlement, taskId: firstTask, label: "it2425: the DM seat reads the first job's result" });
  expect(first.requests.filter((r) => r.fault !== undefined), "a scripted request of the first job degraded").toEqual([]);

  const firstResult = first.requests.flatMap((r) => r.toolResults).find((t) => t.id === FIRST_CALL_ID);
  expect(firstResult?.isError, `the first call errored: ${JSON.stringify(firstResult?.output).slice(0, 400)}`).toBe(false);
  expect(JSON.stringify(firstResult?.output), "the first call does not say a card was posted").toContain("Nothing was sent yet");
  const card = await waitFor(async () => (await rowsSinceCursor(cursor, ["approval.requested"], { limit: 50 })).find(isDelegateCard), "it2425: the a2a.delegate card");
  const pendingId = String(card.detail?.id ?? "");
  const row = await store.getPendingAction(org, pendingId);
  expect(row?.status, "the card is not pending").toBe("pending");
  const frozen = JSON.parse(row!.argsJson) as { agent?: unknown; message?: unknown; host?: unknown; requestedBy?: unknown };
  expect(frozen.agent).toBe(AGENT_NAME);
  expect(frozen.message, "the card does not freeze the exact task text").toBe(TASK_TEXT);
  expect(frozen.host).toBe("a2a-reference.oe-it.test");
  expect(frozen.requestedBy).toBe(OPERATOR_ID);
  expect((frozen as { answerIn?: unknown }).answerIn, "the card does not say where the answer will be posted").toBe(`slack/${SLACK_TEAM_ID}/${DM_CHANNEL_ID}`);
  expect(agentNet.calls, "🔴 the agent was reached before any approval").toEqual([]);
  expect(reference.received, "🔴 the agent received a task before any approval").toEqual([]);
  first.dispose();
  firstSettlement.dispose();

  const seatLeg = disposeLater(
    registerScript(
      {
        parent: [
          { calls: [{ tool: "work", input: { message: `The card was approved: call delegate_to_agent again with agent ${AGENT_NAME} and the same message.` }, id: "it2425-second-forward" }] },
          { say: NO_REPLY_SENTINEL },
          { say: NO_REPLY_SENTINEL },
          { say: NO_REPLY_SENTINEL },
        ],
      },
      seatSession!,
    ),
  );
  const childLeg = disposeLater(
    registerScript({
      parent: [],
      child: [
        { calls: [{ tool: "delegate_to_agent", input: { agent: AGENT_NAME, message: TASK_TEXT }, id: SECOND_CALL_ID }] },
        { calls: [{ tool: "check_agent_task", input: { agent: AGENT_NAME, agentTaskId: "it2425-not-my-task" }, id: CHECK_CALL_ID }] },
        { say: "delegated" },
      ],
    }),
  );

  const clickCursor = await auditCursor();
  const { buildApprovalClickPayload } = await import("../../../packages/core/scripts/e2e/synthetic");
  const tap = await slackInteractivityPost(
    buildApprovalClickPayload({ pendingId, decision: "approve", userId: OPERATOR_ID, channelId: DM_CHANNEL_ID, messageTs: row!.messageTs ?? "", org, teamId: SLACK_TEAM_ID }),
  );
  expect(tap.status, `the Approve tap was refused at the ingress: ${tap.body}`).toBe(200);
  const wake = await waitFor(
    async () => (await rowsSinceCursor(clickCursor, ["approval.decision_wake"], { limit: 20 })).find((r) => r.detail?.id === pendingId),
    "it2425: the approval.decision_wake row for the card",
  );
  expect(wake.detail?.delivered, "the decision wake did not reach the DM seat").toBe(true);
  expect((await store.getPendingAction(org, pendingId))?.status).toBe("approved");
  const approved = await waitFor(
    async () => (await rowsSinceCursor(clickCursor, ["a2a.delegate_approved"], { limit: 20 }))[0],
    "it2425: the a2a.delegate_approved row",
  );
  expect(approved.detail?.agent).toBe(AGENT_NAME);
  expect(JSON.stringify(approved.detail), "🔴 the approval row carries the task text").not.toContain("summarise");
  const wakeStep = await waitFor(() => seatLeg.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "it2425: the seat's decision-wake step");
  expect(wakeStep.messages.map((m) => m.text).join("\n"), "the decision wake does not say the delegation has not run").toContain("HAS NOT RUN");

  await waitForChildren(childLeg, { count: 1, lastStepIndex: 2, label: "it2425: the second child's last step" });
  const sent = childLeg.requests.flatMap((r) => r.toolResults).find((t) => t.id === SECOND_CALL_ID);
  expect(sent, "the approved call returned no result").toBeDefined();
  expect(sent!.isError, `the approved call errored: ${JSON.stringify(sent!.output).slice(0, 400)}`).toBe(false);
  const output = JSON.stringify(sent!.output);
  expect(output, "the answer did not come from the reference agent").toContain("You said:");
  expect(output, "🔴 the agent's answer reached the model outside the untrusted fence").toMatch(/untrusted_external_data[^>]*a2a:reference/);
  expect(reference.received.length, "🔴 the approved task did not reach the agent exactly once").toBe(1);
  const foreign = childLeg.requests.flatMap((r) => r.toolResults).find((t) => t.id === CHECK_CALL_ID);
  expect(foreign, "the check_agent_task call returned no result").toBeDefined();
  expect(JSON.stringify(foreign!.output), "🔴 check_agent_task followed a task this conversation never delegated").toContain("did not delegate a task with that id");
  expect(agentNet.calls.some((c) => String(c.init?.body ?? "").includes("it2425-not-my-task")), "🔴 the foreign task id reached the agent").toBe(false);
  expect(reference.received[0]!.text, "🔴 the agent did not receive the exact approved text").toBe(TASK_TEXT);
  const callerMeta = reference.received[0]!.metadata["open-everywhere/caller"] as Record<string, unknown> | undefined;
  expect(callerMeta?.principalId, "🔴 the asker's identity did not ride with the task").toBe(OPERATOR_ID);
  expect(callerMeta?.platform).toBe("slack");
  expect(callerMeta?.approvedBy, "the approver's identity did not ride with the task").toBe(OPERATOR_ID);
  const delegated = await waitFor(async () => (await rowsSinceCursor(clickCursor, ["a2a.delegated"], { limit: 20 }))[0], "it2425: the a2a.delegated row");
  expect(delegated.detail?.agent).toBe(AGENT_NAME);
  expect(delegated.detail?.state).toBe("completed");
  const allows = (await rowsSinceCursor(clickCursor, ["egress.hostside.allow"], { limit: 50 })).filter((r) => r.detail?.agent === AGENT_NAME);
  expect(allows.length, "the A2A requests wrote no egress.hostside.allow rows").toBeGreaterThan(0);
  expect((await rowsSinceCursor(cursor, ["approval.requested"], { limit: 50 })).filter(isDelegateCard).length, "🔴 the approved call posted a SECOND card").toBe(1);
  expect(childLeg.requests.filter((r) => r.fault !== undefined), "a scripted request of the second job degraded").toEqual([]);
  expect(seatLeg.requests.filter((r) => r.fault !== undefined), "a scripted seat request of the second job degraded").toEqual([]);
}, 600_000);

test("an agent declared for other domains refuses this conversation before any card or request, audited", async () => {
  await bootAgent({ sharedSqlite: true });
  const DM2 = "D0IT2425GATED";
  const GATED_ORIGIN = "https://a2a-gated.oe-it.test";
  const GATED_CALL_ID = "it2425-gated";
  const gated = createReferenceAgent({ origin: GATED_ORIGIN });
  const gatedNet = installHostFetchStub(GATED_ORIGIN, (url, init) => gated.handle(new Request(url, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body ?? null })));
  cleanups.push(() => gatedNet.uninstall());
  registerA2aAgents([{ name: "gated", cardUrl: gated.cardUrl, description: "A reference agent declared for one other domain.", domains: ["it2425-no-such-domain"] }]);
  cleanups.push(() => registerA2aAgents([]));
  const cursor = await auditCursor();

  const leg = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "ask the gated agent" }, id: "it2425-gated-forward" }] }, { say: NO_REPLY_SENTINEL }],
      child: [
        { delayMs: 120_000, calls: [{ tool: "delegate_to_agent", input: { agent: "gated", message: "it2425 gated task" }, id: GATED_CALL_ID }] },
        { say: "reported: refused" },
      ],
    }),
  );
  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackDmWake({ channelId: DM2, userId: OPERATOR_ID, text: "it2425 ask the gated agent", ts, eventId: `EvIT2425G${ts.replace(".", "")}` });
  expect(res.status, `the DM wake POST was refused: ${res.body.slice(0, 200)}`).toBe(200);
  await waitFor(() => leg.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "it2425-gated: the DM seat's receipt step");
  await waitForChildren(leg, { count: 1, lastStepIndex: 0, label: "it2425-gated: the child to enter its hold" });
  const task = await workTaskIdOfCall(cursor, leg, "it2425-gated-forward", "it2425-gated: the forward");
  const settlement = disposeLater(armSettlement(leg, { parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }));
  leg.releaseHolds();
  await waitForChildren(leg, { count: 1, lastStepIndex: 1, label: "it2425-gated: the child's report step" });
  await awaitWorkResult({ handle: settlement, taskId: task, label: "it2425-gated: the DM seat reads the job's result" });

  const refusedCall = leg.requests.flatMap((r) => r.toolResults).find((t) => t.id === GATED_CALL_ID);
  expect(refusedCall, "the delegate_to_agent call returned no result").toBeDefined();
  expect(JSON.stringify(refusedCall!.output), "🔴 the tool did not refuse a conversation outside the agent's domains").toContain("is declared for");
  const refusedRow = await waitFor(async () => (await rowsSinceCursor(cursor, ["a2a.refused"], { limit: 20 }))[0], "it2425-gated: the a2a.refused row");
  expect(refusedRow.detail?.reason).toBe("domain-not-allowed");
  expect(refusedRow.detail?.agent).toBe("gated");
  expect((await rowsSinceCursor(cursor, ["approval.requested"], { limit: 50 })).filter(isDelegateCard), "🔴 a refused room still got a card").toEqual([]);
  expect(gatedNet.calls, "🔴 a refused room still reached the agent").toEqual([]);
  expect(leg.requests.filter((r) => r.fault !== undefined), "a scripted request of the gated leg degraded").toEqual([]);
}, 600_000);

