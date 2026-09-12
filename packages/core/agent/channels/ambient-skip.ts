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
    return `domain "${domain}" routes "${surfaceKey}" and is ADDRESSED-ONLY by declaration — the standing seat wakes on a mention or a name-drop, and ambient talk stays unjudged. That is a decision, not a gap. Its owner MAY opt in to judged ambient talk with ambientSupervisor: true (agent/memory/config/domains/<name>.ts); leave it as it is to keep the room addressed-only`;
  }
  if (via?.startsWith("excluded:")) {
    const [, excludingDomain, ...rest] = via.split(":");
    return `"${surfaceKey}" IS inside domain "${excludingDomain}"'s reach, but its exclude entry "${rest.join(":")}" carves it back out (exclude always wins) — drop or narrow that exclusion, or name the surface in another domain's reach (agent/memory/config/domains/<name>.ts)`;
  }
  return `no domain routes "${surfaceKey}" — add it to a domain's reach: the exact key "${surfaceKey}", the whole tenant "${tenant}", or a same-level glob like "${tenant}/<prefix>*" (agent/memory/config/domains/<name>.ts)`;
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
        dedupe: "process",
      },
    });
  } catch {
  }
  return skip.reason;
}
