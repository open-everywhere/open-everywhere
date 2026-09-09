import { asSchema, jsonSchema } from "ai";

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
    return removed;
  } catch {
    return 0;
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
