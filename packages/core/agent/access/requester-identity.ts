import { defineState } from "eve/context";
import { isSubagentChildContext, isUnifiedWindowContext, windowGrainOf, type BindableContext } from "../identity/binding.js";
import { isWakeEnvelopeShaped, triggerAuthors } from "../channels/wake-envelope.js";

export const OE_REQUESTER_ATTR = "oe_requester";

export const REQUESTER_UNVERIFIED = "oe/unverified";

export const OE_REQUESTER_CANDIDATES_ATTR = "oe_requester_candidates";

export type RequesterSeat =
  | "child"
  | "worker"
  | "room"
  | "open";

export type RequesterVerdict =
  | { readonly kind: "requester"; readonly principalId: string }
  | { readonly kind: "unverified"; readonly reason: string; readonly candidates?: readonly string[] }
  | { readonly kind: "none" };

const NONE: RequesterVerdict = { kind: "none" };

interface RequesterIdentityState {
  readonly turn?: string;
  readonly verdict?: RequesterVerdict;
}

const slot = defineState<RequesterIdentityState>("open-everywhere.requester-identity", () => ({}));

function readState(v: unknown): RequesterIdentityState {
  if (v === null || typeof v !== "object") return {};
  const s = v as { turn?: unknown; verdict?: unknown };
  const verdict = s.verdict;
  if (verdict === null || typeof verdict !== "object") return {};
  const k = (verdict as { kind?: unknown }).kind;
  if (k === "requester") {
    const id = (verdict as { principalId?: unknown }).principalId;
    if (typeof id !== "string" || id.length === 0) return {};
    return { turn: typeof s.turn === "string" ? s.turn : undefined, verdict: { kind: "requester", principalId: id } };
  }
  if (k === "unverified") {
    const reason = (verdict as { reason?: unknown }).reason;
    const raw = (verdict as { candidates?: unknown }).candidates;
    const candidates =
      Array.isArray(raw) && raw.length >= 2 && raw.every((c) => typeof c === "string" && c.length > 0) ? (raw as string[]) : undefined;
    return {
      turn: typeof s.turn === "string" ? s.turn : undefined,
      verdict: {
        kind: "unverified",
        reason: typeof reason === "string" ? reason : "the caller could not be verified on this turn",
        ...(candidates ? { candidates } : {}),
      },
    };
  }
  return {};
}

const NO_CARRIAGE = "the turn that delegated this work carried no verified asker, so this worker has no caller to check standing for";

function verdictFromStamp(inherited: string | undefined, inheritedCandidates: string | undefined): RequesterVerdict | undefined {
  if (inherited === undefined || inherited.length === 0) return undefined;
  if (inherited === REQUESTER_UNVERIFIED) {
    const candidates = parseCandidates(inheritedCandidates);
    if (candidates === undefined) {
      return { kind: "unverified", reason: "the turn that delegated this work could not say whose ask it was serving — it was woken by more than one person, or by no person at all" };
    }
    return {
      kind: "unverified",
      reason: "the turn that delegated this work was woken by more than one person, so it could not say whose ask this is",
      candidates,
    };
  }
  return { kind: "requester", principalId: inherited };
}

function verdictFromEnvelope(text: string | undefined): RequesterVerdict | undefined {
  if (typeof text !== "string" || !isWakeEnvelopeShaped(text)) return undefined;
  const humans = new Set(
    triggerAuthors(text)
      .filter((a) => a.from === "human" && a.authorId !== undefined)
      .map((a) => a.authorId as string),
  );
  if (humans.size === 1) return { kind: "requester", principalId: [...humans][0] as string };
  if (humans.size === 0) {
    return { kind: "unverified", reason: "this turn was woken by a system or relay message, not by a person asking" };
  }
  return {
    kind: "unverified",
    reason: `this turn was woken by ${humans.size} different people at once, so it cannot say whose ask this is`,
    candidates: [...humans].sort(),
  };
}

