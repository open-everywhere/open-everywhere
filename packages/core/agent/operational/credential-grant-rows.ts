export type CredentialGrantMode = "once" | "session" | "standing";

export type CredentialGrantState = "active" | "used" | "revoked" | "expired";

export type CredentialGrantAskState = "pending" | "approved" | "declined" | "expired";

export interface CredentialGrantAskRow {
  readonly id: string;
  readonly requesterPrincipalId: string;
  readonly ownerPrincipalId: string;
  readonly ownerSlug: string;
  readonly ownerPlatform: string;
  readonly ownerNativeId: string;
  readonly connector: string;
  readonly verb: string;
  readonly resource: string;
  readonly scopeKey: string;
  readonly purpose: string;
  readonly requesterTarget?: string;
  readonly requestedMode: CredentialGrantMode;
  readonly status: CredentialGrantAskState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt?: string;
  readonly grantId?: string;
}

export interface CredentialGrantRow {
  readonly id: string;
  readonly askId: string;
  readonly requesterPrincipalId: string;
  readonly ownerPrincipalId: string;
  readonly ownerSlug: string;
  readonly connector: string;
  readonly verb: string;
  readonly resource: string;
  readonly scopeKey: string;
  readonly mode: CredentialGrantMode;
  readonly tier: "read" | "write" | "destructive";
  readonly status: CredentialGrantState;
  readonly purpose: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt?: string;
  readonly revokedAt?: string;
}

export const CREDENTIAL_GRANT_NAMESPACE = "grant";

export function isGrantNameSegment(segment: string): boolean {
  return /^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(segment);
}

export function grantOwnerSlug(handle: string): string | undefined {
  const slug = handle
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .replace(/_{2,}/gu, "_");
  return slug.length > 0 && isGrantNameSegment(slug) ? slug : undefined;
}

export function grantToolName(ownerSlug: string, verb: string): string {
  if (!isGrantNameSegment(ownerSlug)) throw new Error(`grantToolName: illegal owner segment "${ownerSlug}" (a segment may not contain "__")`);
  if (!isGrantNameSegment(verb)) throw new Error(`grantToolName: illegal verb segment "${verb}" (a segment may not contain "__")`);
  return `${CREDENTIAL_GRANT_NAMESPACE}__${ownerSlug}__${verb}`;
}

export function isGrantToolName(name: string): boolean {
  const segments = name.split("__");
  if (segments.length !== 3) return false;
  return segments[0] === CREDENTIAL_GRANT_NAMESPACE && isGrantNameSegment(segments[1] ?? "") && isGrantNameSegment(segments[2] ?? "");
}

export type CredentialGrantRefusal =
  | "revoked"
  | "expired"
  | "burned"
  | "out_of_scope"
  | "no_transport"
  | "owner_unresolvable"
  | "unverified_requester"
  | "unattended_wake";

export function credentialGrantStateRefusal(row: CredentialGrantRow, nowIso: string): CredentialGrantRefusal | undefined {
  if (row.status === "revoked") return "revoked";
  if (row.status === "used") return "burned";
  if (row.status === "expired") return "expired";
  if (row.expiresAt <= nowIso) return "expired";
  return undefined;
}

export function credentialGrantRefusalMessage(row: Pick<CredentialGrantRow, "ownerSlug" | "verb" | "resource">, reason: CredentialGrantRefusal): string {
  const what = `\`${row.verb}\` on \`${row.resource}\`, granted by ${row.ownerSlug}`;
  switch (reason) {
    case "revoked":
      return `Refused: ${row.ownerSlug} revoked this grant. ${what} is no longer spendable. Do not retry — ask again if it is still needed.`;
    case "expired":
      return `Refused: this grant has expired. ${what} is no longer spendable. Do not retry — ask again if it is still needed.`;
    case "burned":
      return `Refused: this was a one-shot grant and it is already spent. ${what} admitted exactly one call. Do not retry — ask again if it is still needed.`;
    case "out_of_scope":
      return `Refused: this grant was approved for a different conversation. ${what} is spendable only where its owner approved it.`;
    case "no_transport":
      return `Refused: this deployment carries no ${row.verb} transport for the granted connector, so the composed request cannot be sent. The grant itself is valid.`;
    case "owner_unresolvable":
      return `Refused: this grant does not name ${row.ownerSlug} in a form this deployment can resolve a credential for, so ${what} cannot be spent under anybody. Do not retry — ask again so a fresh grant is minted.`;
    case "unverified_requester":
      return `Refused: this turn names no single verified requester, so nobody can be recorded as having spent ${row.ownerSlug}'s credential. Do not retry.`;
    case "unattended_wake":
      return (
        `Refused: the scheduler started this turn and nobody is in the room. A grant is spendable only where a person asked for it: ` +
        `there is no requester to record against ${row.ownerSlug}'s credential, and nobody to read the "acting as ${row.ownerSlug}" notice. ` +
        `${what} stays granted. Do not retry — it is spendable the next time a person addresses this conversation.`
      );
  }
}

export function credentialGrantDisclosureLine(row: Pick<CredentialGrantRow, "ownerSlug" | "verb" | "resource" | "expiresAt" | "purpose">): string {
  return `acting as ${row.ownerSlug} — granted tool \`${row.verb}\` on \`${row.resource}\`, expires ${row.expiresAt}, purpose: "${quotedPurpose(row.purpose)}"`;
}

export function quotedPurpose(purpose: string): string {
  const flat = purpose.replace(/[\r\n]+/gu, " ").replace(/["'`]/gu, "").trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}
