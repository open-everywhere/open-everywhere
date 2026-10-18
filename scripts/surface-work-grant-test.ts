import assert from "node:assert/strict";
import {
  SURFACE_WORK_ROLES,
  surfaceWorkRole,
  domainHoldsSurfaceWorkGrant,
  surfaceWorkReadPlatforms,
  surfaceWorkReadMount,
  workerOriginReadPlatform,
  assertSurfaceWorkGrant,
  SurfaceWorkGrantError,
} from "@open-everywhere/core/agent/access/surface-work-grant.js";
import { LEAN_SEAT_TOOLS } from "@open-everywhere/core/agent/access/lean-seat.js";
import { WORKER_WITHHELD_TOOLS, allowedOnWorkerSeat } from "@open-everywhere/core/agent/access/worker-seat.js";
import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import type { Domain } from "@open-everywhere/core/agent/memory/domain.js";
import type { BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";

registerSlackProvider();
registerDiscordProvider();
registerTeamsProvider();
registerNotionProvider();
registerLinearProvider();

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const WORK_ROLE = "work-token";
const CHAT_ROLE = "chat-token";

function workRoleForTestConnector(connector: string): string {
  if (connector === "notion") return "team-key";
  if (connector === "linear") return "workspace";
  return WORK_ROLE;
}
function granted(name: string, channels: readonly string[], connector: string): Domain {
  return defineDomain({ name, reach: [...channels], credentials: [{ connector, credential: workRoleForTestConnector(connector), use: CHAT_ROLE }] });
}
function chatOnly(name: string, channels: readonly string[], connector: string): Domain {
  const role = connector === "notion" ? "channel-key" : connector === "linear" ? "not-the-work-role" : CHAT_ROLE;
  return defineDomain({ name, reach: [...channels], credentials: [{ connector, credential: role, use: "some-other-key" }] });
}

function slackCtx(sources?: string): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: { team_id: "T_WG", channel_id: "C_WG", channel_type: "channel", ...(sources ? { oe_sources: sources } : {}) },
          principalId: "U_WG",
          principalType: "slack-user",
        },
      },
    },
  } as unknown as BindableContext;
}
function discordCtx(sources?: string): BindableContext {
  return {
    channel: { kind: "discord" },
    session: {
      auth: {
        current: {
          attributes: { guild_id: "G_WG", channel_id: "D_WG", channel_type: "0", ...(sources ? { oe_sources: sources } : {}) },
          principalId: "U_WG",
          principalType: "discord-user",
        },
      },
    },
  } as unknown as BindableContext;
}
function teamsCtx(sources?: string): BindableContext {
  return {
    channel: { kind: "teams" },
    session: {
      auth: {
        current: {
          attributes: { tenant_id: "TEN_WG", conversation_id: "K_WG", scope: "channel", ...(sources ? { oe_sources: sources } : {}) },
          principalId: "U_WG",
          principalType: "teams-user",
        },
      },
    },
  } as unknown as BindableContext;
}
function notionCtx(sources?: string): BindableContext {
  return {
    channel: { kind: "notion" },
    session: {
      auth: {
        current: {
          attributes: { workspace_id: "WS_WG", page_id: "P_WG", ...(sources ? { oe_sources: sources } : {}) },
          principalId: "U_WG",
          principalType: "notion-user",
        },
      },
    },
  } as unknown as BindableContext;
}
function linearCtx(sources?: string): BindableContext {
  return {
    channel: { kind: "linear" },
    session: {
      auth: {
        current: {
          attributes: { organization_id: "ORG_WG", team_id: "TEAM_WG", ...(sources ? { oe_sources: sources } : {}) },
          principalId: "U_WG",
          principalType: "linear-user",
        },
      },
    },
  } as unknown as BindableContext;
}

const SLACK_CHANNEL = "slack/T_WG/C_WG";
const DISCORD_CHANNEL = "discord/G_WG/D_WG";
const TEAMS_CHANNEL = "teams/TEN_WG/K_WG";
const NOTION_CHANNEL = "notion/WS_WG/P_WG";
const LINEAR_CHANNEL = "linear/ORG_WG/TEAM_WG";

