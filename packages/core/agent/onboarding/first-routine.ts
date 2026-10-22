import { getSettings } from "../settings/settings.js";
import { SURFACE } from "../memory/store.js";
import { getProvider } from "../memory/provider.js";
import { writeMemoryTier } from "../memory/write-road.js";
import type { Partition } from "../memory/partition.js";
import type { SurfaceBinding } from "../identity/binding.js";
import { actingPrincipalId, unattendedFrom } from "../identity/binding.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { readPersonalWatch, recordFirstConversationOutcome, type FirstConversationOutcome } from "../personal-watch/state.js";

export const FIRST_ROUTINE_MARKER = "_first_routine";

export interface RoomFirstRoutine {
  readonly since: string;
  readonly outcome?: FirstConversationOutcome;
  readonly decidedAt?: string;
}

export function firstConversationDays(): number {
  return getSettings().routines.firstConversationDays;
}

export function firstConversationOpen(record: { readonly since: string; readonly outcome?: unknown } | undefined, nowIso: string, days: number): boolean {
  if (!record || record.outcome !== undefined || days <= 0) return false;
  const since = Date.parse(record.since);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(since) || !Number.isFinite(now)) return false;
  return now >= since && now - since < days * 86_400_000;
}

export function parseRoomFirstRoutine(raw: string | undefined): RoomFirstRoutine | undefined {
  if (raw === undefined) return undefined;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o["since"] !== "string" || o["since"].length === 0) return undefined;
    const outcome: FirstConversationOutcome | undefined =
      o["outcome"] === undefined ? undefined : o["outcome"] === "set-up" || o["outcome"] === "offered" ? o["outcome"] : "declined";
    return { since: o["since"], ...(outcome ? { outcome } : {}), ...(typeof o["decidedAt"] === "string" ? { decidedAt: o["decidedAt"] } : {}) };
  } catch {
    return undefined;
  }
}

export function roomFirstRoutineMarker(atIso: string): string {
  return JSON.stringify({ since: atIso });
}

const HOW_TO_OFFER = `Say it in ONE plain sentence: what you will send or watch, and when. For example: "Want me to send
you a digest of your open issues every Monday at 9:00?" Use friendly names, the words they used, and never an
id. In the same turn, hand off the job that creates that routine, so its card posts beside your sentence.
Pressing the card's approve button is the one confirmation. Its decline button ends the offer.

Offer at most ONE routine, and only once. Never push, never repeat it, and never make it a condition of
helping. If nothing said so far fits a routine, offer nothing, and answer what was asked. If the offer is
declined, ignored or answered with no, do not offer a routine again, in this conversation or later.`;

export const DM_FIRST_CONVERSATION_BLOCK = `### Your first conversation with this person

You and this person are still new to each other. Answer what they ask first. Then, when
they have told you what they do or what they keep an eye on, offer them ONE routine that fits it: a
weekly digest, or a watch that tells them when something changes. A card in this DM may already offer
them a morning brief and check-ins. Never offer those again, and never repeat what that card says.

${HOW_TO_OFFER}`;

export const ROOM_FIRST_CONVERSATION_BLOCK = `### This room's first conversation with you

This room is new to you. Answer what you were asked first. Then, when the people here have said what the
room is for or what they keep an eye on, offer the room ONE routine that fits it: a weekly digest of the
room's open questions, a morning summary, or a watch that posts here when something changes. Offer it only
in a reply to somebody who addressed you, never unprompted.

${HOW_TO_OFFER}`;

const PERSON_SETTLED = new Set<string>();
const ROOM_SETTLED = new Set<string>();
const ROOM_UNMARKED_UNTIL = new Map<string, number>();
export const ROOM_UNMARKED_RECHECK_MS = 60_000;

export function resetFirstRoutineMemo(): void {
  PERSON_SETTLED.clear();
  ROOM_SETTLED.clear();
  ROOM_UNMARKED_UNTIL.clear();
}

function dmPersonKey(binding: SurfaceBinding): string | undefined {
  if (binding.mode !== "dm" || binding.trust !== "internal") return undefined;
  const acting = actingPrincipalId(binding);
  return acting ? tryPrincipalKey(binding.platform, binding.workspace, acting) : undefined;
}

export interface FirstConversationTurn {
  readonly binding: SurfaceBinding;
  readonly partition: Partition;
  readonly worker: boolean;
  readonly nowIso: string;
}

