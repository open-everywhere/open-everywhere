import { actingPrincipalId, currentTurnId, type BindableContext, type SurfaceBinding } from "../identity/binding.js";
import { requesterThisTurn, seatServesManyAskers } from "./requester-identity.js";
import { liveAuthIsAnotherPrincipal } from "./turn-opening-principal.js";
import { rosterHasPrincipal } from "../identity/principal-key.js";
import { criteriaDomain } from "../memory/domain.js";
import { getConfig } from "./config.js";

export type AdminSubject = { readonly ok: true; readonly principalId: string } | { readonly ok: false; readonly message: string };

const ADMIN_NO_ACTING_MESSAGE =
  "No verified sender id on this turn — no acting principal resolved, so there is no caller to check admin standing for.";

const ADMIN_NO_RECORD_REASON =
  "nothing on this turn recorded who asked, and this seat can be woken by more than one person, so the only id left is whichever delivery's auth the turn happens to carry";

const ADMIN_SWAPPED_REASON =
  "a later message inside this turn (for example an answer to a question the agent asked) carried a different person's identity than the message that started it, and admin standing is never taken from whoever answered";

const OWN_ASK_TAIL = "Ask for the admin action in a message of your own.";

const COALESCED_TAIL = "Ask again on its own — in a thread, or once the other work in this room has settled.";

const NO_RECORD_TAIL = "Ask again in a fresh message. If it keeps happening, tell an operator — this one is the host's to fix, not yours.";

function adminUnverifiedMessage(reason: string, tail: string = COALESCED_TAIL): string {
  return (
    `this action needs to know who asked, and this turn cannot say: ${reason}. ` +
    "Admin standing is checked against the person who asked, never against whoever else this session was serving, so it is refused rather than guessed. " +
    tail
  );
}

export function adminStandingSubject(binding: SurfaceBinding, ctx?: BindableContext): AdminSubject {
  const acting = actingPrincipalId(binding);
  if (!acting) return { ok: false, message: ADMIN_NO_ACTING_MESSAGE };
  if (ctx !== undefined && liveAuthIsAnotherPrincipal(ctx)) {
    return { ok: false, message: adminUnverifiedMessage(ADMIN_SWAPPED_REASON, OWN_ASK_TAIL) };
  }
  const requester = requesterThisTurn(ctx === undefined ? undefined : currentTurnId(ctx));
  if (requester.kind === "requester") return { ok: true, principalId: requester.principalId };
  if (requester.kind === "unverified") {
    const shared = sharedOrgAdminSubject(binding, acting, requester.candidates);
    if (shared !== undefined) return { ok: true, principalId: shared };
    return { ok: false, message: adminUnverifiedMessage(requester.reason) };
  }
  if (ctx !== undefined && seatServesManyAskers(ctx)) return { ok: false, message: adminUnverifiedMessage(ADMIN_NO_RECORD_REASON, NO_RECORD_TAIL) };
  return { ok: true, principalId: acting };
}

export function sharedOrgAdminSubject(
  binding: SurfaceBinding,
  acting: string | undefined,
  candidates: readonly string[] | undefined,
): string | undefined {
  if (candidates === undefined || candidates.length < 2) return undefined;
  let admins: readonly string[] | undefined;
  try {
    admins = criteriaDomain("org", getConfig().loadDomains())?.admins;
  } catch {
    return undefined;
  }
  if (admins === undefined || admins.length === 0) return undefined;
  for (const id of candidates) {
    if (!rosterHasPrincipal(admins, binding.platform, binding.workspace, id)) return undefined;
  }
  const sorted = [...candidates].sort();
  return acting !== undefined && candidates.includes(acting) ? acting : (sorted[0] as string);
}
