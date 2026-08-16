import { defineSchedule } from "eve/schedules";
import { getConfig } from "../access/config.js";
import { providerById } from "../memory/provider.js";
import { siloAccess } from "../memory/resolve.js";
import { siloTier, tierId, type Tier } from "../memory/store.js";
import type { Partition } from "../memory/partition.js";
import type { Domain } from "../memory/domain.js";
import { tidySilo, tidySiloJudged, type TidyResult, type JudgeStats } from "../memory/dream/tidy.js";
import { dreamJudge } from "../memory/dream/judge.js";
import { recordMemoryOpProposals, DREAM_ACTOR } from "../memory/dream/proposal.js";
import { appendAudit } from "../audit/audit.js";
import { sweepExpiredPendings } from "../approvals/flow.js";
import { getSettings } from "../settings/settings.js";

function log(msg: string): void {
  console.log(`[open-everywhere:dream/tidy] ${msg}`);
}

export function dreamCandidateCap(): number {
  return getSettings().memory.dreamCandidateCap;
}

export function tidyOrgs(): string[] {
  const raw = process.env.OE_TIDY_ORGS;
  if (!raw) return ["default"];
  const orgs = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return orgs.length > 0 ? orgs : ["default"];
}

function partitionForOrg(org: string): Partition {
  return {
    org,
    platform: org,
    workspace: org,
    surface: org,
    workspaceKey: org,
    surfaceKey: org,
    key: org,
  };
}

export interface TidyTickReport {
  readonly orgs: number;
  readonly silos: number;
  readonly applied: number;
  readonly proposed: number;
  readonly changed: number;
  readonly judged: JudgeStats;
  readonly expiredApprovals: number;
}

export async function tidyTick(opts: { readonly now?: Date; readonly orgs?: readonly string[] } = {}): Promise<TidyTickReport> {
  const now = opts.now ?? new Date();
  const orgs = opts.orgs ?? tidyOrgs();
  let silos: readonly { name: string; provider: string; readOnly?: boolean }[];
  const noJudge: JudgeStats = { candidates: 0, confirmed: 0, rejected: 0, failed: 0 };
  let domains: readonly Domain[] = [];
  try {
    silos = getConfig().loadSilos();
    domains = getConfig().loadDomains();
  } catch (err) {
    log(`tick skipped — config not registered: ${String(err)}`);
    return { orgs: 0, silos: 0, applied: 0, proposed: 0, changed: 0, judged: noJudge, expiredApprovals: 0 };
  }

  const judge = dreamJudge();
  const cap = dreamCandidateCap();

  let siloCount = 0;
  let applied = 0;
  let proposed = 0;
  let changed = 0;
  let judged = noJudge;
  let expiredApprovals = 0;

  for (const org of orgs) {
    const orgStart = { siloCount, applied, proposed, changed, expiredApprovals };
    const p = partitionForOrg(org);
    for (const silo of silos) {
      if (silo.readOnly) continue;
      const tier: Tier = siloTier(silo.name);
      let files;
      try {
        files = await providerById(silo.provider).readTier(p, tier, silo, siloAccess(silo.name, domains));
      } catch (err) {
        log(`skip ${org}/${silo.name} (${silo.provider}) — read failed: ${String(err)}`);
        continue;
      }
      if (Object.keys(files).length === 0) continue;
      siloCount++;

      let result: TidyResult;
      if (judge) {
        const r = await tidySiloJudged(files, silo.name, judge, { now, maxCandidates: cap });
        judged = {
          candidates: judged.candidates + r.judged.candidates,
          confirmed: judged.confirmed + r.judged.confirmed,
          rejected: judged.rejected + r.judged.rejected,
          failed: judged.failed + r.judged.failed,
        };
        result = r;
      } else {
        result = tidySilo(files, { now });
      }

      if (result.changed) {
        try {
          const sha = await providerById(silo.provider).writeTier(
            p,
            tier,
            result.files,
            `dream:tidy [${tierId(tier)}] ${result.applied.length} safe op(s)`,
            silo,
            siloAccess(silo.name, domains),
          );
          changed++;
          await appendAudit({
            org,
            platform: "memory",
            workspace: silo.name,
            principalId: DREAM_ACTOR,
            action: "memory.tidy",
            detail: {
              silo: silo.name,
              provider: silo.provider,
              applied: result.applied.map((o) => ({ kind: o.kind, file: o.file, summary: o.summary })),
              version: sha,
            },
          });
        } catch (err) {
          log(`skip write ${org}/${silo.name} — ${String(err)}`);
          continue;
        }
      }
      applied += result.applied.length;
      proposed += await recordMemoryOpProposals(org, silo.name, result.proposals);
    }
    try {
      expiredApprovals += await sweepExpiredPendings(org, now);
    } catch (err) {
      log(`skip approval-sweep ${org} — ${String(err)}`);
    }

    const orgSilos = siloCount - orgStart.siloCount;
    const orgApplied = applied - orgStart.applied;
    const orgProposed = proposed - orgStart.proposed;
    const orgChanged = changed - orgStart.changed;
    const orgExpired = expiredApprovals - orgStart.expiredApprovals;
    await appendAudit({
      org,
      platform: "memory",
      workspace: "tidy",
      principalId: DREAM_ACTOR,
      action: "memory.tidy_tick",
      detail: {
        outcome: orgChanged > 0 ? "changed" : "no-op: nothing to tidy",
        silos: orgSilos,
        applied: orgApplied,
        proposed: orgProposed,
        changed: orgChanged,
        expiredApprovals: orgExpired,
      },
    });
  }

  const judgeNote = judge
    ? ` (judge: ${judged.candidates} candidate(s), ${judged.confirmed} confirmed, ${judged.rejected} rejected, ${judged.failed} failed-quiet)`
    : " (no judge registered — zero-LLM heuristics)";
  log(`tick: ${orgs.length} org(s), ${siloCount} silo(s) — ${applied} safe op(s) applied, ${changed} silo(s) written, ${proposed} proposal(s) recorded, ${expiredApprovals} approval(s) expired${judgeNote}`);
  return { orgs: orgs.length, silos: siloCount, applied, proposed, changed, judged, expiredApprovals };
}

export default defineSchedule({
  cron: "0 4 * * *",
  async run() {
    await tidyTick();
  },
});
