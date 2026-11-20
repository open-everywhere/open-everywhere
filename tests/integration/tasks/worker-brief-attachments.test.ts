import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  SLACK_TEAM_ID,
  slackTs,
  waitFor,
  workTaskIdOfCall,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const ROOM = "C0EXCHAN027";
const SLACK_BOT = "U0OPE2781BOT";
const MEMBER = "U0OPE2781MEM";

const OWN_FILE = "F0OPE2781OWN";
const OWN_URL = "https://files.slack.example/files-pri/T0EXAMPLE-F0OPE2781OWN/ledger.csv";
const OTHER_FILE = "F0OPE2781OTH";

const BRIEF = "ope2781 job: total the attached ledger";
const RESULT = "ope2781 job result";
const DISPATCH_CALL = "ope2781-dispatch";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function promptOf(request: RecordedRequest): string {
  return request.messages.map((message) => message.text).join("\n");
}

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE2781BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      const name = id === SLACK_BOT ? "ottobot" : `ope2781-${id.slice(-3).toLowerCase()}`;
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name, real_name: name, profile: { display_name: name, real_name: name } } };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      const channel = params.get("channel");
      return {
        ok: true,
        channel: { id: channel, name: `it-ope2781-${String(channel).slice(-3).toLowerCase()}`, is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 27810) };
    return undefined;
  });
  cleanups.push(() => slack.uninstall());
}

/** A signed Slack `app_mention` that shares one file, as Slack sends a mention with an upload. */
async function slackMentionWithFile(base: string, input: { readonly channelId: string; readonly ts: string; readonly text: string; readonly file: { readonly id: string; readonly name: string; readonly mimetype: string; readonly url: string } }): Promise<number> {
  const { buildChannelMentionEnvelope, SYNTHETIC_SLACK_ROUTE, signSlackRequest } = await import("../../../packages/core/scripts/e2e/synthetic");
  const env = buildChannelMentionEnvelope({
    text: input.text,
    channelId: input.channelId,
    userId: MEMBER,
    teamId: SLACK_TEAM_ID,
    ts: input.ts,
    eventId: `EvOPE2781${input.ts.replace(".", "")}`,
  }) as { event: Record<string, unknown> };
  env.event.files = [{ id: input.file.id, name: input.file.name, title: input.file.name, mimetype: input.file.mimetype, url_private: input.file.url }];
  const rawBody = JSON.stringify(env);
  const signed = signSlackRequest(rawBody, process.env.SLACK_SIGNING_SECRET ?? "");
  const res = await fetch(`${base}${SYNTHETIC_SLACK_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": signed.timestamp, "x-slack-signature": signed.signature },
    body: rawBody,
    signal: AbortSignal.timeout(120_000),
  });
  return res.status;
}

test("a worker's brief carries the file the requester attached, and never a file from an earlier wake in the same seat", async () => {
  armSlack();
  const { base } = await bootAgent();

  const earlier = disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] }));
  const earlierTs = slackTs(Date.now() - 2_000, 27811);
  expect(
    await slackMentionWithFile(base, { channelId: ROOM, ts: earlierTs, text: `<@${SLACK_BOT}> ope2781 an unrelated file`, file: { id: OTHER_FILE, name: "other.png", mimetype: "image/png", url: "https://files.slack.example/files-pri/T0EXAMPLE-F0OPE2781OTH/other.png" } }),
  ).toBe(200);
  const earlierTurn = await waitFor(() => earlier.requests.find((r) => r.role === "parent"), "the seat to read the earlier wake");
  expect(promptOf(earlierTurn), "the earlier wake never carried its file, so the control below would prove nothing").toContain(OTHER_FILE);
  earlier.dispose();

  const cursor = await auditCursor();
  const dispatch = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: BRIEF }, id: DISPATCH_CALL }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ say: RESULT }],
    }),
  );
  afterThisTest(() => dispatch.releaseHolds());
  const ts = slackTs(Date.now(), 27812);
  expect(await slackMentionWithFile(base, { channelId: ROOM, ts, text: `<@${SLACK_BOT}> ope2781 please total this ledger`, file: { id: OWN_FILE, name: "ledger.csv", mimetype: "text/csv", url: OWN_URL } })).toBe(200);

  const seatStep = await waitFor(() => dispatch.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the seat's dispatch step");
  expect(promptOf(seatStep), "the requester's wake never carried the file, so the carry below would prove nothing").toContain(OWN_FILE);
  expect(seatStep.sessionId, "the earlier wake reached another seat, so the control below would not exercise the wake-id filter").toBe(earlierTurn.sessionId);
  expect(promptOf(seatStep), "the earlier wake's file is not in the forwarding seat's context, so the control below would prove nothing").toContain(OTHER_FILE);
  expect(seatStep.messages.at(-1)?.text ?? "", "the forwarding wake itself holds the earlier file (backscroll), so the control below would test the wrong thing").not.toContain(OTHER_FILE);
  await waitFor(() => dispatch.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's dispatch turn to serve its last step");
  const results = disposeLater(armSettlement(dispatch, { parent: [{ say: NO_REPLY_SENTINEL }] }));

  const worker = await waitFor(() => dispatch.requests.find((r) => r.role === "child" && r.stepIndex === 0), "the worker's first model call");
  const brief = promptOf(worker);
  expect(brief, "the worker never read the job's brief").toContain(BRIEF);
  expect(brief, "🔴 the requester's file did not reach the worker's brief").toContain("<delegated-attachments>");
  expect(brief, "🔴 …by its id and its name").toMatch(new RegExp(`<attachment kind="file" id="${OWN_FILE}" name="ledger.csv" mimetype="text/csv"/>`));
  expect(brief, "🔴 the file's private url rode into the worker's brief").not.toContain(OWN_URL);
  expect(brief, "🔴 NEGATIVE CONTROL: a file from an EARLIER wake in the same seat reached this job's worker").not.toContain(OTHER_FILE);

  const taskId = await workTaskIdOfCall(cursor, dispatch, DISPATCH_CALL, "the job's task");
  const read = await awaitWorkResult({ handle: results, taskId, label: "the seat's result turn" });
  expect(promptOf(read)).toContain(RESULT);
  for (const [h, label] of [[dispatch, "the dispatch"], [results, "the result turn"]] as const) assertNoFault(h, label);
}, 600_000);