export interface FirstConversationReads {
  readonly readWatch?: typeof readPersonalWatch;
  readonly readRoomTier?: (p: Partition) => Promise<Readonly<Record<string, string>>>;
}

export async function firstConversationBlock(turn: FirstConversationTurn, reads: FirstConversationReads = {}): Promise<string> {
  try {
    const days = firstConversationDays();
    if (days <= 0 || turn.worker) return "";
    if (unattendedFrom(turn.binding)) return "";
    if (turn.binding.mode === "dm") {
      const key = dmPersonKey(turn.binding);
      if (!key) return "";
      const memo = `${turn.binding.org}|${key}`;
      if (PERSON_SETTLED.has(memo)) return "";
      const read = await (reads.readWatch ?? readPersonalWatch)(turn.binding.org, key);
      if (!read.readable || read.state === undefined) return "";
      const fc = read.state.firstConversation;
      if (fc && fc.surfaceKey === turn.partition.surfaceKey && firstConversationOpen(fc, turn.nowIso, days)) return DM_FIRST_CONVERSATION_BLOCK;
      if (!fc || !firstConversationOpen(fc, turn.nowIso, days)) PERSON_SETTLED.add(memo);
      return "";
    }
    if (turn.binding.mode !== "channel") return "";
    const memo = `${turn.partition.org}|${turn.partition.surfaceKey}`;
    if (ROOM_SETTLED.has(memo)) return "";
    const nowMs = Date.parse(turn.nowIso);
    if ((ROOM_UNMARKED_UNTIL.get(memo) ?? 0) > nowMs) return "";
    const files = await (reads.readRoomTier ?? ((p) => getProvider().readTier(p, SURFACE)))(turn.partition);
    const marker = parseRoomFirstRoutine(files[FIRST_ROUTINE_MARKER]);
    if (firstConversationOpen(marker, turn.nowIso, days)) return ROOM_FIRST_CONVERSATION_BLOCK;
    if (marker !== undefined || files["_onboarded"] !== undefined) ROOM_SETTLED.add(memo);
    else ROOM_UNMARKED_UNTIL.set(memo, nowMs + ROOM_UNMARKED_RECHECK_MS);
    return "";
  } catch {
    return "";
  }
}

export interface FirstRoutineDecision {
  readonly partition: Partition;
  readonly decidedBy: string;
  readonly outcome: FirstConversationOutcome;
  readonly room: boolean;
  readonly atIso?: string;
}

export interface FirstRoutineWrites {
  readonly recordPerson?: typeof recordFirstConversationOutcome;
  readonly readRoomTier?: (p: Partition) => Promise<Readonly<Record<string, string>>>;
  readonly writeRoomTier?: (p: Partition, files: Record<string, string>) => Promise<void>;
}

export async function endFirstRoutineOffer(d: FirstRoutineDecision, writes: FirstRoutineWrites = {}): Promise<{ readonly person: boolean; readonly room: boolean }> {
  const at = d.atIso ?? new Date().toISOString();
  let person = false;
  let room = false;
  const key = tryPrincipalKey(d.partition.platform, d.partition.workspace, d.decidedBy);
  if (key) {
    try {
      person = (await (writes.recordPerson ?? recordFirstConversationOutcome)(d.partition.org, key, d.outcome, d.partition.surfaceKey, at)) === "recorded";
    } catch (err) {
      console.warn(`[open-everywhere:first-routine] the person's offer did not end: ${String(err)}`);
    }
  }
  if (!d.room) return { person, room };
  try {
    const files = await (writes.readRoomTier ?? ((p) => getProvider().readTier(p, SURFACE)))(d.partition);
    const marker = parseRoomFirstRoutine(files[FIRST_ROUTINE_MARKER]);
    if (marker && (marker.outcome === undefined || (marker.outcome === "offered" && d.outcome !== "offered"))) {
      const next: Record<string, string> = { ...files, [FIRST_ROUTINE_MARKER]: JSON.stringify({ since: marker.since, outcome: d.outcome, decidedAt: at }) };
      await (writes.writeRoomTier ?? writeRoomMarker)(d.partition, next);
      room = true;
    }
  } catch (err) {
    console.warn(`[open-everywhere:first-routine] the room's offer did not end: ${String(err)}`);
  }
  return { person, room };
}

async function writeRoomMarker(p: Partition, files: Record<string, string>): Promise<void> {
  await writeMemoryTier({
    provider: getProvider(),
    partition: p,
    tier: SURFACE,
    files,
    message: "first routine offer ended",
    road: "onboarding-marker",
    kind: "operational",
  });
}
