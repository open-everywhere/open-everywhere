import { defineState } from "eve/context";
import { isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { isWakeEnvelopeShaped, triggerAuthors } from "../channels/wake-envelope.js";

export const OE_REQUESTER_ATTR = "oe_requester";

export const REQUESTER_UNVERIFIED = "oe/unverified";

export type RequesterVerdict =
  | { readonly kind: "requester"; readonly principalId: string }
  | { readonly kind: "unverified"; readonly reason: string }
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
    return {
      turn: typeof s.turn === "string" ? s.turn : undefined,
      verdict: { kind: "unverified", reason: typeof reason === "string" ? reason : "the caller could not be verified on this turn" },
    };
  }
  return {};
}

export function requesterVerdictFor(input: {
  readonly text: string | undefined;
  readonly isChild: boolean;
  readonly inherited: string | undefined;
}): RequesterVerdict {
  if (input.isChild) {
    if (input.inherited === undefined || input.inherited.length === 0) {
      return { kind: "unverified", reason: "the turn that delegated this work carried no verified asker, so this worker has no caller to check standing for" };
    }
    if (input.inherited === REQUESTER_UNVERIFIED) {
      return { kind: "unverified", reason: "the turn that delegated this work was woken by more than one person, so it could not say whose ask this is" };
    }
    return { kind: "requester", principalId: input.inherited };
  }
  const text = input.text;
  if (typeof text !== "string" || !isWakeEnvelopeShaped(text)) return NONE;
  const humans = new Set(
    triggerAuthors(text)
      .filter((a) => a.from === "human" && a.authorId !== undefined)
      .map((a) => a.authorId as string),
  );
  if (humans.size === 1) return { kind: "requester", principalId: [...humans][0] as string };
  if (humans.size === 0) {
    return { kind: "unverified", reason: "this turn was woken by a system or relay message, not by a person asking" };
  }
  return { kind: "unverified", reason: `this turn was woken by ${humans.size} different people at once, so it cannot say whose ask this is` };
}

export function recordRequesterIdentity(ctx: BindableContext, turnId: string | undefined, text: string | undefined): RequesterVerdict {
  try {
    const attrs = writableAuthAttrs(ctx);
    const inherited = readAttr(attrs?.[OE_REQUESTER_ATTR]);
    const verdict = requesterVerdictFor({ text, isChild: isSubagentChildContext(ctx), inherited });
    slot.update(() => (turnId !== undefined ? { turn: turnId, verdict } : { verdict }));
    if (verdict.kind !== "none" && attrs !== null) {
      attrs[OE_REQUESTER_ATTR] = verdict.kind === "requester" ? verdict.principalId : REQUESTER_UNVERIFIED;
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
