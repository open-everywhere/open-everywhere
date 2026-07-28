import { resolveDomainForChannel, type Domain } from "../memory/domain.js";
import { describeReadableBy, scopeGrantsRead, type ReadableBy } from "../access/read-grant.js";

export interface TriggerReach {
  readonly impossible: readonly string[];
  readonly unreachable: readonly string[];
  readonly undecidable?: string;
}

const DECIDED_CLEAN: TriggerReach = { impossible: [], unreachable: [] };

function inert(why: string): TriggerReach {
  return { impossible: [], unreachable: [], undecidable: why };
}

function tenantKeyOf(surfaceKey: string): string {
  return surfaceKey.split("/").slice(0, 2).join("/");
}

export function readGrantReach(surfaceKey: string, readableBy: ReadableBy | undefined, domains: readonly Domain[] | undefined): TriggerReach {
  if (!domains) return inert("no domain registry was supplied, so which domain this surface belongs to is unknown");
  if (!readableBy || readableBy.length === 0) {
    return inert("this ingress declares no read grant of its own, so authorization is decided per-delivery by its source's scope-grant adapter");
  }
  const routing = resolveDomainForChannel(surfaceKey, domains);
  if (!routing.domain) {
    return {
      impossible: [],
      unreachable: [
        `${surfaceKey} belongs to no memory domain, so no routine armed there can ever read this ingress's events ` +
          `(the grant is ${describeReadableBy(readableBy)}). Add the channel to a domain in the app's memory/domains.ts, or point this at a channel that is already in one.`,
      ],
    };
  }
  const granted = scopeGrantsRead(readableBy, {
    tenantKey: tenantKeyOf(surfaceKey),
    surfaceKey,
    domains: [routing.domain.name],
  });
  if (granted) return DECIDED_CLEAN;
  return {
    impossible: [],
    unreachable: [
      `${surfaceKey} is in domain "${routing.domain.name}", which the read grant does not name — it grants ${describeReadableBy(readableBy)}. ` +
        `A routine armed in that channel would be accepted and would then never fire.`,
    ],
  };
}

export function grantDomainsExist(readableBy: ReadableBy | undefined, domains: readonly Domain[] | undefined): TriggerReach {
  if (!domains) return inert("no domain registry was supplied");
  if (!readableBy || readableBy.length === 0) return DECIDED_CLEAN;
  const named = readableBy.flatMap((s) => (s.level === "domain" && s.domain ? [s.domain] : []));
  if (named.length === 0) return DECIDED_CLEAN;
  const declared = new Set(domains.map((d) => d.name));
  const unknown = named.filter((d) => !declared.has(d));
  if (unknown.length === 0) return DECIDED_CLEAN;
  const list = unknown.map((d) => `"${d}"`).join(", ");
  if (declared.size === 0) {
    return {
      impossible: [],
      unreachable: [
        `the read grant names ${list}, and this deployment declares no memory domains at all — so nothing can read this ingress's events yet. ` +
          `Declare the domain(s) in the app's memory/domains.ts; until then the grant matches nothing.`,
      ],
    };
  }
  return {
    impossible: [
      `the read grant names ${list}, which ${unknown.length > 1 ? "are not memory domains" : "is not a memory domain"} this deployment declares — ` +
        `a grant naming one refuses every routine, forever, in silence. Declared domains: ${[...declared].sort().join(", ")}.`,
    ],
    unreachable: [],
  };
}

export function mergeReach(...parts: readonly TriggerReach[]): TriggerReach {
  const decided = parts.filter((p) => p.undecidable === undefined);
  if (decided.length === 0) {
    return inert(parts.map((p) => p.undecidable).filter(Boolean).join("; ") || "nothing was checkable");
  }
  return {
    impossible: decided.flatMap((p) => p.impossible),
    unreachable: decided.flatMap((p) => p.unreachable),
  };
}

export function webhookReach(
  hook: { readonly id: string; readonly target: string; readonly readableBy: ReadableBy },
  domains: readonly Domain[] | undefined,
): TriggerReach {
  return mergeReach(grantDomainsExist(hook.readableBy, domains), readGrantReach(hook.target, hook.readableBy, domains));
}
