import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { withPatchedFetch } from "../packages/core/scripts/_fetch-test-utils.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-discord-edit-locus-")), "ops.sqlite3");
process.env.OE_ORG = "acme";
process.env.DISCORD_BOT_TOKEN = "fixture-bot-token-not-a-secret";

const ORG = "acme";
const DOMAIN = "payments";
const GUILD = "G1";
const BASE_CHANNEL = "C_BASE";
const THREAD_CHANNEL = "C_THREAD";
const TRIGGER_MESSAGE = "M_TRIGGER";
const SURFACE = `discord/${GUILD}/${BASE_CHANNEL}`;

const messageHome = new Map<string, string>();
const threadOfMessage = new Map<string, string>();
let nextMessageId = 1;
const posts: { channel: string; content: string }[] = [];
const patches: { channel: string; messageId: string; content: string; status: number }[] = [];
let threadCreateCalls = 0;
let messageGetCalls = 0;

type StubRes = { ok: boolean; status: number; json: () => Promise<unknown> };
const res = (status: number, body: unknown): StubRes => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const fakeDiscordFetch = (async (input: unknown, init?: { method?: string; body?: string }): Promise<unknown> => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname.replace(/^\/api\/v\d+/, "");
  const threadCreate = /^\/channels\/([^/]+)\/messages\/([^/]+)\/threads$/.exec(path);
  const message = /^\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(path);
  const create = /^\/channels\/([^/]+)\/messages$/.exec(path);

  if (threadCreate && method === "POST") {
    threadCreateCalls++;
    threadOfMessage.set(threadCreate[2]!, THREAD_CHANNEL);
    return res(200, { id: THREAD_CHANNEL });
  }
  if (create && method === "POST") {
    const channel = create[1]!;
    const id = `msg-${nextMessageId++}`;
    messageHome.set(id, channel);
    posts.push({ channel, content: String(JSON.parse(init?.body ?? "{}").content ?? "") });
    return res(200, { id });
  }
  if (message && method === "GET") {
    messageGetCalls++;
    const [, channel, messageId] = message as unknown as [string, string, string];
    if (messageHome.get(messageId) !== channel && messageId !== TRIGGER_MESSAGE) return res(404, {});
    const thread = threadOfMessage.get(messageId);
    return res(200, thread ? { id: messageId, thread: { id: thread } } : { id: messageId });
  }
  if (message && method === "PATCH") {
    const [, channel, messageId] = message as unknown as [string, string, string];
    const status = messageHome.get(messageId) === channel ? 200 : 404;
    patches.push({ channel, messageId, content: String(JSON.parse(init?.body ?? "{}").content ?? ""), status });
    return res(status, status === 200 ? { id: messageId } : {});
  }
  return res(404, {});
}) as unknown as typeof fetch;

await withPatchedFetch(fakeDiscordFetch, async () => {

messageHome.set(TRIGGER_MESSAGE, BASE_CHANNEL);

const { registerDiscordProvider } = await import("@open-everywhere/provider-discord/agent/register.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { defineDomain } = await import("@open-everywhere/core/agent/memory/domain.js");
const { registerUnifiedWakeTarget, mintWakeId } = await import("@open-everywhere/core/agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("@open-everywhere/core/agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
const { readAudit } = await import("@open-everywhere/core/agent/audit/audit.js");
const { recordOwnPost } = await import("@open-everywhere/core/agent/channels/own-post-ledger.js");
const { EDIT_PLATFORM_ERROR_REASON } = await import("@open-everywhere/core/agent/channels/reply-edit.js");

type BindableContext = import("@open-everywhere/core/agent/identity/binding.js").BindableContext;
type UnifiedWakeOrigin = import("@open-everywhere/core/agent/channels/unified-window.js").UnifiedWakeOrigin;

registerDiscordProvider();

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: DOMAIN, channels: [SURFACE], ambientSupervisor: true, mode: "unified" })],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === BASE_CHANNEL || surface === THREAD_CHANNEL ? [DOMAIN] : []),
});

const TOKEN = unifiedSupervisorToken(DOMAIN, 1);
const store = getOperationalStore();