ok(surfaceWorkRole("slack") === WORK_ROLE, "slack names the work-token role");
ok(surfaceWorkRole("discord") === WORK_ROLE, "discord names the work-token role");
ok(surfaceWorkRole("teams") === WORK_ROLE, "teams names the work-token role");
ok(surfaceWorkRole("github") === undefined, "github declares NO chat work role — its grant is the bundle's repos: list (OPE-940)");
ok(surfaceWorkRole("notion") === "team-key", "notion IS now a chat/container work surface too (OPE-1064) — same role as its entity row");
ok(surfaceWorkRole("linear") === "workspace", "linear IS now a chat/container work surface too (OPE-1064) — same role as its entity row");
ok(surfaceWorkRole("nonsense") === undefined, "an unknown platform names no role");
ok(Object.keys(SURFACE_WORK_ROLES).length === 5, "exactly five chat/container work surfaces are declared — a sixth must arrive with its read adapter");

for (const [platform, channel] of [
  ["slack", SLACK_CHANNEL],
  ["discord", DISCORD_CHANNEL],
  ["teams", TEAMS_CHANNEL],
  ["notion", NOTION_CHANNEL],
  ["linear", LINEAR_CHANNEL],
] as const) {
  const g = granted(`g-${platform}`, [channel], platform);
  const c = chatOnly(`c-${platform}`, [channel], platform);
  const plain = defineDomain({ name: `p-${platform}`, reach: [channel] });
  const other = granted(`o-${platform}`, [channel], platform === "slack" ? "discord" : "slack");

  ok(domainHoldsSurfaceWorkGrant(g, platform) === true, `${platform}: a declared work role IS the grant`);
  ok(domainHoldsSurfaceWorkGrant(plain, platform) === false, `${platform}: a domain that declares nothing holds NO grant (explicit false)`);
  ok(domainHoldsSurfaceWorkGrant(c, platform) === false, `${platform}: declaring the CHAT role does not confer the WORK grant (explicit false)`);
  ok(domainHoldsSurfaceWorkGrant(other, platform) === false, `${platform}: another surface's work grant confers nothing here (explicit false)`);
  ok(domainHoldsSurfaceWorkGrant(undefined, platform) === false, `${platform}: an unresolved domain holds no grant (fail closed)`);
  ok(domainHoldsSurfaceWorkGrant(g, "github") === false, `${platform}: a grant here confers nothing on a surface with no declared role (explicit false)`);
}

{
  const cases = [
    { platform: "slack", channel: SLACK_CHANNEL, ctx: slackCtx, foreign: DISCORD_CHANNEL, foreignPlatform: "discord" },
    { platform: "discord", channel: DISCORD_CHANNEL, ctx: discordCtx, foreign: SLACK_CHANNEL, foreignPlatform: "slack" },
    { platform: "teams", channel: TEAMS_CHANNEL, ctx: teamsCtx, foreign: SLACK_CHANNEL, foreignPlatform: "slack" },
    { platform: "notion", channel: NOTION_CHANNEL, ctx: notionCtx, foreign: SLACK_CHANNEL, foreignPlatform: "slack" },
    { platform: "linear", channel: LINEAR_CHANNEL, ctx: linearCtx, foreign: SLACK_CHANNEL, foreignPlatform: "slack" },
  ] as const;
  for (const c of cases) {
    const g = [granted(`m-${c.platform}`, [c.channel], c.platform)];
    const plain = [defineDomain({ name: `mp-${c.platform}`, reach: [c.channel] })];
    ok(surfaceWorkReadPlatforms(c.ctx(), g).join(",") === c.platform, `${c.platform}: a granted solo window reads exactly its own surface`);
    ok(surfaceWorkReadPlatforms(c.ctx(), plain).length === 0, `${c.platform}: an ungranted domain reads nothing (explicit empty)`);
    ok(surfaceWorkReadMount(c.ctx(), () => g) === true, `${c.platform}: the granted domain MOUNTS the work reads`);
    ok(surfaceWorkReadMount(c.ctx(), () => plain) === false, `${c.platform}: the ungranted domain does NOT mount them (explicit false)`);

    const elsewhere = [
      defineDomain({
        name: `me-${c.platform}`,
        reach: [c.channel, c.foreign],
        credentials: [{ connector: c.foreignPlatform, credential: WORK_ROLE, use: CHAT_ROLE }],
      }),
    ];
    ok(surfaceWorkReadPlatforms(c.ctx(), elsewhere).length === 0, `${c.platform}: a grant on a surface this window has no wakes from mounts nothing`);
    ok(surfaceWorkReadMount(c.ctx(), () => elsewhere) === false, `${c.platform}: …and the mount predicate says so (explicit false)`);
  }
}

