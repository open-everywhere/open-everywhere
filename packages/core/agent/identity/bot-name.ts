import { getSettings } from "../settings/settings.js";

export const DEFAULT_AGENT_SHORT_NAME = "oe";
export const DEFAULT_AGENT_FULL_NAME = "open everywhere";
export const DEFAULT_AGENT_DISPLAY_NAME = "Open Everywhere";
const DEFAULT_COMMAND_NAME = "oe";

export const OE_ADDRESSED_ATTR = "oe_addressed";
export const OE_BOT_NAME_ATTR = "oe_bot_name";

export function configuredAgentName(): string | undefined {
  try {
    const name = getSettings().identity.name.trim();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

export function configuredAgentShortName(): string | undefined {
  try {
    const name = getSettings().identity.shortName.trim();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

export function agentDisplayName(): string {
  return configuredAgentName() ?? DEFAULT_AGENT_DISPLAY_NAME;
}

export function agentCommandName(): string {
  try {
    return getSettings().identity.commandName;
  } catch {
    return DEFAULT_COMMAND_NAME;
  }
}

export function agentNameTokens(resolved?: string): string[] {
  const name = configuredAgentName();
  const shortName = configuredAgentShortName();
  const named = name !== undefined || shortName !== undefined;
  const raw = named ? [resolved, name, shortName] : [resolved, DEFAULT_AGENT_FULL_NAME, DEFAULT_AGENT_SHORT_NAME];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const t = v?.trim();
    if (!t || t.length < 2) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function agentNameTokenPattern(token: string): RegExp {
  const escaped = token.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s*");
  return new RegExp(`\\b${escaped}\\b`, "iu");
}

export function matchesAgentName(text: string, resolved?: string): boolean {
  if (!text) return false;
  return agentNameTokens(resolved).some((t) => agentNameTokenPattern(t).test(text));
}
