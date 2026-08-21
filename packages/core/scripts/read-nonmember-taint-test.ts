import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

import { distinctReadAuthorIds, refutedReadAuthorIds } from "../agent/channels/read-author-trust.js";
import {
  readChannelResult,
  readThreadResult,
  chatReadIngestion,
  renderChannelBody,
  renderThreadBody,
  type ReadAdapter,
  type ReadOutputLine,
  type RenderedLine,
} from "../agent/channels/channel-read.js";
import { WITHHELD_BODY_MARKER } from "../agent/access/external-policy.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
import { classifyIngestion } from "../agent/access/taint-tiers.js";
import { decideIngestion } from "../agent/access/taint-enforcement.js";
import { untrustedIngestedThisTurn, taintKindsThisTurn } from "../agent/access/taint-signal.js";
import { defineAuthorTrust, registerAuthorTrust, _resetAuthorTrustForTest } from "../agent/identity/author-trust.js";
import { projectToolSet } from "../agent/access/untrusted-projection.js";
import { UNTRUSTED_OPEN } from "../agent/access/untrusted.js";
import type { BindableContext } from "../agent/identity/binding.js";
import "../agent/tools/read_channel.js";
import "../agent/tools/read_thread.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const GUILD = "discord/G1";

const human = (id: string, text = "hi"): RenderedLine => ({ author: id, ts: "1", text, authorId: id });
const machine = (id: string, text = "beep"): RenderedLine => ({ author: id, ts: "1", text, authorId: id, bot: true });
const anon = (text = "?"): RenderedLine => ({ author: "(unknown)", ts: "1", text });

console.log("1. distinct authors:");
{
  eq(distinctReadAuthorIds([human("U1"), human("U2"), human("U1")]), ["U1", "U2"], "distinct: repeats collapse, order is first-seen");
  eq(distinctReadAuthorIds([machine("B1"), anon()]), [], "distinct: a MACHINE author and an unattributable line contribute no probe candidate");
  eq(distinctReadAuthorIds([{ author: "x", ts: "1", text: "t", authorId: "" }]), [], "distinct: an EMPTY author id is not an id");

  const page: RenderedLine[] = [];
  for (let i = 0; i < 200; i++) page.push(human(`U${i % 3}`, `line ${i}`));
  eq(distinctReadAuthorIds(page).length, 3, "distinct: a 200-message page from 3 people yields 3 probe candidates");

  let calls = 0;
  const marked = await refutedReadAuthorIds(page, "slack/T1", {
    surfaceRefuted: async () => {
      calls++;
      return false;
    },
  });
  eq(calls, 3, "🔴 the join probes ONCE PER DISTINCT AUTHOR over a 200-message page — never once per message");
  eq(marked, [], "…and a page of three confirmed members refutes NOBODY (=== [])");
}

console.log("2. the surface leg:");
{
  const refuting = async (id: string) => id === "GUEST";
  eq(
    await refutedReadAuthorIds([human("U1"), human("GUEST"), human("U2")], "slack/T1", { surfaceRefuted: refuting }),
    ["GUEST"],
    "🔴 the join names the REFUTED author and only that author — the members on the same page are not in the set",
  );
  ok((await refutedReadAuthorIds([human("U1"), human("U2")], "slack/T1", { surfaceRefuted: refuting })).length === 0, "negative control: a member-only page does NOT mark (=== [])");
  ok(
    (await refutedReadAuthorIds([machine("GUEST")], "slack/T1", { surfaceRefuted: refuting })).length === 0,
    "🔴 negative control: a MACHINE author is skipped even when its id would refute — a bot is below a member but is not a person outside the org (=== [])",
  );
  ok(
    (await refutedReadAuthorIds([anon()], "slack/T1", { surfaceRefuted: refuting })).length === 0,
    "negative control: an author with no readable id is not probed and does not mark (=== [])",
  );
  ok(
    (await refutedReadAuthorIds([human("U1")], "slack/T1", { surfaceRefuted: async () => undefined })).length === 0,
    "🔴 negative control: a probe that CANNOT ANSWER never refutes — absence of evidence is not evidence (=== [])",
  );
  ok(
    (
      await refutedReadAuthorIds([human("U1")], "slack/T1", {
        surfaceRefuted: async () => {
          throw new Error("users.info exploded");
        },
      })
    ).length === 0,
    "negative control: a THROWING probe fails OPEN — it loses a mark, never the read (=== [])",
  );
  ok((await refutedReadAuthorIds([], "slack/T1", { surfaceRefuted: refuting })).length === 0, "an empty page marks nothing");
}

