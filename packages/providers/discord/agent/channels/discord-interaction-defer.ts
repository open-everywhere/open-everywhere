import { discordFetch, type DiscordFetchDeps } from "./discord-rest.js";

const API = "https://discord.com/api/v10";

const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;
const EPHEMERAL = 64;

export interface InteractionFollowUp {
  readonly applicationId: string;
  readonly token: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function interactionFollowUp(raw: unknown): InteractionFollowUp | undefined {
  if (!isObject(raw)) return undefined;
  const applicationId = str(raw["application_id"]);
  const token = str(raw["token"]);
  return applicationId === undefined || token === undefined ? undefined : { applicationId, token };
}

export function deferredEphemeralResponse(): Record<string, unknown> {
  return { type: RESPONSE_DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } };
}

export async function editOriginalInteractionResponse(
  followUp: InteractionFollowUp,
  content: string,
  deps: DiscordFetchDeps = {},
): Promise<boolean> {
  try {
    const res = await discordFetch(
      "PATCH /webhooks/{application.id}/{interaction.token}/messages/@original",
      `${API}/webhooks/${encodeURIComponent(followUp.applicationId)}/${encodeURIComponent(followUp.token)}/messages/@original`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      },
      deps,
    );
    return res.ok;
  } catch {
    return false;
  }
}
