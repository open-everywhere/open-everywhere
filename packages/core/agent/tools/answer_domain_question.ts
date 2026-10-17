import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowGated } from "../access/window-gated.js";
import { currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { taintKindsThisTurn, untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { auditToolAction } from "../audit/tool-action.js";
import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { mintWakeId } from "../channels/unified-window.js";
import { dispatchSeatMessage } from "../channels/unified.js";
import { postUnifiedReply } from "../channels/unified-reply.js";
import type { UnifiedWakeOrigin } from "../channels/unified-window.js";
import {
  DOMAIN_ANSWER_MAX_CHARS,
  DOMAIN_QUESTION_ANSWER_DELIVERED_ACTION,
  DOMAIN_QUESTION_ANSWER_TOOL,
  DOMAIN_QUESTION_ANSWERED_ACTION,
  DOMAIN_QUESTION_REFUSED_ACTION,
  claimDomainAnswer,
  dmSeatForSurface,
  domainAnswerDigest,
  domainAnswerRefusal,
  nonMemberWakeOf,
  readDomainAnswerOutcome,
  readDomainQuestion,
  rememberDomainAnswerOutcome,
  renderDomainAnswerForDmSeat,
  renderDomainAnswerPost,
  standingWindowOfSeat,
  taintStampFor,
} from "../channels/domain-question.js";

const TOOL = DOMAIN_QUESTION_ANSWER_TOOL;

export type DomainAnswerRoute = "dm-seat" | "posted" | "failed";

export function domainAnswerNote(route: DomainAnswerRoute, declined: boolean): string {
  const what = declined ? "Your refusal" : "Your answer";
  if (route === "dm-seat") return `${what} went to the person's DM, and their DM seat will tell them. Nothing was posted here, and nothing more is needed.`;
  if (route === "posted") return `${what} was posted into the person's DM. Nothing was posted here, and nothing more is needed.`;
  return `${what} could not reach the person's DM: their DM seat could not be woken and the post failed. Nobody saw it. Do not post it here; the person can ask again.`;
}

export function postDomainAnswerFallback(origin: UnifiedWakeOrigin, input: Parameters<typeof renderDomainAnswerPost>[0]): Promise<string> {
  return postUnifiedReply(origin, renderDomainAnswerPost(input), {}, undefined, undefined, undefined, { generated: true });
}

export default windowGated(
  "answer_domain_question",
  defineTool({
    description:
      "Answer a question a member of this domain asked from their own DM. Use it only when a delivery names a question id. " +
      "The answer goes to that person's DM and nowhere else — never post it in this room. " +
      "Answer as you would if they had asked in this domain's room: share what you would share with them there. " +
      "If you should not answer, set `declined: true` and give one sentence on why.",
    inputSchema: z.object({
      question: z.string().min(1).describe("The question id from the delivery, exactly as given."),
      answer: z
        .string()
        .min(1)
        .max(DOMAIN_ANSWER_MAX_CHARS)
        .describe("Your answer, written for the person who asked. With `declined: true`, one sentence on why you will not answer."),
      declined: z.boolean().optional().describe("true when you will not answer this question. The person is told the domain declined, with your reason."),
    }),
    outputSchema: z.object({ delivered: z.boolean(), route: z.enum(["dm-seat", "posted", "failed"]), note: z.string() }),
    async execute(input, ctx) {
      const c = ctx as BindableContext;
      const org = deploymentOrg();
      const store = getOperationalStore();
      const seat = standingWindowOfSeat(resolveOwnWindowToken(c));
      const row = seat === undefined ? undefined : await readDomainQuestion(store, org, input.question.trim());
      const domain = row === undefined ? undefined : getConfig().loadDomains().find((d) => d.name === row.domain);
      const refusal = domainAnswerRefusal({ seat, row, domain, answeringWakeId: currentWakeId(c), nonMemberWake: nonMemberWakeOf(c) });
      if (refusal) {
        await auditToolAction(c, DOMAIN_QUESTION_REFUSED_ACTION, { reason: refusal.reason, domain: row?.domain ?? seat?.domain ?? null, questionId: input.question.trim(), tool: TOOL });
        throw new Error(`${TOOL}: ${refusal.message}`);
      }
      const q = row!;
      const nowIso = new Date().toISOString();
      if (!(await claimDomainAnswer(store, org, q.id, nowIso))) {
        const recorded = await readDomainAnswerOutcome(store, org, q.id, domainAnswerDigest(input.answer, input.declined === true));
        if (recorded !== undefined) return { delivered: recorded !== "failed", route: recorded, note: `${domainAnswerNote(recorded, input.declined === true)} (An earlier run of this call sent it; nothing was sent now.)` };
        await auditToolAction(c, DOMAIN_QUESTION_REFUSED_ACTION, { reason: "already-answered", domain: q.domain, questionId: q.id, tool: TOOL });
        throw new Error(`${TOOL}: this question was already answered, by an earlier call or an earlier run of this call. Nothing was sent now. Do not post it here.`);
      }
      const declined = input.declined === true;
      const answer = input.answer.trim();
      const tainted = untrustedIngestedThisTurn();

      let route: DomainAnswerRoute = "failed";
      const dmSeat = await dmSeatForSurface(store, org, q.dmSurfaceKey);
      if (dmSeat) {
        const wakeId = mintWakeId();
        const woke = await dispatchSeatMessage({
          token: dmSeat.token,
          origin: q.dmOrigin,
          wakeId,
          domain: dmSeat.domain,
          message: renderDomainAnswerForDmSeat({ id: q.id, domain: domain!, question: q.question, answer, declined, wakeId }),
          authAttributes: taintStampFor(tainted, taintKindsThisTurn()),
        });
        if (woke) route = "dm-seat";
      }
      if (route === "failed") {
        route = await postDomainAnswerFallback(q.dmOrigin, { domain: domain!, question: q.question, answer, declined })
          .then(() => "posted" as const)
          .catch(() => "failed" as const);
      }

      await rememberDomainAnswerOutcome(store, org, q.id, route, domainAnswerDigest(answer, declined), nowIso);
      const detail = { questionId: q.id, domain: q.domain, asker: q.asker, declined, route, chars: answer.length, tainted };
      await auditToolAction(c, DOMAIN_QUESTION_ANSWERED_ACTION, detail);
      await appendAudit({
        org,
        platform: q.dmAudit.platform,
        workspace: q.dmAudit.workspace,
        surface: q.dmAudit.surface,
        principalId: q.asker,
        action: DOMAIN_QUESTION_ANSWER_DELIVERED_ACTION,
        detail,
      }).catch(() => undefined);
      return { delivered: route !== "failed", route, note: domainAnswerNote(route, declined) };
    },
  }),
);
