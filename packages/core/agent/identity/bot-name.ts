export const DEFAULT_AGENT_SHORT_NAME = "oe";
export const DEFAULT_AGENT_FULL_NAME = "open everywhere";

export const OE_ADDRESSED_ATTR = "oe_addressed";
export const OE_BOT_NAME_ATTR = "oe_bot_name";

export function agentNameTokens(resolved?: string): string[] {
  const raw = [
    resolved,
    process.env.OE_AGENT_NAME ?? DEFAULT_AGENT_FULL_NAME,
    process.env.OE_AGENT_SHORT_NAME ?? DEFAULT_AGENT_SHORT_NAME,
  ];
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
