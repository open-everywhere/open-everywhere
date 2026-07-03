import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom } from "../identity/binding.js";
import { planFor } from "../memory/resolve.js";
import { auditRecurrenceLedger } from "../memory/dream/recurrence.js";
import { learnFromSession, safeDistill, enrichmentBullets, writeEnrichment } from "../memory/dream/learn.js";
import { dreamJudge } from "../memory/dream/judge.js";
import { recordProposal } from "../memory/dream/proposal.js";
import { appendAudit } from "../audit/audit.js";

const MAX_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 300;

const learnLog = defineState<{ messages: string[] }>(
  "open-everywhere.learn.sessionLog",
  () => ({ messages: [] }),
);

function log(msg: string): void {
  console.log(`[open-everywhere:dream/learn] ${msg}`);
}

async function consolidate(ctx: HookContext): Promise<void> {
  const messages = learnLog.get().messages;
  const request = messages[0]?.trim().replace(/\n+/g, " ").slice(0, 300);
  if (!request) return;

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
    "message.received": (event, _ctx) => {
      const raw = event.data?.message;
      if (learnLog.get().messages.length < MAX_MESSAGES && typeof raw === "string") {
        learnLog.update((s) => ({ ...s, messages: [...s.messages, raw.slice(0, MAX_MESSAGE_CHARS)] }));
      }
    },

    "session.completed": async (_event, ctx) => {
      try {
        await consolidate(ctx);
      } catch (err) {
        log(`session.completed learn skipped: ${String(err)}`);
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