console.log("3. the register leg:");
{
  _resetAuthorTrustForTest();
  let roleCalls = 0;
  const roles = async (id: string) => {
    roleCalls++;
    return id === "MEMBER" ? [`${GUILD}/role:R1`] : [];
  };
  ok(
    (await refutedReadAuthorIds([human("STRANGER")], GUILD, { memberships: roles })).length === 0,
    "🔴 negative control: an UNARMED tenant contributes NOTHING — silence is never a declaration (=== [])",
  );
  eq(roleCalls, 0, "🔴 THE COST GATE: an unarmed tenant runs ZERO membership lookups — the default posture costs nothing");

  registerAuthorTrust([defineAuthorTrust({ tenant: GUILD, internal: [{ membership: `${GUILD}/role:R1` }] })]);
  roleCalls = 0;
  ok((await refutedReadAuthorIds([human("MEMBER")], GUILD, { memberships: roles })).length === 0, "armed: an author holding the declared role is INTERNAL and does not mark (=== [])");
  ok((await refutedReadAuthorIds([human("STRANGER")], GUILD, { memberships: roles })).length > 0, "🔴 armed: an author holding NO declared role is refuted and MARKS");
  eq(roleCalls, 2, "armed: one membership lookup per distinct author, no more");

  ok(
    (await refutedReadAuthorIds([human("MEMBER")], GUILD, { memberships: async () => ["R1"] })).length > 0,
    "🔴 the probe's keys must be FULLY QUALIFIED — a raw role id matches no membership pattern, so an unqualified probe refutes everybody",
  );

  ok(
    (await refutedReadAuthorIds([human("STRANGER")], GUILD, { memberships: async () => undefined })).length === 0,
    "🔴 negative control: a membership probe answering `undefined` SKIPS that author entirely — an unverified `[]` would refute every author on a role-armed guild (=== [])",
  );

  _resetAuthorTrustForTest();
  registerAuthorTrust([defineAuthorTrust({ tenant: "teams/TEN1", internal: ["teams/AAD-MEMBER"] })]);
  ok((await refutedReadAuthorIds([human("AAD-MEMBER")], "teams/TEN1")).length === 0, "armed, no membership leg: a listed principal is internal (=== [])");
  ok((await refutedReadAuthorIds([human("AAD-GUEST")], "teams/TEN1")).length > 0, "🔴 armed, no membership leg: an UNLISTED principal is refuted and MARKS");
  ok((await refutedReadAuthorIds([human("AAD-GUEST")], "teams/OTHER-TENANT")).length === 0, "negative control: a DIFFERENT, unarmed tenant marks nothing (=== [])");
  _resetAuthorTrustForTest();
}

