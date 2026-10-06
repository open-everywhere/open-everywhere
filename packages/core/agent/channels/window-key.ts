import { randomBytes } from "node:crypto";

export interface WindowKey {
  readonly domain: string;
  readonly windowId: string;
  readonly generation: number;
}

const EXPLICIT_WINDOW_TOKEN_RE = /^oe-dom:(.+):win:([^:]+):oe-sup:g(\d+)(?:-[0-9a-f]+)?$/;

const DEGENERATE_WINDOW_TOKEN_RE = /^oe-dom:(.+):oe-sup:g(\d+)(?:-[0-9a-f]+)?$/;

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
  const degenerate = DEGENERATE_WINDOW_TOKEN_RE.exec(token);
  if (degenerate) return { domain: degenerate[1], windowId: degenerate[1], generation: Number(degenerate[2]) };
  return undefined;
}

export function isWindowToken(token: unknown): token is string {
  return parseWindowToken(token) !== undefined;
}

export function windowKeyForDomain(domain: string, generation: number): WindowKey {
  return { domain, windowId: domain, generation };
}

const TASK_WINDOW_ID_RE = /^t\//;

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

const THREAD_SEAT_WINDOW_ID_RE = /^s\//;

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

const WORK_WINDOW_ID_RE = /^w\//;

export function workWindowId(seatWindowId: string): string {
  if (seatWindowId.length === 0) throw new Error("workWindowId: the seat windowId must be non-empty");
  if (seatWindowId.includes(":")) {
    throw new Error(`workWindowId: a windowId is colon-free ([^:]+) — got seatWindowId="${seatWindowId}"`);
  }
  if (WORK_WINDOW_ID_RE.test(seatWindowId)) throw new Error("workWindowId: a work session has no work session of its own");
  return `w/${seatWindowId}`;
}

export function isWorkWindowId(windowId: string): boolean {
  return WORK_WINDOW_ID_RE.test(windowId);
}

export function isWorkWindowToken(token: unknown): boolean {
  if (typeof token !== "string") return false;
  const raw = token.startsWith(UNIFIED_SEND_PREFIX) ? token.slice(UNIFIED_SEND_PREFIX.length) : token;
  const key = parseWindowToken(raw);
  return key !== undefined && isWorkWindowId(key.windowId);
}

const DM_SEAT_TOKEN_RE = /^(.+):oe-dm:g(\d+)$/;

export function formatDmSeatToken(dmChannelId: string, generation: number): string {
  if (dmChannelId.length === 0) throw new Error("formatDmSeatToken: dmChannelId must be non-empty");
  return `${dmChannelId}:oe-dm:g${generation}`;
}

export function parseDmSeatToken(token: unknown): { channelId: string; generation: number } | undefined {
  if (typeof token !== "string") return undefined;
  const raw = token.startsWith("unified:") ? token.slice("unified:".length) : token;
  const m = DM_SEAT_TOKEN_RE.exec(raw);
  return m ? { channelId: m[1], generation: Number(m[2]) } : undefined;
}

export function isDmSeatToken(token: unknown): token is string {
  return parseDmSeatToken(token) !== undefined;
}

export function dmSeatRegistryKey(dmChannelId: string): string {
  return `oe-dm-seat::${dmChannelId}`;
}

export const DM_ANCHOR_DOMAIN_PREFIX = "oe-dm/";

export const DM_ANCHOR_GENERATION = 0;

export function dmAnchorDomain(dmSurfaceKey: string): string {
  if (dmSurfaceKey.length === 0) throw new Error("dmAnchorDomain: dmSurfaceKey must be non-empty");
  if (dmSurfaceKey.includes(":")) {
    throw new Error(`dmAnchorDomain: a DM anchor's surface key must be colon-free (it becomes the token's <domain> segment) — got "${dmSurfaceKey}"`);
  }
  return `${DM_ANCHOR_DOMAIN_PREFIX}${dmSurfaceKey}`;
}

export function isDmAnchorDomain(domain: unknown): domain is string {
  return typeof domain === "string" && domain.startsWith(DM_ANCHOR_DOMAIN_PREFIX) && domain.length > DM_ANCHOR_DOMAIN_PREFIX.length;
}

export function dmSurfaceKeyFromAnchorDomain(domain: unknown): string | undefined {
  return isDmAnchorDomain(domain) ? domain.slice(DM_ANCHOR_DOMAIN_PREFIX.length) : undefined;
}

export function dmAnchorWindowKey(dmSurfaceKey: string): WindowKey {
  const domain = dmAnchorDomain(dmSurfaceKey);
  return { domain, windowId: domain, generation: DM_ANCHOR_GENERATION };
}

export function isDmAnchoredTaskToken(token: unknown): boolean {
  const key = parseWindowToken(stripUnifiedPrefix(token));
  return key !== undefined && isTaskWindowId(key.windowId) && isDmAnchorDomain(key.domain);
}

export function dmWindowKey(dmSurfaceKey: string, generation: number): WindowKey {
  const domain = dmAnchorDomain(dmSurfaceKey);
  return { domain, windowId: domain, generation };
}

