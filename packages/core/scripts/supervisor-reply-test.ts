import assert from "node:assert/strict";
import {
  planSupervisorReply,
  isSupervisorReplyTurn,
  deliverSupervisorReply,
  finalMessageAction,
  type SupervisorReplyDeps,
} from "../agent/channels/slack-events.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const CHANNEL = "C_SUP";
const THREAD = "1700159719.100200";
const SUP_TOKEN = `${CHANNEL}:oe-sup:g1`;
const TEXT = "on it — here's the answer";

{
  const top = planSupervisorReply({ channelId: CHANNEL });
  ok(top.post?.channel === CHANNEL, "plan: top-level posts to the channel");
  ok(top.post?.threadTs === undefined, "plan: top-level carries NO thread_ts");
  ok(top.bindThread === false, "plan: top-level binds no thread");

  const threaded = planSupervisorReply({ channelId: CHANNEL, threadTs: THREAD });
  ok(threaded.post?.channel === CHANNEL, "plan: threaded posts to the channel");
  ok(threaded.post?.threadTs === THREAD, "plan: threaded carries the trigger's thread_ts");
  ok(threaded.bindThread === true, "plan: threaded binds the thread");

  ok(planSupervisorReply(undefined).post === null, "plan: undefined target ⇒ post NOTHING");
  ok(planSupervisorReply({}).post === null, "plan: empty target ⇒ post NOTHING");
  ok(planSupervisorReply({ channelId: "" }).post === null, "plan: blank channelId ⇒ post NOTHING");
  ok(planSupervisorReply({ threadTs: THREAD }).post === null, "plan: thread_ts but no channel ⇒ post NOTHING");
  const blankThread = planSupervisorReply({ channelId: CHANNEL, threadTs: "" });
  ok(blankThread.post?.threadTs === undefined && blankThread.bindThread === false, "plan: blank thread_ts ⇒ top-level, no bind");
}

{
  ok(isSupervisorReplyTurn({ oeSupervisor: true }) === true, "gate: oeSupervisor:true ⇒ supervisor turn");
  ok(isSupervisorReplyTurn({ oeSupervisor: false }) === false, "gate: oeSupervisor:false ⇒ NOT a supervisor turn");
  ok(isSupervisorReplyTurn({}) === false, "gate: no flag ⇒ NOT a supervisor turn (default path)");
  ok(isSupervisorReplyTurn(undefined) === false, "gate: undefined state ⇒ NOT a supervisor turn");
  ok(isSupervisorReplyTurn({ oeUninvited: true }) === false, "gate: a plain woken turn is NOT a supervisor turn");
}

interface Spy {
  posts: Array<{ channel: string; threadTs: string | undefined; text: string }>;
  binds: Array<{ threadTs: string; ownerToken: string }>;
  ownerResolved: number;
}
function spyDeps(over: Partial<SupervisorReplyDeps> & { ownerToken?: string | undefined }): { deps: SupervisorReplyDeps; spy: Spy } {
  const spy: Spy = { posts: [], binds: [], ownerResolved: 0 };
  const ownerToken = "ownerToken" in over ? over.ownerToken : SUP_TOKEN;
  const deps: SupervisorReplyDeps = {
    postText: over.postText ?? true,
    text: over.text ?? TEXT,
    target: over.target,
    async post(channel, threadTs, text) {
      spy.posts.push({ channel, threadTs, text });
    },
    async resolveOwnerToken() {
      spy.ownerResolved++;
      return ownerToken;
    },
    async bind(threadTs, tok) {
      spy.binds.push({ threadTs, ownerToken: tok });
    },
  };
  return { deps, spy };
}

{
  const { deps, spy } = spyDeps({ target: { channelId: CHANNEL } });
  const res = await deliverSupervisorReply(deps);
  ok(spy.posts.length === 1, "top-level: posts exactly once");
  ok(spy.posts[0].channel === CHANNEL && spy.posts[0].threadTs === undefined, "top-level: posts to the channel with NO thread_ts");
  ok(spy.posts[0].text === TEXT, "top-level: posts the reply text");
  ok(spy.binds.length === 0 && spy.ownerResolved === 0, "top-level: binds no thread (owner never resolved)");
  ok(res.posted === true && res.bound === false, "top-level: result posted, not bound");
}

{
  const { deps, spy } = spyDeps({ target: { channelId: CHANNEL, threadTs: THREAD } });
  const res = await deliverSupervisorReply(deps);
  ok(spy.posts.length === 1 && spy.posts[0].threadTs === THREAD, "threaded: posts into the trigger's thread");
  ok(spy.binds.length === 1 && spy.binds[0].threadTs === THREAD, "threaded: binds the replied-into thread");
  ok(spy.binds[0].ownerToken === SUP_TOKEN, "threaded: ownerToken IS the supervisor registry token");
  ok(res.posted === true && res.bound === true, "threaded: result posted and bound");
}

{
  const { deps, spy } = spyDeps({ target: undefined });
  const res = await deliverSupervisorReply(deps);
  ok(spy.posts.length === 0, "fail-safe: NO post when the target is missing");
  ok(spy.binds.length === 0 && spy.ownerResolved === 0, "fail-safe: nothing bound");
  ok(res.posted === false && res.bound === false, "fail-safe: result posted nothing, bound nothing");
}

{
  const { deps, spy } = spyDeps({ target: { channelId: CHANNEL, threadTs: THREAD }, postText: false });
  const res = await deliverSupervisorReply(deps);
  ok(spy.posts.length === 0, "card-suppress: no redundant text post");
  ok(spy.binds.length === 1 && spy.binds[0].ownerToken === SUP_TOKEN, "card-suppress: still binds under the supervisor token");
  ok(res.posted === false && res.bound === true, "card-suppress: not posted but bound");
}

{
  const { deps, spy } = spyDeps({ target: { channelId: CHANNEL, threadTs: THREAD }, ownerToken: undefined });
  const res = await deliverSupervisorReply(deps);
  ok(spy.posts.length === 1 && spy.posts[0].threadTs === THREAD, "unresolved-owner: reply still posts into the thread");
  ok(spy.ownerResolved === 1 && spy.binds.length === 0, "unresolved-owner: bind skipped (no owner token)");
  ok(res.posted === true && res.bound === false, "unresolved-owner: posted, not bound");
}

{
  ok(finalMessageAction("stop", "NO_REPLY").kind === "silent", "NO_REPLY: maps to silent (supervisor post branch unreachable ⇒ nothing posts)");
  ok(finalMessageAction("stop", "NO_REPLY — chatter").kind === "silent", "NO_REPLY: prefix match still silent");
  ok(finalMessageAction("stop", "").kind === "silent", "empty completion: silent (nothing posts)");
  ok(finalMessageAction("stop", TEXT).kind === "post", "a real reply: maps to post (the supervisor branch runs)");
}

console.log(`supervisor-reply: ${n} assertions passed`);
