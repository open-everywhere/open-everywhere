import { LINK_CONSENT_CLICK_PREFIX, parseLinkConsentClickId, resolveLinkConsentClick, deploymentOrg, linkTenantOf } from "@open-everywhere/core/agent/adapter-api.js";

function log(msg: string): void {
  console.log(`[open-everywhere:discord-link-consent] ${msg}`);
}

const RESPONSE_CHANNEL_MESSAGE = 4;
const EPHEMERAL = 64;

export type DiscordLinkConsentResponse = Record<string, unknown>;

function ephemeral(content: string): DiscordLinkConsentResponse {
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

export async function handleDiscordLinkConsentInteraction(raw: unknown): Promise<DiscordLinkConsentResponse | null> {
  try {
    if (!isObject(raw)) return null;
    const data = isObject(raw["data"]) ? raw["data"] : undefined;
    const customId = typeof data?.["custom_id"] === "string" ? (data["custom_id"] as string) : undefined;
    if (!customId?.startsWith(LINK_CONSENT_CLICK_PREFIX)) return null;
    const parsed = parseLinkConsentClickId(customId);
    if (!parsed) {
      log(`consent click custom_id did not parse — forwarding`);
      return null;
    }

    if (typeof raw["guild_id"] === "string" && raw["guild_id"].length > 0) {
      return ephemeral(
        "I only take an identity answer in our direct messages — this one came from a server. Open our DM and answer it there; nothing was written.",
      );
    }

    const clicker = clickerIdOf(raw);
    if (!clicker) {
      log(`consent click carried no attributable user — refusing`);
      return ephemeral("I could not tell who pressed that, so I did nothing. Answer me in a message here instead.");
    }

    const result = await resolveLinkConsentClick({
      org: deploymentOrg(),
      challengeId: parsed.challengeId,
      verdict: parsed.verdict,
      clicker: { platform: "discord", tenant: linkTenantOf("discord", ""), nativeId: clicker },
    });
    return ephemeral(result.text);
  } catch (err) {
    log(`consent click failed: ${(err as Error)?.message ?? String(err)}`);
    return ephemeral("Something went wrong answering that, and nothing was written. Tell me here instead and I will record it.");
  }
}
