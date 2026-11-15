import { canonicalAuthorGrain, getSettings, type ExternalAuthorGrain, type ExternalRoomGrain } from "../settings/settings.js";
import { declaredSurfaceTrust } from "../identity/trust.js";
import { nonMemberChatTrust, type ChatWakeRoom, type IngestedChatMessage } from "../identity/non-member.js";
import type { NormalizedWake } from "../channels/normalized-wake.js";
import type { ContextLine } from "../channels/context-render.js";
import type { WakeMessageInput } from "../channels/wake-envelope.js";

export type { ExternalAuthorGrain, ExternalRoomGrain };

export interface ExternalPolicy {
  readonly authorGrain: ExternalAuthorGrain;
  readonly roomGrain: ExternalRoomGrain;
}

export interface ExternalPolicyOverride {
  readonly authorGrain?: ExternalAuthorGrain;
  readonly roomGrain?: ExternalRoomGrain;
}

export function shippedExternalPolicy(): ExternalPolicy {
  const s = getSettings().externalPolicy;
  return { authorGrain: s.authorGrain, roomGrain: s.roomGrain };
}

export function resolveExternalPolicy(override?: ExternalPolicyOverride): ExternalPolicy {
  const org = shippedExternalPolicy();
  return {
    authorGrain: override?.authorGrain !== undefined ? canonicalAuthorGrain(override.authorGrain) : org.authorGrain,
    roomGrain: override?.roomGrain ?? org.roomGrain,
  };
}

export function externalPolicyIsInert(policy: ExternalPolicy): boolean {
  return policy.authorGrain !== "withhold" && policy.roomGrain === "engage";
}

export interface ExternalAuthorFacts extends IngestedChatMessage {
  readonly id: string;
}

export function authorIsExcluded(m: IngestedChatMessage): boolean {
  return nonMemberChatTrust(m);
}

export function withholdsBody(m: IngestedChatMessage, policy: ExternalPolicy): boolean {
  if (policy.authorGrain !== "withhold") return false;
  if (authorIsExcluded(m)) return true;
  return m.ungraded === true && m.trust !== "relay";
}

export const WITHHELD_BODY_MARKER =
  "[a message arrived here — this deployment does not pass on messages from senders outside the organisation, so its text was not delivered]";

export const EXTERNAL_SENDER_NOTICE =
  "I can't act on messages from outside this organisation, so I haven't done anything with that. " +
  "If you need something from me, please ask someone in the organisation to raise it.";

export const EXTERNAL_MENTION_ACK = "I can't help with this request here.";

export function owesSuppressedMentionAck(input: {
  readonly addressed: boolean;
  readonly alreadyAnswered: boolean;
}): boolean {
  return input.addressed && !input.alreadyAnswered;
}

export function suppressionRendering(acked: boolean): { readonly rendering?: "ack" } {
  return acked ? { rendering: "ack" as const } : {};
}

export function withholdWakeBodies(
  nw: NormalizedWake,
  isWithheld: (m: WakeMessageInput) => boolean,
  excludedAuthorId?: (senderId: string) => boolean,
): NormalizedWake {
  const triggerHit = nw.trigger.kind === "message" && isWithheld(nw.trigger.message);
  const backscrollHit = (nw.backscroll ?? []).some(isWithheld);
  const withheldAuthors = new Set<string>();
  if (triggerHit && nw.trigger.kind === "message" && nw.trigger.message.authorId) withheldAuthors.add(nw.trigger.message.authorId);
  for (const m of nw.backscroll ?? []) if (isWithheld(m) && m.authorId) withheldAuthors.add(m.authorId);
  const lineWithheld = (l: ContextLine): boolean =>
    l.senderId !== undefined && l.senderId.length > 0 && (withheldAuthors.has(l.senderId) || excludedAuthorId?.(l.senderId) === true);
  const lines = nw.contextLines ?? [];
  const contextHit = lines.some(lineWithheld);
  if (!triggerHit && !backscrollHit && !contextHit) return nw;
  return {
    ...nw,
    ...(backscrollHit ? { backscroll: (nw.backscroll ?? []).map((m) => (isWithheld(m) ? withheldWakeMessage(m) : m)) } : {}),
    ...(contextHit ? { contextLines: lines.map((l) => (lineWithheld(l) ? { ...l, text: WITHHELD_BODY_MARKER } : l)) } : {}),
    ...(triggerHit ? { trigger: { kind: "message" as const, message: withheldWakeMessage(nw.trigger.message) } } : {}),
  };
}

export function withheldWakeMessage(m: WakeMessageInput): WakeMessageInput {
  const { previousBody: _preEdit, attachments: _attachments, ...rest } = m;
  return { ...rest, body: WITHHELD_BODY_MARKER };
}

export function ingestedAfterWithholding<M extends IngestedChatMessage>(
  ingested: readonly M[],
  policy: ExternalPolicy,
): readonly M[] {
  if (policy.authorGrain !== "withhold") return ingested;
  const kept = ingested.filter((m) => !withholdsBody(m, policy));
  return kept.length === ingested.length ? ingested : kept;
}

export function suppressesAddressedWake(m: IngestedChatMessage, policy: ExternalPolicy): boolean {
  return policy.authorGrain === "withhold" && authorIsExcluded(m);
}

export function suppressesAmbientWake(m: IngestedChatMessage, policy: ExternalPolicy): boolean {
  return withholdsBody(m, policy);
}

export interface ExternalRoomFacts {
  readonly room: ChatWakeRoom;
  readonly vendorExternal?: boolean;
  readonly ingested?: readonly IngestedChatMessage[];
}

export function roomIsExternalClass(f: ExternalRoomFacts): boolean {
  if (f.room.dm === true) return false;
  if (f.vendorExternal === true) return true;
  if ((f.ingested ?? []).some(authorIsExcluded)) return true;
  return declaredPublicRoom(f.room);
}

function declaredPublicRoom(room: ChatWakeRoom): boolean {
  if (room.surfaceKey === undefined) return false;
  const segs = room.surfaceKey.split("/");
  if (segs.length < 3) return false;
  return (
    declaredSurfaceTrust({
      tenantKey: segs.slice(0, 2).join("/"),
      surfaceKeys: [room.surfaceKey],
      ...(room.groupKey === undefined ? {} : { groupKey: room.groupKey }),
    }) === "public"
  );
}

export function roomIsSilenced(f: ExternalRoomFacts, policy: ExternalPolicy): boolean {
  return policy.roomGrain === "silent" && roomIsExternalClass(f);
}

export const SILENT_NOTICE_KINDS = ["join", "suppressed-wake"] as const;

export type SilentNoticeKind = (typeof SILENT_NOTICE_KINDS)[number];

export function silentRoomNotice(kind: SilentNoticeKind): string {
  return kind === "join"
    ? "Heads up: this room is open to people outside the organisation, so I'll stay quiet here. I won't reply, and I won't act on anything said in this room."
    : "I'm staying quiet in this room because it's open to people outside the organisation, so I won't act on that. Please ask me in a room inside the organisation.";
}

export function silentNoticeKey(surfaceKey: string, kind: SilentNoticeKind): string {
  return `external-silent:${kind}:${surfaceKey}`;
}
