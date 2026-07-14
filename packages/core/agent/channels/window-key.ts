export interface WindowKey {
  readonly domain: string;
  readonly windowId: string;
  readonly generation: number;
}

const EXPLICIT_WINDOW_TOKEN_RE = /^oe-dom:(.+):win:([^:]+):oe-sup:g(\d+)$/;

const LEGACY_WINDOW_TOKEN_RE = /^oe-dom:(.+):oe-sup:g(\d+)$/;

export function formatWindowToken(key: WindowKey): string {
  return key.windowId === key.domain
    ? `oe-dom:${key.domain}:oe-sup:g${key.generation}`
    : `oe-dom:${key.domain}:win:${key.windowId}:oe-sup:g${key.generation}`;
}

export function parseWindowToken(token: unknown): WindowKey | undefined {
  if (typeof token !== "string") return undefined;
  const explicit = EXPLICIT_WINDOW_TOKEN_RE.exec(token);
  if (explicit) return { domain: explicit[1], windowId: explicit[2], generation: Number(explicit[3]) };
  const legacy = LEGACY_WINDOW_TOKEN_RE.exec(token);
  if (legacy) return { domain: legacy[1], windowId: legacy[1], generation: Number(legacy[2]) };
  return undefined;
}

export function isWindowToken(token: unknown): token is string {
  return parseWindowToken(token) !== undefined;
}

export function windowKeyForDomain(domain: string, generation: number): WindowKey {
  return { domain, windowId: domain, generation };
}
