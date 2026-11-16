import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  admitToSummary,
  approxEntryTokens,
  buildTail,
  condenseTailEntry,
  parseConversationSummary,
  planConversationCarry,
  selectTail,
  SESSION_TAIL_MAX_ENTRIES,
  SUMMARY_ENTRY_MAX_CHARS,
  tailAuthorGrain,
  tailEntryToWakeMessage,
  type SessionTailEntry,
} from "../agent/channels/session-tail.js";
import { withholdsBody, type ExternalPolicy } from "../agent/access/external-policy.js";
import { nonMemberChatTrust, type IngestedChatMessage } from "../agent/identity/non-member.js";
import { registerAuthorTrust, _resetAuthorTrustForTest, type AuthorTrustQuery } from "../agent/identity/author-trust.js";
import { carryConversationForward, carryTailForward, editPostTail, recordPostTail, seedTailWindow, tailWindowFor, type TailWindow } from "../agent/channels/session-tail-record.js";
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

const T0 = Date.parse("2026-08-19T09:00:00.000Z");
const at = (secs: number): string => new Date(T0 + secs * 1000).toISOString();

function wake(secs: number, text: string, over: Partial<SessionTailEntry> = {}): SessionTailEntry {
  return { kind: "wake", at: at(secs), from: "human", trust: "peer", author: "alice", authorId: "U_ALICE", text, ...over };
}
const wakeRow = (secs: number, text: string, over: Partial<SessionTailEntry> = {}): SessionTailEntry => wake(secs, text, over);
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
    async editConversationSummaryPost() {
      return false;
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
  const OPT_OUT: ExternalPolicy = { authorGrain: "taint", roomGrain: "engage" };
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
    ok(!withholdsBody(refutedMsg!, OPT_OUT), `${s.name}: the \`taint\` opt-out grain withholds nothing`);
    eq(memberRow.refuted, false, `${s.name}: a member's row records a graded "no" as \`false\`, never as an absent field`);
    eq(tailAuthorGrain({ trust: "peer" }).refuted, false, `${s.name}: …and so does a fact set that OMITTED it — the road normalises, it does not forward`);
    eq(refutedMsg!.ungraded, undefined, `${s.name}: a row this road wrote is never UNGRADED — that state is reserved for a row persisted before the field existed`);
  }

  const olderRow: SessionTailEntry = { kind: "wake", at: at(20), from: "human", trust: "peer", author: "alice", authorId: "U_ALICE", text: "written before the field existed" };
  const [olderMsg] = buildTail([olderRow]);
  eq(olderMsg!.body, "written before the field existed", "an older row still renders — the read path tolerates the missing field");
  eq(olderMsg!.ungraded, true, "…and rides as UNGRADED rather than as a claim about its author");
  eq(olderMsg!.refuted, undefined, "🔴 …and is NEVER stamped `refuted`, which would be a verdict nothing measured (and would mark the turn on the `taint` grain)");
  ok(withholdsBody(olderMsg!, WITHHOLD), '🔴 an UNGRADED row is withheld under "withhold" — unknown reads as the fail-closed answer, never as "not refuted"');
  ok(!withholdsBody(olderMsg!, OPT_OUT), "negative control: …and is byte-identical on the `taint` opt-out grain");
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

