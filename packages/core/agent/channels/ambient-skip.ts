import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { deploymentOrg } from "../identity/binding.js";
import { ambientSkipFor, type AmbientSkip, type Domain, type DomainVia } from "../memory/domain.js";

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

function fixFor(reason: AmbientSkip, surfaceKey: string, domain: string | undefined, via?: DomainVia): string {
  const tenant = surfaceKey.split("/").slice(0, 2).join("/");
  if (reason === "domain-refused") {
    return `domain "${domain}" routes "${surfaceKey}" but has not opted in — set ambientSupervisor: true on it (agent/memory/config/domains.ts)`;
  }
  if (via?.startsWith("excluded:")) {
    const [, excludingDomain, ...rest] = via.split(":");
    return `"${surfaceKey}" IS inside domain "${excludingDomain}"'s containers claim, but its excludeContainers entry "${rest.join(":")}" carves it back out (exclude always wins) — drop or narrow that exclusion, or add the surface to a domain's channels (agent/memory/config/domains.ts)`;
  }
  return `no domain routes "${surfaceKey}" — add it to a domain's channels, or claim it with containers: ["${tenant}"] (the whole tenant) or a same-level glob like containers: ["${tenant}/<prefix>*"] (agent/memory/config/domains.ts)`;
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

  p.log?.(`ambient skipped on ${p.surfaceKey}: ${skip.reason} (via ${skip.via}) — ${fixFor(skip.reason, p.surfaceKey, skip.domain, skip.via)}`);

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
        fix: fixFor(skip.reason, p.surfaceKey, skip.domain, skip.via),
        firstSighting: true,
      },
    });
  } catch {
  }
  return skip.reason;
}
