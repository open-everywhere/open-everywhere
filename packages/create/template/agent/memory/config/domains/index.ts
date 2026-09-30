import type { Domain } from "@open-everywhere/core/agent/memory/domain.js";

import * as org from "./org.js";
import * as dm from "./dm.js";

export interface DomainModule {
  readonly domain: Domain;
  readonly enabled?: () => boolean;
}

const MODULES: readonly DomainModule[] = [org, dm];

export function loadDomainModules(): Domain[] {
  return assembleDomains(MODULES);
}

export function assembleDomains(modules: readonly DomainModule[]): Domain[] {
  const out: Domain[] = [];
  const seen = new Map<string, number>();
  for (const [index, m] of modules.entries()) {
    if (m.enabled !== undefined && !m.enabled()) continue;
    const previous = seen.get(m.domain.name);
    if (previous !== undefined) {
      throw new Error(
        `open-everywhere: two domain modules declare the name "${m.domain.name}" (entries ${previous} and ${index} of memory/config/domains/index.ts) — ` +
          "a domain name keys the store's domain rows and the session registry, so one name is one domain. Rename one, or delete the duplicate file.",
      );
    }
    seen.set(m.domain.name, index);
    out.push(m.domain);
  }
  return out;
}
