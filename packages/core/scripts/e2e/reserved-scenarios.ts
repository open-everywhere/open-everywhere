import type { ReactionSurface } from "../../agent/channels/reaction-ingest.js";

export interface ReservedScenario {
  readonly id: string;
  readonly proves: string;
}

export const LANDED_REACTION_SCENARIOS = {
  slack: {
    id: "J-REACT-slack",
    proves:
      "a member's real reaction on the agent's own Slack reply writes one `reaction.feedback` row, its removal writes the removed row, and a reaction on the member's own message (where the agent's status reaction also sits) writes none",
  },
} as const satisfies Partial<Record<ReactionSurface, ReservedScenario>>;

export const RESERVED_REACTION_SCENARIOS: Record<Exclude<ReactionSurface, keyof typeof LANDED_REACTION_SCENARIOS>, ReservedScenario> = {
  discord: {
    id: "J-REACT-discord",
    proves:
      "a member's reaction on the agent's own Discord reply writes one `reaction.feedback` row, and its REMOVAL writes the matching retraction — the only wired surface pair where a removal is observable alongside an add",
  },
  teams: {
    id: "J-REACT-teams",
    proves:
      "a `like` on the agent's own Teams message writes one `reaction.feedback` row bucketed `positive`, and a mixed activity carrying the stop glyph beside it still writes the row rather than losing it to the cancel",
  },
  github: {
    id: "J-REACT-github",
    proves:
      "a reaction on the agent's own GitHub comment is recorded on the NEXT delivery for that conversation (never on the click), exactly once across repeated deliveries, and a conversation the agent has not commented in produces no repository read at all",
  },
  linear: {
    id: "J-REACT-linear",
    proves:
      "a reaction on the agent's own Linear comment writes one `reaction.feedback` row, and a reaction on the human's own comment in the same issue writes none",
  },
};

export function reservedReactionScenarioIds(): readonly string[] {
  return Object.values(RESERVED_REACTION_SCENARIOS).map((s) => s.id);
}