console.log("4. the chat-message row:");
{
  const refuted = classifyIngestion({ kind: "chat-message", authoredByNonMember: true });
  eq(refuted.tier, "untrusted", "🔴 chat-message + authoredByNonMember:true ⇒ UNTRUSTED");
  eq(refuted.assumed, false, "…a POSITIVE ruling, never `assumed` — nothing was missing that could have decided it otherwise");
  eq(classifyIngestion({ kind: "chat-message", authoredByNonMember: false }).tier, "trusted", "negative control: authoredByNonMember:false ⇒ TRUSTED");
  eq(classifyIngestion({ kind: "chat-message" }).tier, "trusted", "🔴 negative control: ABSENT ⇒ TRUSTED, not fail-closed — 'the probe could not answer' is not 'a stranger wrote it'");

  for (const shape of [{ authoredByNonMember: true }, { authoredByNonMember: false }, {}] as const) {
    ok(decideIngestion({ kind: "chat-message", ...shape }, false) === false, `🔴 relaxation-only holds: decideIngestion(chat-message ${JSON.stringify(shape)}, false) === false`);
  }
  ok(decideIngestion({ kind: "chat-message", authoredByNonMember: true }, true) === true, "…and at a TAINTING site the refuted branch keeps the mark");
  ok(decideIngestion({ kind: "chat-message" }, true) === false, "…while the unrefuted branch still drops it");

  eq(chatReadIngestion("read_channel:slack", {}), { kind: "chat-message", label: "read_channel:slack" }, "descriptor: no field on an ungraded read");
  eq(chatReadIngestion("read_channel:slack", { authoredByNonMember: false }), { kind: "chat-message", label: "read_channel:slack" }, "descriptor: no field on a member-only read");
  eq(
    chatReadIngestion("read_channel:slack", { authoredByNonMember: true }),
    { kind: "chat-message", label: "read_channel:slack", authoredByNonMember: true },
    "descriptor: the fact rides only when the page was refuted",
  );
}

console.log("5. readChannelResult / readThreadResult:");

const PAGE: readonly RenderedLine[] = [human("U1", "hello there"), human("GUEST", "hi back")];
const ctx = {} as BindableContext;

function adapter(graded: boolean | "none"): ReadAdapter {
  return {
    platform: "slack",
    wakeAddress: () => undefined,
    readChannel: async () => PAGE,
    readThread: async () => PAGE,
    ...(graded === "none" ? {} : { refutedAuthorIds: async () => (graded ? ["GUEST"] : []) }),
  };
}

{
  const marked = await readChannelResult(ctx, "slack", adapter(true), "C1");
  eq(marked.authoredByNonMember, true, "🔴 execute: a refuted page carries the grading fact out of execute");
  eq(
    marked.messages,
    [
      { author: "U1", ts: "1", text: "hello there" },
      { author: "GUEST", ts: "1", text: "hi back" },
    ],
    "🔴 execute: the message projection is LOSSY — `authorId`/`bot` are grading evidence and stop at the adapter boundary",
  );
  eq(marked.count, 2, "execute: count is the fetched length");
  eq(renderChannelBody(marked), "Recent messages in C1 (oldest first):\n[U1] hello there\n[GUEST] hi back", "execute: the render is unchanged by grading");

  const clean = await readChannelResult(ctx, "slack", adapter(false), "C1");
  ok(!("authoredByNonMember" in clean), "🔴 negative control: a member-only read carries NO field at all — POSITIVE-ONLY, so the common output is byte-identical to before OPE-474");

  const ungraded = await readChannelResult(ctx, "slack", adapter("none"), "C1");
  ok(!("authoredByNonMember" in ungraded), "negative control: an adapter with NO probe contributes nothing (a non-chat surface)");

  const thrower: ReadAdapter = {
    platform: "slack",
    wakeAddress: () => undefined,
    readChannel: async () => PAGE,
    readThread: async () => PAGE,
    refutedAuthorIds: async () => {
      throw new Error("probe exploded");
    },
  };
  const survived = await readChannelResult(ctx, "slack", thrower, "C1");
  eq(survived.count, 2, "negative control: a THROWING adapter probe never fails the read — the page comes back whole");
  ok(!("authoredByNonMember" in survived), "…and contributes no mark (fail-open)");

  const thr = await readThreadResult(ctx, "slack", adapter(true), "C1", "999.9");
  eq(thr.thread_ts, "999.9", "thread: the thread id rides through");
  eq(thr.authoredByNonMember, true, "🔴 thread: read_thread grades identically to read_channel — one body, so they cannot drift");
}

