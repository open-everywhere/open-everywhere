import { randomBytes } from "node:crypto";
import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { CONVERSATION_SUMMARY_PARTITION } from "@open-everywhere/core/agent/channels/session-tail.js";
import { dmWindowRegistryKey } from "@open-everywhere/core/agent/channels/unified-supervisor.js";

import {
  auditCursor,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackDmWake,
  slackTs,
  waitFor,
  WAKE_FROM_ENVELOPE,
  type AuditCursor,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const BOT = "U0IT2501BOT";
const MEMBER = "U0IT2501MEMBER";
const DM = "D0IT2501MEMBER";
const DM_SURFACE = `slack/${SLACK_TEAM_ID}/${DM}`;

const RUN = randomBytes(6).toString("hex");
const FACT = `it2501 remember this: the vault code is VAULT-${RUN}`;
const NOTED = "it2501 noted.";
const CHATTER = "it2501 unrelated: what time is the standup?";
const CHATTER_REPLY = "it2501 the standup is at ten.";
const ASK = "it2501 what was the vault code I told you?";
const ANSWER = `it2501 the vault code is VAULT-${RUN}.`;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});
let tsCounter = 0;

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT, bot_id: "B0IT2501BOT", team_id: SLACK_TEAM_ID };
      case "users.info": {
        const id = params.get("user") ?? "";
        return {
          ok: true,
          user: { id, name: `it2501-${id.slice(-6).toLowerCase()}`, team_id: SLACK_TEAM_ID, is_bot: id === BOT, is_restricted: false, is_ultra_restricted: false, is_stranger: false, profile: { display_name: id, real_name: id } },
        };
      }
      case "users.conversations":
        return { ok: true, channels: [], response_metadata: { next_cursor: "" } };
      case "conversations.members":
        return { ok: true, members: [], response_metadata: { next_cursor: "" } };
      case "conversations.info":
        return { ok: true, channel: { id: params.get("channel") ?? DM, name: "it2501-dm", is_im: true, is_channel: false, is_private: true, num_members: 2 } };
      case "conversations.history":
      case "conversations.replies":
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
  cleanups.push(() => slack.uninstall());
}

const promptOf = (r: RecordedRequest): string => r.messages.map((m) => m.text).join("\n");

async function dmTurn(cursor: AuditCursor, text: string, reply: string, tag: string): Promise<{ handle: ScriptedHandle; first: RecordedRequest }> {
  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: reply }, id: `it2501-${tag}` }] }, { say: NO_REPLY_SENTINEL }],
    }),
  );
  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackDmWake({ channelId: DM, userId: MEMBER, text, ts, eventId: `EvIT2501${tag}${ts.replace(".", "")}` });
  expect(res.status, `the ${tag} DM wake was refused: ${res.body.slice(0, 200)}`).toBe(200);
  const first = await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0), `it2501: the ${tag} turn's first step`);
  await waitFor(
    async () => (await rowsSinceCursor(cursor, ["reply.post"], { limit: 100 })).find((r) => r.detail?.sessionId === first.sessionId && r.detail?.chars === reply.length),
    `it2501: the ${tag} turn's reply.post row`,
  );
  expect(handle.requests.filter((r) => r.fault !== undefined), `a scripted ${tag} request degraded`).toEqual([]);
  return { handle, first };
}

