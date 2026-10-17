import {
  recordReplyFeedback,
  resolvePartition,
  type PostIntent,
  type ReplyFeedbackClick,
  type ReplyFeedbackRating,
  type SourceLink,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildTeamsAuth } from "./teams-identity.js";

export const TEAMS_FEEDBACK_INVOKE = "message/submitAction";

const CITATION_NAME_MAX = 80;
const CITATION_ABSTRACT_MAX = 160;

function kindWords(kind: string): string {
  switch (kind) {
    case "notion-page":
      return "Notion page";
    case "linear-issue":
      return "Linear issue";
    case "github-issue":
      return "GitHub issue";
    case "github-pull-request":
      return "GitHub pull request";
    default:
      return "Source";
  }
}

const cut = (s: string, max: number): string => {
  const cps = Array.from(s);
  return cps.length <= max ? s : `${cps.slice(0, max - 1).join("")}…`;
};

function teamsAnswerEntity(sources: readonly SourceLink[]): Record<string, unknown> {
  return {
    type: "https://schema.org/Message",
    "@type": "Message",
    "@context": "https://schema.org",
    "@id": "",
    additionalType: ["AIGeneratedContent"],
    ...(sources.length === 0
      ? {}
      : {
          citation: sources.map((s, i) => ({
            "@type": "Claim",
            position: i + 1,
            appearance: {
              "@type": "DigitalDocument",
              name: cut(s.name, CITATION_NAME_MAX),
              url: s.url,
              abstract: cut(`${kindWords(s.kind)}: ${s.name}`, CITATION_ABSTRACT_MAX),
            },
          })),
        }),
  };
}

export function teamsAnswerActivity(text: string, intent: PostIntent | undefined): Record<string, unknown> {
  const sources = intent?.sources ?? [];
  const answer = intent?.feedback === true;
  const markers = sources.map((_, i) => `[${i + 1}]`).join(" ");
  return {
    type: "message",
    text: sources.length > 0 ? `${text}\n\nSources: ${markers}` : text,
    ...(answer ? { channelData: { feedbackLoopEnabled: true } } : {}),
    ...(intent?.generated === true || answer || sources.length > 0 ? { entities: [teamsAnswerEntity(sources)] } : {}),
  };
}

export function isTeamsPersonalConversationId(conversationId: string): boolean {
  return conversationId.startsWith("a:");
}

export interface ParsedTeamsFeedbackInvoke {
  readonly rating: ReplyFeedbackRating;
  readonly userId: string;
  readonly aadObjectId?: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly commentChars: number;
  readonly tenantId?: string;
  readonly teamsChannelId?: string;
  readonly teamId?: string;
  readonly scope?: string;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function commentLength(raw: unknown): number {
  const text = str(raw);
  if (text === undefined) return 0;
  try {
    const parsed = obj(JSON.parse(text));
    const words = str(parsed?.feedbackText);
    return words === undefined ? 0 : words.trim().length;
  } catch {
    return text.trim().length;
  }
}

export function parseTeamsFeedbackInvoke(parsed: unknown): ParsedTeamsFeedbackInvoke | null {
  const a = obj(parsed);
  if (a?.type !== "invoke" || a.name !== TEAMS_FEEDBACK_INVOKE) return null;
  const value = obj(a.value);
  if (value?.actionName !== "feedback") return null;
  const actionValue = obj(value.actionValue);
  const reaction = str(actionValue?.reaction);
  const rating: ReplyFeedbackRating | undefined = reaction === "like" ? "up" : reaction === "dislike" ? "down" : undefined;
  if (rating === undefined) return null;
  const from = obj(a.from);
  const userId = str(from?.id);
  const conversation = obj(a.conversation);
  const conversationId = str(conversation?.id);
  const messageId = str(a.replyToId);
  if (userId === undefined || conversationId === undefined || messageId === undefined) return null;
  const channelData = obj(a.channelData);
  const aadObjectId = str(from?.aadObjectId);
  const tenantId = str(a.tenantId) ?? str(conversation?.tenantId) ?? str(obj(channelData?.tenant)?.id);
  const teamsChannelId = str(obj(channelData?.channel)?.id);
  const teamId = str(obj(channelData?.team)?.id);
  const scope = str(conversation?.conversationType);
  return {
    rating,
    userId,
    conversationId,
    messageId,
    commentChars: commentLength(actionValue?.feedback),
    ...(aadObjectId === undefined ? {} : { aadObjectId }),
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(teamsChannelId === undefined ? {} : { teamsChannelId }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(scope === undefined ? {} : { scope }),
  };
}

export interface TeamsFeedbackRouteDeps {
  readonly record?: (click: ReplyFeedbackClick) => Promise<boolean>;
}

export async function routeTeamsFeedbackInvoke(click: ParsedTeamsFeedbackInvoke, deps: TeamsFeedbackRouteDeps = {}): Promise<boolean> {
  try {
    const p = resolvePartition({
      channel: { kind: "teams" },
      session: {
        auth: {
          current: buildTeamsAuth({
            userId: click.userId,
            conversationId: click.conversationId,
            ...(click.aadObjectId ? { aadObjectId: click.aadObjectId } : {}),
            ...(click.tenantId ? { tenantId: click.tenantId } : {}),
            ...(click.teamsChannelId ? { channelId: click.teamsChannelId } : {}),
            ...(click.teamId ? { teamId: click.teamId } : {}),
            ...(click.scope ? { scope: click.scope } : {}),
          }),
        },
      },
    });
    const record = deps.record ?? ((c: ReplyFeedbackClick) => recordReplyFeedback(c));
    return await record({
      surface: "teams",
      rating: click.rating,
      raterId: click.userId,
      channelId: click.conversationId,
      messageId: click.messageId,
      commentChars: click.commentChars,
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surfaceKey: p.surfaceKey,
    });
  } catch {
    return false;
  }
}