console.log("5b. coverage disclosure (OPE-761):");
{
  const cappedAdapter: ReadAdapter = {
    platform: "slack",
    wakeAddress: () => undefined,
    readChannel: async (_c, _ch, limit) => Array.from({ length: limit ?? 50 }, (_v, i) => human(`U${i}`, `msg ${i}`)),
    readThread: async (_c, _ch, _ts, limit) => Array.from({ length: limit ?? 100 }, (_v, i) => human(`U${i}`, `reply ${i}`)),
  };
  const capped = await readChannelResult(ctx, "slack", cappedAdapter, "C1", 5);
  eq(capped.possiblyIncomplete, true, "🔴 a fetch that lands exactly on its requested limit is flagged possiblyIncomplete");
  ok(renderChannelBody(capped).includes("[coverage:"), "…and the rendered body carries a coverage note the model actually sees (not just a schema field)");

  const cappedThread = await readThreadResult(ctx, "slack", cappedAdapter, "C1", "999.9", 5);
  eq(cappedThread.possiblyIncomplete, true, "read_thread: the same signal, from the same shared body");
  ok(renderThreadBody(cappedThread).includes("[coverage:"), "…and the thread render carries the note too");

  const shortAdapter: ReadAdapter = {
    platform: "slack",
    wakeAddress: () => undefined,
    readChannel: async () => [human("U1", "only message")],
    readThread: async () => [human("U1", "only reply")],
  };
  const short = await readChannelResult(ctx, "slack", shortAdapter, "C1", 5);
  ok(!("possiblyIncomplete" in short), "negative control: a page shorter than the limit carries NO field — POSITIVE-ONLY, byte-identical to before OPE-761");
  ok(!renderChannelBody(short).includes("[coverage:"), "…and the render carries no coverage note either");

  const defaultCapped = await readChannelResult(ctx, "slack", cappedAdapter, "C1");
  eq(defaultCapped.count, 50, "no explicit limit ⇒ the channel default (50) is what the fetch actually asked for");
  eq(defaultCapped.possiblyIncomplete, true, "…and hitting the default ceiling is flagged too, not just an explicit limit");
}

console.log("6. end to end — execute → the replayed toModelOutput → the turn mark:");

class FakeSession {
  private readonly store = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.store.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.store.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.store.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}
function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}

async function replayedProjection(name: string, output: unknown): Promise<{ type: string; value: unknown }> {
  const toolset: Record<string, unknown> = { [name]: { execute: () => undefined } };
  projectToolSet(toolset);
  const tool = toolset[name] as { toModelOutput?: (a: { output: unknown; toolCallId: string }) => Promise<{ type: string; value: unknown }> };
  assert.ok(typeof tool.toModelOutput === "function", `${name} has a registered replay projection`);
  return await tool.toModelOutput!({ output, toolCallId: "call-1" });
}

for (const [verb, build] of [
  ["read_channel", async (a: ReadAdapter) => await readChannelResult(ctx, "slack", a, "C1")],
  ["read_thread", async (a: ReadAdapter) => await readThreadResult(ctx, "slack", a, "C1", "999.9")],
] as const) {
  await eveContextStorage().run(new FakeSession(), async () => {
    ok(untrustedIngestedThisTurn() === false, `${verb}: the turn starts clean`);
    const out = await build(adapter(true));
    const projected = await replayedProjection(verb, out);
    ok(untrustedIngestedThisTurn() === true, `🔴 ${verb}: a read whose page carried a REFUTED non-member MARKS the turn`);
    eq(taintKindsThisTurn(), ["chat-message"], `${verb}: …disclosed as \`chat-message\`, which is what an approval card names`);
    ok(String(projected.value).includes(UNTRUSTED_OPEN), `${verb}: …and the body is still fenced (the wrap half was never the missing part)`);
    ok(String(projected.value).includes("hello there"), `${verb}: …with the real content inside the fence`);
  });

  await eveContextStorage().run(new FakeSession(), async () => {
    const out = await build(adapter(false));
    const projected = await replayedProjection(verb, out);
    ok(untrustedIngestedThisTurn() === false, `🔴 ${verb}: a MEMBER-ONLY read leaves the turn CLEAN (=== false) — no always-mark`);
    eq(taintKindsThisTurn(), [], `${verb}: …and discloses nothing`);
    ok(String(projected.value).includes(UNTRUSTED_OPEN), `${verb}: …while STILL fencing the body — the fence is unconditional, only the mark is the table's call`);
  });

  await eveContextStorage().run(new FakeSession(), async () => {
    const out = await build(adapter("none"));
    await replayedProjection(verb, out);
    ok(untrustedIngestedThisTurn() === false, `${verb}: an UNGRADED read leaves the turn clean (=== false)`);
  });
}

