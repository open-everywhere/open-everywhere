import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteHandlerArgs } from "eve/channels";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-owned-thread-ingress-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.LINEAR_API_KEY = "linear-test-key";

const { getOperationalStore, deploymentOrg, registerSettings, resolvePartition, OE_GRAIN_ATTR } = await import(
  "@open-everywhere/core/agent/adapter-api.js"
);
const { unifiedThreadRef, mintWakeId } = await import("@open-everywhere/core/agent/channels/unified-window.js");
const { recordThreadOwner, clearThreadOwner } = await import("@open-everywhere/core/agent/channels/thread-ownership.js");
const { formatWindowToken, parseWindowToken, threadSeatWindowId } = await import("@open-everywhere/core/agent/channels/window-key.js");
type UnifiedWakeOrigin = Parameters<typeof unifiedThreadRef>[0];

const { registerSlackProvider } = await import("@open-everywhere/provider-slack/agent/register.js");
const { registerDiscordProvider } = await import("@open-everywhere/provider-discord/agent/register.js");
const { registerTeamsProvider } = await import("@open-everywhere/provider-teams/agent/register.js");
const { registerGithubProvider } = await import("@open-everywhere/provider-github/agent/register.js");
const { registerLinearProvider } = await import("@open-everywhere/provider-linear/agent/register.js");
const { registerNotionProvider } = await import("@open-everywhere/provider-notion/agent/register.js");
registerSlackProvider();
registerDiscordProvider();
registerTeamsProvider();
registerGithubProvider();
registerLinearProvider();
registerNotionProvider();

const { withSingleWindowDiversion } = await import("@open-everywhere/provider-slack/agent/channels/slack-front.js");
const { divertDiscordWakeToUnifiedWindow, authForRelayMessage } = await import("@open-everywhere/provider-discord/agent/channels/discord-gateway.js");
const { liveTeamsSupervisorDeps } = await import("@open-everywhere/provider-teams/agent/channels/teams-front.js");
const { liveGitHubSupervisorDeps } = await import("@open-everywhere/provider-github/agent/channels/github.js");
const { liveLinearSupervisorDeps } = await import("@open-everywhere/provider-linear/agent/channels/linear.js");
const { liveNotionSupervisorDeps } = await import("@open-everywhere/provider-notion/agent/channels/notion.js");

registerSettings({ delegation: { oneshotAgent: true }, github: { appSlug: "eve-bot" } });

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n += 1;
};

const ORG = deploymentOrg();
const store = getOperationalStore();
const DOMAIN = "wiring";
const GEN = 4;
const STANDING = formatWindowToken({ domain: DOMAIN, windowId: DOMAIN, generation: GEN });

interface ReceivedWake {
  readonly message: string;
  readonly target: { readonly token: string; readonly origin: UnifiedWakeOrigin };
  readonly auth: { readonly attributes?: Record<string, unknown> };
}
const received: ReceivedWake[] = [];
const captureReceive = ((_channel: unknown, rawTarget: unknown) => ({
  async send(message: string, options: { auth: unknown }) {
    received.push({ message, target: rawTarget as ReceivedWake["target"], auth: options.auth as ReceivedWake["auth"] });
    return undefined as never;
  },
})) as unknown as RouteHandlerArgs["to"];

function seatTokenFor(origin: UnifiedWakeOrigin, standing = STANDING): string {
  const ref = unifiedThreadRef(origin);
  const key = parseWindowToken(standing);
  assert.ok(key !== undefined, "precondition: the standing token parses as a window token");
  return formatWindowToken({ domain: key.domain, windowId: threadSeatWindowId(ref.channelKey, ref.threadKey), generation: key.generation });
}

