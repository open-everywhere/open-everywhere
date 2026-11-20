// proves: SEAT-30, SEAT-31

import assert from "node:assert";
import { bindFrom, registerIdentityMapper, type BindableContext } from "../agent/identity/binding.js";
import { registerConfig } from "../agent/access/config.js";
import { registerReadAdapter, type ReadAdapter, type RenderedLine, type WakeReadAddress } from "../agent/channels/channel-read.js";
import { resolveWakeChannel, requireWakeThreadRoot, WakeContainerError } from "../agent/channels/wake-container.js";
import readChannelDynamic from "../agent/tools/read_channel.js";
import readThreadDynamic from "../agent/tools/read_thread.js";
import { _dynamicResolverForTest } from "../agent/access/window-gated.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const PLATFORM = "slack";

const lines: RenderedLine[] = [{ author: "U1", ts: "1", text: "hello", authorId: "U1" }];
let lastRead: { container?: string; threadTs?: string } = {};
const adapter: ReadAdapter = {
  platform: PLATFORM,
  wakeAddress(ctx): WakeReadAddress | undefined {
    const b = bindFrom(ctx);
    const container = typeof b.target?.["channelId"] === "string" ? (b.target["channelId"] as string) : undefined;
    if (!container) return undefined;
    return { container, ...(b.threadTs ? { threadRoot: b.threadTs } : {}) };
  },
  async readChannel(_ctx, channel) {
    lastRead = { container: channel };
    return lines;
  },
  async readThread(_ctx, channel, threadTs) {
    lastRead = { container: channel, threadTs };
    return lines;
  },
};
registerReadAdapter(adapter);

registerIdentityMapper(PLATFORM, (c) => {
  const a = (c.session?.auth?.current?.attributes ?? {}) as Record<string, string>;
  return {
    workspace: a["team_id"],
    surface: a["channel_id"],
    mode: "channel",
    visibility: "private",
    trust: "internal",
    ...(a["channel_id"] ? { target: { channelId: a["channel_id"] } } : {}),
    ...(a["thread_ts"] ? { threadTs: a["thread_ts"] } : {}),
    ...(a["anchor_channel_id"] ? { anchorChannelId: a["anchor_channel_id"] } : {}),
  };
});

registerConfig({
  loadDomains: () => [{ name: "d", reach: [`${PLATFORM}/T1/C1`] }],
} as unknown as Parameters<typeof registerConfig>[0]);

function turn(attrs: Record<string, string>): BindableContext {
  return {
    channel: { kind: PLATFORM, continuationToken: "cse_seat" },
    session: { auth: { current: { attributes: { oe_platform: PLATFORM, ...attrs }, principalId: "U9" } } },
  } as unknown as BindableContext;
}

const DOMAINS = [{ name: "d", reach: [`${PLATFORM}/T1/C1`] }] as never;

console.log("1. the tool surface:");
{
  const mount = (dyn: unknown): { inputSchema?: { shape?: Record<string, unknown>; parse?: (v: unknown) => unknown } } | null => {
    const handler = _dynamicResolverForTest(dyn);
    return handler({}, turn({ team_id: "T1", channel_id: "C1" })) as never;
  };

  const channelEntry = mount(readChannelDynamic);
  const threadEntry = mount(readThreadDynamic);
  ok(channelEntry !== null, "read_channel mounts on a seat whose window has a source (the precondition every case below rests on)");
  ok(threadEntry !== null, "read_thread mounts on the same seat");

  eq(Object.keys(channelEntry!.inputSchema!.shape!).sort(), ["limit"], "🔴 OPE-929: read_channel's input schema is EXACTLY { limit } — no `channel`, so a cross-container read is not expressible");
  eq(Object.keys(threadEntry!.inputSchema!.shape!).sort(), ["limit"], "🔴 OPE-929: read_thread's input schema is EXACTLY { limit } — no `channel` and no `thread_ts`");

  eq(
    channelEntry!.inputSchema!.parse!({ channel: "ch_somewhere_else", limit: 5 }),
    { limit: 5 },
    "🔴 negative control: a `channel` argument does not survive the schema — an attempted target is dropped, never honoured",
  );
  eq(
    threadEntry!.inputSchema!.parse!({ channel: "ch_x", thread_ts: "999.1", limit: 3 }),
    { limit: 3 },
    "🔴 negative control: neither `channel` nor `thread_ts` survives read_thread's schema",
  );

  eq(channelEntry!.inputSchema!.parse!({ limit: 7 }), { limit: 7 }, "…while `limit` does survive — the schema is not simply empty");
  eq(channelEntry!.inputSchema!.parse!({}), {}, "…and `limit` stays optional (an omitting call is the common one)");
}

console.log("2. the derivation:");
{
  const t = resolveWakeChannel(turn({ team_id: "T1", channel_id: "C1" }), DOMAINS);
  eq(t.platform, PLATFORM, "resolveWakeChannel resolves the turn's ORIGIN platform (no target names one)");
  eq(t.container, "C1", "…and the container is the binding's own channel id, host-resolved");
  ok(t.adapter === adapter, "…and the adapter is the one registered for that platform");

  eq(
    resolveWakeChannel(turn({ team_id: "T1", channel_id: "C1", anchor_channel_id: "REPLYCHAIN" }), DOMAINS).container,
    "C1",
    "🔴 the container comes from the ADAPTER's own wakeAddress — a stop-registry anchor beside it changes nothing",
  );

  let threw = "";
  try {
    resolveWakeChannel(turn({ team_id: "T1" }), DOMAINS);
  } catch (err) {
    threw = err instanceof WakeContainerError ? "wake-container" : `other:${String(err)}`;
  }
  eq(threw, "wake-container", "a turn whose binding names NO container refuses loudly — it never falls back to a sanitized key segment");

  eq(
    requireWakeThreadRoot(resolveWakeChannel(turn({ team_id: "T1", channel_id: "C1", thread_ts: "1699.1" }), DOMAINS)),
    "1699.1",
    "the thread root is the adapter's too — this fixture spells it the Slack way",
  );

  let threwThread = "";
  try {
    requireWakeThreadRoot(resolveWakeChannel(turn({ team_id: "T1", channel_id: "C1" }), DOMAINS));
  } catch (err) {
    threwThread = err instanceof WakeContainerError ? String((err as Error).message) : `other:${String(err)}`;
  }
  ok(threwThread.includes("not in a thread"), "a TOP-LEVEL turn gets an honest 'this turn is not in a thread' refusal, never an empty thread read");
  ok(threwThread.includes("read_channel"), "…and the refusal points at the verb that does apply");
}

console.log(`\n✓ chat-read-container (OPE-929): ${n} assertions passed (tool surface admits no target, container + thread root derived from the turn's binding)`);

// proves: TOOL-read_channel, TOOL-read_thread