{
  const mixed = [
    defineDomain({
      name: "mixed",
      reach: [SLACK_CHANNEL, DISCORD_CHANNEL],
      credentials: [{ connector: "slack", credential: WORK_ROLE, use: CHAT_ROLE }],
    }),
  ];
  const bothSources = "slack,discord";
  ok(surfaceWorkReadPlatforms(slackCtx(bothSources), mixed).join(",") === "slack", "unified window: only the GRANTED source is readable");
  ok(surfaceWorkReadMount(slackCtx(bothSources), () => mixed) === true, "unified window: the verbs mount because one source is granted");

  assertSurfaceWorkGrant(slackCtx(bothSources), mixed, "slack");
  passed++;
  assert.throws(
    () => assertSurfaceWorkGrant(slackCtx(bothSources), mixed, "discord"),
    (err: unknown) => err instanceof SurfaceWorkGrantError && err.platform === "discord",
    "unified window: a turn on the UNGRANTED source is refused, with its platform named",
  );
  passed++;
  assert.throws(() => assertSurfaceWorkGrant(slackCtx(bothSources), mixed, "github"), SurfaceWorkGrantError, "a platform with no declared work role is refused");
  passed++;
  assert.throws(
    () => assertSurfaceWorkGrant({ channel: { kind: "slack" } } as unknown as BindableContext, mixed, "slack"),
    SurfaceWorkGrantError,
    "an identity-less ctx resolves NO domain and is refused (fail closed)",
  );
  passed++;
  ok(surfaceWorkReadMount({ channel: { kind: "slack" } } as unknown as BindableContext, () => mixed) === false, "…and the mount predicate fails closed on the same ctx");
  ok(
    surfaceWorkReadMount(slackCtx(bothSources), () => {
      throw new Error("config not registered");
    }) === false,
    "an unreadable domain list refuses the mount (explicit false)",
  );
}

ok(LEAN_SEAT_TOOLS.has("read_channel") === true, "control: the CHAT read IS on the lean seat's roster");
ok(LEAN_SEAT_TOOLS.has("read_thread") === true, "control: the chat thread read IS on the lean seat's roster");
ok(LEAN_SEAT_TOOLS.has("read_work_channel") === false, "the WORK channel read is NOT on the lean seat's roster (explicit false)");
ok(LEAN_SEAT_TOOLS.has("read_work_thread") === false, "the WORK thread read is NOT on the lean seat's roster (explicit false)");
ok(WORKER_WITHHELD_TOOLS.has("read_channel") === true, "control: the chat read IS withheld from a delegated worker");
ok(allowedOnWorkerSeat("read_work_channel") === true, "the WORK channel read REACHES a delegated worker");
ok(allowedOnWorkerSeat("read_work_thread") === true, "the WORK thread read REACHES a delegated worker");

{
  const { domain: soakDomain } = await import("../agent/memory/config/domains/soak.js");
  const soakDomains = [soakDomain];
  const soakCtx = (): BindableContext =>
    ({
      channel: { kind: "slack" },
      session: {
        auth: {
          current: {
            attributes: { team_id: "T0EXAMPLE", channel_id: "C0EXCHAN008", channel_type: "channel", oe_sources: "slack,notion,linear,github" },
            principalId: "U_SOAK",
            principalType: "slack-user",
          },
        },
      },
    }) as unknown as BindableContext;

  ok(
    domainHoldsSurfaceWorkGrant(soakDomain, "slack") === true,
    "🔴 §6: the shipped `soak` domain HOLDS the Slack work grant. Without it the wrap-up worker can read none of the day it is asked to summarise",
  );
  const platforms = surfaceWorkReadPlatforms(soakCtx(), soakDomains);
  ok(platforms.includes("slack"), "🔴 §6: …so a turn in #oe-soak-dev resolves `slack` as a work-readable surface");
  ok(surfaceWorkReadMount(soakCtx(), () => soakDomains) === true, "🔴 §6: …and the work reads MOUNT, which is what the summary worker needs");
  const soakWithoutSlack = defineDomain({
    name: "soak-control",
    reach: [...(soakDomain.reach ?? [])],
    mode: "unified",
    ambientSupervisor: true,
    credentials: (soakDomain.credentials ?? []).filter((c) => c.connector !== "slack"),
  });
  ok(
    domainHoldsSurfaceWorkGrant(soakWithoutSlack, "slack") === false,
    "🔴 §6/CONTROL: the SAME domain minus the Slack row holds nothing (explicit false) — this is the state that wrote \"No shipped work could be verified\"",
  );
  ok(
    surfaceWorkReadPlatforms(soakCtx(), [soakWithoutSlack]).includes("slack") === false,
    "🔴 §6/CONTROL: …and its work reads resolve no Slack surface, so the declaration is what unlocks the read",
  );
  ok(
    domainHoldsSurfaceWorkGrant(soakDomain, "discord") === false,
    "🔴 §6: the Slack row confers NOTHING on an undeclared platform (explicit false) — a container-fenced grant, never a widening",
  );
  ok(LEAN_SEAT_TOOLS.has("read_work_channel") === false, "🔴 §6: the seat STILL cannot make the work read — the grant arms the worker, not the seat");
}

