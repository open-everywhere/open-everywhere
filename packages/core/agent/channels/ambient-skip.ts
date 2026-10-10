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

function fixFor(reason: AmbientSkip, surfaceKey: string, domain: string | undefined, declaredBy: string | undefined, via: DomainVia | undefined, loadFailed: boolean): string {
  if (reason === "domain-refused") {
    const decider = declaredBy ?? domain;
    const inherits = domain !== undefined && domain !== decider ? `, and domain "${domain}", which routes it, inherits that` : "";
    return `"${surfaceKey}" is ADDRESSED-ONLY by declaration: domain "${decider}" sets ambientSupervisor: false${inherits}. The standing seat wakes on a mention or a name-drop, and ambient talk stays unjudged. That is a decision, not a gap. The owner MAY turn ambient talk on: delete that line, or set ambientSupervisor: true on domain "${domain ?? decider}" (agent/memory/config/domains/<name>.ts). Leave it as it is to keep the room addressed-only`;
  }
  if (loadFailed) {
    return `the domain set did not load, so the ambient gate failed closed for "${surfaceKey}" — fix the config error the boot log names (agent/memory/config/domains/)`;
  }
  const tenant = surfaceKey.split("/").slice(0, 2).join("/");
  if (via?.startsWith("excluded:")) {
    const [, excludingDomain, ...rest] = via.split(":");
    return `"${surfaceKey}" IS inside domain "${excludingDomain}"'s reach, but its exclude entry "${rest.join(":")}" carves it back out (exclude always wins), and the deployment declares no "org" domain for it to fall to — drop or narrow that exclusion, name the surface in another domain's reach, or add an "org" domain (agent/memory/config/domains/<name>.ts)`;
  }
  return `no domain routes "${surfaceKey}" and the deployment declares no "org" domain to inherit from — add an "org" domain (agent/memory/config/domains/org.ts), which turns the default on for every unrouted surface, or add this one to a domain's reach: the exact key "${surfaceKey}", the whole tenant "${tenant}", or a same-level glob like "${tenant}/<prefix>*" (agent/memory/config/domains/<name>.ts)`;
}

export async function auditAmbientSkip(p: AmbientSkipRecord): Promise<AmbientSkip | undefined> {
  let skip: ReturnType<typeof ambientSkipFor>;
  let loadFailed = false;
  try {
    const domains = p.domains ?? getConfig().loadDomains();
    skip = ambientSkipFor(p.surfaceKey, domains);
  } catch {
    skip = { reason: "no-domain", via: "none" };
    loadFailed = true;
  }
  if (!skip) return undefined;

  p.log?.(`ambient skipped on ${p.surfaceKey}: ${skip.reason} (via ${skip.via}) — ${fixFor(skip.reason, p.surfaceKey, skip.domain, skip.declaredBy, skip.via, loadFailed)}`);

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
        ...(skip.declaredBy && skip.declaredBy !== skip.domain ? { declaredBy: skip.declaredBy } : {}),
        fix: fixFor(skip.reason, p.surfaceKey, skip.domain, skip.declaredBy, skip.via, loadFailed),
        firstSighting: true,
        dedupe: "process",
        ...(loadFailed ? { loadFailed: true } : {}),
      },
    });
  } catch {
  }
  return skip.reason;
}