console.log("7. the author grain on the read path (OPE-534):");
{
  const GRAINS = ["taint", "withhold"] as const;
  const body = (out: { messages: ReadOutputLine[] }, i: number): string => out.messages[i]!.text;

  for (const grain of GRAINS) {
    overrideSettingsForTest({ externalPolicy: { authorGrain: grain } });
    const withholding = grain === "withhold";

    const out = await readChannelResult(ctx, "slack", adapter(true), "C1");

    eq(
      body(out, 1),
      withholding ? WITHHELD_BODY_MARKER : "hi back",
      `🔴 ${grain}: the REFUTED author's body is ${withholding ? "the arrived-marker" : "returned verbatim"}`,
    );
    eq(body(out, 0), "hello there", `🔴 ${grain}: the MEMBER's body on the same page is untouched — a withhold is per AUTHOR, never per page`);
    ok(
      String(renderChannelBody(out)).includes("hi back") === !withholding,
      `🔴 ${grain}: the RENDERED body ${withholding ? "no longer carries" : "carries"} the excluded author's text — the render is what the model reads`,
    );

    eq(out.count, 2, `${grain}: count is the fetched length — a withheld line is replaced, never dropped`);
    eq(out.messages[1]!.author, "GUEST", `${grain}: the withheld line keeps its AUTHOR — the marker is legible as "who and when"`);
    eq(out.messages[1]!.ts, "1", `${grain}: …and its timestamp`);

    await eveContextStorage().run(new FakeSession(), async () => {
      const fresh = await readChannelResult(ctx, "slack", adapter(true), "C1");
      const projected = await replayedProjection("read_channel", fresh);
      ok(
        untrustedIngestedThisTurn() === (!withholding),
        withholding
          ? "🔴 withhold: a WITHHELD body does NOT mark the turn (=== false) — claiming an exposure that did not happen is the always-on bit"
          : "🔴 taint (shipped): the refuted page still MARKS the turn — the read-side withhold is off by default and changes nothing",
      );
      ok(
        String(projected.value).includes("hi back") === !withholding,
        `🔴 ${grain}: the FENCED projection ${withholding ? "does not carry" : "carries"} the excluded author's text — end to end, through eve's replay path`,
      );
    });
  }

  overrideSettingsForTest({ externalPolicy: { authorGrain: "withhold" } });
  const clean = await readChannelResult(ctx, "slack", adapter(false), "C1");
  eq(
    clean.messages.map((m) => m.text),
    ["hello there", "hi back"],
    "🔴 negative control: under `withhold`, a page with NO refuted author comes back byte-identical — nothing is blanked on suspicion",
  );
  ok(!("authoredByNonMember" in clean), "…and it marks nothing");

  const thr = await readThreadResult(ctx, "slack", adapter(true), "C1", "999.9");
  eq(thr.messages[1]!.text, WITHHELD_BODY_MARKER, "🔴 read_thread withholds identically to read_channel — one grade-and-project body");

  const botLine: RenderedLine = { author: "GUEST", ts: "2", text: "beep", authorId: "GUEST", bot: true };
  const botAdapter: ReadAdapter = {
    platform: "slack",
    wakeAddress: () => undefined,
    readChannel: async () => [botLine],
    readThread: async () => [botLine],
    refutedAuthorIds: async () => ["GUEST"],
  };
  eq(
    (await readChannelResult(ctx, "slack", botAdapter, "C1")).messages[0]!.text,
    "beep",
    "🔴 negative control: a MACHINE line is not withheld even when its id is in the refuted set — a bot is below a member but is not a person outside the org",
  );

  overrideSettingsForTest({ externalPolicy: { authorGrain: "taint" } });
}

console.log(`✓ ${n} read-nonmember-taint assertions passed`);
