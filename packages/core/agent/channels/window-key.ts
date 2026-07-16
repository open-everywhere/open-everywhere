export interface WindowKey {
  readonly domain: string;
  readonly windowId: string;
  readonly generation: number;
}

const EXPLICIT_WINDOW_TOKEN_RE = /^oe-dom:(.+):win:([^:]+):oe-sup:g(\d+)$/;

const LEGACY_WINDOW_TOKEN_RE = /^oe-dom:(.+):oe-sup:g(\d+)$/;

export function formatWindowToken(key: WindowKey): string {
  if (key.windowId === key.domain) {
    return `oe-dom:${key.domain}:oe-sup:g${key.generation}`;
  }
  if (key.windowId.includes(":")) {
    throw new Error(
      `formatWindowToken: a windowId is colon-free ([^:]+) — got windowId="${key.windowId}" (domain="${key.domain}"); sanitise colons before minting the explicit :win: form`,
    );
  }
  return `oe-dom:${key.domain}:win:${key.windowId}:oe-sup:g${key.generation}`;
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

export function taskWindowId(channelKey: string, threadTs: string, nonce?: string): string {
  if (channelKey.length === 0 || threadTs.length === 0) {
    throw new Error("taskWindowId: channelKey and threadTs must both be non-empty");
  }
  const parts = [channelKey, threadTs, ...(nonce !== undefined ? [nonce] : [])];
  for (const p of parts) {
    if (p.length === 0) throw new Error("taskWindowId: nonce must be non-empty when supplied");
    if (p.includes(":")) {
      throw new Error(
        `taskWindowId: a windowId is colon-free ([^:]+) — got a colon-bearing component in ["${channelKey}","${threadTs}"${nonce !== undefined ? `,"${nonce}"` : ""}] (sanitise colons before minting)`,
      );
    }
  }
  return `t/${parts.join("/")}`;
}
export function isTaskWindowId(windowId: string): boolean {
  return TASK_WINDOW_ID_RE.test(windowId);
}

export function isTaskWindowToken(token: unknown): boolean {
  const key = parseWindowToken(token);
  return key !== undefined && isTaskWindowId(key.windowId);
}

export const THREAD_SEAT_WINDOW_ID_RE = /^s\//;

export function threadSeatWindowId(channelKey: string, threadTs: string): string {
  if (channelKey.length === 0 || threadTs.length === 0) {
    throw new Error("threadSeatWindowId: channelKey and threadTs must both be non-empty");
  }
  if (channelKey.includes(":") || threadTs.includes(":")) {
    throw new Error(
      `threadSeatWindowId: a windowId is colon-free ([^:]+) — got channelKey="${channelKey}", threadTs="${threadTs}" (sanitise colons before minting)`,
    );
  }
  return `s/${channelKey}/${threadTs}`;
}

export function isThreadSeatWindowId(windowId: string): boolean {
  return THREAD_SEAT_WINDOW_ID_RE.test(windowId);
}

export function isThreadSeatWindowToken(token: unknown): boolean {
  const key = parseWindowToken(token);
  return key !== undefined && isThreadSeatWindowId(key.windowId);
}

const SUPERVISOR_SUFFIX_RE = /(?:^|:)oe-sup:g(\d+)$/;

const UNIFIED_SEND_PREFIX = "unified:";

export type SessionId =
  | { kind: "window"; grain: "standing"; key: WindowKey }
  | { kind: "task"; grain: "task"; key: WindowKey; nonce?: string }
  | { kind: "thread-seat"; grain: "thread"; key: WindowKey }
  | { kind: "container-supervisor"; grain: "standing"; containerKey: string; generation: number }
  | { kind: "native"; grain: "native" };

export function classifySessionId(token: unknown): SessionId {
  if (typeof token !== "string") return { kind: "native", grain: "native" };
  const raw = token.startsWith(UNIFIED_SEND_PREFIX) ? token.slice(UNIFIED_SEND_PREFIX.length) : token;
  const key = parseWindowToken(raw);
  if (key) {
    if (isTaskWindowId(key.windowId)) return { kind: "task", grain: "task", key };
    if (isThreadSeatWindowId(key.windowId)) return { kind: "thread-seat", grain: "thread", key };
    return { kind: "window", grain: "standing", key };
  }
  const sup = SUPERVISOR_SUFFIX_RE.exec(raw);
  if (sup) {
    const idx = raw.lastIndexOf(":oe-sup:g");
    return {
      kind: "container-supervisor",
      grain: "standing",
      containerKey: idx > 0 ? raw.slice(0, idx) : "",
      generation: Number(sup[1]),
    };
  }
  return { kind: "native", grain: "native" };
}

export function isSupervisorShapedToken(token: unknown): boolean {
  return classifySessionId(token).kind !== "native";
}
