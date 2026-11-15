import { getConfig } from "../access/config.js";
import { nonMemberWakeFromAuth, type MemberPlaneAuthLike } from "../access/member-plane.js";
import { OE_CHAT_NONMEMBER_ATTR } from "../identity/non-member.js";
import { auditToolAction } from "../audit/tool-action.js";
import { delegatedNonMemberWakeThisTurn } from "../identity/delegated-binding.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import type { A2aAgentDeclaration } from "./agents.js";

export type A2aRoomRefusalReason = "room-not-internal" | "non-member-in-wake" | "domain-not-allowed";

export interface A2aRoomFacts {
  readonly trust: string;
  readonly nonMemberWake: boolean;
  readonly conversationDomains: readonly string[];
}

export function a2aRoomRefusal(
  agent: Pick<A2aAgentDeclaration, "name" | "domains">,
  facts: A2aRoomFacts,
): { readonly reason: A2aRoomRefusalReason; readonly message: string } | undefined {
  if (facts.trust !== "internal") {
    return {
      reason: "room-not-internal",
      message:
        `This conversation is not an internal room (it is shared with another organisation, declared public, or with a guest), ` +
        `so it cannot hand a task to the A2A agent "${agent.name}": the task would go out on the organisation's credential and the answer would come back here. ` +
        "Ask from an internal channel or DM.",
    };
  }
  if (facts.nonMemberWake) {
    return {
      reason: "non-member-in-wake",
      message:
        `A guest or external account took part in this request, so it cannot hand a task to the A2A agent "${agent.name}". ` +
        "A member must ask in an internal room.",
    };
  }
  if (agent.domains !== undefined && !facts.conversationDomains.some((d) => agent.domains!.includes(d))) {
    return {
      reason: "domain-not-allowed",
      message:
        `The A2A agent "${agent.name}" is declared for ${agent.domains.map((d) => `"${d}"`).join(", ")} only, and this conversation is not in ` +
        (agent.domains.length === 1 ? "that domain" : "one of those domains") +
        ". Ask from a room in an allowed domain, or change the declaration by pull request.",
    };
  }
  return undefined;
}

function nonMemberWakeOf(ctx: BindableContext): boolean {
  const auth = (ctx as { session?: { auth?: MemberPlaneAuthLike } }).session?.auth;
  return delegatedNonMemberWakeThisTurn(undefined) ?? nonMemberWakeFromAuth(auth, OE_CHAT_NONMEMBER_ATTR);
}

function conversationDomainsOf(ctx: BindableContext, binding: ReturnType<typeof bindFrom>): readonly string[] {
  try {
    const p = resolvePartition(ctx);
    return getConfig().domainsForSurface({ workspaceKey: p.workspaceKey, surface: binding.domainSurface ?? p.surface });
  } catch {
    return [];
  }
}

export async function assertA2aRoomAllowed(ctx: BindableContext, agent: A2aAgentDeclaration, tool: string): Promise<void> {
  const binding = bindFrom(ctx);
  const refusal = a2aRoomRefusal(agent, {
    trust: binding.trust,
    nonMemberWake: nonMemberWakeOf(ctx),
    conversationDomains: conversationDomainsOf(ctx, binding),
  });
  if (refusal === undefined) return;
  await auditToolAction(ctx, "a2a.refused", { reason: refusal.reason, agent: agent.name, tool });
  throw new Error(`${tool}: ${refusal.message}`);
}
