import { asSchema, jsonSchema } from "ai";
import { defineState } from "eve/context";
import { parseWakeAttachments, withDelegatedAttachments, type BriefAttachment } from "../channels/attachments.js";
import { isWakeEnvelopeShaped } from "../channels/wake-envelope.js";

const DELEGATION_TOOL_NAME = "agent";

const CONTINUATION_FIELD = "agentId";

export const CONTINUATION_REFUSAL_MESSAGE =
  "Worker continuation is disabled on this deployment: `agentId` is not accepted. Start a fresh delegation and pass the context it needs in the brief.";

const AGENTS_NOTE_PREFIX = "[Agents]\n<agents>";

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

function isAgentsNote(message: unknown): boolean {
  if (message === null || typeof message !== "object") return false;
  const m = message as MessageLike;
  if (m.role !== "user") return false;
  return typeof m.content === "string" && m.content.startsWith(AGENTS_NOTE_PREFIX);
}

export function suppressAgentsListing(messages: unknown): number {
  try {
    if (!Array.isArray(messages)) return 0;
    let removed = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!isAgentsNote(messages[i])) continue;
      messages.splice(i, 1);
      removed++;
    }
    noteWakeAttachments(messages);
    return removed;
  } catch {
    return 0;
  }
}

const wakeAttachmentSlot = defineState<readonly BriefAttachment[]>("open-everywhere.wake-attachments", () => []);

const DELEGATION_BRIEF_FIELD = "message";

function lastUserText(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === null || typeof m !== "object") continue;
    const like = m as MessageLike;
    if (like.role !== "user") continue;
    if (typeof like.content === "string") return like.content;
    if (!Array.isArray(like.content)) return undefined;
    const text = like.content
      .map((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("\n");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function noteWakeAttachments(messages: readonly unknown[]): void {
  let found: readonly BriefAttachment[] = [];
  try {
    const text = lastUserText(messages);
    if (text !== undefined && isWakeEnvelopeShaped(text)) found = parseWakeAttachments(text);
  } catch {
    found = [];
  }
  try {
    wakeAttachmentSlot.update(() => found);
  } catch {
  }
}

function currentWakeAttachments(): readonly BriefAttachment[] {
  try {
    return wakeAttachmentSlot.get();
  } catch {
    return [];
  }
}

function carryAttachmentsIntoBrief(candidate: unknown): unknown {
  try {
    const attachments = currentWakeAttachments();
    if (attachments.length === 0) return candidate;
    if (candidate === null || typeof candidate !== "object") return candidate;
    const message = (candidate as Record<string, unknown>)[DELEGATION_BRIEF_FIELD];
    if (typeof message !== "string" || message.length === 0) return candidate;
    return { ...(candidate as Record<string, unknown>), [DELEGATION_BRIEF_FIELD]: withDelegatedAttachments(message, attachments) };
  } catch {
    return candidate;
  }
}

interface ToolWithInputSchema {
  inputSchema?: unknown;
}

type JsonSchemaObject = {
  properties?: Record<string, unknown>;
  required?: readonly string[];
  [k: string]: unknown;
};

const replacements = new WeakMap<object, unknown>();

function isBlankContinuationId(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim().length === 0;
}

export function refuseAgentContinuation(toolset: Record<string, unknown>): boolean {
  const raw = toolset[DELEGATION_TOOL_NAME];
  if (raw === null || typeof raw !== "object") return false;
  const tool = raw as ToolWithInputSchema;
  const current = tool.inputSchema;
  if (current === null || typeof current !== "object") return false;

  const cached = replacements.get(current as object);
  if (cached !== undefined) {
    tool.inputSchema = cached;
    return true;
  }

  const original = asSchema(current as never);
  const source = original.jsonSchema as JsonSchemaObject | undefined;
  const properties = source?.properties;
  if (source === undefined || properties === undefined || !(CONTINUATION_FIELD in properties)) return false;

  const { [CONTINUATION_FIELD]: _dropped, ...keptProperties } = properties;
  const stripped: JsonSchemaObject = { ...source, properties: keptProperties };
  if (Array.isArray(source.required)) {
    stripped.required = source.required.filter((name) => name !== CONTINUATION_FIELD);
  }

  const replacement = jsonSchema(stripped as never, {
    validate: async (value: unknown) => {
      let candidate = value;
      if (candidate !== null && typeof candidate === "object" && CONTINUATION_FIELD in candidate) {
        const id = (candidate as Record<string, unknown>)[CONTINUATION_FIELD];
        if (!isBlankContinuationId(id)) {
          return { success: false as const, error: new Error(CONTINUATION_REFUSAL_MESSAGE) };
        }
        const { [CONTINUATION_FIELD]: _blank, ...rest } = candidate as Record<string, unknown>;
        candidate = rest;
      }
      candidate = carryAttachmentsIntoBrief(candidate);
      if (typeof original.validate !== "function") return { success: true as const, value: candidate };
      return await original.validate(candidate);
    },
  });

  replacements.set(current as object, replacement);
  tool.inputSchema = replacement;
  return true;
}

const MODEL_MESSAGE_HOOK_KEY = "__oeModelMessageProjection";

function installAgentsListingProjectionHook(): void {
  (globalThis as Record<string, unknown>)[MODEL_MESSAGE_HOOK_KEY] = suppressAgentsListing;
}

installAgentsListingProjectionHook();
