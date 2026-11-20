import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { resolvePartition } from "../memory/partition.js";
import { auditSurfaceModeStamp, bindFrom, currentTurnId, deliveryStampOf, isSubagentChildContext, isScheduleOriginatedAuth, type BindableContext } from "../identity/binding.js";
import { deliveryChangedThisTurn } from "../access/task-wake-signal.js";
import { planFor } from "../memory/resolve.js";
import { auditRecurrenceLedger, signatureDigest } from "../memory/dream/recurrence.js";
import { learnFromSession, safeDistill, enrichmentBullets, writeEnrichment } from "../memory/dream/learn.js";
import { dreamJudge } from "../memory/dream/judge.js";
import { recordProposal } from "../memory/dream/proposal.js";
import { openSkillProposalPr } from "../memory/dream/skill-proposal-pr.js";
import { appendAudit } from "../audit/audit.js";
import { auditPersonOptOutRefusal } from "../identity/person-opt-out.js";
import { turnPersonOptOut } from "../memory/opt-out-turn.js";
import { triggerMessageBody } from "../channels/wake-envelope.js";
import { optional } from "./control-refusal.js";
import { deliveredText } from "./event-reads.js";

const MAX_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 300;

const learnLog = defineState<{ session: string[]; turn: string[] }>(
  "open-everywhere.learn.sessionLog",
  () => ({ session: [], turn: [] }),
);

function log(msg: string): void {
  console.log(`[open-everywhere:dream/learn] ${msg}`);
}

function consolidatableTurn(ctx: HookContext): boolean {
  try {
    if (isSubagentChildContext(ctx as unknown as BindableContext)) return false;
    const c = ctx as unknown as { session?: { auth?: { current?: unknown; initiator?: unknown } | null } };
    const auth = (c.session?.auth?.current ?? c.session?.auth?.initiator ?? null) as
      | { authenticator?: unknown; principalId?: unknown; principalType?: unknown }
      | null;
    return !isScheduleOriginatedAuth(auth);
  } catch {
    return false;
  }
}

function authoredBody(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const body = triggerMessageBody(raw)?.trim();
  return body !== undefined && body.length > 0 ? body.slice(0, MAX_MESSAGE_CHARS) : undefined;
}

function consumeTurnRequest(): { request: string; messages: string[]; turnTexts: string[] } | null {
  try {
    const state = learnLog.get();
    const request = state.turn[0]?.trim().replace(/\n+/g, " ").slice(0, 300);
    if (!request) return null;
    learnLog.update((s) => ({ ...s, turn: [] }));
    return { request, messages: state.session, turnTexts: state.turn };
  } catch {
    return null;
  }
}

function dropFromSessionLog(turnTexts: readonly string[]): void {
  try {
    const own = new Set(turnTexts);
    learnLog.update((s) => ({ ...s, session: s.session.filter((t) => !own.has(t)) }));
  } catch {
  }
}

async function consolidate(ctx: HookContext): Promise<void> {
  if (!consolidatableTurn(ctx)) return;
  const captured = consumeTurnRequest();
  if (!captured) return;
  if (deliveryChangedThisTurn(currentTurnId(ctx as unknown as BindableContext))) {
    dropFromSessionLog(captured.turnTexts);
    return;
  }
  const { request, messages } = captured;

  const p = resolvePartition(ctx);
  const binding = bindFrom(ctx);
  if (binding.principalId) {
    const optOut = await turnPersonOptOut(p.org, binding.principalId, currentTurnId(ctx as unknown as BindableContext));
    if (optOut.optedOut) {
      log(`skipped: the turn's person opted out of agent memory about them${optOut.readable ? "" : " (the opt-out store did not answer; fail-closed)"}`);
      dropFromSessionLog(captured.turnTexts);
      await auditPersonOptOutRefusal(
        { org: p.org, platform: p.platform, workspace: p.workspace, surface: p.surface, ...auditSurfaceModeStamp(binding), principalKey: binding.principalId },
        "memory-write",
        { road: "dream-learn", storeReadable: optOut.readable },
      );
      return;
    }
  }
  const plan = planFor(binding, p);
  const target = plan.writes[0];
  const scope = target ? target.silo.name : p.surfaceKey;

  const ledger = auditRecurrenceLedger(p.org);
  let dedupeKey: string | undefined;
  try {
    dedupeKey = deliveryStampOf(ctx as unknown as BindableContext);
  } catch {
    dedupeKey = undefined;
  }
  const result = await learnFromSession(scope, { request, messages, ...(dedupeKey !== undefined ? { dedupeKey } : {}) }, ledger);
  if (result.skipped === "memory-instruction") {
    log("skipped: the request is an instruction about memory, not a fact for memory");
    return;
  }
  if (!result.signature) return;

  if (result.enrich && target) {
    try {
      const facts = await safeDistill(dreamJudge(), {
        scope,
        request,
        messages,
        signature: result.signature,
        count: result.count,
      });
      const bullets = enrichmentBullets(result, facts, new Date().toISOString().slice(0, 10));
      const sha = await writeEnrichment(p, target, bullets);
      await appendAudit({
        org: p.org,
        platform: p.platform,
        workspace: p.workspace,
        surface: p.surface,
        ...auditSurfaceModeStamp(binding),
        principalId: binding.principalId,
        action: "memory.learn",
        detail: { silo: target.silo.name, sigSha: signatureDigest(result.signature), count: result.count, distilled: facts?.length ?? 0, version: sha },
      });
      log(`enriched ${target.silo.name}: ${facts && facts.length > 0 ? `${facts.length} distilled fact(s)` : `recurring workflow "${result.signature}"`} (${result.count}×)`);
    } catch (err) {
      log(`enrich skipped: ${String(err)}`);
    }
  }

  if (result.skillProposal) {
    await recordProposal(p.org, result.skillProposal, binding.principalId);
    log(`proposed SKILL.md for repeated workflow "${result.signature}" (${result.count}×)`);
    try {
      const pr = await openSkillProposalPr(p.org, result.skillProposal, dedupeKey !== undefined ? { delivery: dedupeKey } : {});
      if (pr.opened) {
        log(
          `skill proposal PR ${pr.url} (${pr.updated ? "updated" : "opened"}${pr.reopened ? ", REOPENED after a decline" : ""}) — ` +
            `${pr.corrections === null ? "corrections unreadable" : `${pr.corrections} correction(s) carried`}, ${pr.refusedCorrections} refused`,
        );
      } else {
        log(`skill proposal PR not opened: ${pr.skipped}`);
      }
    } catch (err) {
      log(`skill proposal PR failed: ${String(err)}`);
    }
  }
}

export default defineHook({
  events: {
    "turn.started": optional("learn", () => {
      learnLog.update((s) => ({ ...s, turn: [] }));
    }),

    "delivery.consumed": optional("learn", (event) => {
      const text = authoredBody(deliveredText(event.data));
      if (text === undefined) return;
      learnLog.update((s) => ({
        session: s.session.length < MAX_MESSAGES ? [...s.session, text] : s.session,
        turn: s.turn.length < MAX_MESSAGES ? [...s.turn, text] : s.turn,
      }));
    }),

    "turn.settled": optional("learn", async (event, ctx) => {
      switch (event.data.outcome) {
        case "completed":
        case "failed":
          await consolidate(ctx);
          return;
        default:
          return;
      }
    }),

    "session.ended": optional("learn", async (event, ctx) => {
      if (event.data.outcome === "failed") await consolidate(ctx);
    }),
  },
});