async function assertConsultsOwnership(input: {
  readonly surface: string;
  readonly origin: UnifiedWakeOrigin;
  readonly drive: () => Promise<string>;
  readonly standing?: string;
  readonly after?: () => void;
}): Promise<void> {
  const { surface, origin } = input;
  const ref = unifiedThreadRef(origin);

  const standingSeen = await input.drive();
  const standing = input.standing ?? STANDING;
  ok(standingSeen === standing, `${surface}: UNOWNED thread ⇒ the wake reaches the STANDING seat (the negative control)`);

  const owner = seatTokenFor(origin, standing);
  ok(owner !== standing, `${surface}: precondition — the owner token and the standing token are different strings`);
  await recordThreadOwner(store, ORG, ref, owner, new Date().toISOString());

  const ownedSeen = await input.drive();
  ok(ownedSeen === owner, `🔴 ${surface}: an OWNED thread's follow-up reaches the OWNER session's token`);
  ok(ownedSeen !== standing, `🔴 ${surface}: …and NOT the standing seat's — the defect OPE-1719 closes`);
  ok(
    received[received.length - 1]!.auth.attributes?.[OE_GRAIN_ATTR] === "thread",
    `${surface}: the owner delivery is pre-stamped with the grain the owner booted as`,
  );
  await clearThreadOwner(store, ORG, ref);
  input.after?.();
}

const wakeInput = (origin: UnifiedWakeOrigin) => ({
  message: "<wake>a follow-up in the thread</wake>",
  context: [] as readonly string[],
  token: STANDING,
  window: { wakeId: mintWakeId(), origin, addressing: "direct-mention" as const },
  auth: { attributes: { oe_test: "1" } },
});

async function oneDelivery(surface: string, run: () => Promise<void>): Promise<string> {
  const before = received.length;
  await run();
  ok(received.length === before + 1, `${surface}: the ingest produced exactly one delivery`);
  return received[received.length - 1]!.target.token;
}

