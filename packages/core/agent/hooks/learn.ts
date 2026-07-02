import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom } from "../identity/binding.js";
import { planFor } from "../memory/resolve.js";
import { providerById } from "../memory/provider.js";
import { upsertUnderSection } from "../memory/markdown.js";
import { auditRecurrenceLedger } from "../memory/dream/recurrence.js";
import { learnFromSession } from "../memory/dream/learn.js";
import { recordProposal } from "../memory/dream/proposal.js";
import { appendAudit } from "../audit/audit.js";

const learnLog = defineState<{ firstMessage?: string }>(
  "open-everywhere.learn.sessionLog",
  () => ({}),
);

function log(msg: string): void {
  console.log(`[open-everywhere:dream/learn] ${msg}`);
}

async function consolidate(ctx: HookContext): Promise<void> {
  const request = learnLog.get().firstMessage?.trim().replace(/\n+/g, " ").slice(0, 300);
  if (!request) return;

  const p = resolvePartition(ctx);
  const binding = bindFrom(ctx);
  const plan = planFor(binding, p);
  const target = plan.writes[0];
  const scope = target ? target.silo.name : p.surfaceKey;

  const ledger = auditRecurrenceLedger(p.org);
  const result = await learnFromSession(scope, { request }, ledger);
  if (!result.signature) return;

  if (result.enrich && target) {
    try {
      const provider = providerById(target.silo.provider);
      const files = await provider.readTier(p, target.tier, target.silo);
      const seed = `# Recurring workflows (auto-learned)\n\n## Recurring\n(none yet)\n`;
      const bullet = `- ${new Date().toISOString().slice(0, 10)}: recurring workflow — ${result.signature} (seen ${result.count}×) [[MEMORY]]`;
      files["RECURRING.md"] = upsertUnderSection(files["RECURRING.md"] ?? seed, "Recurring", bullet);
      const sha = await provider.writeTier(p, target.tier, files, `dream:learn recurrence enrich [${target.silo.name}]`, target.silo);
      await appendAudit({
        org: p.org,
        platform: p.platform,
        workspace: p.workspace,
        surface: p.surface,
        principalId: binding.principalId,
        action: "memory.learn",
        detail: { silo: target.silo.name, signature: result.signature, count: result.count, version: sha },
      });
      log(`enriched ${target.silo.name}: recurring workflow "${result.signature}" (${result.count}×)`);
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
      const current = learnLog.get();
      if (!current.firstMessage && typeof event.data?.message === "string") {
        learnLog.update((s) => ({ ...s, firstMessage: event.data.message }));
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
