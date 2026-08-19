import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { MarkEventSeen } from "../agent/operational/post-once.js";

const dir = join(tmpdir(), `open-everywhere-post-once-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { postOnce, outboundKey, OUTBOUND_DEDUPE_TTL_MS, OUTBOUND_KEY_PREFIX } = await import(
  "../agent/operational/post-once.js"
);

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function makeFakeStore() {
  const rows = new Map<string, number>();
  let clock = 1_000_000;
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const markEventSeen: MarkEventSeen = async (org, key, atIso, ttlMs) => {
    const at = Date.parse(atIso);
    const mapKey = `${org}\u0000${key}`;
    const prev = rows.get(mapKey);
    if (prev !== undefined && at - prev < ttlMs) return false;
    rows.set(mapKey, at);
    return true;
  };
  const forget = async (org: string, key: string): Promise<void> => {
    rows.delete(`${org}\u0000${key}`);
  };
  return { now, advance, markEventSeen, forget };
}

const K = (payload: string, over: Partial<{ action: string; channel: string; threadTs: string; stableId: string }> = {}) =>
  outboundKey({ surface: "slack", channel: over.channel ?? "C1", threadTs: over.threadTs, action: over.action ?? "act", stableId: over.stableId, payload });

{
  const store = makeFakeStore();
  let posts = 0;
  const key = K("hello world");
  const call = () => postOnce({ org: "acme", key, now: store.now, markEventSeen: store.markEventSeen, run: async () => void posts++ });
  await call();
  await call();
  await call();
  ok(posts === 1, "1. same key replayed three times → real post fires exactly once");
}

{
  const store = makeFakeStore();
  let posts = 0;
  const run = async () => void posts++;
  await postOnce({ org: "acme", key: K("message A"), now: store.now, markEventSeen: store.markEventSeen, run });
  await postOnce({ org: "acme", key: K("message B"), now: store.now, markEventSeen: store.markEventSeen, run });
  await postOnce({ org: "acme", key: K("same", { action: "other" }), now: store.now, markEventSeen: store.markEventSeen, run });
  await postOnce({ org: "acme", key: K("same", { channel: "C2" }), now: store.now, markEventSeen: store.markEventSeen, run });
  await postOnce({ org: "acme", key: K("same", { stableId: "call-1" }), now: store.now, markEventSeen: store.markEventSeen, run });
  await postOnce({ org: "acme", key: K("same", { stableId: "call-2" }), now: store.now, markEventSeen: store.markEventSeen, run });
  ok(posts === 6, "2. six genuinely-distinct sends → all six post (no false dedup on any axis)");
}

{
  const throwing: MarkEventSeen = async () => {
    throw new Error("dedupe store down");
  };
  let posts = 0;
  const key = K("outage");
  await postOnce({ org: "acme", key, markEventSeen: throwing, run: async () => void posts++ });
  await postOnce({ org: "acme", key, markEventSeen: throwing, run: async () => void posts++ });
  ok(posts === 2, "3. store throws → fail-open: both identical sends post (a drop is worse than a dup)");

  let posts2 = 0;
  await postOnce({ org: undefined, key, markEventSeen: throwing, run: async () => void posts2++ });
  await postOnce({ org: "", key, markEventSeen: throwing, run: async () => void posts2++ });
  ok(posts2 === 2, "3b. absent org → fail-open: posts directly without touching the store");
}

{
  const store = makeFakeStore();
  let posts = 0;
  const key = K("done");
  const call = () => postOnce({ org: "acme", key, now: store.now, markEventSeen: store.markEventSeen, run: async () => void posts++ });
  await call();
  store.advance(OUTBOUND_DEDUPE_TTL_MS - 1);
  await call();
  ok(posts === 1, "4a. identical repost INSIDE the TTL window → deduped (catches the resume duplicate)");
  store.advance(2);
  await call();
  ok(posts === 2, "4b. identical repost OUTSIDE the TTL window → posts again (no silent message loss)");
}

{
  const store = makeFakeStore();
  const inboundId = "default:Ev0123456789";
  await store.markEventSeen("acme", inboundId, new Date(store.now()).toISOString(), 600_000);

  const okey = K(inboundId, { action: "x" });
  ok(okey.startsWith(OUTBOUND_KEY_PREFIX), "5a. outbound key carries the outbound: namespace prefix");
  ok(okey !== inboundId, "5b. outbound key is not the raw inbound id");

  let posts = 0;
  await postOnce({ org: "acme", key: okey, now: store.now, markEventSeen: store.markEventSeen, run: async () => void posts++ });
  ok(posts === 1, "5c. an outbound post is NOT suppressed by a same-string inbound event_dedupe row");
}

{
  let posts = 0;
  const key = outboundKey({ surface: "slack", channel: "C9", action: "real", payload: "integration" });
  await postOnce({ org: "acme", key, run: async () => void posts++ });
  await postOnce({ org: "acme", key, run: async () => void posts++ });
  ok(posts === 1, "live: real sqlite store dedupes the same key within the TTL (exactly once)");
  await postOnce({ org: "globex", key, run: async () => void posts++ });
  ok(posts === 2, "live: the same key in another org is a fresh sighting (org-partitioned)");
}

{
  const boom = async (): Promise<void> => {
    throw Object.assign(new Error("the platform refused"), { applied: false });
  };

  {
    const store = makeFakeStore();
    const key = K("hold");
    let posts = 0;
    await postOnce({ org: "acme", key, now: store.now, markEventSeen: store.markEventSeen, run: boom }).catch(() => undefined);
    await postOnce({ org: "acme", key, now: store.now, markEventSeen: store.markEventSeen, run: async () => void posts++ });
    ok(posts === 0, "6a. WITHOUT a release predicate a failed post KEEPS its claim — the retry is suppressed (the old behaviour)");
  }

  {
    const store = makeFakeStore();
    const key = K("release");
    let posts = 0;
    let forgot: string | undefined;
    await postOnce({
      org: "acme",
      key,
      now: store.now,
      markEventSeen: store.markEventSeen,
      forgetEventSeen: async (_org, k) => {
        forgot = k;
        await store.forget("acme", k);
      },
      releaseKeyOnFailure: () => true,
      run: boom,
    }).catch(() => undefined);
    ok(forgot === key, "6b. the release names the SAME key the claim was taken on");
    await postOnce({ org: "acme", key, now: store.now, markEventSeen: store.markEventSeen, run: async () => void posts++ });
    ok(posts === 1, "6b. …so the IDENTICAL retry really posts — the definitive failure is not silently swallowed");
  }

  {
    const store = makeFakeStore();
    const key = K("ambiguous");
    let posts = 0;
    let released = false;
    await postOnce({
      org: "acme",
      key,
      now: store.now,
      markEventSeen: store.markEventSeen,
      forgetEventSeen: async () => void (released = true),
      releaseKeyOnFailure: () => false,
      run: boom,
    }).catch(() => undefined);
    ok(!released, "6c. a predicate answering false releases NOTHING");
    await postOnce({ org: "acme", key, now: store.now, markEventSeen: store.markEventSeen, run: async () => void posts++ });
    ok(posts === 0, "6c. …so the identical retry stays suppressed — an ambiguous failure must not double-post");
  }

  {
    const store = makeFakeStore();
    const key = K("rethrow");
    let seen: string | undefined;
    await postOnce({
      org: "acme",
      key,
      now: store.now,
      markEventSeen: store.markEventSeen,
      releaseKeyOnFailure: () => {
        throw new Error("predicate blew up");
      },
      run: boom,
    }).catch((e: unknown) => {
      seen = String((e as Error).message);
    });
    ok(seen === "the platform refused", "6d. the ORIGINAL error re-throws — the release path never swallows or replaces it");
  }

  {
    let posts = 0;
    const key = outboundKey({ surface: "slack", channel: "C9", action: "release-live", payload: "integration" });
    await postOnce({ org: "acme", key, releaseKeyOnFailure: () => true, run: boom }).catch(() => undefined);
    await postOnce({ org: "acme", key, run: async () => void posts++ });
    ok(posts === 1, "6e. live: the real sqlite store gives the key back, so the retry posts inside the TTL");
    await postOnce({ org: "acme", key, run: async () => void posts++ });
    ok(posts === 1, "6e. live NEGATIVE CONTROL: with no release the next identical send is deduped as before");
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(
  `✓ post-once — ${passed} assertions (exactly-once replay, no false dedup, fail-open, short-TTL repost, key namespacing, failed-post claim release, live sqlite wiring)`,
);