console.log("slack:");
{
  const origin = { platform: "slack", channelId: "C_WIRE", threadTs: "1700159721.000100" } as UnifiedWakeOrigin;
  const deps = {} as never;
  await assertConsultsOwnership({
    surface: "slack",
    origin,
    drive: () =>
      oneDelivery("slack", async () => {
        await withSingleWindowDiversion(deps, captureReceive, "slack/T_WIRE/C_WIRE").wake(wakeInput(origin) as never);
      }),
    after: () => {
      const front = readFileSync(new URL("../packages/providers/slack/agent/channels/slack-front.ts", import.meta.url), "utf8");
      const dmAt = front.indexOf("const scheduleDmWake = ");
      ok(dmAt > 0, "slack DM: precondition — `scheduleDmWake` is found in the source at all (a rename must red this scan, never silently empty it)");
      const dmOpen = front.indexOf("{", dmAt);
      let dmDepth = 0;
      let dmEnd = -1;
      for (let i = dmOpen; i < front.length && dmOpen > dmAt; i++) {
        if (front[i] === "{") dmDepth++;
        else if (front[i] === "}" && --dmDepth === 0) {
          dmEnd = i;
          break;
        }
      }
      ok(dmEnd > dmAt, "slack DM: precondition — `scheduleDmWake`'s body closes (the scan is bounded to that function, never widened to the rest of the file)");
      const dmBody = front.slice(dmAt, dmEnd);
      ok(
        /await divertInboundToUnifiedWindow\(/.test(dmBody),
        "🔴 slack DM: `scheduleDmWake` dispatches through the INBOUND divert — a Slack DM thread carries a `threadTs`, so it can be owned",
      );
      ok(!/await divertToUnifiedWindow\(/.test(dmBody), "…and not through the raw divert beside it (the negative control on the same body)");
    },
  });
}

console.log("github:");
{
  const origin = { platform: "github", owner: "wire-org", repo: "wire-repo", issueNumber: 42 } as UnifiedWakeOrigin;
  const ev = { owner: "wire-org", repo: "wire-repo", issueNumber: 42, isPullRequest: false, comment: { body: "follow-up" } } as never;
  await assertConsultsOwnership({
    surface: "github",
    origin,
    drive: () =>
      oneDelivery("github", async () => {
        await liveGitHubSupervisorDeps((async () => {}) as never, ev, captureReceive).wake(wakeInput(origin) as never);
      }),
  });
}

console.log("linear:");
{
  const origin = { platform: "linear", agentSessionId: "as-wire", issueId: "issue-wire", parentId: "comment-wire" } as UnifiedWakeOrigin;
  await assertConsultsOwnership({
    surface: "linear",
    origin,
    drive: () =>
      oneDelivery("linear", async () => {
        await liveLinearSupervisorDeps((async () => {}) as never, "team-wire", "org-wire", captureReceive).wake(wakeInput(origin) as never);
      }),
  });
}

console.log("notion:");
{
  const origin = { platform: "notion", discussionId: "disc-wire", pageId: "page-wire", workspaceId: "ws-wire" } as UnifiedWakeOrigin;
  await assertConsultsOwnership({
    surface: "notion",
    origin,
    drive: () =>
      oneDelivery("notion", async () => {
        await liveNotionSupervisorDeps((async () => {}) as never, "notion/ws-wire/page-wire", captureReceive).wake(wakeInput(origin) as never);
      }),
  });
}

console.log("teams:");
{
  const origin = {
    platform: "teams",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    conversationId: "19:wirechan@thread.tacv2;messageid=1712",
    replyToActivityId: "1712",
  } as UnifiedWakeOrigin;
  const plan = {
    surfaceKey: "teams/tenant-wire/19_wirechan@thread.tacv2",
    partition: { org: ORG, workspace: "tenant-wire", surfaceKey: "teams/tenant-wire/19_wirechan@thread.tacv2" },
    grain: { unified: true, registryKey: `oe-domain::${DOMAIN}`, domainName: DOMAIN, singleWindow: true as const },
  } as never;
  await assertConsultsOwnership({
    surface: "teams",
    origin,
    drive: () =>
      oneDelivery("teams", async () => {
        await liveTeamsSupervisorDeps(plan, captureReceive).wake(wakeInput(origin) as never);
      }),
  });
}

console.log("discord:");
{
  const GUILD = "G_WIRE";
  const THREAD_CHANNEL = "CH_WIRE_THREAD";
  const msg = {
    id: "m-wire-1",
    content: "a follow-up in the thread",
    channelId: THREAD_CHANNEL,
    channelType: "11",
    guildId: GUILD,
    author: { id: "u-wire", username: "sam", bot: false },
    mentionsBot: false,
    botId: "BOT",
    botName: "OE",
  };
  const auth = authForRelayMessage(msg as never);
  ok(auth !== null, "discord: precondition — a human relay message resolves an auth");
  const partition = resolvePartition({
    channel: { kind: "discord" as const },
    session: { auth: { current: auth as unknown as { attributes?: Readonly<Record<string, string>> } } },
  } as never);
  const grain = { unified: true, registryKey: `oe-domain::${DOMAIN}`, domainName: DOMAIN, singleWindow: true as const };

  const drive = (): Promise<string> =>
    oneDelivery("discord", async () => {
      await divertDiscordWakeToUnifiedWindow({
        msg: msg as never,
        auth: auth as never,
        partition,
        grain,
        addressing: "channel-watch",
        privacyOk: true,
        receive: captureReceive as never,
        contextLines: [],
        contextIngestion: [],
      });
    });

  const before = received.length;
  const standing = await drive();
  ok(received.length === before + 1, "discord: the first drive minted the standing domain session");
  ok(parseWindowToken(standing) !== undefined, "discord: the minted standing token is a window token");
  const origin = received[received.length - 1]!.target.origin;
  ok(
    (origin as { thread?: unknown }).thread === true,
    "🔴 discord: the frozen origin carries `thread: true` — the positive thread signal a thread channel's wake needs (OPE-1719)",
  );

  const ref = unifiedThreadRef(origin);
  const owner = seatTokenFor(origin, standing);
  ok(owner !== standing, "discord: precondition — the owner token and the standing token are different strings");
  await recordThreadOwner(store, ORG, ref, owner, new Date().toISOString());
  const ownedSeen = await drive();
  ok(ownedSeen === owner, "🔴 discord: an OWNED thread's follow-up reaches the OWNER session's token");
  ok(ownedSeen !== standing, "🔴 discord: …and NOT the standing seat's — the defect OPE-1719 closes");
  ok(
    received[received.length - 1]!.auth.attributes?.[OE_GRAIN_ATTR] === "thread",
    "discord: the owner delivery is pre-stamped with the grain the owner booted as",
  );
  await clearThreadOwner(store, ORG, ref);

  const plain = { ...msg, id: "m-wire-2", channelId: "CH_WIRE_BASE", channelType: "0" };
  const plainAuth = authForRelayMessage(plain as never);
  const plainPartition = resolvePartition({
    channel: { kind: "discord" as const },
    session: { auth: { current: plainAuth as unknown as { attributes?: Readonly<Record<string, string>> } } },
  } as never);
  const drivePlain = (): Promise<string> =>
    oneDelivery("discord base channel", async () => {
      await divertDiscordWakeToUnifiedWindow({
        msg: plain as never,
        auth: plainAuth as never,
        partition: plainPartition,
        grain,
        addressing: "channel-watch",
        privacyOk: true,
        receive: captureReceive as never,
        contextLines: [],
        contextIngestion: [],
      });
    });
  const plainStanding = await drivePlain();
  const plainOrigin = received[received.length - 1]!.target.origin;
  ok((plainOrigin as { thread?: unknown }).thread === undefined, "discord: a BASE channel's origin carries NO `thread` stamp");
  await recordThreadOwner(store, ORG, unifiedThreadRef(plainOrigin), seatTokenFor(plainOrigin, plainStanding), new Date().toISOString());
  ok(
    (await drivePlain()) === plainStanding,
    "🔴 discord: a BASE-channel wake goes STANDING even with a matching ownership row — the channel-capture guard holds",
  );
  await clearThreadOwner(store, ORG, unifiedThreadRef(plainOrigin));
}

console.log("spawn guard (discord):");
{
  const { default: spawnThreadSession } = await import("@open-everywhere/core/agent/tools/spawn_thread_session.js");
  const { resolveWindowGated } = await import("@open-everywhere/core/agent/access/window-gated.js");
  const WAKE_STORE_TTL_MS = 10 * 60 * 1000;

  const spawnOn = async (origin: UnifiedWakeOrigin, thread?: string): Promise<string> => {
    const wakeId = mintWakeId();
    await store.putUnifiedWakeTarget(ORG, wakeId, JSON.stringify(origin), new Date().toISOString(), WAKE_STORE_TTL_MS);
    const ctx = { session: { auth: { current: { attributes: { oe_window_token: STANDING, oe_grain: "standing", oe_wake_id: wakeId } } } } } as never;
    const entry = (await resolveWindowGated(spawnThreadSession, ctx)) as { execute: (i: unknown, c: unknown) => Promise<unknown> } | null;
    ok(entry !== null && typeof entry?.execute === "function", "spawn guard: precondition — the gated tool RESOLVES on a standing window seat");
    try {
      await entry!.execute({ brief: "own this thread", ...(thread !== undefined ? { thread } : {}) }, ctx);
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const base = { platform: "discord", channelId: "CH_SPAWN_BASE", guildId: "G_SPAWN" } as UnifiedWakeOrigin;
  const inThread = { platform: "discord", channelId: "CH_SPAWN_THREAD", guildId: "G_SPAWN", thread: true } as UnifiedWakeOrigin;

  ok(
    (await spawnOn(base)).includes("would own the whole channel"),
    "🔴 spawn guard: a Discord BASE-channel spawn is refused by the DISCORD guard, with the remedy that works on Discord",
  );
  ok(
    (await spawnOn(inThread, "some-root-id")).includes("`thread` isn't accepted on Discord"),
    "🔴 spawn guard: the `thread` escape hatch is refused on Discord — a supplied key could only disagree with the channel id ingress derives",
  );
  ok(
    (await spawnOn(inThread)).includes(`couldn't resolve a window-enabled surface for domain "${DOMAIN}"`),
    "🔴 spawn guard: a spawn from INSIDE a Discord thread clears BOTH guards and reaches the dispatch — the blanket platform refusal's stated reason was the routing gap OPE-1719 closes",
  );
}

console.log(`owned-thread-ingress-wiring-test: ${n} assertions passed`);

// proves: TOOL-spawn_thread_session
