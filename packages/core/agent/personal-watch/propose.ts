import { auditErrorDetail } from "../audit/tool-action.js";
import { approvalPostDeps, hasApprovalCardPath, requestApproval, type RequestApprovalDeps } from "../approvals/flow.js";
import { checkClickerFloor, type ClickerFloorDeps } from "../approvals/clicker-floor.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { resolveDeclaredTarget } from "../schedules/routine-dispatch.js";
import { ROUTINE_SUGGEST_KIND, routineSuggestArgs, type ProposeRoutine } from "./discovery.js";
import { ROOM_DISCOVERY_REQUESTER, roomRoutineSuggestArgs, type ProposeRoomRoutine } from "./room-discovery.js";

export interface ProposalPostEdges {
  readonly resolveTarget?: typeof resolveDeclaredTarget;
  readonly post?: RequestApprovalDeps["post"];
  readonly postCard?: RequestApprovalDeps["postCard"];
  readonly floor?: ClickerFloorDeps["floor"];
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
      return { ok: false, reason: `the DM resolver failed: ${auditErrorDetail(err).error}` };
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
      return { ok: false, reason: `the card did not post: ${auditErrorDetail(err).error}` };
    }
  };
}

export function proposeRoomRoutineCard(edges: ProposalPostEdges = {}): ProposeRoomRoutine {
  return async ({ org, surfaceKey, work }) => {
    const [platform = "", workspace = "", ...rest] = surfaceKey.split("/");
    const surface = rest.join("/");
    if (platform.length === 0 || surface.length === 0) return { ok: false, reason: "the key does not name a room" };
    if (edges.post === undefined && edges.postCard === undefined && !hasApprovalCardPath(platform)) {
      return { ok: false, reason: `${platform} has no card path, so a proposal would have no button` };
    }
    let resolved;
    try {
      resolved = await (edges.resolveTarget ?? resolveDeclaredTarget)({ kind: "room", platform, workspace, surface });
    } catch (err) {
      return { ok: false, reason: `the room resolver failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    if (resolved.dispatch.mode !== "channel") return { ok: false, reason: `the room resolved to a ${resolved.dispatch.mode} surface, not a shared room` };
    const channelId = channelIdOf(resolved.dispatch.target);
    if (channelId === undefined) return { ok: false, reason: "the room has no channel id to post a card into" };
    const floor = await checkClickerFloor(resolved.surfaceKey, { beneficiaryClicker: false }, edges.floor ? { floor: edges.floor } : {});
    if (!floor.ok) return { ok: false, reason: "the room holds a guest or an outside account, so no member could answer the card", keep: true };
    const args = roomRoutineSuggestArgs({ org, surfaceKey: resolved.surfaceKey, target: resolved.dispatch.target, work });
    try {
      const posted = await requestApproval(
        {
          org,
          kind: ROUTINE_SUGGEST_KIND,
          args,
          scopeKey: resolved.surfaceKey,
          domain: null,
          requestedBy: ROOM_DISCOVERY_REQUESTER,
          channelId,
          threadTs: null,
          postedTo: resolved.surfaceKey,
        },
        {
          ...approvalPostDeps(platform),
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
