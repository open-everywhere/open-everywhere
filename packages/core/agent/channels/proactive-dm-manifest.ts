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
      "It is not somebody else's errand: it tells a person that their OWN identity changed, and it is the only thing that makes a quiet takeover loud. Whether a stop should silence a security alert about the recipient themselves is a behaviour ruling, and OPE-1868 holds it.",
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
      "Mixed, and stated at its weakest: the answers `identity/link-consent.ts` and `hooks/link-claim.ts` send go back to the account that began the handshake, but `tools/link_identity.ts` cold-DMs the named TARGET account, which began nothing — it is the challenge that proves that account's ownership, and its copy names the initiator so the person can judge it. A stopped person can therefore still be made to receive that challenge, repeatedly, by anyone who names their account. OPE-1868 holds the ruling on these facts.",
  },
  {
    plane: "governance.pane",
    modules: ["packages/core/agent/access/pane-venue.ts"],
    what: "An admin's own pane read — a usage report, a spend report, a connector disclosure — delivered privately back to the admin who asked for it.",
    stop: "exempt",
    recordsDelivery: false,
    exemptBecause:
      "It answers the recipient's own tool call. The DM is the private venue for a pane they just asked for, because an org-grain read must not land in a room, so it is a reply rather than a message the agent starts. OPE-1868 holds the ruling.",
  },
];

export function proactiveDmPlaneRow(plane: ProactiveDmPlane): ProactiveDmPlaneRow {
  const row = PROACTIVE_DM_PLANES.find((r) => r.plane === plane);
  if (row === undefined) throw new Error(`proactive DM plane "${plane}" is not declared in PROACTIVE_DM_PLANES`);
  return row;
}
