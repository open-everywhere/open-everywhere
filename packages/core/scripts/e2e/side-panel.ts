import type { AuditWireEntry } from "./audit-read.js";
import type { TranscriptWireEvent } from "./transcript-read.js";
import { auditSessionIds } from "./transcript-timings.js";

export function slackTsAt(ms: number): string {
  const whole = Math.floor(ms);
  return `${Math.floor(whole / 1000)}.${String((whole % 1000) * 1000).padStart(6, "0")}`;
}

const LINK_KEYS = ["wakeId", "inheritedWakeId", "seatSessionId", "requestId", "request"] as const;

function linksOf(row: AuditWireEntry): string[] {
  const out = [...auditSessionIds([row])];
  for (const key of LINK_KEYS) {
    const v = row.detail?.[key];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

export function turnRows(rows: readonly AuditWireEntry[], wakeId: string): AuditWireEntry[] {
  const links = new Set([wakeId]);
  const taken = new Set<AuditWireEntry>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (taken.has(row)) continue;
      const own = linksOf(row);
      if (!own.some((l) => links.has(l))) continue;
      taken.add(row);
      grew = true;
      for (const l of own) links.add(l);
    }
  }
  return rows.filter((r) => taken.has(r));
}

export function viewedRoomRows(turn: readonly AuditWireEntry[], channelId: string): AuditWireEntry[] {
  return turn.filter(
    (r) => r.surface === channelId || (r.surface?.endsWith(`/${channelId}`) ?? false) || JSON.stringify(r.detail ?? {}).includes(channelId),
  );
}

export const NOT_A_READ_TOOLS: ReadonlySet<string> = new Set(["reply", "edit_reply", "no_reply", "update_status", "react", "look_up"]);

export const NO_TARGET_READ_TOOLS: ReadonlySet<string> = new Set(["read_channel", "read_thread", "read_work_channel", "read_work_thread"]);

export interface ViewedRoom {
  readonly id: string;
  readonly name?: string;
}

export const MIN_ROOM_NAME_LENGTH = 4;

export function namesRoom(text: string, room: ViewedRoom): boolean {
  if (text.includes(room.id)) return true;
  const name = room.name?.trim().toLowerCase() ?? "";
  if (name.length < MIN_ROOM_NAME_LENGTH) return false;
  const lower = text.toLowerCase();
  for (let at = lower.indexOf(name); at >= 0; at = lower.indexOf(name, at + 1)) {
    const before = at === 0 ? "" : lower[at - 1]!;
    const after = lower[at + name.length] ?? "";
    if (!/[a-z0-9_-]/u.test(before) && !/[a-z0-9_-]/u.test(after)) return true;
  }
  return false;
}

export function toolCallsNamingRoom(events: readonly TranscriptWireEvent[], room: ViewedRoom, sinceMs: number): string[] {
  const out: string[] = [];
  for (const e of events) {
    const at = e.at === null ? Number.NaN : Date.parse(e.at);
    if (Number.isFinite(at) && at < sinceMs) continue;
    if (e.type === "actions.requested") {
      const actions = (e.data as { actions?: readonly unknown[] } | null)?.actions ?? [];
      for (const a of actions) {
        const toolName = (a as { toolName?: unknown } | null)?.toolName;
        const name = typeof toolName === "string" ? toolName : "?";
        if (NOT_A_READ_TOOLS.has(name)) continue;
        if (namesRoom(JSON.stringify(a ?? null), room)) out.push(name);
      }
    } else if (e.type === "action.result") {
      const result = (e.data as { result?: { toolName?: unknown; output?: unknown } } | null)?.result;
      const toolName = typeof result?.toolName === "string" ? result.toolName : "";
      if (!NO_TARGET_READ_TOOLS.has(toolName)) continue;
      const channel = (result?.output as { channel?: unknown } | null | undefined)?.channel;
      if (typeof channel === "string" && channel.includes(room.id)) out.push(`${toolName} (read ${channel})`);
    }
  }
  return out;
}

export function viewedRoomNotePhrase(channelId: string): string {
  return `while viewing the room ${channelId}`;
}

export function noteNamesViewedRoom(events: readonly TranscriptWireEvent[], channelId: string, sinceMs: number): boolean {
  const phrase = viewedRoomNotePhrase(channelId);
  return events.some((e) => {
    if (e.type !== "message.received") return false;
    const at = e.at === null ? Number.NaN : Date.parse(e.at);
    if (Number.isFinite(at) && at < sinceMs) return false;
    return JSON.stringify(e.data ?? null).includes(phrase);
  });
}
