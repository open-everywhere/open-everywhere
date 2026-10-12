import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowGated } from "../access/window-gated.js";
import { bindFrom, currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { actingPrincipalIdOf, unattendedOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { auditToolAction } from "../audit/tool-action.js";
import { getOperationalStore } from "../operational/provider.js";
import { resolveUnifiedWakeTarget } from "../channels/unified-window.js";
import { dmSurfaceOfSeat, nonMemberWakeOf } from "../channels/domain-question.js";
import {
  BOT_ASK_ASK_MAX_CHARS,
  BOT_ASK_EXPECTED_ACTION,
  BOT_ASK_REFUSED_ACTION,
  BOT_ASK_REPLY_CAP,
  BOT_ASK_TOOL,
  BOT_ASK_WINDOW_MS,
  botAskBotName,
  botAskIdFor,
  botAskProbe,
  botAskProbeRefusal,
  botAskRelayTurn,
  botAskRoomRefusal,
  rememberBotAsk,
  type BotAskRefusal,
} from "../channels/bot-ask.js";

const TOOL = BOT_ASK_TOOL;

function currentAuthAttributes(ctx: BindableContext): Record<string, unknown> | undefined {
  return (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null } } }).session?.auth?.current?.attributes;
}

async function refuse(ctx: BindableContext, refusal: BotAskRefusal): Promise<never> {
  await auditToolAction(ctx, BOT_ASK_REFUSED_ACTION, { reason: refusal.reason, tool: TOOL });
  throw new Error(`${TOOL}: ${refusal.message}`);
}

export default windowGated(
  "expect_bot_reply",
  defineTool({
    description:
      "Wait for another bot's answer to an ask you posted for the person, and bring it back to this DM. Use it when the person asks you to ask another bot something for them (\"ask the deploy bot in #ops to roll back for me\"). " +
      "Other bots answer people, not bots, so the ask goes out in the PERSON's name: first have it posted in the channel through the person's own Slack connection, @mentioning the bot (a job does that, and it takes an approval card), and have the job return the channel id and the message ts. Then call this with them and the bot's user id. " +
      `The host checks the person wrote that message and that it mentions that bot. From then on, for ${BOT_ASK_WINDOW_MS / 3_600_000} hours and at most ${BOT_ASK_REPLY_CAP} replies, that bot's replies in that thread come to this DM as messages of their own. Tell the person you are waiting, and relay each reply when it arrives. ` +
      "Through this tool, a bot's message anywhere else is never relayed to you. DM only.",
    inputSchema: z.object({
      channel: z.string().min(1).describe("The channel the ask was posted in, as its platform id (Slack: C…)."),
      messageTs: z.string().min(1).describe("The ask message's id (Slack: its ts, e.g. 1760009420.123456)."),
      bot: z.string().min(1).describe("The bot asked, as its platform user id — the id inside the ask's @mention (Slack: U…)."),
    }),
    outputSchema: z.object({
      status: z.literal("waiting"),
      askId: z.string(),
      bot: z.string(),
      expiresAt: z.string(),
      note: z.string(),
    }),
    async execute(input, ctx) {
      const c = ctx as BindableContext;
      const binding = bindFrom(c);
      const asker = actingPrincipalIdOf(c);
      const probe = botAskProbe(binding.platform);
      const roomRefusal = botAskRoomRefusal({
        mode: binding.mode,
        trust: binding.trust,
        nonMemberWake: nonMemberWakeOf(c),
        asker,
        unattended: unattendedOf(c),
        relayTurn: botAskRelayTurn(currentAuthAttributes(c)),
        probe: probe !== undefined,
      });
      if (roomRefusal) return refuse(c, roomRefusal);
      const person = asker as string;
      const p = resolvePartition(c);
      const channel = input.channel.trim();
      const messageTs = input.messageTs.trim();
      const bot = input.bot.trim().replace(/^<@([^|>\s]+)(\|[^>]*)?>$/, "$1");
      const answer = await probe!({ workspaceKey: p.workspaceKey, personId: person, channel, messageTs, bot }).catch(() => ({ ok: false as const, reason: "unreadable" as const }));
      if (!answer.ok) return refuse(c, botAskProbeRefusal(answer.reason));

      const org = deploymentOrg();
      const store = getOperationalStore();
      const wakeId = currentWakeId(c);
      const dmOrigin = wakeId ? await resolveUnifiedWakeTarget(store, org, wakeId) : null;
      const dmSurfaceKey = dmSurfaceOfSeat(resolveOwnWindowToken(c));
      if (!dmOrigin || dmSurfaceKey === undefined) {
        throw new Error(`${TOOL}: I couldn't resolve this DM's own address, so nothing was recorded. Try again on a message the person sent.`);
      }
      const workspace = p.workspaceKey.split("/")[1] ?? p.workspace;
      const now = Date.now();
      const atIso = new Date(now).toISOString();
      const expiresAtIso = new Date(now + BOT_ASK_WINDOW_MS).toISOString();
      const askText = answer.askText.length > BOT_ASK_ASK_MAX_CHARS ? `${answer.askText.slice(0, BOT_ASK_ASK_MAX_CHARS - 1)}…` : answer.askText;
      const id = botAskIdFor(binding.platform ?? p.platform, workspace, channel, messageTs, answer.botUserId);
      const row = {
        id,
        org,
        platform: binding.platform ?? p.platform,
        workspace,
        channel,
        threadTs: answer.threadTs,
        askTs: messageTs,
        botUserId: answer.botUserId,
        ...(answer.botId === undefined ? {} : { botId: answer.botId }),
        ...(answer.botLabel === undefined ? {} : { botLabel: answer.botLabel }),
        asker: person,
        dmSurfaceKey,
        dmOrigin,
        dmAudit: { platform: p.platform, workspace: p.workspace, surface: p.surface },
        askText,
        atIso,
        expiresAtIso,
      };
      await rememberBotAsk(store, row);
      await auditToolAction(c, BOT_ASK_EXPECTED_ACTION, { askId: id, bot: answer.botUserId, channel, thread: answer.threadTs, windowHours: BOT_ASK_WINDOW_MS / 3_600_000, cap: BOT_ASK_REPLY_CAP });
      const name = botAskBotName(row);
      return {
        status: "waiting" as const,
        askId: id,
        bot: answer.botUserId,
        expiresAt: expiresAtIso,
        note: `Waiting for ${name}. Its replies in that thread come to this DM as messages of their own until ${expiresAtIso}. Tell the person you asked and are waiting, and do not guess the answer in the meantime.`,
      };
    },
  }),
);
