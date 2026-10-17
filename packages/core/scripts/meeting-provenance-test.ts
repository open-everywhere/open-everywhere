import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SQLITE_DIR = mkdtempSync(join(tmpdir(), "oe-meeting-provenance-"));
delete process.env.DATABASE_URL;
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(SQLITE_DIR, "meeting-provenance.sqlite3");

const { getOperationalStore, registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");
const { initOperationalSchema, makeOperationalPostgresStore } = await import("../agent/operational/postgres.js");
const { openTestPg, closeAllTestPg } = await import("./test-pg-driver.js");
const meetingStore = await import("../agent/meetings/store.js");
const provenance = await import("../agent/meetings/provenance.js");
const { DEFAULT_MEETING_POLICY, setMeetingPolicyForTest, resetMeetingPolicyForTest } = await import("../agent/meetings/policy.js");
const { readChannelResult, readThreadResult, chatReadIngestion, registerReadAdapter } = await import("../agent/channels/channel-read.js");
const { classifyIngestion } = await import("../agent/access/taint-tiers.js");
const { untrustedIngestedThisTurn, taintKindsThisTurn } = await import("../agent/access/taint-signal.js");
const { authoredModelProjectionFor } = await import("../agent/access/window-gated.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");
const { markIfTurnLocusCarriesMeetingPost } = await import("../agent/hooks/spawn-taint.js");
const meetingSweep = (await import("../agent/schedules/meeting-sweep.js")).default as unknown as { run: () => Promise<void> };
await import("../agent/tools/read_thread.js");
import type { OperationalStore } from "../agent/operational/store.js";
import type { BindableContext } from "../agent/identity/binding.js";
import type { ReadAdapter, RenderedLine } from "../agent/channels/channel-read.js";

let n = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  n++;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

async function contract(store: OperationalStore, label: string): Promise<void> {
  const A = "org-a";
  const B = "org-b";
  await store.putMeetingData(A, "k1", "v1", iso(T0), iso(T0 + HOUR));
  ok((await store.getMeetingData(A, "k1", iso(T0 + 30 * MIN))) === "v1", `${label}: a row reads before its expiry`);
  ok((await store.getMeetingData(A, "k1", iso(T0 + HOUR))) === null, `🔴 ${label}: a row does NOT read at its expiry`);
  ok((await store.getMeetingData(A, "k1", iso(T0 + 2 * HOUR))) === null, `🔴 ${label}: a row does NOT read after its expiry, even though nothing deleted it`);
  ok((await store.getMeetingData(B, "k1", iso(T0))) === null, `${label}: another org never reads the row`);
  ok((await store.putMeetingDataIfAbsent(A, "k1", "v2", iso(T0 + 10 * MIN), iso(T0 + 5 * HOUR))) === false, `${label}: put-if-absent refuses a LIVE row`);
  ok((await store.getMeetingData(A, "k1", iso(T0 + 20 * MIN))) === "v1", `${label}: …and leaves it unchanged`);
  ok((await store.putMeetingDataIfAbsent(A, "k1", "v3", iso(T0 + 2 * HOUR), iso(T0 + 3 * HOUR))) === true, `🔴 ${label}: put-if-absent REPLACES an expired row, so a stale claim never blocks a new one`);
  ok((await store.getMeetingData(A, "k1", iso(T0 + 2 * HOUR))) === "v3", `${label}: …with the new value and the new expiry`);

  await store.putMeetingData(A, "short", "s", iso(T0), iso(T0 + MIN));
  await store.putMeetingData(A, "long", "l", iso(T0), iso(T0 + 30 * 24 * HOUR));
  await store.putMeetingData(B, "short", "s", iso(T0), iso(T0 + MIN));
  ok((await store.sweepMeetingData(A, iso(T0 + 5 * MIN))) === 1, `${label}: the sweep deletes exactly the one expired row of the org`);
  ok((await store.getMeetingData(A, "long", iso(T0 + 5 * MIN))) === "l", `${label}: …and keeps the live one`);
  ok((await store.getMeetingData(B, "short", iso(T0))) === "s", `${label}: …and never touches another org's rows`);
  await store.putMeetingData(B, "other", "o", iso(T0 + 2 * MIN), iso(T0 + HOUR));
  ok((await store.getMeetingData(B, "short", iso(T0))) === null, `${label}: a write deletes its own org's rows that are past their own expiry`);
  ok((await store.deleteMeetingData(A, "long")) === true && (await store.getMeetingData(A, "long", iso(T0))) === null, `${label}: delete removes one row`);
}

console.log("1. the store contract:");
await contract(getOperationalStore(), "sqlite");
{
  const pg = await openTestPg();
  await initOperationalSchema(pg.client);
  await contract(makeOperationalPostgresStore(pg.client), "postgres");
}

console.log("2. a short-TTL write elsewhere no longer deletes a meeting row:");
{
  const org = deploymentOrg();
  await meetingStore.putMeetingRow(org, "meeting:mtg_survivesashortttlwrite00", "{}", 24 * HOUR);
  await new Promise((r) => setTimeout(r, 20));
  await getOperationalStore().putTaskResult(org, "cancel-work:x", "1", new Date().toISOString(), 1);
  ok((await meetingStore.getMeetingRow(org, "meeting:mtg_survivesashortttlwrite00")) === "{}", "🔴 a 1 ms task_result write leaves a live meeting row in place");
}

console.log("3. the meeting-sweep schedule deletes expired meeting rows:");
{
  const org = deploymentOrg();
  await meetingStore.putMeetingRow(org, "meeting-chunk:mtg_expiredchunk0000000000:0", "{}", 1);
  await new Promise((r) => setTimeout(r, 20));
  const EPOCH = iso(0);
  ok((await getOperationalStore().getMeetingData(org, "meeting-chunk:mtg_expiredchunk0000000000:0", EPOCH)) !== null, "the expired row is still on the disk before the tick (read at the epoch to see it)");
  ok((await meetingStore.getMeetingRow(org, "meeting-chunk:mtg_expiredchunk0000000000:0")) === null, "…but no read returns it now");
  await meetingSweep.run();
  ok((await getOperationalStore().getMeetingData(org, "meeting-chunk:mtg_expiredchunk0000000000:0", EPOCH)) === null, "🔴 one tick of the meeting-sweep schedule deletes it from the disk");
}

console.log("4. the provenance marks:");
{
  const fresh = "org-without-recaps";
  ok(!(await provenance.chatReadCarriesMeetingPost(fresh, { platform: "slack", container: "C1", threadRoot: "1.1", botMessageIds: ["1.2"] })), "an org with no recap answers false");
  const org = deploymentOrg();
  const inThread = { platform: "slack", channelId: "C9", threadTs: "100.1" };
  await provenance.markMeetingPostTarget(org, inThread);
  await provenance.markMeetingPostId(org, inThread, "100.9");
  ok(await provenance.chatReadCarriesMeetingPost(org, { platform: "slack", container: "C9", threadRoot: "100.1", botMessageIds: [] }), "a read of the recap's thread carries the mark");
  ok(await provenance.chatReadCarriesMeetingPost(org, { platform: "slack", container: "C9", botMessageIds: ["5.5", "100.9"] }), "a page with the recap's post id carries the mark");
  ok(!(await provenance.chatReadCarriesMeetingPost(org, { platform: "slack", container: "C9", threadRoot: "200.1", botMessageIds: ["5.5"] })), "another thread with an unmarked bot line does not");
  ok(!(await provenance.chatReadCarriesMeetingPost(org, { platform: "slack", container: "C8", threadRoot: "100.1", botMessageIds: ["100.9"] })), "the same ids in another container do not");
  ok(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C9", threadRoot: "100.1" }), "a turn in the recap's thread is marked");
  ok(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C9" }), "🔴 a top-level turn in that container is marked inside the window: its backscroll can carry the threaded recap");
  ok(!(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C9" }, Date.now() + provenance.TOP_LEVEL_MARK_TTL_MS + MIN)), "…and clean after it");
  ok(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C9", threadRoot: "100.1" }, Date.now() + provenance.TOP_LEVEL_MARK_TTL_MS + MIN), "…while the recap's own thread stays marked");
  const edge = Date.now() + provenance.TOP_LEVEL_MARK_TTL_MS;
  ok(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C9" }, edge - 5 * MIN, "turn-sticky"), "a top-level turn just inside the window is marked, and its turn id is recorded");
  ok(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C9" }, edge + 5 * MIN, "turn-sticky"), "🔴 a redelivery of THAT turn just after the window still reads marked");
  ok(!(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C9" }, edge + 5 * MIN, "turn-other")), "…while a new turn after the window does not");

  const topLevel = { platform: "slack", channelId: "C7", threadTs: null };
  await provenance.markMeetingPostTarget(org, topLevel);
  await provenance.markMeetingPostId(org, topLevel, "300.3");
  ok(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C7" }), "a top-level recap marks the top level of its container");
  ok(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C7", threadRoot: "300.3" }), "…and the thread it roots");
  ok(!(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C7" }, Date.now() + provenance.TOP_LEVEL_MARK_TTL_MS + MIN)), "the top-level mark lapses after its bounded window");
  ok(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C7", threadRoot: "300.3" }, Date.now() + provenance.TOP_LEVEL_MARK_TTL_MS + MIN), "…while the post's own thread stays marked");

  const real = getOperationalStore();
  const broken = { ...real, getMeetingData: async () => { throw new Error("store down"); } } as OperationalStore;
  registerOperationalStore(broken);
  resetOperationalStore();
  ok(!(await provenance.chatReadCarriesMeetingPost(org, { platform: "slack", container: "C1", botMessageIds: ["1"] })), "a store error with meetings OFF answers not marked");
  setMeetingPolicyForTest({ ...DEFAULT_MEETING_POLICY, native: { enabled: true, watchHours: 24, meet: { domains: ["example.com"], serviceAccountKeyRef: "MEET_KEY", why: "test" } } });
  ok(await provenance.chatReadCarriesMeetingPost(org, { platform: "slack", container: "C1", botMessageIds: ["1"] }), "🔴 a store error with meetings ON answers marked (fail closed)");
  ok(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C1", threadRoot: "1" }), "🔴 …for the turn leg too");
  resetMeetingPolicyForTest();
  const readOnly = { ...real, putMeetingData: async () => { throw new Error("write refused"); } } as OperationalStore;
  registerOperationalStore(readOnly);
  resetOperationalStore();
  ok(await provenance.turnLocusCarriesMeetingPost(org, { platform: "slack", container: "C9", threadRoot: "100.1" }, Date.now(), "ses_x:turn_0"), "🔴 a failed sticky-record write never turns a found mark into not marked (meetings off)");
  registerOperationalStore(real);
  resetOperationalStore();
  ok((await meetingStore.getMeetingRow(org, "meeting-post-any")) !== null, "the real store is back");
}

console.log("5. the read leg:");

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

const ctx = {} as BindableContext;
const recapLine = (bot: boolean): RenderedLine => ({ author: bot ? "B0" : "U1", ts: "100.9", text: "Meeting recap: Zoom, 30 min", ...(bot ? { bot: true } : { authorId: "U1" }) });
const pageAdapter = (lines: readonly RenderedLine[]): ReadAdapter => ({
  platform: "slack",
  wakeAddress: () => undefined,
  readChannel: async () => lines,
  readThread: async () => lines,
});
const human: RenderedLine = { author: "U2", ts: "100.5", text: "please make tickets for these", authorId: "U2" };
{
  const page = await readChannelResult(ctx, "slack", pageAdapter([human, recapLine(true)]), "C9");
  ok(page.carriesUntrustedPost === true, "🔴 a channel page with the marked recap post carries the flag");
  ok(classifyIngestion(chatReadIngestion("read_channel:slack", page)).tier === "untrusted", "🔴 …and the table grades it untrusted");
  const asHuman = await readChannelResult(ctx, "slack", pageAdapter([human, recapLine(false)]), "C9");
  ok(!("carriesUntrustedPost" in asHuman), "a HUMAN line with the same id is never looked up: only a machine line can be OE's post");
  ok(classifyIngestion(chatReadIngestion("read_channel:slack", asHuman)).tier === "trusted", "…so a members-only page stays trusted");
  const unmarked = await readChannelResult(ctx, "slack", pageAdapter([human, { ...recapLine(true), ts: "999.9" }]), "C9");
  ok(!("carriesUntrustedPost" in unmarked), "an unmarked bot line leaves the page unflagged");
  const thread = await readThreadResult(ctx, "slack", pageAdapter([human]), "C9", "100.1");
  ok(thread.carriesUntrustedPost === true, "🔴 a read of the recap's THREAD carries the flag even when the recap scrolled off the page");
  const otherThread = await readThreadResult(ctx, "slack", pageAdapter([human]), "C9", "200.1");
  ok(!("carriesUntrustedPost" in otherThread), "another thread does not");

  const project = authoredModelProjectionFor("read_thread");
  ok(typeof project === "function", "read_thread authors a replayable projection");
  await eveContextStorage().run(new FakeSession(), async () => {
    ok(untrustedIngestedThisTurn() === false, "the turn starts clean");
    await project!(thread);
    ok(untrustedIngestedThisTurn() === true, "🔴 read_thread over the recap's thread MARKS the turn");
    assert.deepStrictEqual(taintKindsThisTurn(), ["chat-message"]);
    n++;
  });
  await eveContextStorage().run(new FakeSession(), async () => {
    await project!(otherThread);
    ok(untrustedIngestedThisTurn() === false, "🔴 negative control: read_thread over another thread leaves the turn CLEAN");
  });
}

console.log("6. the turn leg:");
{
  let address: { container: string; threadRoot?: string } | undefined;
  registerReadAdapter({ platform: "fakechat", wakeAddress: () => address, readChannel: async () => [], readThread: async () => [] });
  await provenance.markMeetingPostTarget(deploymentOrg(), { platform: "fakechat", channelId: "R1", threadTs: "t-1" });
  const turnCtx = { session: { auth: { current: { attributes: { oe_platform: "fakechat" } } } } } as unknown as BindableContext;
  address = { container: "R1", threadRoot: "t-1" };
  await eveContextStorage().run(new FakeSession(), async () => {
    await markIfTurnLocusCarriesMeetingPost(turnCtx, "ses_a", "turn_0");
    ok(untrustedIngestedThisTurn() === true, "🔴 a turn that woke in the recap's thread is marked before its first action");
  });
  address = { container: "R1", threadRoot: "t-2" };
  await eveContextStorage().run(new FakeSession(), async () => {
    await markIfTurnLocusCarriesMeetingPost(turnCtx, "ses_b", "turn_0");
    ok(untrustedIngestedThisTurn() === true, "a turn in another thread of the same container is marked inside the window (its catch-up can read the channel)");
  });
  address = { container: "R2", threadRoot: "t-1" };
  await eveContextStorage().run(new FakeSession(), async () => {
    await markIfTurnLocusCarriesMeetingPost(turnCtx, "ses_c", "turn_0");
    ok(untrustedIngestedThisTurn() === false, "🔴 negative control: a turn in another container stays clean");
  });
  address = undefined;
  await eveContextStorage().run(new FakeSession(), async () => {
    await markIfTurnLocusCarriesMeetingPost(turnCtx, "ses_d", "turn_0");
    ok(untrustedIngestedThisTurn() === false, "a turn with no readable locus is left as it is");
  });

  address = { container: "R3", threadRoot: "t-9" };
  await eveContextStorage().run(new FakeSession(), async () => {
    await markIfTurnLocusCarriesMeetingPost(turnCtx, "ses_e", "turn_1");
    ok(untrustedIngestedThisTurn() === false, "session E's turn_1 in an unmarked container is clean, and is memoised as checked");
  });
  address = { container: "R1", threadRoot: "t-1" };
  await eveContextStorage().run(new FakeSession(), async () => {
    await markIfTurnLocusCarriesMeetingPost(turnCtx, "ses_f", "turn_1");
    ok(untrustedIngestedThisTurn() === true, "🔴 session F's turn_1 in the recap's thread is STILL marked: E's memo does not cover it");
  });
  address = { container: "R3", threadRoot: "t-9" };
  await eveContextStorage().run(new FakeSession(), async () => {
    await markIfTurnLocusCarriesMeetingPost(turnCtx, "ses_g", "turn_1");
    ok(untrustedIngestedThisTurn() === false, "🔴 session G's turn_1 in an unmarked container stays clean: F's sticky row does not cover it");
  });
}

await closeAllTestPg();
console.log(`✓ meeting-provenance-test: ${n} assertions`);
process.exit(0);
