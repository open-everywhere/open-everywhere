import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom, isSubagentChildContext, isScheduleOriginatedAuth, type BindableContext } from "../identity/binding.js";
import { planFor } from "../memory/resolve.js";
import { auditRecurrenceLedger } from "../memory/dream/recurrence.js";
import { learnFromSession, safeDistill, enrichmentBullets, writeEnrichment } from "../memory/dream/learn.js";
import { dreamJudge } from "../memory/dream/judge.js";
import { recordProposal } from "../memory/dream/proposal.js";
import { appendAudit } from "../audit/audit.js";

const MAX_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 300;

const learnLog = defineState<{ session: string[]; turn: string[] }>(
  "open-everywhere.learn.sessionLog",
  () => ({ session: [], turn: [] }),
);

function log(msg: string): void {
  console.log(`[open-everywhere:dream/learn] ${msg}`);
}

export function consolidatableTurn(ctx: HookContext): boolean {
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

function consumeTurnRequest(): { request: string; messages: string[] } | null {
  try {
    const state = learnLog.get();
    const request = state.turn[0]?.trim().replace(/\n+/g, " ").slice(0, 300);
    if (!request) return null;
    learnLog.update((s) => ({ ...s, turn: [] }));
    return { request, messages: state.session };
  } catch {
    return null;
  }
}

async function consolidate(ctx: HookContext): Promise<void> {
  if (!consolidatableTurn(ctx)) return;
  const captured = consumeTurnRequest();
  if (!captured) return;
  const { request, messages } = captured;

  const p = resolvePartition(ctx);
  const binding = bindFrom(ctx);
  const plan = planFor(binding, p);
  const target = plan.writes[0];
  const scope = target ? target.silo.name : p.surfaceKey;

  const ledger = auditRecurrenceLedger(p.org);
  const result = await learnFromSession(scope, { request, messages }, ledger);
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
        principalId: binding.principalId,
        action: "memory.learn",
        detail: { silo: target.silo.name, signature: result.signature, count: result.count, distilled: facts?.length ?? 0, version: sha },
      });
      log(`enriched ${target.silo.name}: ${facts && facts.length > 0 ? `${facts.length} distilled fact(s)` : `recurring workflow "${result.signature}"`} (${result.count}×)`);
    } catch (err) {
      log(`enrich skipped: ${String(err)}`);
    }
  }

  if (result.skillProposal) {
    await recordProposal(p.org, result.skillProposal, binding.principalId);
    log(`proposed SKILL.md for repeated workflow "${result.signature}" (${result.count}×)`);
  }
}

export default defineHook({
  events: {
    "turn.started": (_event, _ctx) => {
      try {
        learnLog.update((s) => ({ ...s, turn: [] }));
      } catch {
      }
    },

    "message.received": (event, _ctx) => {
      const raw = event.data?.message;
      if (typeof raw !== "string") return;
      const text = raw.slice(0, MAX_MESSAGE_CHARS);
      learnLog.update((s) => ({
        session: s.session.length < MAX_MESSAGES ? [...s.session, text] : s.session,
        turn: s.turn.length < MAX_MESSAGES ? [...s.turn, text] : s.turn,
      }));
    },

    "turn.completed": async (_event, ctx) => {
      try {
        await consolidate(ctx);
      } catch (err) {
        log(`turn.completed learn skipped: ${String(err)}`);
      }
    },

    "turn.failed": async (_event, ctx) => {
      try {
        await consolidate(ctx);
      } catch (err) {
        log(`turn.failed learn skipped: ${String(err)}`);
      }
    },

    "session.failed": async (_event, ctx) => {
      try {
        await consolidate(ctx);
      } catch (err) {
        log(`session.failed learn skipped: ${String(err)}`);
      }
    },
  },
});
