export type MemberPlaneOpTier = "read" | "write" | "destructive";

export type MemberPlaneRequester =
  | { readonly kind: "requester"; readonly principalId: string }
  | { readonly kind: "unverified" }
  | { readonly kind: "none" };

export interface MemberPlaneInput {
  readonly armed: boolean;
  readonly opTiered: boolean;
  readonly granted: boolean;
  readonly requester: MemberPlaneRequester;
  readonly nonMemberWake: boolean;
  readonly opTier?: MemberPlaneOpTier;
}

export type MemberPlaneRefusal =
  | "member_plane_disarmed"
  | "member_plane_untiered"
  | "member_plane_ungranted"
  | "member_plane_unverified_requester"
  | "member_plane_nonmember_wake"
  | "member_plane_write";

export type MemberPlaneVerdict =
  | { readonly admit: true; readonly requesterPrincipalId: string }
  | { readonly admit: false; readonly reason: MemberPlaneRefusal };

export function memberPlaneVerdict(input: MemberPlaneInput): MemberPlaneVerdict {
  if (!input.armed) return { admit: false, reason: "member_plane_disarmed" };
  if (!input.opTiered) return { admit: false, reason: "member_plane_untiered" };
  if (!input.granted) return { admit: false, reason: "member_plane_ungranted" };
  if (input.requester.kind !== "requester" || input.requester.principalId.length === 0) {
    return { admit: false, reason: "member_plane_unverified_requester" };
  }
  if (input.nonMemberWake) return { admit: false, reason: "member_plane_nonmember_wake" };
  if (input.opTier !== undefined && input.opTier !== "read") {
    return { admit: false, reason: "member_plane_write" };
  }
  return { admit: true, requesterPrincipalId: input.requester.principalId };
}

export function memberPlaneRefusalMessage(connector: string, reason: MemberPlaneRefusal): string {
  switch (reason) {
    case "member_plane_disarmed":
      return (
        `connection "${connector}": personal credentials are not admitted outside a DM in this deployment. ` +
        `The member plane is disarmed (\`connectors: { memberPlane: true }\` in agent/settings.ts). ` +
        `This is a deployment rule enforced at the credential layer, not a permission that can be requested in-chat.`
      );
    case "member_plane_untiered":
      return (
        `connection "${connector}": personal credentials are not admitted outside a DM in this deployment. ` +
        `The member plane needs per-op consequence tiering (\`connectors: { opTiering: true }\` in ` +
        `agent/settings.ts), because that is what keeps a personal credential to READS in a shared room.`
      );
    case "member_plane_ungranted":
      return (
        `connection "${connector}": this domain does not admit personal credentials in its rooms. ` +
        `A domain grants the member plane by declaring the connector's member role in its own ` +
        `\`credentials\` (agent/memory/config/domains.ts) — absence is a refusal, never the org default.`
      );
    case "member_plane_unverified_requester":
      return (
        `connection "${connector}": refusing to use a personal credential here — this turn could not be ` +
        `attributed to exactly one person, so there is no single asker whose account to act as. ` +
        `Ask again on your own, or in a DM.`
      );
    case "member_plane_nonmember_wake":
      return (
        `connection "${connector}": refusing to use a personal credential here — this conversation ` +
        `includes a message from somebody the workspace could not vouch for as a member.`
      );
    case "member_plane_write":
      return (
        `connection "${connector}": personal credentials are READ-ONLY outside a DM. A write would be ` +
        `recorded under your own name at the provider, which needs its own approval path. ` +
        `Do the write in a DM, or use this domain's work-surface credential.`
      );
  }
}

export type PersonalWriteRefusal =
  | "member_plane_write"
  | "personal_write_unproven_dm"
  | "personal_write_requester_mismatch";

export interface PersonalConnectorWriteInput {
  readonly memberPlaneBinding: boolean;
  readonly personalCredential: boolean;
  readonly surfaceMode?: string;
  readonly actingPrincipalId?: string;
  readonly requester: MemberPlaneRequester;
}

export type PersonalConnectorWriteVerdict =
  | { readonly prompt: true }
  | { readonly prompt: false; readonly reason: PersonalWriteRefusal };

export function personalConnectorWriteVerdict(input: PersonalConnectorWriteInput): PersonalConnectorWriteVerdict {
  if (input.memberPlaneBinding) return { prompt: false, reason: "member_plane_write" };
  if (!input.personalCredential) return { prompt: true };
  if (input.surfaceMode !== "dm") return { prompt: false, reason: "personal_write_unproven_dm" };
  if (input.actingPrincipalId === undefined || input.actingPrincipalId.length === 0) {
    return { prompt: false, reason: "personal_write_unproven_dm" };
  }
  if (input.requester.kind === "requester" && input.requester.principalId !== input.actingPrincipalId) {
    return { prompt: false, reason: "personal_write_requester_mismatch" };
  }
  return { prompt: true };
}

export function personalWriteRefusalMessage(connector: string, reason: PersonalWriteRefusal): string {
  switch (reason) {
    case "member_plane_write":
      return memberPlaneRefusalMessage(connector, "member_plane_write");
    case "personal_write_unproven_dm":
      return (
        `connection "${connector}": refusing to write with your personal credential — this surface did ` +
        `not resolve as a DM. A write records your own name at the provider, so it is admitted only ` +
        `where the asker, the approver and that name are the same person. Ask again in a DM.`
      );
    case "personal_write_requester_mismatch":
      return (
        `connection "${connector}": refusing to write with a personal credential — the person this ` +
        `turn serves and the person this conversation belongs to are not the same. A write would ` +
        `record one person's name on another person's approval.`
      );
  }
}

export interface MemberPlaneAuthLike {
  readonly current?: { readonly attributes?: Readonly<Record<string, unknown>> } | null;
}

function attrOf(auth: MemberPlaneAuthLike | undefined, key: string): string | undefined {
  const v = auth?.current?.attributes?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function requesterFromAuth(auth: MemberPlaneAuthLike | undefined, requesterAttr: string, unverifiedSentinel: string): MemberPlaneRequester {
  const stamp = attrOf(auth, requesterAttr);
  if (stamp === undefined) return { kind: "none" };
  if (stamp === unverifiedSentinel) return { kind: "unverified" };
  return { kind: "requester", principalId: stamp };
}

export function nonMemberWakeFromAuth(auth: MemberPlaneAuthLike | undefined, nonMemberAttr: string): boolean {
  return attrOf(auth, nonMemberAttr) === "true";
}
