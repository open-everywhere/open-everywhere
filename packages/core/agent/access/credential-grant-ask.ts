import { accountProfileFor, composedAccountName } from "../identity/account-display-name.js";
import { isQualifiedPrincipalKey, parsePrincipalKey, tryPrincipalKey } from "../identity/principal-key.js";
import { grantMintRefusalMessage, type GrantDuplicateContext, type GrantMintRefusal } from "./credential-grant.js";
import { GRANT_ID_LEAK_PATTERNS } from "./credential-grant-copy.js";

export interface ResolvedGrantOwner {
  readonly principalId: string;
  readonly platform: string;
  readonly nativeId: string;
  readonly handle: string;
  readonly displayName?: string;
}

function bareId(raw: string): string {
  const trimmed = raw.trim();
  const m = /^<@!?([^>|]+)(?:\|[^>]*)?>$/u.exec(trimmed);
  return m ? m[1]!.trim() : trimmed;
}

const BARE_ID_SHAPES: Readonly<Record<string, { readonly re: RegExp; readonly noun: string }>> = {
  discord: { noun: "Discord user id", re: /^\d{17,20}$/u },
  slack: { noun: "Slack member id", re: /^[UW][A-Z0-9]{8,}$/u },
};

export interface UnresolvedGrantOwner {
  readonly named: string;
  readonly platform: string;
}

export async function resolveGrantOwner(
  raw: string,
  surfacePlatform: string,
  surfaceWorkspace: string,
): Promise<ResolvedGrantOwner | { readonly refusal: string }> {
  const named = bareId(raw);
  if (named.length === 0) return { refusal: "Refused: no owner was named. Name the person whose credential you are asking for." };

  const shape = named.includes("/") ? undefined : BARE_ID_SHAPES[surfacePlatform];
  if (shape !== undefined && !shape.re.test(named)) {
    return { refusal: credentialGrantRefusalNote("", "owner_unresolved", undefined, { named, platform: surfacePlatform }) };
  }

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
  const displayName = composedAccountName(profile);
  const handle = displayName ?? parsed.id;
  return { handle, nativeId: parsed.id, platform: parsed.platform, principalId: asKey, ...(displayName === undefined ? {} : { displayName }) };
}

export function credentialGrantRefusalNote(
  connector: string,
  reason: GrantMintRefusal | "owner_unreachable",
  duplicate?: GrantDuplicateContext,
  unresolvedOwner?: UnresolvedGrantOwner,
): string {
  if (reason === "owner_unresolved" && unresolvedOwner !== undefined) {
    const noun = BARE_ID_SHAPES[unresolvedOwner.platform]?.noun ?? `${unresolvedOwner.platform} user id`;
    const flat = unresolvedOwner.named.replace(/[\r\n"]+/gu, " ").trim().slice(0, 64);
    const shown = GRANT_ID_LEAK_PATTERNS.some(({ re }) => re.test(flat)) ? "That owner id" : `"${flat}"`;
    return `Refused: ${shown} is not a ${noun}; name the owner as they appear in this room, or give their full principal key.`;
  }
  if (reason === "owner_unreachable") {
    return (
      "Refused: this deployment cannot send that person a direct message, so the card would never be seen. " +
      "An ask nobody can read is worse than no ask — say so in the room rather than trying again."
    );
  }
  const message = grantMintRefusalMessage(connector, reason, duplicate);
  return reason === "grant_already_live" ? message : `Refused: ${message}`;
}
