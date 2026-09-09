import {
  resolveApprovalClick,
  deliverDecisionFeedback,
  discordDecisionWakeTarget,
  postDiscordDecisionNotice,
  clickerFloorRefusalNotice,
  judgeContradictionNotice,
  type ApprovalClickResolution,
  type DecisionWakeDeps,
  type ApprovalOutcome,
  type PendingActionRow,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  OE_DISCORD_APPROVAL_PREFIX,
  parseDiscordApprovalCustomId,
  pendingDiscordCard,
  decidedDiscordCard,
  judgeLiftNoticeDiscordCard,
  isGuildAdministrator,
  scopeWithinGuild,
  type DiscordCardMessage,
} from "./discord-card.js";
import { guildIdFromScopeKey, isGuildAdminViaRest } from "./discord-admin.js";

function log(msg: string): void {
  console.log(`[open-everywhere:discord-approvals] ${msg}`);
}

const RESPONSE_CHANNEL_MESSAGE = 4;
const RESPONSE_DEFERRED_UPDATE = 6;
const RESPONSE_UPDATE_MESSAGE = 7;
const EPHEMERAL_FLAG = 64;

export type DiscordInteractionResponse = Record<string, unknown>;

export interface DiscordPostDeps {
  readonly fetchFn?: typeof fetch;
  readonly token?: string;
}

export async function postDiscordApprovalCard(
  row: PendingActionRow,
  summaryLines: readonly string[],
  deps: DiscordPostDeps = {},
): Promise<string | undefined> {
  return postDiscordCardMessage(row, deps, "approval card", () => pendingDiscordCard(row, summaryLines));
}

export async function postDiscordJudgeLiftNotice(
  row: PendingActionRow,
  summaryLines: readonly string[],
  outcomeLine: string,
  deps: DiscordPostDeps = {},
): Promise<void> {
  await postDiscordCardMessage(row, deps, "judge-lift notice", () => judgeLiftNoticeDiscordCard(row, summaryLines, outcomeLine));
}

