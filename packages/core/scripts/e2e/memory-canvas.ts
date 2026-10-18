import type { AuditWireEntry } from "./audit-read.js";

export const CANVAS_REFRESH_ACTION = "memory.canvas_refresh";

const WROTE = new Set(["created", "updated"]);
const WITHHELD = new Set(["skipped-external", "skipped-guest", "cleared-external", "cleared-guest"]);

export type CanvasRefreshVerdict =
  | { readonly kind: "none" }
  | { readonly kind: "wrote"; readonly outcome: string }
  | { readonly kind: "withheld"; readonly outcome: string }
  | { readonly kind: "other"; readonly outcome: string };

export function canvasRefreshVerdict(rows: readonly AuditWireEntry[], channelId: string): CanvasRefreshVerdict {
  const mine = rows
    .filter((r) => r.action === CANVAS_REFRESH_ACTION && r.surface === channelId && r.detail?.["trigger"] === "memory-write")
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const outcome = mine[0]?.detail?.["outcome"];
  if (typeof outcome !== "string") return { kind: "none" };
  if (WROTE.has(outcome)) return { kind: "wrote", outcome };
  if (WITHHELD.has(outcome)) return { kind: "withheld", outcome };
  return { kind: "other", outcome };
}

export type SlackRawCall = (method: string, params: Record<string, string>) => Promise<Record<string, unknown>>;

export type ChannelCanvasRead =
  | { readonly kind: "no-canvas" }
  | { readonly kind: "canvas"; readonly canvasId: string; readonly creator: string | undefined; readonly holdsText: boolean }
  | { readonly kind: "missing-scope"; readonly method: string; readonly scope: string }
  | { readonly kind: "error"; readonly method: string; readonly error: string };

export function channelCanvasIdsOf(info: Record<string, unknown>): string[] {
  const props = (info.channel as { properties?: { canvas?: { file_id?: unknown }; tabs?: unknown } } | undefined)?.properties;
  const ids: string[] = [];
  const add = (id: unknown) => {
    if (typeof id === "string" && id.length > 0 && !ids.includes(id)) ids.push(id);
  };
  add(props?.canvas?.file_id);
  if (Array.isArray(props?.tabs)) {
    for (const tab of props.tabs as { type?: unknown; data?: { file_id?: unknown } }[]) {
      if (tab?.type === "canvas") add(tab.data?.file_id);
    }
  }
  return ids;
}

export function channelCanvasIdOf(info: Record<string, unknown>): string | undefined {
  return channelCanvasIdsOf(info)[0];
}

type FailedRead = { readonly kind: "missing-scope"; readonly method: string; readonly scope: string } | { readonly kind: "error"; readonly method: string; readonly error: string };

export function failedRead(method: string, json: Record<string, unknown>): FailedRead {
  const error = typeof json.error === "string" ? json.error : "unknown_error";
  if (error === "missing_scope") {
    const scope = typeof json.needed === "string" && json.needed.length > 0 ? json.needed : "unknown";
    return { kind: "missing-scope", method, scope };
  }
  return { kind: "error", method, error };
}

export async function readChannelCanvas(call: SlackRawCall, channelId: string, text: string, creator?: string): Promise<ChannelCanvasRead> {
  const info = await call("conversations.info", { channel: channelId });
  if (info.ok !== true) return failedRead("conversations.info", info);
  const ids = channelCanvasIdsOf(info);
  if (ids.length === 0) return { kind: "no-canvas" };
  const reads: ChannelCanvasRead[] = [];
  for (const id of ids) {
    const r = await readCanvasById(call, id, text);
    if (r.kind !== "canvas") return r;
    reads.push(r);
  }
  const holds = (r: ChannelCanvasRead) => r.kind === "canvas" && r.holdsText;
  return reads.find((r) => holds(r) && r.kind === "canvas" && creator !== undefined && r.creator === creator) ?? reads.find(holds) ?? reads[0]!;
}

export async function readCanvasById(call: SlackRawCall, canvasId: string, text: string): Promise<ChannelCanvasRead> {
  const file = await call("files.info", { file: canvasId });
  if (file.ok !== true) return failedRead("files.info", file);
  const user = (file.file as { user?: unknown } | undefined)?.user;
  const lookup = await call("canvases.sections.lookup", { canvas_id: canvasId, criteria: JSON.stringify({ contains_text: text }) });
  if (lookup.ok !== true) return failedRead("canvases.sections.lookup", lookup);
  const sections = Array.isArray(lookup.sections) ? lookup.sections : [];
  return { kind: "canvas", canvasId, creator: typeof user === "string" ? user : undefined, holdsText: sections.length > 0 };
}

export type ChannelTrust = { readonly kind: "internal" } | { readonly kind: "untrusted"; readonly why: string } | FailedRead;

const MEMBER_CHECK_MAX = 200;

export async function classifyChannelTrust(call: SlackRawCall, channelId: string, homeTeamId: string): Promise<ChannelTrust> {
  const info = await call("conversations.info", { channel: channelId });
  if (info.ok !== true) return failedRead("conversations.info", info);
  const ch = (info.channel ?? {}) as Record<string, unknown>;
  for (const flag of ["is_ext_shared", "is_shared", "is_org_shared", "is_pending_ext_shared"]) {
    if (ch[flag] === true) return { kind: "untrusted", why: flag };
  }
  const members = await call("conversations.members", { channel: channelId, limit: String(MEMBER_CHECK_MAX) });
  if (members.ok !== true) return failedRead("conversations.members", members);
  const next = (members.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
  if (typeof next === "string" && next.length > 0) return { kind: "untrusted", why: `more than ${MEMBER_CHECK_MAX} members` };
  for (const m of Array.isArray(members.members) ? members.members : []) {
    if (typeof m !== "string") continue;
    const u = await call("users.info", { user: m });
    if (u.ok !== true) return failedRead("users.info", u);
    const user = (u.user ?? {}) as Record<string, unknown>;
    if (user.is_restricted === true || user.is_ultra_restricted === true) return { kind: "untrusted", why: `guest member ${m}` };
    if (user.is_stranger === true || (typeof user.team_id === "string" && user.team_id !== homeTeamId)) return { kind: "untrusted", why: `member ${m} from another team` };
  }
  return { kind: "internal" };
}

export function canvasShowsFact(read: ChannelCanvasRead, botUserId: string): boolean {
  return read.kind === "canvas" && read.creator === botUserId && read.holdsText;
}

export const CANVAS_WRITE_ACTION = "canvas.write";

export function createdCanvasId(rows: readonly AuditWireEntry[], channelId: string): string | undefined {
  const mine = rows
    .filter((r) => r.action === CANVAS_WRITE_ACTION && r.detail?.["channel"] === channelId && r.detail?.["op"] === "create")
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const id = mine[0]?.detail?.["canvasId"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function memoryCanvasTeach(fact: string): string {
  return `remember: the memory canvas check ref is now ${fact}. It is a plain test label, not a secret, and it replaces the value from any earlier run.`;
}
