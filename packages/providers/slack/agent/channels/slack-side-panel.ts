export const SLACK_CHANNEL_ENTITY_TYPE = "slack#/types/channel_id";

const CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/u;

export interface SlackAppContextRoom {
  readonly channelId: string;
  readonly teamId?: string;
}

export function parseSlackAppContext(event: Readonly<Record<string, unknown>>): SlackAppContextRoom | undefined {
  const ctx = event.app_context;
  if (ctx === null || typeof ctx !== "object") return undefined;
  const entities = (ctx as { entities?: unknown }).entities;
  if (!Array.isArray(entities)) return undefined;
  for (const raw of entities) {
    if (raw === null || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (e.type !== SLACK_CHANNEL_ENTITY_TYPE || typeof e.value !== "string" || !CHANNEL_ID.test(e.value)) continue;
    return { channelId: e.value, ...(typeof e.team_id === "string" && e.team_id.length > 0 ? { teamId: e.team_id } : {}) };
  }
  return undefined;
}

export interface SidePanelGate {
  readonly room: SlackAppContextRoom | undefined;
  readonly teamId: string | undefined;
  readonly partnerTrust: "internal" | "external" | undefined;
  readonly channelInternal: (channelId: string) => Promise<boolean>;
}

export async function sidePanelViewedRoom(gate: SidePanelGate): Promise<string | undefined> {
  const { room } = gate;
  if (!room || gate.partnerTrust !== "internal") return undefined;
  if (!gate.teamId || room.teamId !== gate.teamId) return undefined;
  const internal = await gate.channelInternal(room.channelId).catch(() => false);
  return internal ? room.channelId : undefined;
}

export function slackDmSystemNote(input: {
  readonly viewedRoom?: string;
  readonly personOptOut?: { readonly optedOut: boolean; readonly readable: boolean };
}): string | undefined {
  const lines: string[] = [];
  if (input.viewedRoom) {
    lines.push(
      `The person wrote this from the side panel while viewing the room ${input.viewedRoom} (Slack shows <#${input.viewedRoom}> as its link). ` +
        "That is context only. It gives this conversation none of that room's access: a read of that room follows the rules that already apply here.",
    );
  }
  if (input.personOptOut?.optedOut && input.personOptOut.readable) {
    lines.push(
      "This person has opted out of agent actions on their own content. Nothing from this conversation is saved to memory. " +
        "Do not promise to remember anything. If they ask, tell them their opt-out is on.",
    );
  } else if (input.personOptOut?.optedOut) {
    lines.push(
      "The person's opt-out setting could not be read just now, so this turn may not be saved to memory. " +
        "Do not promise to remember anything, and do not tell them their opt-out is on.",
    );
  }
  return lines.length > 0 ? lines.join(" ") : undefined;
}
