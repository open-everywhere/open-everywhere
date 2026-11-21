import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LINEAR_ANSWERED_ACK_BODY, LinearDriver, pickAppReply, type LinearComment } from "./linear-driver.js";

let n = 0;
const ok = (cond: boolean, msg: string): void => {
  assert.ok(cond, msg);
  n++;
};

const APP = "app-user";
const comment = (id: string, body: string, createdAt: string, userId = APP): LinearComment => ({ id, body, userId, userDisplayName: userId, createdAt });
const isApp = (c: LinearComment): boolean => c.userId === APP;

const ask = comment("c-ask", "@oe summarise this issue. Include the ref lina-7f3.", "2026-04-15T09:30:00.000Z", "human");
const answer = comment("c-answer", "OPE-1: the e2e probe issue (ref lina-7f3).", "2026-04-15T09:30:41.200Z");
const hostAck = comment("c-ack", LINEAR_ANSWERED_ACK_BODY, "2026-04-15T09:30:41.900Z");
const served = [hostAck, answer, ask];

{
  const src = readFileSync(join(import.meta.dirname, "../../../providers/linear/agent/channels/linear-silence-ack.ts"), "utf8");
  const m = /export const LINEAR_ANSWERED_ACK_BODY = "([^"]*)";/u.exec(src);
  ok(m !== null, "the provider still exports LINEAR_ANSWERED_ACK_BODY as one string literal");
  ok(m?.[1] === LINEAR_ANSWERED_ACK_BODY, `the driver's LINEAR_ANSWERED_ACK_BODY equals the provider's (driver "${LINEAR_ANSWERED_ACK_BODY}", provider "${m?.[1]}")`);
}

{
  const before = new Set(["c-ask"]);
  ok(pickAppReply(served, isApp, before)?.id === "c-answer", "the answer and the host ack in one poll ⇒ the answer");

  const first = comment("c-first", "144", "2026-04-15T09:40:10.000Z");
  const second = comment("c-second", "150", "2026-04-15T09:40:40.000Z");
  ok(pickAppReply([second, first], isApp, new Set())?.id === "c-first", "two unseen app replies ⇒ the older one");
  ok(pickAppReply([second, first], isApp, new Set(["c-first"]))?.id === "c-second", "…and with the older one seen ⇒ the newer one");

  ok(pickAppReply(served, isApp, new Set(["c-ask", "c-answer"])) === undefined, "only the host ack unseen ⇒ no reply yet");
  ok(pickAppReply([comment("c-ack2", `  ${LINEAR_ANSWERED_ACK_BODY}\n`, "2026-04-15T09:30:42.000Z")], isApp, new Set()) === undefined, "…with surrounding whitespace too");

  const silence = comment("c-silence", "Noted — no response needed.", "2026-04-15T09:31:00.000Z");
  ok(pickAppReply([silence], isApp, new Set())?.id === "c-silence", "the silence ack is still a pickable reply");
  ok(pickAppReply([ask], isApp, new Set()) === undefined, "a human comment is never an app reply");
  ok(pickAppReply(served, isApp, before, (c) => c.id === "c-answer") === undefined, "the caller's skip still drops the answer");

  const unstamped = comment("c-nostamp", "late", "");
  ok(pickAppReply([unstamped, answer], isApp, new Set())?.id === "c-answer", "a comment with no createdAt sorts last");
  ok(pickAppReply([unstamped], isApp, new Set())?.id === "c-nostamp", "…and is still pickable alone");
}

{
  class FakeDriver extends LinearDriver {
    override async comments(): Promise<readonly LinearComment[]> {
      return served;
    }
    override async resolveActivityId(): Promise<string | undefined> {
      return undefined;
    }
  }
  const driver = new FakeDriver({ apiKey: "x", teamId: "t", appUserId: APP, agentHandle: "oe" });
  const reply = await driver.awaitAppReply("issue-1", new Set(["c-ask"]), { timeoutMs: 1_000 });
  ok(reply.id === "c-answer", `awaitAppReply returns the answer, not the host ack (got ${reply.id}: "${reply.body}")`);
}

console.log(`✓ ${n} linear-driver assertions passed`);
