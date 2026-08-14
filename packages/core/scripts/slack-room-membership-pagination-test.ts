import assert from "node:assert/strict";
import { registerSlackTestBridge } from "./_slack-test-stubs.js";
import { slackRoomMembershipViaConversationsMembers, liveRoomMembership, _resetFireEligibilityCachesForTest } from "../agent/routines/fire-eligibility.js";
import type { SlackFormFn } from "../agent/channels/slack-bridge.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const CHAN = "C_BIG";
const CREATOR = "U_CREATOR";

{
  const foundPage1: SlackFormFn = async () => ({ ok: true, members: [CREATOR, "someone-else"] });
  ok((await slackRoomMembershipViaConversationsMembers(CHAN, CREATOR, foundPage1)) === true, "§1: found on page 1 ⇒ true");

  let calls = 0;
  const foundPage2: SlackFormFn = async () => {
    calls++;
    if (calls === 1) return { ok: true, members: ["someone-else"], response_metadata: { next_cursor: "cursor-2" } };
    return { ok: true, members: [CREATOR] };
  };
  ok((await slackRoomMembershipViaConversationsMembers(CHAN, CREATOR, foundPage2)) === true, "§1: found on a LATER page ⇒ pagination is actually followed, not just page 1 read");
  ok(calls === 2, "§1: …exactly two requests, one per page — no over-fetch once found");

  const fullyEnumeratedNoMatch: SlackFormFn = async () => ({ ok: true, members: ["a", "b"] });
  ok((await slackRoomMembershipViaConversationsMembers(CHAN, CREATOR, fullyEnumeratedNoMatch)) === false, "§1: NEGATIVE CONTROL — the FULL roster was seen and did not include the creator ⇒ CONFIRMED false");

  const fullyEnumeratedWithMatchOnLastPage: SlackFormFn = (() => {
    let call = 0;
    return async () => {
      call++;
      if (call === 1) return { ok: true, members: ["a"], response_metadata: { next_cursor: "cursor-2" } };
      return { ok: true, members: [CREATOR] };
    };
  })();
  ok((await slackRoomMembershipViaConversationsMembers(CHAN, CREATOR, fullyEnumeratedWithMatchOnLastPage)) === true, "§1: NEGATIVE CONTROL — the full roster was seen AND it included the creator ⇒ CONFIRMED true");

  const alwaysMore: SlackFormFn = async () => ({ ok: true, members: ["not-the-creator"], response_metadata: { next_cursor: "always-more" } });
  ok(
    (await slackRoomMembershipViaConversationsMembers(CHAN, CREATOR, alwaysMore)) === undefined,
    "§1: 🔴 THE FIX — hitting the page bound with roster STILL UNSEEN degrades to UNRESOLVED, never a manufactured 'removed'",
  );

  const malformed: SlackFormFn = async () => ({ ok: true, notMembers: [] });
  ok((await slackRoomMembershipViaConversationsMembers(CHAN, CREATOR, malformed)) === undefined, "§1: a response with no `members` array ⇒ unresolvable, never a fabricated false");

  const notOk: SlackFormFn = async () => ({ ok: false, error: "channel_not_found" });
  ok((await slackRoomMembershipViaConversationsMembers(CHAN, CREATOR, notOk)) === undefined, "§1: ok:false (a real API error) ⇒ unresolvable");

  const noResponse: SlackFormFn = async () => undefined;
  ok((await slackRoomMembershipViaConversationsMembers(CHAN, CREATOR, noResponse)) === undefined, "§1: no response (no provider / no token) ⇒ unresolvable");

  const throws: SlackFormFn = async () => {
    throw new Error("network down");
  };
  ok((await slackRoomMembershipViaConversationsMembers(CHAN, CREATOR, throws)) === undefined, "§1: a THROWING form fn degrades to unresolved, never a crash");

  const neverCalled: SlackFormFn = async () => {
    throw new Error("must never be called — an empty id argument means nothing to ask");
  };
  ok((await slackRoomMembershipViaConversationsMembers("", CREATOR, neverCalled)) === undefined, "§1: an empty channelId ⇒ unresolvable, and form is never even called");
  ok((await slackRoomMembershipViaConversationsMembers(CHAN, "", neverCalled)) === undefined, "§1: an empty userId ⇒ unresolvable, never called");
}

{
  _resetFireEligibilityCachesForTest();

  let confirmedCalls = 0;
  registerSlackTestBridge({
    form: (async () => {
      confirmedCalls++;
      return { ok: true, members: ["someone-else"] };
    }) as SlackFormFn,
  });
  const first = await liveRoomMembership(CHAN, CREATOR);
  const second = await liveRoomMembership(CHAN, CREATOR);
  ok(first === false && second === false, "§2: a fully-enumerated non-member resolves to CONFIRMED false both times");
  ok(confirmedCalls === 1, "§2: 🔴 …and the SECOND call is served from cache — the form fn is called exactly once, not twice");

  _resetFireEligibilityCachesForTest();
  let unresolvedCalls = 0;
  const otherChan = "C_BIG_UNRESOLVED";
  registerSlackTestBridge({
    form: (async () => {
      unresolvedCalls++;
      return { ok: true, members: ["not-the-creator"], response_metadata: { next_cursor: "always-more" } };
    }) as SlackFormFn,
  });
  const u1 = await liveRoomMembership(otherChan, CREATOR);
  const callsAfterFirst = unresolvedCalls;
  const u2 = await liveRoomMembership(otherChan, CREATOR);
  ok(u1 === undefined && u2 === undefined, "§2: a page-bound-hit-with-cursor-set resolves to UNRESOLVED both times, never a manufactured false");
  ok(callsAfterFirst === 10, "§2: fixture sanity — the first call itself paginated the full ROOM_MEMBER_MAX_PAGES bound (10 requests) before giving up unresolved");
  ok(
    unresolvedCalls === callsAfterFirst * 2,
    "§2: 🔴 …and the SECOND call repeats the SAME full page-bound walk — nothing was cached, proving an unresolved verdict never poisons the cache (a cached call would need zero extra requests)",
  );
}

console.log(`✓ ${n} Slack room-membership pagination assertions passed`);
