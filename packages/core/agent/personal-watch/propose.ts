import { approvalPostDeps, hasApprovalCardPath, requestApproval, type RequestApprovalDeps } from "../approvals/flow.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { resolveDeclaredTarget } from "../schedules/routine-dispatch.js";
import { ROUTINE_SUGGEST_KIND, routineSuggestArgs, type ProposeRoutine } from "./discovery.js";

export interface ProposalPostEdges {
  readonly resolveTarget?: typeof resolveDeclaredTarget;
  readonly post?: RequestApprovalDeps["post"];
  readonly postCard?: RequestApprovalDeps["postCard"];
}

function channelIdOf(target: unknown): string | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  const id = (target as { channelId?: unknown }).channelId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function proposeRoutineCard(edges: ProposalPostEdges = {}): ProposeRoutine {
  return async ({ org, principalKey, work }) => {
    const person = parsePrincipalKey(principalKey);
    if (!person) return { ok: false, reason: `"${principalKey}" is not a qualified principal key` };
    if (edges.post === undefined && edges.postCard === undefined && !hasApprovalCardPath(person.platform)) {
      return { ok: false, reason: `${person.platform} has no card path, so a proposal would have no button` };
    }
    let resolved;
    try {
      resolved = await (edges.resolveTarget ?? resolveDeclaredTarget)({
        kind: "person",
        platform: person.platform,
        ...(person.tenant !== undefined ? { tenant: person.tenant } : {}),
        principalId: person.id,
      });
    } catch (err) {
      return { ok: false, reason: `the DM resolver failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const { surfaceKey, dispatch } = resolved;
    if (dispatch.mode !== "dm") return { ok: false, reason: `the person's target resolved to a ${dispatch.mode} surface, not a direct message` };
    const channelId = channelIdOf(dispatch.target);
    if (channelId === undefined) return { ok: false, reason: "the person's DM has no channel id to post a card into" };
    const args = routineSuggestArgs({ org, principalKey, personId: person.id, surfaceKey, target: dispatch.target, work });
    try {
      const posted = await requestApproval(
        {
          org,
          kind: ROUTINE_SUGGEST_KIND,
          args,
          scopeKey: surfaceKey,
          domain: null,
          requestedBy: person.id,
          channelId,
          threadTs: null,
          postedTo: surfaceKey,
        },
        {
          ...approvalPostDeps(person.platform),
          ...(edges.post ? { post: edges.post } : {}),
          ...(edges.postCard ? { postCard: edges.postCard } : {}),
        },
      );
      return { ok: true, cardId: posted.id };
    } catch (err) {
      return { ok: false, reason: `the card did not post: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}
