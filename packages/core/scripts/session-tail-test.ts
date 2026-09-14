import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { approxEntryTokens, buildTail, selectTail, tailAuthorGrain, tailEntryToWakeMessage, type SessionTailEntry } from "../agent/channels/session-tail.js";
import { withholdsBody, type ExternalPolicy } from "../agent/access/external-policy.js";
import { nonMemberChatTrust, type IngestedChatMessage } from "../agent/access/taint-signal.js";
import { registerAuthorTrust, _resetAuthorTrustForTest, type AuthorTrustQuery } from "../agent/identity/author-trust.js";
import { carryTailForward, editPostTail, recordPostTail, seedTailWindow, tailWindowFor, type TailWindow } from "../agent/channels/session-tail-record.js";
import { unifiedDomainSessionKey } from "../agent/channels/unified-supervisor.js";
import { formatWindowToken, taskWindowId, threadSeatWindowId } from "../agent/channels/window-key.js";
import type { OperationalStore } from "../agent/operational/store.js";

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));

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

  const threaded = tailEntryToWakeMessage(wake(2, "in a thread", { threadRoot: "1755590000.0001" }));
  eq(threaded.type, "thread", "a threaded entry renders as a thread message");
  eq(threaded.threadRoot, "1755590000.0001", "…naming its root");
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

  const ticketing: ReadonlyArray<readonly [string, string]> = [
    ["notion:notion:6f7ea678-0000-4000-8000-000000000002:oe-sup:g3", "notion:6f7ea678-0000-4000-8000-000000000002:oe-sup:g3"],
    ["github:github:acme/oe-repo:oe-sup:g12", "github:acme/oe-repo:oe-sup:g12"],
    ["linear:linear:team_9f2:oe-sup:g1", "linear:team_9f2:oe-sup:g1"],
  ];
  for (const [raw, bare] of ticketing) {
    ok(call(raw) !== null, `a per-container TICKETING supervisor token gets a tail window (${raw})`);
    eq(call(raw)!.token, bare, `…filed under the BARE token the surface minted (${raw})`);
    eq(call(raw)!.registryKey, DOMAIN, `…on the caller's domain row (${raw})`);
  }
}

{
  let writes = 0;
  const store = {
    async appendSessionTail() {
      writes++;
    },
  } as unknown as OperationalStore;

  await recordPostTail({ text: "something the seat said", at: new Date().toISOString(), platform: "slack" }, store);
  eq(writes, 0, "🔴 no seeded window ⇒ NO store write — a worker, a task session or a routine fire posting through the choke point records nothing");
}