const replyTool = (await import("@open-everywhere/core/agent/tools/reply.js")).default;
const editTool = (await import("@open-everywhere/core/agent/tools/edit_reply.js")).default;
interface Armed {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;
const armOf = (tool: unknown, ctx: unknown): Armed | null =>
  (tool as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as Armed | null;

function ctxFor(turnWake: string, turnId: string): BindableContext {
  return {
    channel: { kind: "channel:unified", continuationToken: `unified:${TOKEN}` },
    session: {
      id: "discord-edit-locus-test",
      turn: { id: turnId },
      auth: {
        current: {
          attributes: {
            oe_platform: "discord",
            oe_wake_id: turnWake,
            oe_window_token: TOKEN,
            channel_id: BASE_CHANNEL,
            guild_id: GUILD,
          },
          principalId: "U1",
          principalType: "discord-user",
        },
      },
    },
  } as unknown as BindableContext;
}

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
function newSession(): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "discord-edit-locus-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callReply(turnWake: string, turnId: string, wake: string, text: string): Promise<{ id?: string; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = armOf(replyTool, ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done: true, force: false }, ctx)
    .then((r) => r as { id?: string })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function callEdit(turnWake: string, turnId: string, wake: string, messageId: string, text: string): Promise<{ edited?: boolean; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = armOf(editTool, ctx);
  if (!armed) return { error: "edit_reply did not arm" };
  return armed
    .execute({ text, wake, message_id: messageId }, ctx)
    .then((r) => r as { edited?: boolean })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function wakeFor(origin: UnifiedWakeOrigin): Promise<string> {
  const id = mintWakeId();
  await registerUnifiedWakeTarget(store, ORG, id, origin, new Date(Date.now() - 1000).toISOString(), TOKEN, true);
  return id;
}

const rowsFor = async (action: string, wakeId: string): Promise<Record<string, unknown>[]> =>
  (await readAudit({ org: ORG, action }))
    .map((r) => (r.detail ?? {}) as Record<string, unknown>)
    .filter((d) => d["wakeId"] === wakeId);

{
  const inTurn = newSession();
  const w = await wakeFor({
    platform: "discord",
    channelId: BASE_CHANNEL,
    guildId: GUILD,
    messageId: TRIGGER_MESSAGE,
    autoThreadName: "the question",
  });

  const r = await inTurn(() => callReply(w, "turn_1", w, "1. Mars\n2. Venus"));
  ok(typeof r.id === "string" && r.id.length > 0, "§1: `reply` returns the platform message id the edit verb addresses");
  ok(messageHome.get(r.id as string) === THREAD_CHANNEL, "§1/POST: the reply landed in the AUTO-THREAD, not the base channel — the premise of this file");

  const patchesBefore = patches.length;
  const e = await inTurn(() => callEdit(w, "turn_1", w, r.id as string, "1. Mars\n2. Venus\n3. Earth"));
  ok(e.edited === true, "§1: `edit_reply` succeeds on a reply that landed in an auto-thread (this threw a 404 before OPE-798)");
  ok(patches.length === patchesBefore + 1, "§1/PATCH: exactly one PATCH reached Discord");
  const patch = patches[patches.length - 1]!;
  ok(patch.channel === THREAD_CHANNEL, "§1/LOCUS: the PATCH addressed the THREAD the message is in, never the frozen base channel");
  ok(patch.status === 200, "§1/LOCUS: Discord accepted it — the 404 was the wrong channel, nothing else");
  ok(patch.messageId === r.id, "§1/PATCH: it addressed the id `reply` returned");
  ok(patch.content === "1. Mars\n2. Venus\n3. Earth", "§1/PATCH: the replacement text is what the model passed");
  ok(posts.length === 1, "§1/ROOM: the edit added NO message to the room — an edit is not a delivery channel");
  ok((await rowsFor("reply.edit", w)).length === 1, "§1/AUDIT: one `reply.edit` row");
  ok((await rowsFor("reply.edit.refused", w)).length === 0, "§1/AUDIT: no refusal row on the happy path");

  ok(threadCreateCalls === 1, "§3: the edit path NEVER creates a thread — the one create is the post path's");
  ok(messageGetCalls >= 1, "§3: the edit path RESOLVED the thread by reading the trigger message");
}

{
  const inTurn = newSession();
  const w = await wakeFor({ platform: "discord", channelId: BASE_CHANNEL, guildId: GUILD, messageId: TRIGGER_MESSAGE });

  const createsBefore = threadCreateCalls;
  const getsBefore = messageGetCalls;
  const r = await inTurn(() => callReply(w, "turn_2", w, "Base channel answer."));
  ok(typeof r.id === "string", "§2: `reply` posted");
  ok(messageHome.get(r.id as string) === BASE_CHANNEL, "§2/POST: with no auto-thread name the reply stays in the BASE channel");

  const patchesBefore = patches.length;
  const e = await inTurn(() => callEdit(w, "turn_2", w, r.id as string, "Base channel answer, corrected."));
  ok(e.edited === true, "§2: `edit_reply` still succeeds on a base-channel reply");
  ok(patches.length === patchesBefore + 1, "§2/PATCH: exactly one PATCH reached Discord");
  const patch = patches[patches.length - 1]!;
  ok(patch.channel === BASE_CHANNEL, "§2/LOCUS: it addressed the BASE channel — the retarget does not move an edit that has nowhere to go");
  ok(patch.status === 200, "§2/LOCUS: Discord accepted it");
  ok(threadCreateCalls === createsBefore, "§2: no thread was created on either path");
  ok(messageGetCalls === getsBefore, "§2: the retarget did not even READ — an origin with no auto-thread name short-circuits");
}

{
  const inTurn = newSession();
  const w = await wakeFor({ platform: "discord", channelId: BASE_CHANNEL, guildId: GUILD, messageId: TRIGGER_MESSAGE });

  const ghost = "msg-ghost";
  await recordOwnPost(ORG, { platform: "discord", channelId: BASE_CHANNEL }, ghost);

  const patchesBefore = patches.length;
  const e = await inTurn(() => callEdit(w, "turn_3", w, ghost, "This edit cannot land."));
  ok(typeof e.error === "string", "§4: the tool still throws — the model must learn the edit did not land");
  ok(patches.length === patchesBefore + 1 && patches[patches.length - 1]!.status === 404, "§4: the PATCH really was rejected");

  const refusals = await rowsFor("reply.edit.refused", w);
  ok(refusals.length === 1, "§4/AUDIT: a platform rejection writes exactly one `reply.edit.refused` row — no silent hole");
  ok(refusals[0]!["reason"] === EDIT_PLATFORM_ERROR_REASON, "§4/AUDIT: the reason separates a vendor rejection from a host verdict");
  ok(refusals[0]!["status"] === 404, "§4/AUDIT: the row carries the platform HTTP status that caused it");
  ok((await rowsFor("reply.edit", w)).length === 0, "§4/AUDIT: and NO `reply.edit` row — nothing changed");
}

});
console.log(`✓ discord edit locus (OPE-798): ${passed} assertions`);
