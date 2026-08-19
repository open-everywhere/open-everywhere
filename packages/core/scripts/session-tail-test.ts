import assert from "node:assert/strict";
import { approxEntryTokens, buildTail, selectTail, tailEntryToWakeMessage, type SessionTailEntry } from "../agent/channels/session-tail.js";
import { carryTailForward, recordPostTail, tailWindowFor, type TailWindow } from "../agent/channels/session-tail-record.js";
import { unifiedDomainSessionKey } from "../agent/channels/unified-supervisor.js";
import { formatWindowToken, taskWindowId, threadSeatWindowId } from "../agent/channels/window-key.js";
import type { OperationalStore } from "../agent/operational/store.js";

let n = 0;
function ok(cond: boolean, msg: string): void {
  assert.ok(cond, msg);
  n++;
}
function eq<T>(actual: T, expected: T, msg: string): void {
  assert.deepEqual(actual, expected, `${msg} (got ${JSON.stringify(actual)})`);
  n++;
}

const T0 = Date.parse("2026-04-23T08:30:00.000Z");
const at = (secs: number): string => new Date(T0 + secs * 1000).toISOString();

function wake(secs: number, text: string, over: Partial<SessionTailEntry> = {}): SessionTailEntry {
  return { kind: "wake", at: at(secs), from: "human", trust: "peer", author: "alice", authorId: "U_ALICE", text, ...over };
}
function post(secs: number, text: string, over: Partial<SessionTailEntry> = {}): SessionTailEntry {
  return { kind: "post", at: at(secs), from: "self", trust: "relay", author: "self", text, ...over };
}

{
  eq(selectTail([], 5_000), [], "an empty ring selects nothing");

  const ring = [wake(0, "oldest"), wake(10, "middle"), wake(20, "newest")];
  eq(
    selectTail(ring, 10_000).map((e) => e.text),
    ["oldest", "middle", "newest"],
    "under the cap the whole ring survives, OLDEST-FIRST — the render order is a conversation, not a stack",
  );

  const per = approxEntryTokens(ring[0]);
  eq(
    selectTail(ring, per * 2 + 1).map((e) => e.text),
    ["middle", "newest"],
    "🔴 over the cap the OLDEST entries are dropped — selection walks newest-first, so what survives is the most recent conversation",
  );
  eq(
    selectTail(ring, per * 3 + 1).map((e) => e.text),
    ["oldest", "middle", "newest"],
    "…the negative control: one entry's worth more headroom and the third entry is back",
  );

  const huge = [wake(0, "x".repeat(80_000))];
  eq(selectTail(huge, 10).length, 1, "a single oversized entry is KEPT — a degraded tail beats a silent one");

  ok(approxEntryTokens(wake(0, "x".repeat(4_000))) > approxEntryTokens(wake(0, "x")), "the cost proxy grows with the body (it is not a per-entry constant)");
}

{
  const outOfOrder = [post(15, "answer"), wake(10, "question"), post(25, "follow-up")];
  eq(
    buildTail(outOfOrder, 100_000).map((m) => m.body),
    ["question", "answer", "follow-up"],
    "🔴 the render sorts by `at`, so a post recorded before the wake it answers still renders after it",
  );
}

{
  const genPrev = [wake(0, "the refund for 4417"), post(5, "chasing payments now")];
  const carried = buildTail(genPrev, 100_000);
  eq(carried.length, 2, "generation N-1's tail carries two entries into N's first wake");

  const genN: SessionTailEntry[] = [wake(100, "any update?"), post(105, "payments confirmed it")];
  const nextCarried = buildTail(genN, 100_000);
  eq(nextCarried.length, 2, "🔴 generation N's own tail is TWO entries — its own trigger and its own post");
  eq(
    nextCarried.map((m) => m.body),
    ["any update?", "payments confirmed it"],
    "🔴 …and it contains NOTHING from generation N-1: reach is exactly one generation, by construction",
  );
  ok(
    !nextCarried.some((m) => carried.some((c) => c.body === m.body)),
    "🔴 the negative control: no body from the PRIOR generation's carried tail appears in the next one",
  );
  eq(
    (["wake", "post"] as const).filter((k) => !genN.some((e) => e.kind === k)),
    [],
    "…and the only two kinds a ring can hold are `wake` and `post` — there is no kind that could carry a rendered backscroll block",
  );
}