{
  const ORG = "acme";
  const REG = "oe-domain::eng";
  const TOK = "oe-dom:eng:oe-sup:g1";
  const rows: SessionTailEntry[] = [];
  const store = {
    async appendSessionTail(org: string, key: string, token: string, entry: SessionTailEntry) {
      eq([org, key, token], [ORG, REG, TOK], "…the write targets the seeded window");
      rows.push(entry);
    },
    async editSessionTailPost(org: string, key: string, token: string, messageId: string, text: string) {
      eq([org, key, token], [ORG, REG, TOK], "…the edit targets the seeded window");
      const row = rows.find((r) => r.kind === "post" && r.id === messageId);
      if (!row) return false;
      (row as { text: string }).text = text;
      return true;
    },
  } as unknown as OperationalStore;

  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "session-tail-record-test", auth: null, turn: 1, parent: undefined });
  const inTurn = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);

  await inTurn(async () => {
    seedTailWindow({ org: ORG, registryKey: REG, token: TOK, platform: "slack" });
    await recordPostTail({ text: "Three items: a, b, c.", at: at(0), platform: "slack", id: "1755776340.000100", wake: "wk-A" }, store);
  });
  eq(rows.length, 1, "the post row was recorded");
  eq(rows[0]!.id, "1755776340.000100", "🔴 the platform message id THREADS THROUGH onto the ring row — the precondition an edit needs to find it later");
  eq(rows[0]!.wake, "wk-A", "🔴 the ANSWERED WAKE threads through onto the ring row too — the should-be-edit policy compares it");

  const edited = await inTurn(() => editPostTail("1755776340.000100", "Four items: a, b, c, d.", store));
  ok(edited === true, "editPostTail reports the row it found and rewrote");
  eq(rows[0]!.text, "Four items: a, b, c, d.", "…and the row's text is REWRITTEN in place");
  eq(rows[0]!.kind, "post", "…the kind is untouched");
  eq(rows[0]!.id, "1755776340.000100", "…the id is untouched");

  const miss = await inTurn(() => editPostTail("some-id-never-recorded", "won't land anywhere", store));
  ok(miss === false, "🔴 a miss — no ring row carries this id — is silent: editPostTail answers false, never throws");
  eq(rows[0]!.text, "Four items: a, b, c, d.", "…and the existing row is untouched by the miss");

  await inTurn(async () => {
    await recordPostTail({ text: "and one more, with no wake known.", at: at(1), platform: "slack", id: "1755776340.000200" }, store);
  });
  eq(rows.length, 2, "the second post row was recorded");
  ok(rows[1]!.wake === undefined, "🔴 no wake supplied ⇒ the row carries NO `wake` field — the unknown the fold policy fails open on");

  let calls = 0;
  const failingStore = {
    async appendSessionTail() {
      calls++;
    },
    async editSessionTailPost() {
      calls++;
      return true;
    },
  } as unknown as OperationalStore;
  await recordPostTail({ text: "outside any turn", at: at(1), platform: "slack", id: "should-not-record" }, failingStore);
  ok((await editPostTail("should-not-record", "should not rewrite", failingStore)) === false, "no seeded window ⇒ editPostTail answers false too");
  eq(calls, 0, "🔴 neither function touches the store with no seeded window — a worker/task/routine post is recorded (and edited) nowhere, same as §8");
}

