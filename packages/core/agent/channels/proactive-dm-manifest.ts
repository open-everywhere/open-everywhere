export type ProactiveDmPlane =
  | "chat.dm"
  | "credential.grant.card"
  | "credential.grant.notice"
  | "credential.grant.consent"
  | "identity.link-set"
  | "identity.link-consent"
  | "governance.pane";

export type ProactiveDmStopStanding = "outranks" | "exempt";

export interface ProactiveDmPlaneRow {
  readonly plane: ProactiveDmPlane;
  readonly modules: readonly string[];
  readonly what: string;
  readonly stop: ProactiveDmStopStanding;
  readonly recordsDelivery: boolean;
  readonly exemptBecause?: string;
}

export const PROACTIVE_DM_PLANES: readonly ProactiveDmPlaneRow[] = [
  {
    plane: "chat.dm",
    modules: ["packages/core/agent/tools/dm_person.ts", "packages/core/agent/approvals/chat-dm.ts"],
    what: "A message the model wrote, to a person an operator granted.",
    stop: "outranks",
    recordsDelivery: true,
  },
  {
    plane: "credential.grant.card",
    modules: ["packages/core/agent/access/credential-grant-card.ts"],
    what: "The card that asks an owner to lend their own connector credential to somebody else's conversation.",
    stop: "outranks",
    recordsDelivery: false,
  },
  {
    plane: "credential.grant.notice",
    modules: ["packages/core/agent/access/credential-grant-notice.ts"],
    what: "The once-per-grant notice that the owner's credential was just used.",
    stop: "outranks",
    recordsDelivery: false,
  },
  {
    plane: "credential.grant.consent",
    modules: ["packages/core/agent/access/credential-grant-card.ts"],
    what: "The link an owner opens to connect their own account before they can answer a grant card.",
    stop: "outranks",
    recordsDelivery: false,
  },
  {
    plane: "identity.link-set",
    modules: ["packages/core/agent/channels/post-arms.ts", "packages/core/agent/tools/unlink_identity.ts"],
    what: "The alert that an account joined or left the recipient's own linked identity.",
    stop: "exempt",
    recordsDelivery: false,
    exemptBecause:
      "It is not somebody else's errand: it tells a person that their OWN identity changed, and it is the only thing that makes a quiet takeover loud. A stop request throttles chattiness and this message is important, so it stays exempt — a security alert about the recipient themselves is not what a person is asking to be spared.",
  },
  {
    plane: "identity.link-consent",
    modules: [
      "packages/core/agent/tools/link_identity.ts",
      "packages/core/agent/identity/link-consent.ts",
      "packages/core/agent/hooks/link-claim.ts",
    ],
    what: "The link handshake: the challenge sent to a named TARGET account, and the answer sent back to the account that started it.",
    stop: "exempt",
    recordsDelivery: false,
    exemptBecause:
      "Mixed, and stated at its weakest: the answers `identity/link-consent.ts` and `hooks/link-claim.ts` send go back to the account that began the handshake, but `tools/link_identity.ts` cold-DMs the named TARGET account, which began nothing — it is the challenge that proves that account's ownership, and its copy names the initiator so the person can judge it. A stopped person can therefore still be made to receive that challenge, repeatedly, by anyone who names their account. It stays exempt on the rule that a stop request throttles chattiness: a challenge against the recipient's own account is important, and silencing it would let a link be claimed without the one message that can contest it. The repetition is the real cost, and it belongs to a rate limit on this plane rather than to the stop. NO SUCH RATE LIMIT EXISTS TODAY: `tools/link_identity.ts` names that gap in its own header, and one DM per TTL-bounded single-use request is the only bound the plane has.",
  },
  {
    plane: "governance.pane",
    modules: ["packages/core/agent/access/pane-venue.ts"],
    what: "An admin's own pane read — a usage report, a spend report, a connector disclosure — delivered privately back to the admin who asked for it.",
    stop: "exempt",
    recordsDelivery: false,
    exemptBecause:
      "It answers the recipient's own tool call. The DM is the private venue for a pane they just asked for, because an org-grain read must not land in a room, so it is a reply rather than a message the agent starts. A stop request throttles chattiness, and an answer the person asked for this minute is not chattiness — silencing it would drop the reply to their own command.",
  },
];

export function proactiveDmPlaneRow(plane: ProactiveDmPlane): ProactiveDmPlaneRow {
  const row = PROACTIVE_DM_PLANES.find((r) => r.plane === plane);
  if (row === undefined) throw new Error(`proactive DM plane "${plane}" is not declared in PROACTIVE_DM_PLANES`);
  return row;
}
