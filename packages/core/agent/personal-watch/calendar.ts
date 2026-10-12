import { createHash } from "node:crypto";
import type { WatchUrgency } from "./dial.js";

export interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface CalendarConflict {
  readonly a: CalendarEvent;
  readonly b: CalendarEvent;
  readonly urgency: WatchUrgency;
  readonly fingerprint: string;
}

const CALENDAR_LOOKAHEAD_HOURS = 72;
const CALENDAR_URGENT_HOURS = 4;
const CALENDAR_SOON_HOURS = 24;

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function timeOf(v: unknown): number | undefined {
  if (typeof v === "string") {
    if (!/T\d/.test(v)) return undefined;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : undefined;
  }
  const o = asObject(v);
  if (!o) return undefined;
  const dateTime = str(o["dateTime"]);
  if (!dateTime) return undefined;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(dateTime);
  if (!hasOffset) {
    const zone = str(o["timeZone"]);
    if (zone === undefined || !/^(?:UTC|Etc\/UTC|GMT)$/i.test(zone)) return undefined;
    return timeOf(`${dateTime}Z`);
  }
  return timeOf(dateTime);
}

function readEvent(raw: unknown, index: number): CalendarEvent | undefined {
  const e = asObject(raw);
  if (!e) return undefined;
  if (e["status"] === "cancelled" || e["isCancelled"] === true) return undefined;
  if (e["transparency"] === "transparent" || e["showAs"] === "free") return undefined;
  const attendees = Array.isArray(e["attendees"]) ? e["attendees"] : [];
  const self = attendees.map(asObject).find((a) => a?.["self"] === true);
  if (self?.["responseStatus"] === "declined") return undefined;
  if (asObject(e["responseStatus"])?.["response"] === "declined" || e["responseStatus"] === "declined") return undefined;
  if (e["isAllDay"] === true) return undefined;
  const startMs = timeOf(e["start"]);
  const endMs = timeOf(e["end"]);
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return undefined;
  const id = str(e["id"]) ?? str(e["iCalUID"]) ?? `#${index}`;
  const title = str(e["summary"]) ?? str(e["subject"]) ?? str(e["title"]) ?? "(no title)";
  return { id, title, startMs, endMs };
}

export type CalendarRead = { readonly ok: true; readonly events: readonly CalendarEvent[] } | { readonly ok: false; readonly unreadable: true };

export function readCalendarBody(body: string): CalendarRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, unreadable: true };
  }
  const o = asObject(parsed);
  const list = Array.isArray(parsed) ? parsed : o && Array.isArray(o["items"]) ? o["items"] : o && Array.isArray(o["value"]) ? o["value"] : o && Array.isArray(o["events"]) ? o["events"] : undefined;
  if (list === undefined) return { ok: false, unreadable: true };
  const events: CalendarEvent[] = [];
  list.forEach((raw, i) => {
    const ev = readEvent(raw, i);
    if (ev) events.push(ev);
  });
  return { ok: true, events };
}

function urgencyOf(startMs: number, now: number): WatchUrgency {
  const hours = (startMs - now) / 3_600_000;
  return hours <= CALENDAR_URGENT_HOURS ? "urgent" : hours <= CALENDAR_SOON_HOURS ? "soon" : "later";
}

function fingerprintOf(a: CalendarEvent, b: CalendarEvent): string {
  return createHash("sha256").update(`${a.id}@${a.startMs}|${b.id}@${b.startMs}`).digest("hex").slice(0, 16);
}

export function findCalendarConflicts(events: readonly CalendarEvent[], now: Date): readonly CalendarConflict[] {
  const t = now.getTime();
  const horizon = t + CALENDAR_LOOKAHEAD_HOURS * 3_600_000;
  const live = events.filter((e) => e.startMs > t && e.startMs <= horizon).sort((x, y) => x.startMs - y.startMs || x.id.localeCompare(y.id));
  const out: CalendarConflict[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      if (b.startMs >= a.endMs) continue;
      if (a.id === b.id) continue;
      out.push({ a, b, urgency: urgencyOf(a.startMs, t), fingerprint: fingerprintOf(a, b) });
    }
  }
  return out;
}