async function postDiscordCardMessage(
  row: PendingActionRow,
  deps: DiscordPostDeps,
  what: string,
  render: () => DiscordCardMessage,
): Promise<string | undefined> {
  const token = deps.token ?? process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    log(`DISCORD_BOT_TOKEN is not set — cannot post the ${what} to channel ${row.channelId}`);
    return undefined;
  }
  if (!row.channelId) {
    log(`no channel id on the pending row — nothing to post the ${what} to`);
    return undefined;
  }
  const doFetch = deps.fetchFn ?? fetch;
  try {
    const card = render();
    const res = await doFetch(`https://discord.com/api/v10/channels/${row.channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: card.content, components: card.components }),
    });
    if (!res.ok) {
      log(`Discord create-message failed (${res.status}) posting the ${what} to channel ${row.channelId}`);
      return undefined;
    }
    const body = (await res.json()) as unknown;
    const id = body && typeof body === "object" ? (body as Record<string, unknown>)["id"] : undefined;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch (err) {
    log(`Discord ${what} post error for channel ${row.channelId}: ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}

export interface DiscordApprovalClick {
  readonly customId: string;
  readonly clickerId?: string;
  readonly guildId?: string;
  readonly memberPermissions?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function parseDiscordComponentClick(raw: unknown): DiscordApprovalClick | null {
  if (!isObject(raw) || raw["type"] !== 3) return null;
  const data = isObject(raw["data"]) ? raw["data"] : undefined;
  const customId = data ? str(data["custom_id"]) : undefined;
  if (!customId || !customId.startsWith(OE_DISCORD_APPROVAL_PREFIX)) return null;
  const member = isObject(raw["member"]) ? raw["member"] : undefined;
  const memberUser = member && isObject(member["user"]) ? member["user"] : undefined;
  const user = isObject(raw["user"]) ? raw["user"] : undefined;
  return {
    customId,
    clickerId: (memberUser ? str(memberUser["id"]) : undefined) ?? (user ? str(user["id"]) : undefined),
    guildId: str(raw["guild_id"]),
    memberPermissions: member ? str(member["permissions"]) : undefined,
  };
}

function ephemeral(content: string): DiscordInteractionResponse {
  return { type: RESPONSE_CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL_FLAG } };
}

export interface DiscordApprovalDeps {
  readonly postNotice?: (row: PendingActionRow, text: string) => Promise<unknown>;
  readonly decisionWake?: DecisionWakeDeps;
  readonly waitUntil?: (p: Promise<unknown>) => void;
}

export function discordResponseFor(res: ApprovalClickResolution): DiscordInteractionResponse {
  switch (res.outcome) {
    case "unknown":
      return ephemeral("This approval request is no longer known (it may have already been decided or has aged out).");
    case "not-pending":
    case "expired-race":
    case "unregistered-kind":
    case "lost-race":
      return { type: RESPONSE_DEFERRED_UPDATE };
    case "expired": {
      const card = decidedDiscordCard(res.row, res.summaryLines, "expired");
      return { type: RESPONSE_UPDATE_MESSAGE, data: { content: card.content, components: card.components } };
    }
    case "denied":
      return ephemeral("Only a domain/org admin — or a server administrator, for this server's own scopes — can decide this request.");
    case "clicker-denied":
      return ephemeral(clickerFloorRefusalNotice(res.reason));
    case "halted":
      return ephemeral(res.notice);
    case "contradicted":
      return ephemeral(judgeContradictionNotice(res.contradiction));
    case "decided": {
      const card = decidedDiscordCard(res.row, res.summaryLines, res.outcomeLine);
      return { type: RESPONSE_UPDATE_MESSAGE, data: { content: card.content, components: card.components } };
    }
  }
}

export async function handleDiscordApprovalInteraction(raw: unknown, deps: DiscordApprovalDeps = {}): Promise<DiscordInteractionResponse | null> {
  const click = parseDiscordComponentClick(raw);
  if (!click) return null;

  try {
    const parsed = parseDiscordApprovalCustomId(click.customId);
    if (!parsed) return null;

    if (!click.clickerId) {
      console.error(`[open-everywhere:discord-approvals] component click "${click.customId}" carries no user id — ignoring the click`);
      return ephemeral("Couldn't read who clicked — this decision was not applied.");
    }
    const clickerId = click.clickerId;

    const res = await resolveApprovalClick({
      org: parsed.org,
      id: parsed.id,
      decision: parsed.decision,
      clickerId,
      clickerPlatform: "discord",
      platformAdmin: async (row) => {
        if (click.guildId) return isGuildAdministrator(click.memberPermissions) && scopeWithinGuild(row.scopeKey, click.guildId);
        const rowGuild = guildIdFromScopeKey(row.scopeKey);
        return rowGuild ? isGuildAdminViaRest(rowGuild, clickerId) : false;
      },
    });
    const feedback = (): Promise<void> | undefined => {
      if (res.outcome === "expired") {
        return deliverDecisionFeedback(
          {
            row: res.row,
            summaryLines: res.summaryLines,
            outcome: "expired",
            outcomeLine: "expired",
            executed: "none",
            target: discordDecisionWakeTarget(res.row, click.guildId),
            postNotice: (text) => (deps.postNotice ?? postDiscordDecisionNotice)(res.row, text),
          },
          deps.decisionWake,
        );
      }
      if (res.outcome === "decided") {
        return deliverDecisionFeedback(
          {
            row: res.row,
            summaryLines: res.summaryLines,
            outcome: res.row.status as ApprovalOutcome,
            outcomeLine: res.outcomeLine,
            executed: res.executed,
            clickerId,
            target: discordDecisionWakeTarget(res.row, click.guildId),
            postNotice: (text) => (deps.postNotice ?? postDiscordDecisionNotice)(res.row, text),
          },
          deps.decisionWake,
        );
      }
      return undefined;
    };

    const pending = feedback();
    if (pending !== undefined) {
      if (deps.waitUntil === undefined) {
        await pending;
      } else {
        deps.waitUntil(
          pending.catch((err: unknown) => {
            log(`deferred decision feedback failed for "${click.customId}": ${(err as Error)?.message ?? String(err)}`);
          }),
        );
      }
    }
    return discordResponseFor(res);
  } catch (err) {
    console.error(`[open-everywhere:discord-approvals] click handling failed softly for "${click.customId}": ${String(err)}`);
    return ephemeral("Something went wrong handling this click — the decision was not applied.");
  }
}
