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

export const TASK_WINDOW_ID_RE = /^t\//;

export function taskWindowId(channelKey: string, threadTs: string): string {
  if (channelKey.length === 0 || threadTs.length === 0) {
    throw new Error("taskWindowId: channelKey and threadTs must both be non-empty");
  }
  if (channelKey.includes(":") || threadTs.includes(":")) {
    throw new Error(
      `taskWindowId: a windowId is colon-free ([^:]+) — got channelKey="${channelKey}", threadTs="${threadTs}" (sanitise colons before minting)`,
    );
  }
  return `t/${channelKey}/${threadTs}`;
}
export function isTaskWindowId(windowId: string): boolean {
  return TASK_WINDOW_ID_RE.test(windowId);
}

export function isTaskWindowToken(token: unknown): boolean {
  const key = parseWindowToken(token);
  return key !== undefined && isTaskWindowId(key.windowId);
}