export function requesterVerdictFor(input: {
  readonly text: string | undefined;
  readonly seat: RequesterSeat;
  readonly inherited: string | undefined;
  readonly inheritedCandidates?: string | undefined;
}): RequesterVerdict {
  const stamped = verdictFromStamp(input.inherited, input.inheritedCandidates);
  if (input.seat === "child") {
    return stamped ?? { kind: "unverified", reason: NO_CARRIAGE };
  }
  if (input.seat === "worker") {
    return stamped ?? verdictFromEnvelope(input.text) ?? { kind: "unverified", reason: NO_CARRIAGE };
  }
  const fromText = verdictFromEnvelope(input.text);
  if (fromText !== undefined) return fromText;
  if (input.seat === "room") {
    return { kind: "unverified", reason: "this turn carried no wake envelope, and this seat can be woken by more than one person, so it cannot say whose ask this is" };
  }
  return NONE;
}

export function requesterSeatOf(ctx: BindableContext): RequesterSeat {
  try {
    if (isSubagentChildContext(ctx)) return "child";
    if (!isUnifiedWindowContext(ctx)) return "open";
    const grain = windowGrainOf(ctx);
    return grain === "task" || grain === "thread" ? "worker" : "room";
  } catch {
    return "open";
  }
}

export function requesterStampForDispatch(turnId?: string): string {
  const verdict = requesterThisTurn(turnId);
  return verdict.kind === "requester" ? verdict.principalId : REQUESTER_UNVERIFIED;
}

export function requesterCandidatesStampForDispatch(turnId?: string): string | undefined {
  const verdict = requesterThisTurn(turnId);
  if (verdict.kind !== "unverified") return undefined;
  const candidates = verdict.candidates;
  if (candidates === undefined || candidates.length < 2) return undefined;
  return JSON.stringify([...candidates].sort());
}

export function recordRequesterIdentity(ctx: BindableContext, turnId: string | undefined, text: string | undefined): RequesterVerdict {
  try {
    const attrs = writableAuthAttrs(ctx);
    const inherited = readAttr(attrs?.[OE_REQUESTER_ATTR]);
    const inheritedCandidates = readAttr(attrs?.[OE_REQUESTER_CANDIDATES_ATTR]);
    const seat = requesterSeatOf(ctx);
    const verdict = requesterVerdictFor({ text, seat, inherited, inheritedCandidates });
    slot.update(() => (turnId !== undefined ? { turn: turnId, verdict } : { verdict }));
    if (attrs !== null) {
      if (verdict.kind === "none") {
        if (seat !== "child") {
          delete attrs[OE_REQUESTER_ATTR];
          delete attrs[OE_REQUESTER_CANDIDATES_ATTR];
        }
      } else {
        attrs[OE_REQUESTER_ATTR] = verdict.kind === "requester" ? verdict.principalId : REQUESTER_UNVERIFIED;
        const candidates = verdict.kind === "unverified" ? verdict.candidates : undefined;
        if (candidates && candidates.length > 0) attrs[OE_REQUESTER_CANDIDATES_ATTR] = JSON.stringify(candidates);
        else delete attrs[OE_REQUESTER_CANDIDATES_ATTR];
      }
    }
    return verdict;
  } catch {
    return NONE;
  }
}

export function requesterThisTurn(currentTurn?: string): RequesterVerdict {
  try {
    const state = readState(slot.get());
    if (state.verdict === undefined) return NONE;
    if (currentTurn !== undefined && state.turn !== undefined && state.turn !== currentTurn) return NONE;
    return state.verdict;
  } catch {
    return NONE;
  }
}

function parseCandidates(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length < 2) return undefined;
    if (!parsed.every((c) => typeof c === "string" && c.length > 0)) return undefined;
    return [...(parsed as string[])].sort();
  } catch {
    return undefined;
  }
}

function readAttr(v: unknown): string | undefined {
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

function writableAuthAttrs(ctx: BindableContext): Record<string, unknown> | null {
  try {
    const current = (ctx as { session?: { auth?: { current?: { attributes?: unknown } } } }).session?.auth?.current;
    if (current === undefined || current === null) return null;
    const attrs = (current as { attributes?: unknown }).attributes;
    if (typeof attrs === "object" && attrs !== null) return attrs as Record<string, unknown>;
    const fresh: Record<string, unknown> = {};
    (current as { attributes?: unknown }).attributes = fresh;
    return (current as { attributes?: unknown }).attributes === fresh ? fresh : null;
  } catch {
    return null;
  }
}