test("a fact told to a Slack DM in generation 1 still reaches the DM seat in generation 3, through the conversation summary", async () => {
  armSlack();
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const registryKey = dmWindowRegistryKey(DM_SURFACE);
  const cursor = await auditCursor();

  const ringHolds = (token: string, wake: string, post: string, label: string) =>
    waitFor(async () => {
      const ring = await store.readSessionTail(org, registryKey, token);
      return ring.some((e) => e.kind === "wake" && e.text === wake) && ring.some((e) => e.kind === "post" && e.text === post) ? ring : undefined;
    }, `it2501: ${label}`);

  const g1 = await dmTurn(cursor, FACT, NOTED, "fact");
  const gen1 = await store.getChannelSession(org, registryKey);
  expect(gen1, "the DM wake did not seat a DM window").not.toBeNull();
  await ringHolds(gen1!.token, FACT, NOTED, "generation 1's ring holds the fact and the seat's reply");
  g1.handle.dispose();

  expect(await store.markChannelSessionRotation(org, registryKey, new Date().toISOString()), "the DM seat's row was not marked").toBe(true);
  const g2 = await dmTurn(cursor, CHATTER, CHATTER_REPLY, "chatter");
  const gen2 = await store.getChannelSession(org, registryKey);
  expect(gen2!.token, "the mark did not rotate the DM seat").not.toBe(gen1!.token);
  expect(g2.first.sessionId, "generation 2 ran in generation 1's session").not.toBe(g1.first.sessionId);
  expect(promptOf(g2.first), "generation 2's first wake does not carry generation 1's tail").toContain(FACT);
  const ring2 = await ringHolds(gen2!.token, CHATTER, CHATTER_REPLY, "generation 2's ring holds its own turn");
  expect(ring2.map((e) => e.text).filter((t) => t.includes(RUN)), "🔴 generation 2's ring holds the fact, so the next rotation would not test the summary").toEqual([]);
  expect(await store.readSessionTail(org, registryKey, gen1!.token), "generation 1's ring was not cleared by its rotation").toEqual([]);
  const summary2 = await store.readConversationSummary(org, registryKey);
  expect(summary2.map((e) => e.text), `the ${CONVERSATION_SUMMARY_PARTITION} row does not hold generation 1`).toEqual(expect.arrayContaining([FACT, NOTED]));
  g2.handle.dispose();

  expect(await store.markChannelSessionRotation(org, registryKey, new Date().toISOString()), "the DM seat's row was not marked again").toBe(true);
  const g3 = await dmTurn(cursor, ASK, ANSWER, "ask");
  const gen3 = await store.getChannelSession(org, registryKey);
  expect(gen3!.token, "the second mark did not rotate the DM seat").not.toBe(gen2!.token);
  expect(gen3!.generation, "the DM seat is not on its third generation").toBe(gen1!.generation + 2);
  expect(g3.first.sessionId, "generation 3 ran in an earlier generation's session").not.toBe(g2.first.sessionId);

  const read = promptOf(g3.first);
  expect(read, "🔴 generation 3 lost the fact told in generation 1 — the DM forgot the conversation across a rotation").toContain(`VAULT-${RUN}`);
  expect(read, "generation 3 lost generation 2's tail").toContain(CHATTER);
  expect(read, "generation 3 did not read the person's question").toContain(ASK);
  expect(read.split(CHATTER).length - 1, "🔴 generation 2's tail is carried twice — the summary did not leave out what the verbatim tail shows").toBe(1);
  expect(read.split(CHATTER_REPLY).length - 1, "🔴 generation 2's reply is carried twice — the summary did not leave out what the verbatim tail shows").toBe(1);
  expect(read.split(`VAULT-${RUN}`).length - 1, "the carried conversation holds the fact more than once").toBe(1);

  const summary3 = await store.readConversationSummary(org, registryKey);
  expect(summary3.map((e) => e.text), `the ${CONVERSATION_SUMMARY_PARTITION} row does not hold both earlier generations`).toEqual(expect.arrayContaining([FACT, NOTED, CHATTER, CHATTER_REPLY]));

  const answerPost = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["reply.post"], { limit: 100 })).find((r) => r.detail?.sessionId === g3.first.sessionId && r.detail?.chars === ANSWER.length),
    "it2501: generation 3's reply.post row",
  );
  expect(answerPost.surface, "the answer was posted somewhere other than the person's DM").toBe(DM);
  g3.handle.dispose();
}, 600_000);
