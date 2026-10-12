import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { pinSuiteStore } from "../packages/core/scripts/_suite-store.js";
pinSuiteStore("meeting-provenance-surfaces");
delete process.env.DATABASE_URL;
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";

import { READ_ADAPTERS } from "@open-everywhere/core/agent/channels/channel-read.js";
import { bindFrom, deploymentOrg, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { markMeetingPostTarget, markMeetingPostId, turnLocusCarriesMeetingPost, TOP_LEVEL_MARK_TTL_MS } from "@open-everywhere/core/agent/meetings/provenance.js";
import { untrustedIngestedThisTurn } from "@open-everywhere/core/agent/access/taint-signal.js";
import { markIfTurnLocusCarriesMeetingPost } from "@open-everywhere/core/agent/hooks/spawn-taint.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { buildDiscordAuth } from "@open-everywhere/provider-discord/agent/channels/discord-identity.js";
import { discordReadAdapter } from "@open-everywhere/provider-discord/agent/channels/discord-read.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { buildTeamsAuth } from "@open-everywhere/provider-teams/agent/channels/teams-identity.js";
import { teamsReadAdapter } from "@open-everywhere/provider-teams/agent/channels/teams-read.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

registerDiscordProvider();
registerTeamsProvider();
ok(READ_ADAPTERS["discord"] === discordReadAdapter && READ_ADAPTERS["teams"] === teamsReadAdapter, "both real read adapters are registered");

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

function originOf(ctx: BindableContext): { platform: string; channelId: string; threadTs: string | null } {
  const b = bindFrom(ctx);
  const channelId = b.target?.["channelId"];
  assert.ok(typeof channelId === "string", "the binding carries target.channelId");
  return { platform: b.platform, channelId, threadTs: b.threadTs ?? null };
}

async function postRecapFrom(ask: BindableContext, postId: string): Promise<void> {
  const origin = originOf(ask);
  await markMeetingPostTarget(deploymentOrg(), origin);
  await markMeetingPostId(deploymentOrg(), origin, postId);
}

let turn = 0;
async function marked(ctx: BindableContext): Promise<boolean> {
  return await eveContextStorage().run(new FakeSession(), async () => {
    await markIfTurnLocusCarriesMeetingPost(ctx, `ses_${++turn}`, "turn_0");
    return untrustedIngestedThisTurn();
  });
}

console.log("Discord:");
{
  const discord = (channelId: string, parentChannelId?: string): BindableContext =>
    ({ channel: { kind: "discord" }, session: { auth: { current: buildDiscordAuth({ userId: "U-ALICE", guildId: "G1", channelId, ...(parentChannelId ? { parentChannelId } : {}) }) } } }) as unknown as BindableContext;
  const inThread = discord("T-42", "C-ENG");
  ok(originOf(inThread).threadTs === null, "premise: a Discord origin carries no threadTs");
  const address = discordReadAdapter.wakeAddress(inThread);
  ok(address?.container === "T-42" && address.threadRoot === "T-42", "premise: a Discord thread turn's locus is (T-42, T-42)");
  await postRecapFrom(inThread, "M-900");
  ok(await marked(inThread), "🔴 a later turn in the same Discord thread is marked");
  const afterWindow = Date.now() + TOP_LEVEL_MARK_TTL_MS + 60_000;
  ok(await turnLocusCarriesMeetingPost(deploymentOrg(), { platform: "discord", ...address! }, afterWindow), "🔴 …and stays marked after the 7-day top-level window (the thread is marked as its own channel)");
  ok(!(await marked(discord("C-OTHER"))), "🔴 negative control: a turn in an unrelated channel stays clean");
  ok(!(await marked(discord("T-43", "C-ENG"))), "🔴 negative control: a turn in another thread of the same parent stays clean (that thread is another channel)");
  const topLevel = discord("C-STANDUP");
  await postRecapFrom(topLevel, "M-901");
  ok(await marked(topLevel), "a later top-level turn in the channel that got a top-level recap is marked");
}

console.log("Teams:");
{
  const teams = (channelId: string, rootId: string): BindableContext =>
    ({
      channel: { kind: "teams" },
      session: { auth: { current: buildTeamsAuth({ userId: "U5", tenantId: "TEN1", conversationId: `${channelId};messageid=${rootId}`, channelId, teamId: "TEAM1", serviceUrl: "https://smba.trafficmanager.net/emea/", scope: "channel" }) } },
    }) as unknown as BindableContext;
  const ask = teams("19:chan1@thread.tacv2", "1001");
  ok(originOf(ask).threadTs === null, "premise: a Teams origin carries no threadTs");
  const address = teamsReadAdapter.wakeAddress(ask);
  ok(address?.container === "19:chan1@thread.tacv2" && address.threadRoot === "1001", "premise: a Teams channel turn's locus is (channel, reply-chain root)");
  ok(!(await marked(teams("19:chan1@thread.tacv2", "2002"))), "before any recap, a turn in the channel is clean");
  await postRecapFrom(ask, "3003");
  ok(await marked(teams("19:chan1@thread.tacv2", "2002")), "🔴 a later turn in ANOTHER reply chain of the recap's channel is marked (its catch-up reads the channel)");
  ok(await marked(teams("19:chan1@thread.tacv2", "3003")), "🔴 a turn in the reply chain the recap roots is marked");
  ok(!(await marked(teams("19:chan2@thread.tacv2", "1001"))), "🔴 negative control: a turn in an unrelated channel stays clean");
}

console.log(`✓ meeting-provenance-surfaces-test: ${n} assertions`);
process.exit(0);
