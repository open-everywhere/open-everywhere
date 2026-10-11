import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowGated } from "../access/window-gated.js";
import { bindFrom, currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { getConfig } from "../access/config.js";
import type { Domain } from "../memory/domain.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { domainMembershipProbe, type DomainMembershipAnswer } from "../access/domain-membership.js";
import { taintKindsThisTurn, untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { auditToolAction } from "../audit/tool-action.js";
import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { resolveUnifiedWakeTarget } from "../channels/unified-window.js";
import { dispatchSeatMessage } from "../channels/unified.js";
import {
  DOMAIN_QUESTION_ASK_TOOL,
  DOMAIN_QUESTION_ASKED_ACTION,
  DOMAIN_QUESTION_MAX_CHARS,
  DOMAIN_QUESTION_RECEIVED_ACTION,
  DOMAIN_QUESTION_REFUSED_ACTION,
  claimDomainQuestionSend,
  domainLabel,
  domainQuestionDomainRefusal,
  domainQuestionDeliveryWakeId,
  domainQuestionIdFor,
  domainQuestionMembershipRefusal,
  domainQuestionNoSeatRefusal,
  domainQuestionRoomRefusal,
  domainSeatForRoom,
  domainTakesDmQuestions,
  nonMemberWakeOf,
  dmSurfaceOfSeat,
  readDomainQuestion,
  readDomainQuestionOutcome,
  askDeliveryOutcome,
  rememberDomainQuestion,
  rememberDomainQuestionOutcome,
  routedMembershipRooms,
  renderDomainQuestion,
  taintStampFor,
  type DomainQuestionRefusal,
} from "../channels/domain-question.js";

const TOOL = DOMAIN_QUESTION_ASK_TOOL;

async function refuse(ctx: BindableContext, refusal: DomainQuestionRefusal, domain: string | undefined): Promise<never> {
  await auditToolAction(ctx, DOMAIN_QUESTION_REFUSED_ACTION, { reason: refusal.reason, domain: domain ?? null, tool: TOOL });
  throw new Error(`${TOOL}: ${refusal.message}`);
}

function askedResult(id: string, target: Pick<Domain, "name" | "title">, delivered: boolean | undefined) {
  const label = domainLabel(target);
  return {
    status: "asked" as const,
    questionId: id,
    domain: target.name,
    delivered,
    note:
      delivered === true
        ? `Asked the ${label} domain. Its answer comes back to this DM as a message of its own. Tell the person you asked, and do not guess the answer in the meantime.`
        : delivered === false
          ? `The ${label} domain's seat could not be woken, so nobody saw the question. Tell the person, and suggest asking in one of the domain's channels.`
          : `It is unknown whether the ${label} domain's seat received the question: an earlier run of this call asked and did not record the outcome. Tell the person an answer may still arrive here, and do not ask again.`,
  };
}

export default windowGated(
  "ask_domain",
  defineTool({
    description:
      "Ask one of the person's domains a question, and bring its answer back to this DM. A domain is a team this deployment declares (for example a launch, a project or a department), and the person belongs to it when they sit in one of its internal channels. " +
      "Use it when the person asks about something one of their teams knows — \"what's the latest on the launch?\" — and you do not know it yourself. " +
      "The domain's own seat answers under that domain's rules, exactly as if the person had asked in its channel. The call returns at once: tell the person you asked, and relay the answer when it arrives here. " +
      "Call it with no `domain` to list the domains the person belongs to. DM only.",
    inputSchema: z.object({
      domain: z.string().min(1).optional().describe("The domain's name, as this deployment declares it. Omit it to list the person's domains instead of asking."),
      question: z
        .string()
        .min(1)
        .max(DOMAIN_QUESTION_MAX_CHARS)
        .optional()
        .describe("The question, written so it stands alone: the domain's seat sees this text, not this conversation. Required with `domain`."),
    }),
    outputSchema: z.object({
      status: z.enum(["asked", "domains"]),
      questionId: z.string().optional(),
      domain: z.string().optional(),
      domains: z.array(z.object({ name: z.string(), title: z.string() })).optional(),
      delivered: z.boolean().optional(),
      note: z.string(),
    }),
    async execute(input, ctx) {
      const c = ctx as BindableContext;
      const binding = bindFrom(c);
      const asker = actingPrincipalIdOf(c);
      const domains = getConfig().loadDomains();
      const named = input.domain?.trim();
      const domain = named === undefined ? undefined : domains.find((d) => d.name === named);
      const roomRefusal =
        domainQuestionRoomRefusal({ mode: binding.mode, trust: binding.trust, nonMemberWake: nonMemberWakeOf(c), asker }) ??
        (named === undefined ? undefined : domainQuestionDomainRefusal(domain, named));
      if (roomRefusal) return refuse(c, roomRefusal, named);
      const principal = asker as string;
      const p = resolvePartition(c);
      const probe = domainMembershipProbe(binding.platform);
      const answer: DomainMembershipAnswer = probe
        ? await probe({ principalId: principal, workspaceKey: p.workspaceKey }).catch(() => ({ fullMember: false, rooms: [] }))
        : { fullMember: false, rooms: [] };
      const teamRooms = routedMembershipRooms(answer.rooms, domains, p.workspaceKey);

      if (named === undefined) {
        const listRefusal = domainQuestionMembershipRefusal("your domains", { probe: probe !== undefined, fullMember: answer.fullMember, roomsInDomain: Number.POSITIVE_INFINITY });
        if (listRefusal) return refuse(c, listRefusal, undefined);
        const mine = [...new Set(teamRooms.map((r) => r.domain))]
          .map((n) => domains.find((d) => d.name === n)!)
          .filter((d) => domainTakesDmQuestions(d))
          .map((d) => ({ name: d.name, title: domainLabel(d) }));
        return {
          status: "domains" as const,
          domains: mine,
          note:
            mine.length === 0
              ? "The person belongs to no domain that takes DM questions, so there is no domain to ask. Say so."
              : `The person belongs to ${mine.length} domain(s) you can ask. Pick the one whose work the question is about, and call ${TOOL} again with its name and the question.`,
        };
      }

      const target = domain!;
      if (input.question === undefined || input.question.trim().length === 0) {
        throw new Error(`${TOOL}: say what to ask the ${domainLabel(target)} domain — \`question\` is empty.`);
      }
      const rooms = teamRooms.filter((r) => r.domain === target.name);
      const memberRefusal = domainQuestionMembershipRefusal(`the ${domainLabel(target)} domain`, { probe: probe !== undefined, fullMember: answer.fullMember, roomsInDomain: rooms.length });
      if (memberRefusal) return refuse(c, memberRefusal, target.name);

      const org = deploymentOrg();
      const store = getOperationalStore();
      const wakeId = currentWakeId(c);
      const dmOrigin = wakeId ? await resolveUnifiedWakeTarget(store, org, wakeId) : null;
      const dmSurfaceKey = dmSurfaceOfSeat(resolveOwnWindowToken(c));
      if (!dmOrigin || dmSurfaceKey === undefined) {
        throw new Error(`${TOOL}: I couldn't resolve this DM's own address, so nothing was asked. Try again on a message the person sent.`);
      }
      const question = input.question.trim();
      const nowIso = new Date().toISOString();
      const id = domainQuestionIdFor(wakeId as string, target.name, question);
      const deliveryWakeId = domainQuestionDeliveryWakeId(id);
      const existing = await readDomainQuestion(store, org, id);
      const recordedSend = existing === undefined ? undefined : await readDomainQuestionOutcome(store, org, id);
      if (existing !== undefined && recordedSend !== undefined) {
        const replayDetail = { questionId: id, domain: target.name, room: existing.roomSurfaceKey, seatId: existing.seatWindowId, delivered: recordedSend, replay: true, chars: question.length, tainted: untrustedIngestedThisTurn() };
        await auditToolAction(c, DOMAIN_QUESTION_ASKED_ACTION, replayDetail);
        await appendAudit({ org, platform: "unified", workspace: target.name, principalId: principal, action: DOMAIN_QUESTION_RECEIVED_ACTION, detail: { ...replayDetail, dm: dmSurfaceKey } }).catch(() => undefined);
        return askedResult(id, target, recordedSend);
      }
      const candidates = existing === undefined ? rooms : rooms.filter((r) => r.surfaceKey === existing.roomSurfaceKey);
      let seat: Awaited<ReturnType<typeof domainSeatForRoom>> = null;
      let room = candidates[0];
      for (const r of candidates) {
        const s = await domainSeatForRoom(store, org, r.surfaceKey, domains);
        if (s && (existing === undefined || s.windowId === existing.seatWindowId)) {
          seat = s;
          room = r;
          break;
        }
      }
      if (!seat || !room) return refuse(c, domainQuestionNoSeatRefusal(target), target.name);

      if (existing === undefined) {
        await rememberDomainQuestion(store, {
          id,
          org,
          domain: target.name,
          seatWindowId: seat.windowId,
          deliveryWakeId,
          roomSurfaceKey: room.surfaceKey,
          asker: principal,
          dmSurfaceKey,
          dmOrigin,
          dmAudit: { platform: p.platform, workspace: p.workspace, surface: p.surface },
          question,
          atIso: nowIso,
        });
      }
      const tainted = untrustedIngestedThisTurn();
      const first = await claimDomainQuestionSend(store, org, id, nowIso);
      const dispatched = first
        ? await dispatchSeatMessage({
            token: seat.token,
            origin: room.origin,
            wakeId: deliveryWakeId,
            domain: seat.domain,
            message: renderDomainQuestion({ id, domain: target, asker: principal, roomSurfaceKey: room.surfaceKey, question }),
            authAttributes: taintStampFor(tainted, taintKindsThisTurn()),
          })
        : undefined;
      if (first) await rememberDomainQuestionOutcome(store, org, id, dispatched === true, nowIso);
      const delivered = askDeliveryOutcome(first, dispatched, first ? undefined : await readDomainQuestionOutcome(store, org, id));
      const detail = { questionId: id, domain: target.name, room: room.surfaceKey, seatId: seat.windowId, delivered: delivered ?? null, replay: !first, chars: question.length, tainted };
      await auditToolAction(c, DOMAIN_QUESTION_ASKED_ACTION, detail);
      await appendAudit({ org, platform: "unified", workspace: target.name, principalId: principal, action: DOMAIN_QUESTION_RECEIVED_ACTION, detail: { ...detail, dm: dmSurfaceKey } }).catch(() => undefined);
      return askedResult(id, target, delivered);
    },
  }),
);