{
  const ring = [
    wake(0, "deploy started", { from: "bot", author: "deploybot", authorId: "B_DEPLOY", trust: "relay" }),
    wake(5, "did that finish?", { from: "human" }),
    post(9, "it did — 14:02"),
    wake(12, "deploy finished", { from: "bot", author: "deploybot", authorId: "B_DEPLOY", trust: "relay" }),
  ];
  const built = buildTail(ring, 100_000);
  eq(built.map((m) => m.from), ["bot", "human", "self", "bot"], "🔴 bot posts are INCLUDED and interleaved in true order — an honest transcript, not a human-only one");
  eq(built.filter((m) => m.trigger === true).length, 0, "…and no tail entry is ever the trigger: a carried bot message is awareness, never a response obligation");
}

{
  const own = tailEntryToWakeMessage(post(3, "I've asked payments to expedite it"));
  eq(own.from, "self", "🔴 the seat's own post renders `from=self` — it reads as an ACT the seat performed, not as channel content it is holding");
  eq(own.trust, "relay", "…at the machine-author floor: the tier says who wrote the bytes, and the seat is a machine author");
  eq(own.body, "I've asked payments to expedite it", "…with the body carried verbatim (the envelope does the escaping)");
  ok(own.id.length > 0, "…and always with an id, so the render never emits an empty attribute");

  const theirs = tailEntryToWakeMessage(wake(1, "hello", { id: "1755776340.000100" }));
  eq(theirs.id, "1755776340.000100", "a recorded platform message id survives to the render");
  eq(theirs.trust, "peer", "…carrying the tier its ORIGINAL ingestion resolved, not one re-derived at rotation");

  const threaded = tailEntryToWakeMessage(wake(2, "in a thread", { threadRoot: "1755590000.0001", threadPosition: 88 }));
  eq(threaded.type, "thread", "a threaded entry renders as a thread message");
  eq(threaded.threadRoot, "1755590000.0001", "…naming its root");
  eq(threaded.threadPosition, 88, "🔴 …and carrying the GAP HINT: position 88 tells the seat how much of the thread it is not seeing");
  eq(tailEntryToWakeMessage(wake(2, "no count")).threadPosition, undefined, "…absent where the platform reports no count — never guessed, because an invented 1 would claim a complete thread");
}

{
  const A = "slack/T1/C_PAY";
  const B = "slack/T1/C_ENG";
  const mixed = [
    wake(0, "payments question", { container: A }),
    wake(5, "eng question", { container: B }),
    post(9, "answered in payments", { container: A }),
  ];
  const built = buildTail(mixed, 100_000);
  eq(built.map((m) => m.container), [A, B, A], "🔴 each message keeps its OWN room across an interleaved tail — two surfaces never merge into one stream");
  eq(built.map((m) => m.body), ["payments question", "eng question", "answered in payments"], "…and the interleaving is by TIME, which is the order the rooms actually happened in");
  eq(tailEntryToWakeMessage(wake(0, "single-surface")).container, undefined, "a single-surface window records no container — the enclosing <channel> already names the room");
}

{
  const ORG = "acme";
  const KEY = "oe-domain::eng";
  const OUT = "oe-dom:eng:oe-sup:g3-aaa111";
  const rings = new Map<string, SessionTailEntry[]>();
  rings.set(`${ORG}:${KEY}:${OUT}`, [wake(0, "friday's open ask"), post(4, "picking it up monday")]);

  const store = {
    async readSessionTail(org: string, key: string, token: string) {
      return [...(rings.get(`${org}:${key}:${token}`) ?? [])];
    },
    async clearSessionTail(org: string, key: string, token: string) {
      rings.delete(`${org}:${key}:${token}`);
    },
  } as unknown as OperationalStore;

  const carried = await carryTailForward(ORG, KEY, OUT, store);
  eq(carried.map((m) => m.body), ["friday's open ask", "picking it up monday"], "the outgoing generation's ring is carried forward, oldest-first");
  eq(rings.has(`${ORG}:${KEY}:${OUT}`), false, "…and the ring is CLEARED once carried — it has served its only purpose");
  eq((await carryTailForward(ORG, KEY, OUT, store)).length, 0, "…so a second read of the same token is empty (the negative control for the clear)");

  eq((await carryTailForward(ORG, KEY, undefined, store)).length, 0, "no outgoing token (a first mint) ⇒ [] ⇒ the caller falls back to a platform fetch");
  eq((await carryTailForward(ORG, KEY, "a-token-that-never-ran", store)).length, 0, "🔴 an outgoing generation that predates the ring ⇒ [] — the BOOTSTRAP case, which takes the same fallback");

  const failing = {
    async readSessionTail() {
      throw new Error("store blip");
    },
  } as unknown as OperationalStore;
  eq((await carryTailForward(ORG, KEY, OUT, failing)).length, 0, "🔴 a store failure fail-SOFTS to an empty tail — a rotation never waits on continuity and never fails for want of it");
}

