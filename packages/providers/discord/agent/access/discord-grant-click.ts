import { OE_GRANT_ACTION_PREFIX, parseGrantCardActionId, resolveGrantCardClick, deploymentOrg } from "@open-everywhere/core/agent/adapter-api.js";
import { deferredEphemeralResponse, editOriginalInteractionResponse, interactionFollowUp, type InteractionFollowUp } from "../channels/discord-interaction-defer.js";

function log(msg: string): void {
  console.log(`[open-everywhere:discord-grant] ${msg}`);
}

const RESPONSE_CHANNEL_MESSAGE = 4;
const EPHEMERAL = 64;

export type DiscordGrantClickResponse = Record<string, unknown>;

export interface DiscordGrantClickDeps {
  readonly waitUntil?: (p: Promise<unknown>) => void;
  readonly edit?: (followUp: InteractionFollowUp, content: string) => Promise<boolean>;
}

function ephemeral(content: string): DiscordGrantClickResponse {
  return { type: RESPONSE_CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function clickerIdOf(interaction: Record<string, unknown>): string | undefined {
  const direct = isObject(interaction["user"]) ? interaction["user"]["id"] : undefined;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const member = isObject(interaction["member"]) ? interaction["member"]["user"] : undefined;
  const viaMember = isObject(member) ? member["id"] : undefined;
  return typeof viaMember === "string" && viaMember.length > 0 ? viaMember : undefined;
}

function channelIdOf(interaction: Record<string, unknown>): string | undefined {
  const id = interaction["channel_id"];
  if (typeof id === "string" && id.length > 0) return id;
  const channel = isObject(interaction["channel"]) ? interaction["channel"]["id"] : undefined;
  return typeof channel === "string" && channel.length > 0 ? channel : undefined;
}

export async function handleDiscordGrantCardInteraction(
  raw: unknown,
  deps: DiscordGrantClickDeps = {},
): Promise<DiscordGrantClickResponse | null> {
  try {
    if (!isObject(raw)) return null;
    const data = isObject(raw["data"]) ? raw["data"] : undefined;
    const customId = typeof data?.["custom_id"] === "string" ? (data["custom_id"] as string) : undefined;
    if (!customId?.startsWith(OE_GRANT_ACTION_PREFIX)) return null;
    const parsed = parseGrantCardActionId(customId);
    if (parsed === undefined) {
      log("grant card custom_id did not parse — forwarding");
      return null;
    }

    if (typeof raw["guild_id"] === "string" && raw["guild_id"].length > 0) {
      return ephemeral(
        "I only take an answer to a credential request in our direct messages — this one came from a server. Open our DM and answer it there. Nothing was granted.",
      );
    }

    const clicker = clickerIdOf(raw);
    if (clicker === undefined) {
      log("grant card click carried no attributable user — refusing");
      return ephemeral("I could not tell who pressed that, so I did nothing and nothing was granted.");
    }

    const channelId = channelIdOf(raw);
    const resolve = (): Promise<{ text: string }> =>
      resolveGrantCardClick({
        askId: parsed.askId,
        answer: parsed.answer,
        clicker: { platform: "discord", nativeId: clicker },
        nowMs: Date.now(),
        org: deploymentOrg(),
        platform: "discord",
        workspace: clicker,
        ...(channelId === undefined ? {} : { surface: channelId }),
      });

    const followUp = interactionFollowUp(raw);
    if (deps.waitUntil === undefined || followUp === undefined) {
      log(`grant card click answering synchronously (${deps.waitUntil === undefined ? "no waitUntil" : "no follow-up address"}) — a slow approve may outlive the interaction token`);
      return ephemeral((await resolve()).text);
    }

    const edit = deps.edit ?? editOriginalInteractionResponse;
    deps.waitUntil(
      (async () => {
        let text: string;
        try {
          text = (await resolve()).text;
        } catch (err) {
          log(`deferred grant card resolution failed: ${(err as Error)?.message ?? String(err)}`);
          text = "That could not be answered right now. Nothing changed, and nothing was granted. Try the button again.";
        }
        const shown = await edit(followUp, text);
        if (!shown) log(`grant card answer could NOT be shown to the owner — the decision landed and is audited, the owner was not told`);
      })(),
    );
    return deferredEphemeralResponse();
  } catch (err) {
    log(`grant card click failed: ${(err as Error)?.message ?? String(err)}`);
    return ephemeral("That could not be answered right now. Nothing changed, and nothing was granted. Try the button again.");
  }
}