{
  const WITHHOLD: ExternalPolicy = { authorGrain: "withhold", roomGrain: "engage" };
  const SHIPPED: ExternalPolicy = { authorGrain: "taint", roomGrain: "engage" };
  const REGISTER: AuthorTrustQuery = { tenantKey: "discord/guild-1", authorId: "U_STRANGER" };

  const shapes: readonly { readonly name: string; readonly refuted: IngestedChatMessage; readonly member: IngestedChatMessage }[] = [
    { name: "surface-roster leg (slack, slack-dm, teams, teams-dm, github, linear)", refuted: { trust: "unauth", refuted: true }, member: { trust: "peer", refuted: false } },
    { name: "register-only leg (discord, discord-dm, notion)", refuted: { trust: "peer", refuted: false, authorTrust: REGISTER }, member: { trust: "peer", refuted: false } },
  ];
  registerAuthorTrust([{ tenant: "discord/guild-1", internal: ["discord/U_MEMBER"] }]);

  for (const s of shapes) {
    const refutedRow = wake(0, "a refuted author's words", { ...tailAuthorGrain(s.refuted) });
    const memberRow = wake(10, "a member's words", { ...tailAuthorGrain(s.member) });
    const [refutedMsg, memberMsg] = buildTail([refutedRow, memberRow]);

    ok(withholdsBody(refutedMsg!, WITHHOLD), `🔴 ${s.name}: a refuted author's tail row is WITHHELD under authorGrain: "withhold"`);
    ok(!withholdsBody(memberMsg!, WITHHOLD), `🔴 ${s.name} NEGATIVE CONTROL: a member's tail row in the same position is NOT withheld — the row's facts decide, not the grain`);
    ok(!withholdsBody(refutedMsg!, SHIPPED), `${s.name}: the SHIPPED \`taint\` grain withholds nothing, so no deployment moves without opting in`);
    eq(memberRow.refuted, false, `${s.name}: a member's row records a graded "no" as \`false\`, never as an absent field`);
    eq(tailAuthorGrain({ trust: "peer" }).refuted, false, `${s.name}: …and so does a fact set that OMITTED it — the road normalises, it does not forward`);
    eq(refutedMsg!.ungraded, undefined, `${s.name}: a row this road wrote is never UNGRADED — that state is reserved for a row persisted before the field existed`);
  }

  const olderRow: SessionTailEntry = { kind: "wake", at: at(20), from: "human", trust: "peer", author: "alice", authorId: "U_ALICE", text: "written before the field existed" };
  const [olderMsg] = buildTail([olderRow]);
  eq(olderMsg!.body, "written before the field existed", "an older row still renders — the read path tolerates the missing field");
  eq(olderMsg!.ungraded, true, "…and rides as UNGRADED rather than as a claim about its author");
  eq(olderMsg!.refuted, undefined, "🔴 …and is NEVER stamped `refuted`, which would be a verdict nothing measured (and would mark the turn on the shipped grain)");
  ok(withholdsBody(olderMsg!, WITHHOLD), '🔴 an UNGRADED row is withheld under "withhold" — unknown reads as the fail-closed answer, never as "not refuted"');
  ok(!withholdsBody(olderMsg!, SHIPPED), "negative control: …and is byte-identical on the shipped `taint` grain");
  ok(!nonMemberChatTrust(olderMsg!), "🔴 …while the TAINT JOIN still fails OPEN on it — an ungraded old row must not start marking every turn it appears in");

  const [postMsg] = buildTail([post(30, "the seat's own reply", { refuted: false })]);
  ok(!withholdsBody(postMsg!, WITHHOLD), "the seat's own recorded post is never withheld (graded, and `relay` besides)");
  const [oldPostMsg] = buildTail([{ kind: "post", at: at(40), from: "self", trust: "relay", author: "self", text: "an older self post" }]);
  eq(oldPostMsg!.ungraded, true, "an older POST row is ungraded too");
  ok(!withholdsBody(oldPostMsg!, WITHHOLD), "🔴 …but is still not withheld: `relay` is a machine author, not a person outside the organisation");

  const [registerMsg] = buildTail([wake(50, "a stranger in an armed tenant", { ...tailAuthorGrain({ trust: "peer", refuted: false, authorTrust: REGISTER }) })]);
  eq(registerMsg!.authorTrust, REGISTER, "🔴 the operator's register query survives the round trip onto the wake message");
  ok(withholdsBody(registerMsg!, WITHHOLD), "…and is what withholds the body where the surface has no verdict of its own");
  _resetAuthorTrustForTest();
}

{
  const providers = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "providers");
  const sites: string[] = [];
  const missing: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist" || e.name === "scripts") continue;
        walk(p);
        continue;
      }
      if (!e.name.endsWith(".ts")) continue;
      const src = readFileSync(p, "utf8");
      for (const anchor of ["recordWakeTail(", "deps.recordWake("]) {
        for (const [i, part] of src.split(anchor).entries()) {
          if (i === 0) continue;
          const window = part.slice(0, 1500);
          if (!window.includes('kind: "wake"')) continue;
          sites.push(p);
          if (!window.includes("tailAuthorGrain(")) missing.push(`${p} (${anchor})`);
        }
      }
    }
  };
  walk(providers);
  ok(sites.length >= 9, `every seat surface's record site is found (got ${sites.length}: the six surfaces plus the DM seats)`);
  eq(missing, [], `🔴 every wake row resolves its author grain through tailAuthorGrain. Missing: ${missing.join(", ")}`);
}

console.log(`✓ session-tail: ${n} assertions passed (cap + most-recent-first, time order, the recursive-inheritance guard, bot posts, self provenance, the cross-surface container guard, carry-forward, the standing-grain window guard, the unseeded no-write floor, the OPE-815 id thread + ring rewrite, the OPE-1747 withhold grain + its per-surface parity)`);