export function isDmAnchorWindowToken(token: unknown): boolean {
  const key = parseWindowToken(stripUnifiedPrefix(token));
  return key !== undefined && isDmAnchorDomain(key.domain) && !isTaskWindowId(key.windowId) && !isThreadSeatWindowId(key.windowId) && !isWorkWindowId(key.windowId);
}

export function dmAnchorSurfaceForToken(token: unknown): string | undefined {
  const key = parseWindowToken(stripUnifiedPrefix(token));
  return key ? dmSurfaceKeyFromAnchorDomain(key.domain) : undefined;
}

const SUBAGENT_TOKEN_RE = /^subagent:(.+):([^:]+)$/;

export function parseSubagentToken(token: unknown): { parentSessionId: string; callId: string } | undefined {
  if (typeof token !== "string") return undefined;
  const raw = token.startsWith(UNIFIED_SEND_PREFIX) ? token.slice(UNIFIED_SEND_PREFIX.length) : token;
  const m = SUBAGENT_TOKEN_RE.exec(raw);
  return m ? { parentSessionId: m[1], callId: m[2] } : undefined;
}

export function isSubagentSessionToken(token: unknown): token is string {
  return parseSubagentToken(token) !== undefined;
}

const SUPERVISOR_SUFFIX_RE = /(?:^|:)oe-sup:g(\d+)(?:-[0-9a-f]+)?$/;

const UNIFIED_SEND_PREFIX = "unified:";

function stripUnifiedPrefix(token: unknown): unknown {
  return typeof token === "string" && token.startsWith(UNIFIED_SEND_PREFIX) ? token.slice(UNIFIED_SEND_PREFIX.length) : token;
}

export function mintGenerationSalt(): string {
  return randomBytes(3).toString("hex");
}

export function saltSupervisorGeneration(token: string): string {
  return `${token}-${mintGenerationSalt()}`;
}

export type SessionId =
  | { kind: "window"; grain: "standing"; key: WindowKey }
  | { kind: "task"; grain: "task"; key: WindowKey; nonce?: string }
  | { kind: "thread-seat"; grain: "thread"; key: WindowKey }
  | { kind: "work"; grain: "standing"; key: WindowKey }
  | { kind: "container-supervisor"; grain: "standing"; containerKey: string; generation: number }
  | { kind: "dm-seat"; grain: "native"; channelId: string; generation: number }
  | { kind: "subagent"; grain: "native"; parentSessionId: string; callId: string }
  | { kind: "native"; grain: "native" };

export function classifySessionId(token: unknown): SessionId {
  if (typeof token !== "string") return { kind: "native", grain: "native" };
  const raw = token.startsWith(UNIFIED_SEND_PREFIX) ? token.slice(UNIFIED_SEND_PREFIX.length) : token;
  const key = parseWindowToken(raw);
  if (key) {
    if (isTaskWindowId(key.windowId)) return { kind: "task", grain: "task", key };
    if (isThreadSeatWindowId(key.windowId)) return { kind: "thread-seat", grain: "thread", key };
    if (isWorkWindowId(key.windowId)) return { kind: "work", grain: "standing", key };
    return { kind: "window", grain: "standing", key };
  }
  const dm = parseDmSeatToken(raw);
  if (dm) return { kind: "dm-seat", grain: "native", channelId: dm.channelId, generation: dm.generation };
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
  const sub = parseSubagentToken(raw);
  if (sub) return { kind: "subagent", grain: "native", parentSessionId: sub.parentSessionId, callId: sub.callId };
  return { kind: "native", grain: "native" };
}

export function bareTokenFromEveContext(token: unknown): string | undefined {
  if (typeof token !== "string" || token.length === 0) return undefined;
  const anchored = (t: string): boolean => {
    if (parseWindowToken(t)) return true;
    if (SUBAGENT_TOKEN_RE.test(t)) return true;
    const dm = parseDmSeatToken(t);
    return dm !== undefined && !dm.channelId.includes(":");
  };
  if (anchored(token)) return token;
  const i = token.indexOf(":");
  const stripped = i > 0 ? token.slice(i + 1) : undefined;
  if (stripped && (anchored(stripped) || SUPERVISOR_SUFFIX_RE.test(stripped))) return stripped;
  if (SUPERVISOR_SUFFIX_RE.test(token)) return token;
  return undefined;
}

export function windowTokenPlatform(token: unknown): string | undefined {
  const sid = classifySessionId(token);
  if (sid.kind === "task" || sid.kind === "thread-seat") {
    return sid.key.windowId.split("/")[1] || undefined;
  }
  if (sid.kind !== "window") return undefined;
  if (sid.key.windowId !== sid.key.domain) return sid.key.windowId.split("/")[0] || undefined;
  return dmSurfaceKeyFromAnchorDomain(sid.key.domain)?.split("/")[0] || undefined;
}

export function isSupervisorShapedToken(token: unknown): boolean {
  const k = classifySessionId(token).kind;
  return k === "window" || k === "task" || k === "thread-seat" || k === "container-supervisor";
}
