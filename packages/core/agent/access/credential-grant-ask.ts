import { accountProfileFor, composedAccountName } from "../identity/account-display-name.js";
import { isQualifiedPrincipalKey, parsePrincipalKey, tryPrincipalKey } from "../identity/principal-key.js";
import { grantMintRefusalMessage, type GrantMintRefusal } from "./credential-grant.js";

export interface ResolvedGrantOwner {
  readonly principalId: string;
  readonly platform: string;
  readonly nativeId: string;
  readonly handle: string;
}

function bareId(raw: string): string {
  const trimmed = raw.trim();
  const m = /^<@!?([^>|]+)(?:\|[^>]*)?>$/u.exec(trimmed);
  return m ? m[1]!.trim() : trimmed;
}

export async function resolveGrantOwner(
  raw: string,
  surfacePlatform: string,
  surfaceWorkspace: string,
): Promise<ResolvedGrantOwner | { readonly refusal: string }> {
  const named = bareId(raw);
  if (named.length === 0) return { refusal: "Refused: no owner was named. Name the person whose credential you are asking for." };

  const asKey = named.includes("/")
    ? isQualifiedPrincipalKey(named)
      ? named
      : undefined
    : tryPrincipalKey(surfacePlatform, surfaceWorkspace, named);
  if (asKey === undefined) {
    return {
      refusal:
        `Refused: "${named}" does not name a person this deployment can resolve. ` +
        "Give either their full principal key (for example `slack/T0AB1CD2E/U123ABC`) or, for somebody on this same surface, their bare member id.",
    };
  }
  const parsed = parsePrincipalKey(asKey);
  if (parsed === undefined) {
    return { refusal: `Refused: "${named}" is not a well-formed principal key, so nothing could ever be spent under it.` };
  }
  const profile = await accountProfileFor(parsed.platform, parsed.id, parsed.tenant).catch(() => undefined);
  const handle = composedAccountName(profile) ?? parsed.id;
  return { handle, nativeId: parsed.id, platform: parsed.platform, principalId: asKey };
}

export function credentialGrantRefusalNote(connector: string, reason: GrantMintRefusal | "owner_unreachable"): string {
  if (reason === "owner_unreachable") {
    return (
      "Refused: this deployment cannot send that person a direct message, so the card would never be seen. " +
      "An ask nobody can read is worse than no ask — say so in the room rather than trying again."
    );
  }
  return `Refused: ${grantMintRefusalMessage(connector, reason)}`;
}
