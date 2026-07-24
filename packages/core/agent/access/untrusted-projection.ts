import { ingestUntrustedModelOutput } from "./untrusted.js";

const AUTH_PENDING_BRAND = "__eveAuthorizationPending";

function isAuthPendingOutput(output: unknown): boolean {
  return typeof output === "object" && output !== null && (output as Record<string, unknown>)[AUTH_PENDING_BRAND] === true;
}

export interface ToolModelOutputShape {
  type: string;
  value: unknown;
}

type AuthoredProjection = (output: unknown) => ToolModelOutputShape | Promise<ToolModelOutputShape>;

interface AiSdkToolLike {
  execute?: (...args: unknown[]) => unknown;
  toModelOutput?: (args: { output: unknown; toolCallId: string }) => ToolModelOutputShape | Promise<ToolModelOutputShape>;
}

const authoredProjections = new Map<string, AuthoredProjection>();

export function registerReplayModelProjection(name: string, projection: AuthoredProjection): void {
  authoredProjections.set(name, projection);
}

export function registeredProjectionNames(): readonly string[] {
  return [...authoredProjections.keys()];
}

function isConnectorExternalName(name: string): boolean {
  return (name.includes("__") || name === "connection_search") && !authoredProjections.has(name);
}

export function projectToolSet(toolset: Record<string, unknown>): void {
  for (const [name, raw] of Object.entries(toolset)) {
    if (raw === null || typeof raw !== "object") continue;
    const tool = raw as AiSdkToolLike;

    const authored = authoredProjections.get(name);
    if (authored !== undefined) {
      if (typeof tool.execute !== "function") continue;
      const prev = tool.toModelOutput?.bind(tool);
      tool.toModelOutput = async (args) => {
        if (isAuthPendingOutput(args?.output) && prev !== undefined) return prev(args);
        return await authored(args?.output);
      };
      continue;
    }

    if (isConnectorExternalName(name) && typeof tool.execute === "function") {
      const prev = tool.toModelOutput?.bind(tool);
      tool.toModelOutput = async (args) => {
        const output = args?.output;
        if (isAuthPendingOutput(output)) {
          if (prev !== undefined) return prev(args);
          return { type: "text", value: "Authorization required. Waiting for the user to sign in." };
        }
        let text: string;
        if (prev !== undefined) {
          const base = await prev(args);
          text = base.type === "text" ? String(base.value) : JSON.stringify(base.value ?? null);
        } else {
          text = typeof output === "string" ? output : JSON.stringify(output ?? null);
        }
        return ingestUntrustedModelOutput(text, { source: `connector ${name}` });
      };
    }
  }
}

const HOOK_KEY = "__oeToolResultProjection";

export function installToolResultProjectionHook(): void {
  (globalThis as Record<string, unknown>)[HOOK_KEY] = projectToolSet;
}

installToolResultProjectionHook();
