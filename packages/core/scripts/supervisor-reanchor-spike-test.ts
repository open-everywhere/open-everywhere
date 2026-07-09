import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;

const api = (await import(abs("dist/src/public/channels/slack/api.js"))) as {
  buildSlackBinding: (e: {
    botToken?: string;
    channelId: string;
    threadTs: string;
    teamId?: string;
    onThreadTsChanged?: (t: string) => void;
  }) => {
    thread: { post: (input: unknown) => Promise<{ id: string; raw: unknown }> };
    slack: { readonly threadTs: string; channelId: string };
  };
  slackContinuationToken: (channelId: string, threadTs: string) => string;
};
const { buildSlackBinding, slackContinuationToken } = api;
assert.equal(typeof buildSlackBinding, "function", "eve dist exports buildSlackBinding (real compiled code under test)");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
  console.log(`  ok ${n} — ${label}`);
};

const realFetch = globalThis.fetch;
let postCount = 0;
const postedTsLog: string[] = [];
function nextTs(): string {
  postCount += 1;
  const ts = `1700000000.00000${postCount}`;
  postedTsLog.push(ts);
  return ts;
}
globalThis.fetch = (async (url: unknown): Promise<unknown> => {
  const u = String(url);
  if (u.includes("chat.postMessage")) {
    const ts = nextTs();
    return { ok: true, json: async () => ({ ok: true, ts, channel: "C_SPIKE" }) };
  }
  throw new Error(`spike stub: unexpected non-post fetch to ${u}`);
}) as typeof globalThis.fetch;

const CHANNEL = "C_SPIKE";
const BOT_TOKEN = "xoxb-fake-spike-token";

try {
  {
    const SENTINEL = "oe-sup:g1";
    const supervisorToken = `${CHANNEL}:oe-sup:g1`;
    let liveToken = supervisorToken;
    let reanchorFires = 0;
    const reanchoredTo: string[] = [];

    const binding = buildSlackBinding({
      botToken: BOT_TOKEN,
      channelId: CHANNEL,
      threadTs: SENTINEL,
      onThreadTsChanged(t: string) {
        reanchorFires += 1;
        reanchoredTo.push(t);
        liveToken = slackContinuationToken(CHANNEL, t);
      },
    });

    const N = 4;
    for (let i = 0; i < N; i++) {
      const res = await binding.thread.post(`supervisor reply #${i + 1}`);
      ok(typeof res.id === "string" && res.id.length > 0, `leg1: post #${i + 1} returned a real posted ts (${res.id})`);
    }

    ok(reanchorFires === 0, `leg1: onThreadTsChanged NEVER fired across ${N} posts (fires=${reanchorFires})`);
    ok(reanchoredTo.length === 0, "leg1: no re-anchor target was ever recorded");
    ok(liveToken === supervisorToken, `leg1: continuation token UNCHANGED (${liveToken})`);
    ok(binding.slack.threadTs === SENTINEL, `leg1: eve binding's internal threadTs still the sentinel (${binding.slack.threadTs}) — guard short-circuited every time`);
    console.log(`  [leg1] posted ts values: ${postedTsLog.join(", ")}`);
  }

  {
    let reanchorFires = 0;
    const reanchoredTo: string[] = [];
    let liveToken = `${CHANNEL}:oe-sup:g0`;

    const binding = buildSlackBinding({
      botToken: BOT_TOKEN,
      channelId: CHANNEL,
      threadTs: "",
      onThreadTsChanged(t: string) {
        reanchorFires += 1;
        reanchoredTo.push(t);
        liveToken = slackContinuationToken(CHANNEL, t);
      },
    });

    const first = await binding.thread.post("first supervisor post (empty threadTs)");
    ok(reanchorFires === 1, `leg3: onThreadTsChanged fired EXACTLY once on the first post (fires=${reanchorFires})`);
    ok(reanchoredTo[0] === first.id, `leg3: re-anchored onto the first post's ts (${reanchoredTo[0]} === ${first.id})`);
    ok(liveToken === slackContinuationToken(CHANNEL, first.id), `leg3: continuation token RE-KEYED to ${liveToken}`);
    ok(binding.slack.threadTs === first.id, `leg3: eve binding's internal threadTs moved to the posted ts (${binding.slack.threadTs}) — session re-anchored`);

    const second = await binding.thread.post("second supervisor post");
    ok(reanchorFires === 1, `leg3: no SECOND re-anchor — the guard now short-circuits (fires still ${reanchorFires}), later posts (${second.id}) never re-key`);
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\nsupervisor-reanchor spike (Tier A): ${n} assertions passed.`);
console.log("VERDICT: amendment A holds — a non-empty state.threadTs sentinel makes eve's re-anchor STRUCTURALLY unreachable (leg 1),");
console.log("         while an empty threadTs re-keys on first post (leg 3, negative control). Proven against eve's REAL compiled buildSlackBinding.");
