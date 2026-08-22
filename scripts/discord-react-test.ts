import assert from "node:assert/strict";
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

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-discord-react-")), "ops.sqlite3");
process.env.OE_ORG = "acme";
process.env.DISCORD_BOT_TOKEN = "fixture-bot-token-not-a-secret";

const ORG = "acme";
const GUILD = "G1";
const CHANNEL = "C1";
const TRIGGER_MESSAGE = "M_TRIGGER";

const { registerDiscordProvider } = await import("@open-everywhere/provider-discord/agent/register.js");
const { discordPostArm } = await import("@open-everywhere/provider-discord/agent/channels/discord-post-arm.js");
const { capabilitiesForPlatform, registerCapabilityManifest } = await import("@open-everywhere/core/agent/identity/capabilities.js");
const { registerIdentityMapper } = await import("@open-everywhere/core/agent/identity/binding.js");
const { readAudit, deploymentOrg, platformFailureClass } = await import("@open-everywhere/core/agent/adapter-api.js");

registerDiscordProvider();

ok(capabilitiesForPlatform("discord").reactions === true, "🔴 OPE-987: the discord manifest now declares reactions:true (was false)");

{
  type ReactBag = Parameters<NonNullable<typeof discordPostArm.resolveReactTarget>>[0];
  const bag = (channelId: string | undefined, messageId: string | undefined): ReactBag =>
    ({
      str: (k: string) => (k === "channelId" ? channelId : undefined),
      num: () => undefined,
      ctx: {
        channel: { kind: "discord" },
        session: {
          auth: {
            current: {
              attributes: {
                ...(channelId ? { channel_id: channelId } : {}),
                ...(GUILD ? { guild_id: GUILD } : {}),
                ...(messageId ? { message_id: messageId } : {}),
              },
              principalId: "U1",
              principalType: "discord-user",
            },
          },
        },
      } as never,
    }) as ReactBag;

  ok(
    typeof discordPostArm.resolveReactTarget === "function" && typeof discordPostArm.react === "function",
    "🔴 OPE-987: the discord arm implements the REACT pair (resolveReactTarget + react)",
  );

  const t = discordPostArm.resolveReactTarget!(bag(CHANNEL, TRIGGER_MESSAGE));
  assert.deepStrictEqual(t, { platform: "discord", channelId: CHANNEL, messageId: TRIGGER_MESSAGE }, "resolveReactTarget builds the MESSAGE-level target — channel + the triggering message, not a conversation anchor");
  ok(discordPostArm.resolveReactTarget!(bag(undefined, TRIGGER_MESSAGE)) === null, "negative control: no channel id ⇒ NO react target");
  ok(discordPostArm.resolveReactTarget!(bag(CHANNEL, undefined)) === null, "negative control: no triggering message id ⇒ NO react target (Discord has no anchor fallback the way GitHub/Linear do)");

  await withPatchedFetch(
    (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      ok(url === `https://discord.com/api/v10/channels/${CHANNEL}/messages/${TRIGGER_MESSAGE}/reactions/${encodeURIComponent("👍")}/@me`, "react: PUTs the resolved (channel, message) reaction endpoint, emoji translated + URL-encoded");
      ok((init?.method ?? "").toUpperCase() === "PUT", "react: uses PUT (add), never DELETE");
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    () => discordPostArm.react!(t as never, "thumbsup"),
  );

  {
    let networkCalled = false;
    let err: unknown;
    await withPatchedFetch(
      (async () => {
        networkCalled = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      async () => {
        try {
          await discordPostArm.react!(t as never, "bogus_emoji_name");
        } catch (e) {
          err = e;
        }
      },
    );
    ok(err instanceof Error && /has no Discord emoji equivalent/.test((err as Error).message), 'react: an unmapped emoji name refuses with an honest, naming error');
    ok((err as Error).message.includes("thumbsup") && (err as Error).message.includes("eyes"), "react: the refusal names this deployment's real vocabulary, so the model can retry with a supported name");
    ok(platformFailureClass(err) === "definitive", "OPE-987/825: an unmapped emoji classifies DEFINITIVE — decided before any byte left this host");
    ok(networkCalled === false, "react: an unmapped emoji never reaches the network");
  }

  {
    let err: unknown;
    await withPatchedFetch(
      (async () => new Response("{}", { status: 404 })) as typeof fetch,
      async () => {
        try {
          await discordPostArm.react!(t as never, "eyes");
        } catch (e) {
          err = e;
        }
      },
    );
    ok(platformFailureClass(err) === "definitive", "OPE-987/825: a 404 reactions PUT classifies DEFINITIVE");

    let ambErr: unknown;
    await withPatchedFetch(
      (async () => new Response("{}", { status: 503 })) as typeof fetch,
      async () => {
        try {
          await discordPostArm.react!(t as never, "eyes");
        } catch (e) {
          ambErr = e;
        }
      },
    );
    ok(platformFailureClass(ambErr) === "ambiguous", "OPE-987/825: a 503 reactions PUT classifies AMBIGUOUS");
  }
}

await withPatchedFetch(
  (async () => new Response("{}", { status: 200 })) as typeof fetch,
  async () => {
    const react = (await import("@open-everywhere/core/agent/tools/react.js")).default;
    const { markReactedThisTurn, consumeReactedThisTurn } = await import("@open-everywhere/core/agent/channels/react-signal.js");

    const nodeRequire = createRequire(import.meta.url);
    const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
    const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
    const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
    const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

    interface Armed {
      readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
    }
    type Handler = (event: unknown, ctx: unknown) => unknown;
    const armEvent = (react as unknown as { events: Record<string, Handler> }).events["session.started"];

    function discordCtx(): Record<string, unknown> {
      return {
        channel: { kind: "discord" },
        session: {
          auth: {
            current: {
              attributes: { channel_id: CHANNEL, guild_id: GUILD, message_id: TRIGGER_MESSAGE },
              principalId: "U1",
              principalType: "discord-user",
            },
          },
        },
      };
    }

    const armed = (await armEvent({}, discordCtx())) as Armed;
    ok(armed !== null && typeof armed.execute === "function", "🔴 OPE-987: react now ARMS on a Discord session (the manifest flip's effect at mount time)");

    const before = (await readAudit({ org: ORG, platform: "discord", action: "discord.react" })).length;
    const result = await inSession(() =>
      armed.execute({ emoji: "thumbsup" }, discordCtx()).catch((e: unknown) => ({ error: String(e) })),
    );
    ok((result as { error?: string }).error === undefined, `🔴 OPE-987: react EXECUTES on a Discord-origin turn without throwing (got: ${JSON.stringify(result)})`);
    ok((result as { reacted?: boolean }).reacted === true, "react returns reacted:true — the turn's acknowledgement is satisfied");
    const after = await readAudit({ org: ORG, platform: "discord", action: "discord.react" });
    ok(after.length === before + 1, "react appends exactly one discord.react audit row");
    ok(after[after.length - 1]!.detail?.emoji === "thumbsup", "…naming the emoji the model chose");

    await inSession(async () => {
      markReactedThisTurn();
      ok(consumeReactedThisTurn() === true, "react-signal: a Discord react marks the turn's reply obligation satisfied, same as every other surface");
    });

    const FIXTURE_PLATFORM = "fixture-no-reaction-surface";
    registerCapabilityManifest(FIXTURE_PLATFORM, { midTurnPost: true, reactions: false });
    registerIdentityMapper(FIXTURE_PLATFORM, (c) => {
      const a = (c.session?.auth?.current?.attributes ?? {}) as Record<string, string>;
      return { workspace: "acme", surface: a["surface_id"], mode: "channel", visibility: "private" };
    });
    function fixtureCtx(): Record<string, unknown> {
      return {
        channel: { kind: FIXTURE_PLATFORM },
        session: {
          auth: {
            current: {
              attributes: { surface_id: "S1" },
              principalId: "U1",
              principalType: `${FIXTURE_PLATFORM}-user`,
            },
          },
        },
      };
    }
    const fixtureArmed = (await armEvent({}, fixtureCtx())) as Armed | null;
    ok(fixtureArmed === null, "negative control: react stays HIDDEN on a surface whose manifest still says reactions:false — the mount gate is unchanged for everyone but Discord");

    function unifiedCtx(platform: string, attrs: Record<string, string>): Record<string, unknown> {
      return {
        channel: { kind: "unified" },
        session: {
          auth: {
            current: {
              attributes: { oe_platform: platform, ...attrs },
              principalId: "U1",
              principalType: `${platform}-user`,
            },
          },
        },
      };
    }

    const unifiedArmed = (await armEvent({}, unifiedCtx("discord", {}))) as Armed;
    ok(unifiedArmed !== null && typeof unifiedArmed.execute === "function", "a unified session arms react unconditionally (opener-blind presence gate) — unchanged by this ticket");

    const unifiedDiscordResult = await inSession(() =>
      unifiedArmed
        .execute({ emoji: "eyes" }, unifiedCtx("discord", { channel_id: CHANNEL, guild_id: GUILD, message_id: TRIGGER_MESSAGE }))
        .catch((e: unknown) => ({ error: String(e) })),
    );
    ok(
      (unifiedDiscordResult as { error?: string }).error === undefined && (unifiedDiscordResult as { reacted?: boolean }).reacted === true,
      `🔴 OPE-987: a Discord-origin UNIFIED turn now offers react — the per-turn origin fence passes where it used to throw "no reaction primitive" (got: ${JSON.stringify(unifiedDiscordResult)})`,
    );

    const unifiedFixtureResult = await inSession(() =>
      unifiedArmed.execute({ emoji: "eyes" }, unifiedCtx(FIXTURE_PLATFORM, {})).catch((e: unknown) => ({ error: String(e) })),
    );
    ok(
      typeof (unifiedFixtureResult as { error?: string }).error === "string" && /no reaction primitive/.test((unifiedFixtureResult as { error: string }).error),
      "negative control: a unified turn from a still-unwired origin is refused at the SAME fence with the SAME instructive error — the flip is Discord-specific",
    );
  },
);

console.log(`✓ discord-react (OPE-987): ${passed} assertions passed`);
