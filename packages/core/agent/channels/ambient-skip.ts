import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { deploymentOrg } from "../identity/binding.js";
import { ambientSkipFor, type AmbientSkip, type Domain } from "../memory/domain.js";

const seen = new Set<string>();

export function resetAmbientSkipSightings(): void {
  seen.clear();
}

export interface AmbientSkipRecord {
  readonly platform: string;
  readonly workspace: string;
  readonly surfaceKey: string;
  readonly log?: (msg: string) => void;
  readonly domains?: readonly Domain[];
}

function fixFor(reason: AmbientSkip, surfaceKey: string, domain: string | undefined): string {
  const tenant = surfaceKey.split("/").slice(0, 2).join("/");
  return reason === "no-domain"
    ? `no domain routes "${surfaceKey}" — add it to a domain's channels, or claim its tenant with containers: ["${tenant}"] (agent/memory/domains.ts)`
    : `domain "${domain}" routes "${surfaceKey}" but has not opted in — set ambientSupervisor: true on it (agent/memory/domains.ts)`;
}

export async function auditAmbientSkip(p: AmbientSkipRecord): Promise<AmbientSkip | undefined> {
  let skip: ReturnType<typeof ambientSkipFor>;
  try {
    const domains = p.domains ?? getConfig().loadDomains();
    skip = ambientSkipFor(p.surfaceKey, domains);
  } catch {
    skip = { reason: "no-domain", via: "none" };
  }
  if (!skip) return undefined;

  p.log?.(`ambient skipped on ${p.surfaceKey}: ${skip.reason} (via ${skip.via}) — ${fixFor(skip.reason, p.surfaceKey, skip.domain)}`);

  const key = `${p.surfaceKey}|${skip.reason}`;
  if (seen.has(key)) return skip.reason;
  seen.add(key);
  try {
    await appendAudit({
      org: deploymentOrg(),
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surfaceKey,
      action: `${p.platform}.ambient_skipped`,
      detail: {
        reason: skip.reason,
        via: skip.via,
        ...(skip.domain ? { domain: skip.domain } : {}),
        fix: fixFor(skip.reason, p.surfaceKey, skip.domain),
        firstSighting: true,
      },
    });
  } catch {
  }
  return skip.reason;
}
