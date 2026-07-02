import { defineSchedule } from "eve/schedules";
import { getConfig } from "../access/config.js";
import { providerById } from "../memory/provider.js";
import { siloTier, tierId, type Tier } from "../memory/store.js";
import type { Partition } from "../memory/partition.js";
import { tidySilo } from "../memory/dream/tidy.js";
import { recordMemoryOpProposals, DREAM_ACTOR } from "../memory/dream/proposal.js";
import { appendAudit } from "../audit/audit.js";

function log(msg: string): void {
  console.log(`[open-everywhere:dream/tidy] ${msg}`);
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
}

export async function tidyTick(opts: { readonly now?: Date; readonly orgs?: readonly string[] } = {}): Promise<TidyTickReport> {
  const now = opts.now ?? new Date();
  const orgs = opts.orgs ?? tidyOrgs();
  let silos: readonly { name: string; provider: string; readOnly?: boolean }[];
  try {
    silos = getConfig().loadSilos();
  } catch (err) {
    log(`tick skipped — config not registered: ${String(err)}`);
    return { orgs: 0, silos: 0, applied: 0, proposed: 0, changed: 0 };
  }

  let siloCount = 0;
  let applied = 0;
  let proposed = 0;
  let changed = 0;

  for (const org of orgs) {
    const p = partitionForOrg(org);
    for (const silo of silos) {
      if (silo.readOnly) continue;
      const tier: Tier = siloTier(silo.name);
      let files;
      try {
        files = await providerById(silo.provider).readTier(p, tier, silo);
      } catch (err) {
        log(`skip ${org}/${silo.name} (${silo.provider}) — read failed: ${String(err)}`);
        continue;
      }
      if (Object.keys(files).length === 0) continue;
      siloCount++;

      const result = tidySilo(files, { now });

      if (result.changed) {
        try {
          const sha = await providerById(silo.provider).writeTier(
            p,
            tier,
            result.files,
            `dream:tidy [${tierId(tier)}] ${result.applied.length} safe op(s)`,
            silo,
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
  }

  log(`tick: ${orgs.length} org(s), ${siloCount} silo(s) — ${applied} safe op(s) applied, ${changed} silo(s) written, ${proposed} proposal(s) recorded`);
  return { orgs: orgs.length, silos: siloCount, applied, proposed, changed };
}

export default defineSchedule({
  cron: "0 4 * * *",
  async run() {
    await tidyTick();
  },
});