{
  const wake = (secs: number, text: string, over: Partial<SessionTailEntry> = {}): SessionTailEntry => wakeRow(secs, text, { refuted: false, ...over });

  const short = wake(0, "the offsite is in Lisbon");
  ok(condenseTailEntry(short) === short, "a short single-line entry condenses to ITSELF (no copy, no change)");
  const long = wake(1, `${"word ".repeat(400)}TAIL-FACT`, { ...tailAuthorGrain({ trust: "peer", refuted: true }) });
  const cut = condenseTailEntry(long);
  eq(Array.from(cut.text).length, SUMMARY_ENTRY_MAX_CHARS, "a long body is cut to exactly SUMMARY_ENTRY_MAX_CHARS code points");
  ok(cut.text.endsWith("…") && !cut.text.includes("TAIL-FACT"), "…and ends in an ellipsis, so the seat can see it holds a shortened copy");
  eq(condenseTailEntry(cut), cut, "🔴 condense is IDEMPOTENT — a summary entry is condensed again at every later rotation and must not shrink each time");
  eq([cut.refuted, cut.trust, cut.author, cut.at, cut.kind], [true, "peer", "alice", long.at, "wake"], "🔴 the author grain and every other field survive the condense — only the text changes");
  eq(condenseTailEntry(wake(2, "line one\n\n  line two\tthree")).text, "line one line two three", "whitespace runs collapse to single spaces");
  const emoji = condenseTailEntry(wake(3, "🙂".repeat(SUMMARY_ENTRY_MAX_CHARS + 10)));
  ok(Array.from(emoji.text).every((ch) => ch === "🙂" || ch === "…"), "the cut is by CODE POINT, so it never splits a surrogate pair");

  const code = "ACDE2345";
  const selfPost = condenseTailEntry(post(4, `Your link code is below.\n  ${code}\nPaste it in the other app.`));
  ok(!selfPost.text.includes(code), "🔴 a live link code on its own line in the seat's own post does NOT survive the condense");
  ok(selfPost.text.includes("[private identity-link code omitted]"), "…the redaction marker stands in its place");
  ok(condenseTailEntry(wake(5, `link ${code}`)).text.includes(code), "negative control: a HUMAN claim body keeps its exact bytes, as the render keeps them");

  const gen = [wake(10, "q1"), post(11, "a1"), wake(20, "q2"), post(21, "a2"), wake(30, "q3"), post(31, "a3")];
  const per = approxEntryTokens(gen[0]);
  const plan = planConversationCarry([], gen, { tailTokens: per * 2 + 1, summaryTokens: 100_000 });
  eq(plan.tail.map((e) => e.text), ["q3", "a3"], "the tail is the newest entries that fit the TAIL cap, verbatim — exactly what buildTail selects");
  eq(plan.summary.map((e) => e.text), ["q1", "a1", "q2", "a2"], "🔴 the summary is everything OLDER than the tail, oldest-first — it never carries a message twice");
  eq(plan.record.map((e) => e.text), ["q1", "a1", "q2", "a2", "q3", "a3"], "🔴 the RECORD keeps the tail too — the next ring starts empty, so nothing else would keep those messages");
  const capped = planConversationCarry([], gen, { tailTokens: per * 2 + 1, summaryTokens: per * 4 + 1 });
  eq(capped.record.map((e) => e.text), ["q2", "a2", "q3", "a3"], "over the SUMMARY cap the OLDEST entries drop first");
  eq(capped.summary.map((e) => e.text), ["q2", "a2"], "…and the summary is still the record minus the tail");
  const many = Array.from({ length: SESSION_TAIL_MAX_ENTRIES + 50 }, (_, k) => wake(100 + k, `m${k}`));
  eq(planConversationCarry([], many, { tailTokens: 1, summaryTokens: 10_000_000 }).record.length, SESSION_TAIL_MAX_ENTRIES, "the record also respects the ring's row bound, whatever the token cap");
  eq(planConversationCarry([], [], { tailTokens: 5_000, summaryTokens: 32_000 }), { summary: [], tail: [], record: [] }, "an empty ring and no summary plan nothing");

  let prior: readonly SessionTailEntry[] = [];
  let carriedBodies: string[] = [];
  let tailOnlyBodies: string[] = [];
  for (let g = 0; g < 4; g++) {
    const base = g * 10_000;
    const ring = [
      ...(g === 0 ? [wake(base, "remember: the offsite is in Lisbon, 14 November"), post(base + 1, "noted — Lisbon, 14 November")] : []),
      ...Array.from({ length: 40 }, (_, k) => (k % 2 === 0 ? wake(base + 10 + k, `gen ${g} question ${k}: ${"detail ".repeat(20)}`) : post(base + 10 + k, `gen ${g} answer ${k}: ${"detail ".repeat(30)}`))),
    ];
    const step = planConversationCarry(prior, ring, { tailTokens: 5_000, summaryTokens: 32_000 });
    carriedBodies = [...step.summary, ...step.tail].map((e) => e.text);
    tailOnlyBodies = buildTail(ring, 5_000).map((m) => m.body);
    prior = step.record;
  }
  ok(carriedBodies.some((t) => t.includes("Lisbon, 14 November")), "🔴 the generation-1 fact is STILL CARRIED at the fourth rotation — the DM reads as one conversation");
  ok(!tailOnlyBodies.some((t) => t.includes("Lisbon")), "negative control: the tail-only carry has no trace of it — the defect OPE-2431 closes");

  const grainRing = [
    wake(0, "a refuted author's words", { ...tailAuthorGrain({ trust: "unauth", refuted: true }) }),
    wakeRow(1, "an ungraded author's words (a row from before OPE-1747)"),
    wake(2, "a member's words", { ...tailAuthorGrain({ trust: "peer", refuted: false }) }),
    post(3, "the seat's own words"),
    wake(4, "the refuted author again, newest", { ...tailAuthorGrain({ trust: "unauth", refuted: true }) }),
  ];
  const grainPlan = planConversationCarry([], grainRing, { tailTokens: 1, summaryTokens: 100_000 });
  eq(grainPlan.record.map((e) => e.text), ["a member's words", "the seat's own words"], "🔴 the record admits ONLY a graded, unrefuted author and the seat's own posts");
  eq(grainPlan.summary.map((e) => e.text), ["a member's words", "the seat's own words"], "…so the summary carries no refuted and no ungraded author's bytes");
  eq(grainPlan.tail.map((e) => e.text), ["the refuted author again, newest"], "…while the verbatim tail is unchanged: a refuted author's newest message still rides it, as before OPE-2431");
  ok(admitToSummary(post(0, "x")) && !admitToSummary(wakeRow(0, "x")) && !admitToSummary(wake(0, "x", { refuted: true })), "admitToSummary: a post yes; ungraded no; refuted no");
  registerAuthorTrust([{ tenant: "discord/guild-1", internal: ["discord/U_MEMBER"] }]);
  {
    const REG_KEY = "oe-domain::oe-dm/discord/guild-1/D9";
    const REG_TOK = "oe-dom:oe-dm/discord/guild-1/D9:oe-sup:g2-fff666";
    const stranger = { ...tailAuthorGrain({ trust: "peer", refuted: false, authorTrust: { tenantKey: "discord/guild-1", authorId: "U_STRANGER" } }) };
    const member = { ...tailAuthorGrain({ trust: "peer", refuted: false, authorTrust: { tenantKey: "discord/guild-1", authorId: "U_MEMBER" } }) };
    let stored: SessionTailEntry[] = [wake(0, "an inherited entry from the stranger", stranger), wake(1, "an inherited entry from the member", member)];
    const ring = [wake(10, "the stranger writes", stranger), wake(11, "the member writes", member), post(12, "the seat answers")];
    const regStore = {
      readSessionTail: async () => [...ring],
      clearSessionTail: async () => {},
      readConversationSummary: async () => [...stored],
      writeConversationSummary: async (_o: string, _k: string, e: readonly SessionTailEntry[]) => {
        stored = [...e];
      },
    } as unknown as OperationalStore;
    await carryConversationForward("acme", REG_KEY, REG_TOK, regStore);
    eq(stored.map((e) => e.text), ["an inherited entry from the member", "the member writes", "the seat answers"], "🔴 an author the REGISTER refutes is kept out of the summary — new entries AND inherited ones");
  }
  _resetAuthorTrustForTest();

  eq(parseConversationSummary(undefined), [], "no row ⇒ empty summary");
  eq(parseConversationSummary("{not json"), [], "a row that does not parse ⇒ empty, never a throw");
  eq(parseConversationSummary('{"text":"x"}'), [], "a row that is not an array ⇒ empty");
  eq(parseConversationSummary(JSON.stringify([wake(0, "kept"), { at: "x" }, null, 7])).map((e) => e.text), ["kept"], "an element without a string text is dropped and the rest is kept");

  const ORG = "acme";
  const KEY = "oe-domain::oe-dm/slack/T1/D1";
  const OUT = "oe-dom:oe-dm/slack/T1/D1:oe-sup:g2-abc123";
  const rings = new Map<string, SessionTailEntry[]>();
  const summaries = new Map<string, SessionTailEntry[]>();
  const log: string[] = [];
  const store = {
    async readSessionTail(org: string, key: string, token: string) {
      return [...(rings.get(`${org}:${key}:${token}`) ?? [])];
    },
    async clearSessionTail(org: string, key: string, token: string) {
      log.push("clear");
      rings.delete(`${org}:${key}:${token}`);
    },
    async readConversationSummary(org: string, key: string) {
      return [...(summaries.get(`${org}:${key}`) ?? [])];
    },
    async writeConversationSummary(org: string, key: string, entries: readonly SessionTailEntry[]) {
      log.push("write");
      summaries.set(`${org}:${key}`, [...entries]);
    },
  } as unknown as OperationalStore;
  summaries.set(`${ORG}:${KEY}`, [wake(0, "an earlier generation's question"), post(1, "an earlier generation's answer")]);
  rings.set(`${ORG}:${KEY}:${OUT}`, [wake(100, "this generation's question"), post(101, "this generation's answer")]);
  const carried = await carryConversationForward(ORG, KEY, OUT, store);
  eq(
    carried.map((m) => m.body),
    ["an earlier generation's question", "an earlier generation's answer", "this generation's question", "this generation's answer"],
    "🔴 the carry is the inherited summary, then this generation, oldest-first",
  );
  eq(carried[1]!.from, "self", "…the seat's own earlier post still renders from=self");
  eq(summaries.get(`${ORG}:${KEY}`)!.length, 4, "the summary partition now holds the whole conversation for the next rotation");
  eq(log, ["write", "clear"], "the summary is written before the ring is cleared");
  eq(rings.has(`${ORG}:${KEY}:${OUT}`), false, "…and the outgoing ring is cleared, as the tail-only carry clears it");

  rings.set(`${ORG}:${KEY}:${OUT}`, [wake(200, "q"), post(201, "a")]);
  log.length = 0;
  const blindRead = { ...store, readConversationSummary: async () => { throw new Error("store blip"); } } as unknown as OperationalStore;
  eq((await carryConversationForward(ORG, KEY, OUT, blindRead)).map((m) => m.body), ["q", "a"], "🔴 a summary read that throws still carries the tail — today's behaviour is the floor");
  eq(log, ["clear"], "🔴 …and writes NO summary, so the inherited one survives for the next rotation");
  eq(summaries.get(`${ORG}:${KEY}`)!.length, 4, "…confirmed: the stored summary is untouched");
  eq(rings.has(`${ORG}:${KEY}:${OUT}`), false, "…and the ring is cleared, so this generation also drops out of the rolling summary");

  rings.set(`${ORG}:${KEY}:${OUT}`, [wake(300, "q2"), post(301, "a2")]);
  const deafWrite = { ...store, writeConversationSummary: async () => { throw new Error("store blip"); } } as unknown as OperationalStore;
  eq((await carryConversationForward(ORG, KEY, OUT, deafWrite)).length, 6, "a summary write that throws still carries the full summary and tail into this wake");
  eq(rings.has(`${ORG}:${KEY}:${OUT}`), false, "🔴 …but the ring is still cleared, so that generation DROPS OUT of the rolling summary (the documented cost of a failed write)");
  eq(summaries.get(`${ORG}:${KEY}`)!.length, 4, "…and the stored summary stays the inherited one — never a partial write");
  const deadRing = { ...store, readSessionTail: async () => { throw new Error("store blip"); } } as unknown as OperationalStore;
  eq((await carryConversationForward(ORG, KEY, OUT, deadRing)).length, 0, "a RING read that throws carries nothing, exactly as carryTailForward does");
  eq((await carryConversationForward(ORG, KEY, undefined, store)).length, 0, "no outgoing token ⇒ []");

  const SUM_KEY = "oe-domain::oe-dm/slack/T1/D2";
  const SUM_TOK = "oe-dom:oe-dm/slack/T1/D2:oe-sup:g5-ddd444";
  summaries.set(`${ORG}:${SUM_KEY}`, [wake(0, "the question", { id: "1.2" }), post(1, "the old answer", { id: "1.2" })]);
  const editStore = {
    ...store,
    async editSessionTailPost() {
      return false;
    },
    async editConversationSummaryPost(org: string, key: string, messageId: string, text: string) {
      const cur = summaries.get(`${org}:${key}`) ?? [];
      const i = cur.findIndex((e) => e.kind === "post" && e.id === messageId);
      if (i < 0) return false;
      cur[i] = { ...cur[i]!, text };
      return true;
    },
  } as unknown as OperationalStore;
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "session-tail-summary-edit-test", auth: null, turn: 1, parent: undefined });
  const edited = await contextStorage.run(c, async () => {
    seedTailWindow({ org: ORG, registryKey: SUM_KEY, token: SUM_TOK, platform: "slack" });
    return editPostTail("1.2", `the corrected answer${" with more words".repeat(60)}`, editStore);
  });
  ok(edited === true, "🔴 an edit of a post from an EARLIER generation finds it in the summary");
  const after = summaries.get(`${ORG}:${SUM_KEY}`)!;
  ok(after[1]!.text.startsWith("the corrected answer") && after[1]!.text.endsWith("…"), "…rewrites its text, CONDENSED as the summary stores it");
  eq(after[0]!.text, "the question", "…the fake mirrors the adapters' kind filter, which operational-test pins for pg and sqlite; this case pins only that editPostTail falls through to the summary leg");
}

console.log(`✓ session-tail: ${n} assertions passed (cap + most-recent-first, time order, the recursive-inheritance guard, bot posts, self provenance, the cross-surface container guard, carry-forward, the standing-grain window guard, the unseeded no-write floor, the OPE-815 id thread + ring rewrite, the OPE-1747 withhold grain + its per-surface parity, the OPE-2431 DM conversation summary)`);

// proves: SET-034, SET-087
