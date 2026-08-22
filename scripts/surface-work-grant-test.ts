import assert from "node:assert/strict";
import {
  SURFACE_WORK_ROLES,
  surfaceWorkRole,
  domainHoldsSurfaceWorkGrant,
  surfaceWorkReadPlatforms,
  surfaceWorkReadMount,
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

registerSlackProvider();
registerDiscordProvider();
registerTeamsProvider();

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

function granted(name: string, channels: readonly string[], connector: string): Domain {
  return defineDomain({ name, channels: [...channels], credentials: [{ connector, credential: WORK_ROLE, use: CHAT_ROLE }] });
}
function chatOnly(name: string, channels: readonly string[], connector: string): Domain {
  return defineDomain({ name, channels: [...channels], credentials: [{ connector, credential: CHAT_ROLE, use: "some-other-key" }] });
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

const SLACK_CHANNEL = "slack/T_WG/C_WG";
const DISCORD_CHANNEL = "discord/G_WG/D_WG";
const TEAMS_CHANNEL = "teams/TEN_WG/K_WG";

ok(surfaceWorkRole("slack") === WORK_ROLE, "slack names the work-token role");
ok(surfaceWorkRole("discord") === WORK_ROLE, "discord names the work-token role");
ok(surfaceWorkRole("teams") === WORK_ROLE, "teams names the work-token role");
ok(surfaceWorkRole("github") === undefined, "github declares NO chat work role — its grant is the bundle's repos: list (OPE-940)");
ok(surfaceWorkRole("notion") === undefined, "notion is not a chat work surface — its work half is the page, under its own role");
ok(surfaceWorkRole("linear") === undefined, "linear is not a chat work surface — its work half is the issue, under its own role");
ok(surfaceWorkRole("nonsense") === undefined, "an unknown platform names no role");
ok(Object.keys(SURFACE_WORK_ROLES).length === 3, "exactly three chat work surfaces are declared — a fourth must arrive with its read adapter");

for (const [platform, channel] of [
  ["slack", SLACK_CHANNEL],
  ["discord", DISCORD_CHANNEL],
  ["teams", TEAMS_CHANNEL],
] as const) {
  const g = granted(`g-${platform}`, [channel], platform);
  const c = chatOnly(`c-${platform}`, [channel], platform);
  const plain = defineDomain({ name: `p-${platform}`, channels: [channel] });
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
  ] as const;
  for (const c of cases) {
    const g = [granted(`m-${c.platform}`, [c.channel], c.platform)];
    const plain = [defineDomain({ name: `mp-${c.platform}`, channels: [c.channel] })];
    ok(surfaceWorkReadPlatforms(c.ctx(), g).join(",") === c.platform, `${c.platform}: a granted solo window reads exactly its own surface`);
    ok(surfaceWorkReadPlatforms(c.ctx(), plain).length === 0, `${c.platform}: an ungranted domain reads nothing (explicit empty)`);
    ok(surfaceWorkReadMount(c.ctx(), () => g) === true, `${c.platform}: the granted domain MOUNTS the work reads`);
    ok(surfaceWorkReadMount(c.ctx(), () => plain) === false, `${c.platform}: the ungranted domain does NOT mount them (explicit false)`);

    const elsewhere = [
      defineDomain({
        name: `me-${c.platform}`,
        channels: [c.channel, c.foreign],
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
      channels: [SLACK_CHANNEL, DISCORD_CHANNEL],
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

console.log(`✓ surface-work-grant: ${passed} assertions passed`);
