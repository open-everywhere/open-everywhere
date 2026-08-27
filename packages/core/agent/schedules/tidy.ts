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
import { guardProvenanceMarks } from "../memory/provenance-mark.js";
import { appendAudit } from "../audit/audit.js";
import { sweepExpiredPendings } from "../approvals/flow.js";
import { sweepCredentialGrants } from "../access/credential-grant-flow.js";
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
  readonly expiredGrantAsks: number;
  readonly grantLapseNotices: number;
  readonly grantCardsExpired: number;
  readonly expiredGrants: number;
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
    return { orgs: 0, silos: 0, applied: 0, proposed: 0, changed: 0, judged: noJudge, expiredApprovals: 0, expiredGrantAsks: 0, grantLapseNotices: 0, grantCardsExpired: 0, expiredGrants: 0 };
  }

  const judge = dreamJudge();
  const cap = dreamCandidateCap();

  let siloCount = 0;
  let applied = 0;
  let proposed = 0;
  let changed = 0;
  let judged = noJudge;
  let expiredApprovals = 0;
  let expiredGrantAsks = 0;
  let grantLapseNotices = 0;
  let grantCardsExpired = 0;
  let expiredGrants = 0;

  for (const org of orgs) {
    const orgStart = { siloCount, applied, proposed, changed, expiredApprovals, expiredGrantAsks };
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

      const guarded = guardProvenanceMarks(files, result.files);
      if (guarded.reverted.length > 0) {
        log(`provenance fence: kept pre-tidy bytes for ${org}/${silo.name} — ${guarded.reverted.join(", ")} would have lost an external-provenance mark`);
      }
      const changedAfterGuard = Object.entries(guarded.files).some(([rel, content]) => files[rel] !== content);
      if (guarded.reverted.length > 0 && !changedAfterGuard) {
        await appendAudit({
          org,
          platform: "memory",
          workspace: silo.name,
          principalId: DREAM_ACTOR,
          action: "memory.tidy",
          detail: {
            silo: silo.name,
            provider: silo.provider,
            applied: [],
            provenanceReverted: [...guarded.reverted],
            version: null,
          },
        });
      }
      if (result.changed && changedAfterGuard) {
        try {
          const sha = await providerById(silo.provider).writeTier(
            p,
            tier,
            guarded.files,
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
              ...(guarded.reverted.length > 0 ? { provenanceReverted: [...guarded.reverted] } : {}),
              version: sha,
            },
          });
        } catch (err) {
          log(`skip write ${org}/${silo.name} — ${String(err)}`);
          continue;
        }
      }
      const refused = new Set(guarded.reverted);
      applied += result.applied.filter((o) => !refused.has(o.file)).length;
      proposed += await recordMemoryOpProposals(org, silo.name, result.proposals);
    }
    try {
      expiredApprovals += await sweepExpiredPendings(org, now);
    } catch (err) {
      log(`skip approval-sweep ${org} — ${String(err)}`);
    }

    try {
      const grants = await sweepCredentialGrants(org, now.toISOString());
      expiredGrantAsks += grants.asks;
      grantLapseNotices += grants.requesterNotices;
      grantCardsExpired += grants.cardsUpdated;
      expiredGrants += grants.grants;
    } catch (err) {
      log(`skip credential-grant-sweep ${org} — ${String(err)}`);
    }

    const orgSilos = siloCount - orgStart.siloCount;
    const orgApplied = applied - orgStart.applied;
    const orgProposed = proposed - orgStart.proposed;
    const orgChanged = changed - orgStart.changed;
    const orgExpired = expiredApprovals - orgStart.expiredApprovals;
    const orgExpiredGrantAsks = expiredGrantAsks - orgStart.expiredGrantAsks;
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
        expiredGrantAsks: orgExpiredGrantAsks,
      },
    });
  }

  const judgeNote = judge
    ? ` (judge: ${judged.candidates} candidate(s), ${judged.confirmed} confirmed, ${judged.rejected} rejected, ${judged.failed} failed-quiet)`
    : " (no judge registered — zero-LLM heuristics)";
  log(
    `tick: ${orgs.length} org(s), ${siloCount} silo(s) — ${applied} safe op(s) applied, ${changed} silo(s) written, ` +
      `${proposed} proposal(s) recorded, ${expiredApprovals} approval(s) expired, ` +
      `${expiredGrantAsks} grant ask(s) lapsed (${grantLapseNotices} notice(s), ${grantCardsExpired} card(s) updated), ` +
      `${expiredGrants} grant(s) expired${judgeNote}`,
  );
  return { orgs: orgs.length, silos: siloCount, applied, proposed, changed, judged, expiredApprovals, expiredGrantAsks, grantLapseNotices, grantCardsExpired, expiredGrants };
}

export default defineSchedule({
  cron: "0 4 * * *",
  async run() {
    await tidyTick();
  },
});
