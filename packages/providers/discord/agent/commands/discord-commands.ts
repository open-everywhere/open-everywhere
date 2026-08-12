import {
  bindFrom,
  OE_COMMAND_NAME,
  runOeCommand,
  type AttachSessionForCancel,
  type BindableContext,
  type OeCommand,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildDiscordAuth, type OpenEverywhereDiscordAuth } from "../channels/discord-identity.js";
import type { DiscordInteractionResponse } from "../approvals/discord-flow.js";

const RESPONSE_CHANNEL_MESSAGE = 4;
const EPHEMERAL_FLAG = 64;

function ephemeral(content: string): DiscordInteractionResponse {
  return { type: RESPONSE_CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL_FLAG } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function channelTypeFromRaw(raw: Record<string, unknown>): string | undefined {
  const ch = raw["channel"];
  if (ch && typeof ch === "object") {
    const t = (ch as Record<string, unknown>)["type"];
    if (typeof t === "number") return String(t);
  }
  return undefined;
}

interface DiscordCommandOption {
  readonly name?: unknown;
  readonly value?: unknown;
  readonly options?: unknown;
}

function optArray(options: unknown): readonly DiscordCommandOption[] {
  return Array.isArray(options) ? (options as DiscordCommandOption[]) : [];
}

function findOpt(options: readonly DiscordCommandOption[], name: string): DiscordCommandOption | undefined {
  return options.find((o) => isObject(o) && o.name === name);
}

export function parseDiscordOeCommandOptions(rawOptions: unknown): OeCommand {
  const top = optArray(rawOptions);
  if (top.length === 0) return { kind: "help" };
  const first = top[0];
  const name = str(first.name);
  if (name === "status") return { kind: "status" };
  if (name === "stop") return { kind: "stop" };
  if (name === "help") return { kind: "help" };
  if (name === "budget") {
    const sub = optArray(first.options)[0];
    const subName = sub ? str(sub.name) : undefined;
    if (!subName || subName === "status") return { kind: "budget-status" };
    if (subName === "clear") return { kind: "budget-clear" };
    if (subName === "raise") {
      const usdOpt = findOpt(optArray(sub?.options), "usd");
      const usd = num(usdOpt?.value);
      if (usd === undefined || usd <= 0) {
        return {
          kind: "error",
          message: `"/oe budget raise" needs a positive "usd" amount (got ${JSON.stringify(usdOpt?.value)}).`,
        };
      }
      return { kind: "budget-raise", usd };
    }
    return { kind: "error", message: `Unknown "budget" subcommand "${subName}".` };
  }
  return { kind: "error", message: `Unknown "/oe" subcommand "${name ?? "?"}" — try "/oe help".` };
}

interface ParsedOeInvocation {
  readonly auth: OpenEverywhereDiscordAuth;
  readonly command: OeCommand;
}

export function parseOeCommandInteraction(raw: unknown): ParsedOeInvocation | { readonly error: string } | null {
  if (!isObject(raw) || raw["type"] !== 2) return null;
  const data = isObject(raw["data"]) ? raw["data"] : undefined;
  if (!data || data["name"] !== OE_COMMAND_NAME) return null;

  const member = isObject(raw["member"]) ? raw["member"] : undefined;
  const memberUser = member && isObject(member["user"]) ? member["user"] : undefined;
  const user = isObject(raw["user"]) ? raw["user"] : undefined;
  const userId = (memberUser ? str(memberUser["id"]) : undefined) ?? (user ? str(user["id"]) : undefined);
  const isBot = memberUser?.["bot"] === true || user?.["bot"] === true;
  if (!userId || isBot) {
    return { error: "Couldn't identify who invoked this — commands can't be run by a bot." };
  }
  const channelId = str(raw["channel_id"]);
  if (!channelId) {
    return { error: "Couldn't resolve this channel's id — try again from a real channel or DM." };
  }
  const guildId = str(raw["guild_id"]);
  const channelType = channelTypeFromRaw(raw);
  const auth = buildDiscordAuth({ userId, guildId, channelId, channelType });
  const command = parseDiscordOeCommandOptions(data["options"]);
  return { auth, command };
}

export async function handleDiscordOeCommandInteraction(
  raw: unknown,
  attachSession?: AttachSessionForCancel,
): Promise<DiscordInteractionResponse | null> {
  const parsed = parseOeCommandInteraction(raw);
  if (parsed === null) return null;
  if ("error" in parsed) return ephemeral(parsed.error);

  try {
    const ctx: BindableContext = { channel: { kind: "discord" }, session: { auth: { current: parsed.auth } } };
    const binding = bindFrom(ctx);
    const text = await runOeCommand(parsed.command, binding, attachSession ? { attachSession } : {});
    return ephemeral(text);
  } catch (err) {
    console.error(`[open-everywhere:discord-commands] "/oe" command failed softly: ${String(err)}`);
    return ephemeral(`Couldn't complete that: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;
const OPTION_NUMBER = 10;
const CHAT_INPUT = 1;

export function buildOeDiscordCommandDefinition(): Record<string, unknown> {
  return {
    name: OE_COMMAND_NAME,
    type: CHAT_INPUT,
    description: "Open Everywhere control-plane commands (status, budget) — no model turn.",
    options: [
      {
        name: "budget",
        description: "Spend-cap status and proposals for this channel/server.",
        type: SUB_COMMAND_GROUP,
        options: [
          { name: "status", description: "Show effective caps and current-month spend.", type: SUB_COMMAND },
          {
            name: "raise",
            description: "Propose a new monthly USD cap for this channel (posts an approval card).",
            type: SUB_COMMAND,
            options: [
              {
                name: "usd",
                description: "Proposed monthly USD budget.",
                type: OPTION_NUMBER,
                required: true,
                min_value: 0.01,
              },
            ],
          },
          { name: "clear", description: "Propose clearing this channel's spend-limit override.", type: SUB_COMMAND },
        ],
      },
      { name: "status", description: "Deploy sanity: app version, model config, memory provider.", type: SUB_COMMAND },
      { name: "stop", description: "Stand down the turn running in this channel.", type: SUB_COMMAND },
      { name: "help", description: "List the /oe commands.", type: SUB_COMMAND },
    ],
  };
}