{
  const ORG = "acme";
  const DOMAIN = "eng";
  const SURFACE = "slack/T1/C_ENG";
  const call = (rawToken: unknown): TailWindow | null =>
    tailWindowFor({ org: ORG, domainKey: DOMAIN, surfaceKey: SURFACE, rawToken, platform: "slack" });

  const standing = formatWindowToken({ domain: DOMAIN, windowId: DOMAIN, generation: 11 });
  const w = call(`unified:${standing}`);
  ok(w !== null, "a standing WINDOW seat gets a tail window — this is the case OPE-804 found recording nothing");
  eq(w!.token, standing, "…filed under the BARE token, with eve's channel namespace stripped");
  eq(w!.registryKey, unifiedDomainSessionKey(DOMAIN), "…on the SYNTHETIC window row, the same key the rotation read and the spend counter use");
  eq(w!.container, SURFACE, "…carrying the PER-CONTAINER surface key, so a cross-surface window's rooms stay apart");
  eq(w!.platform, "slack", "…and the platform the post will name");
  eq(call(standing)?.token, standing, "a BARE token needs no strip and resolves identically");

  const workerToken = formatWindowToken({ domain: DOMAIN, windowId: taskWindowId("slack-T1-C_ENG", "1755776340.000100"), generation: 3 });
  ok(workerToken.includes(":oe-sup:g"), "the task window token really does carry the supervisor infix — without this the control below proves nothing");
  eq(call(workerToken), null, "🔴 a DELEGATED WORKER files no post: a task-grain session is not a generation anything rotates");
  eq(call(`unified:${workerToken}`), null, "…namespaced too — the strip must not smuggle a worker past the grain test");

  eq(call(formatWindowToken({ domain: DOMAIN, windowId: threadSeatWindowId("slack-T1-C_ENG", "1755776340.000200"), generation: 2 })), null, "a THREAD SEAT files no post either — nothing carries its ring forward");

  eq(call(undefined), null, "no token at all ⇒ no window (a sessionless schedule, an eval)");
  eq(call(""), null, "an empty token ⇒ no window");
  eq(call("cse_01ABCDEF"), null, "a NATIVE eve session id ⇒ no window");
  eq(call("subagent:cse_01ABCDEF:call_1"), null, "eve's own declared-subagent child ⇒ no window");
  eq(call("D0123456:oe-dm:g4"), null, "the legacy per-user DM-seat token ⇒ no window (its grain is native)");
  eq(call({ token: standing }), null, "a non-string ⇒ no window, never a throw");

  const container = "C0EXCHAN001:oe-sup:g7";
  eq(call(`slack:${container}`)?.registryKey, DOMAIN, "a per-container supervisor files on the caller's domain key — no synthetic window row exists for it");
  eq(call(`slack:${container}`)?.token, container, "…under its own bare token, so its ring is that generation's and no other's");
}

{
  let writes = 0;
  const store = {
    async appendSessionTail() {
      writes++;
    },
  } as unknown as OperationalStore;

  await recordPostTail("something the seat said", new Date().toISOString(), "slack", store);
  eq(writes, 0, "🔴 no seeded window ⇒ NO store write — a worker, a task session or a routine fire posting through the choke point records nothing");
}

console.log(`✓ session-tail: ${n} assertions passed (cap + most-recent-first, time order, the recursive-inheritance guard, bot posts, self provenance, the cross-surface container guard, carry-forward, the standing-grain window guard, the unseeded no-write floor)`);
