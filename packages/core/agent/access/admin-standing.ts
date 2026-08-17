import { actingPrincipalId, currentTurnId, type BindableContext, type SurfaceBinding } from "../identity/binding.js";
import { requesterThisTurn } from "./requester-identity.js";
import { rosterHasPrincipal } from "../identity/principal-key.js";
import { criteriaDomain } from "../memory/domain.js";
import { getConfig } from "./config.js";

export type AdminSubject = { readonly ok: true; readonly principalId: string } | { readonly ok: false; readonly message: string };

export const ADMIN_NO_ACTING_MESSAGE =
  "No verified sender id on this turn — no acting principal resolved, so there is no caller to check admin standing for.";

export function adminUnverifiedMessage(reason: string): string {
  return (
    `this action needs to know who asked, and this turn cannot say: ${reason}. ` +
    "Admin standing is checked against the person who asked, never against whoever else this session was serving, so it is refused rather than guessed. " +
    "Ask again on its own — in a thread, or once the other work in this room has settled."
  );
}

export function adminStandingSubject(binding: SurfaceBinding, ctx?: BindableContext): AdminSubject {
  const acting = actingPrincipalId(binding);
  if (!acting) return { ok: false, message: ADMIN_NO_ACTING_MESSAGE };
  const requester = requesterThisTurn(ctx === undefined ? undefined : currentTurnId(ctx));
  if (requester.kind === "unverified") {
    const shared = sharedOrgAdminSubject(binding, acting, requester.candidates);
    if (shared !== undefined) return { ok: true, principalId: shared };
    return { ok: false, message: adminUnverifiedMessage(requester.reason) };
  }
  return { ok: true, principalId: requester.kind === "requester" ? requester.principalId : acting };
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