{
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { bindFrom } = await import("@open-everywhere/core/agent/identity/binding.js");
  const { adoptDelegatedAuthority } = await import("@open-everywhere/core/agent/identity/delegated-binding.js");
  const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
  const readWorkThread = (await import("@open-everywhere/core/agent/tools/read_work_thread.js")).default;
  const readWorkChannel = (await import("@open-everywhere/core/agent/tools/read_work_channel.js")).default;

  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
    ContextContainer: new () => unknown;
    contextStorage: { run<T>(store: unknown, fn: () => T): T };
  };

  const mixed = [
    defineDomain({
      name: "mixed-worker",
      reach: [SLACK_CHANNEL, DISCORD_CHANNEL],
      credentials: [{ connector: "slack", credential: WORK_ROLE, use: CHAT_ROLE }],
    }),
  ];
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => mixed,
    loadSilos: () => [],
    domainsForSurface: () => [],
  } as never);
  const bothSources = "slack,discord";

  function workerOf(parent: BindableContext, platform: string): BindableContext {
    return {
      channel: { kind: "subagent", continuationToken: "subagent:wrun_parent:0" },
      session: {
        id: `sess-worker-${platform}`,
        parent: { sessionId: "sess-seat", callId: `call-${platform}` },
        auth: {
          current: {
            ...parent.session?.auth?.current,
            attributes: { ...(parent.session?.auth?.current?.attributes as Record<string, string>), oe_platform: platform },
          },
        },
      },
    } as unknown as BindableContext;
  }
  function asWorker<T>(parent: BindableContext, fn: () => T): T {
    return contextStorage.run(new ContextContainer(), () => {
      assert.ok(
        adoptDelegatedAuthority({ binding: bindFrom(parent), requester: { kind: "requester", principalId: "U_WG" }, nonMemberWake: false }, "turn_0"),
        "fixture must install the child's dispatch authority",
      );
      return fn();
    });
  }
  type Resolver = (event: unknown, ctx: unknown) => unknown;
  const resolverOf = (tool: unknown): Resolver => (tool as { events: Record<string, Resolver> }).events["session.started"];

  const discordWorker = workerOf(discordCtx(bothSources), "discord");
  const slackWorker = workerOf(slackCtx(bothSources), "slack");

  const plain = [defineDomain({ name: "plain-worker", reach: [SLACK_CHANNEL, DISCORD_CHANNEL] })];

  asWorker(discordCtx(bothSources), () => {
    ok(surfaceWorkReadPlatforms(discordWorker, mixed).join(",") === "slack", "§7/CONTROL: the Discord worker's window resolves its domain, and Slack is the granted source");
    ok(workerOriginReadPlatform(discordWorker, mixed) === "discord", "🔴 §7: the Discord worker's own origin is its dispatch platform, discord");
    ok(
      surfaceWorkReadMount(discordWorker, () => mixed) === true,
      "🔴 §7: a Discord worker on a window where only Slack holds the grant MOUNTS the work reads (OPE-2491 ruling)",
    );
    ok(resolverOf(readWorkThread)({}, discordWorker) !== null, "🔴 §7: …and read_work_thread's own resolver mounts it");
    ok(resolverOf(readWorkChannel)({}, discordWorker) !== null, "🔴 §7: …and read_work_channel's own resolver mounts it");
    assertSurfaceWorkGrant(discordWorker, mixed, "discord");
    passed++;

    ok(surfaceWorkReadMount(discordWorker, () => plain) === true, "🔴 §7: a worker of a domain that declares NO work role mounts the read of its own origin");
    assertSurfaceWorkGrant(discordWorker, plain, "discord");
    passed++;
    assert.throws(
      () => assertSurfaceWorkGrant(discordWorker, plain, "slack"),
      (err: unknown) => err instanceof SurfaceWorkGrantError && err.platform === "slack",
      "🔴 §7: the Discord worker is refused a Slack work read on the ungranted domain",
    );
    passed++;
    ok(domainHoldsSurfaceWorkGrant(plain[0], "discord") === false, "§7/CONTROL: the origin arm declares no grant — the domain still holds none (explicit false)");
  });

  asWorker(slackCtx(bothSources), () => {
    ok(surfaceWorkReadMount(slackWorker, () => mixed) === true, "§7: a Slack worker on the SAME window still mounts the work reads");
    ok(resolverOf(readWorkThread)({}, slackWorker) !== null, "§7: …and read_work_thread's own resolver mounts it");
    ok(resolverOf(readWorkChannel)({}, slackWorker) !== null, "§7: …and read_work_channel's own resolver mounts it");
    assertSurfaceWorkGrant(slackWorker, mixed, "slack");
    passed++;
  });

  asWorker(discordCtx(bothSources), () => {
    const stampSaysSlack = workerOf(slackCtx(bothSources), "slack");
    ok(workerOriginReadPlatform(stampSaysSlack, plain) === "discord", "🔴 §7: a Discord-dispatched worker whose inherited stamp says Slack has origin discord");
    assertSurfaceWorkGrant(stampSaysSlack, plain, "discord");
    passed++;
    assert.throws(
      () => assertSurfaceWorkGrant(stampSaysSlack, plain, "slack"),
      SurfaceWorkGrantError,
      "🔴 §7: …and the stamp's platform, slack, is refused with no grant",
    );
    passed++;
  });
  asWorker(discordCtx(), () => {
    ok(
      surfaceWorkReadMount(workerOf(slackCtx("slack"), "slack"), () => plain) === false,
      "🔴 §7: a worker whose dispatch origin is not a source of its window does NOT mount (explicit false)",
    );
  });
  {
    const emailParent = {
      channel: { kind: "email" },
      session: { auth: { current: { attributes: { email_inbox: "room@example.com", email_thread_id: "T1", oe_sources: "email" }, principalId: "a@example.com", principalType: "email-user" } } },
    } as unknown as BindableContext;
    const emailWorker = workerOf(emailParent, "email");
    asWorker(emailParent, () => {
      ok(bindFrom(emailWorker).platform === "email", "§7/CONTROL: the email worker's dispatch binding names email");
      ok(workerOriginReadPlatform(emailWorker, plain) === undefined, "🔴 §7: an email-dispatched worker has NO grant-free origin (explicit undefined)");
      ok(surfaceWorkReadMount(emailWorker, () => plain) === false, "🔴 §7: …and mounts neither work read (explicit false)");
      assert.throws(() => assertSurfaceWorkGrant(emailWorker, plain, "email"), SurfaceWorkGrantError, "🔴 §7: …and the per-turn check refuses its email read");
      passed++;
    });
  }

  ok(workerOriginReadPlatform(discordWorker, plain) === undefined, "🔴 §7: a child with no adopted dispatch authority has no origin (fail closed)");
  ok(surfaceWorkReadMount(discordWorker, () => plain) === false, "🔴 §7: …and mounts nothing on the ungranted domain (explicit false)");

  ok(surfaceWorkReadMount(discordCtx(bothSources), () => mixed) === true, "§7: a non-child context on the same window keeps the any-granted-source mount");
  ok(workerOriginReadPlatform(discordCtx(bothSources), plain) === undefined, "🔴 §7: a non-child context has no origin arm");
  ok(surfaceWorkReadMount(discordCtx(bothSources), () => plain) === false, "🔴 §7: a non-child context on the ungranted domain does NOT mount (explicit false)");
  assert.throws(
    () => assertSurfaceWorkGrant(discordCtx(bothSources), plain, "discord"),
    SurfaceWorkGrantError,
    "🔴 §7: a non-child context is refused the ungranted discord read",
  );
  passed++;
}

console.log(`✓ surface-work-grant: ${passed} assertions passed`);
