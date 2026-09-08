import type { Domain } from "@open-everywhere/core/agent/memory/domain.js";

import * as org from "./org.js";
import * as dm from "./dm.js";
import * as e2eB from "./e2e-b.js";
import * as e2eUnified from "./e2e-unified.js";
import * as e2eEngaged from "./e2e-engaged.js";
import * as soak from "./soak.js";
import * as e2eLinearSignedDelivery from "./e2e-linear-signed-delivery.js";
import * as e2eMemory from "./e2e-memory.js";
import * as e2eConnector from "./e2e-connector.js";
import * as e2eCap from "./e2e-cap.js";
import * as itMemory from "./it-memory.js";
import * as itMemoryB from "./it-memory-b.js";
import * as itNotionWithhold from "./it-notion-withhold.js";
import * as itWorkReadFixtureDiscord from "./it-work-read-fixture-discord.js";
import * as itWorkReadFixtureTeams from "./it-work-read-fixture-teams.js";
import * as itWorkReadFixtureNotion from "./it-work-read-fixture-notion.js";

export interface DomainModule {
  readonly domain: Domain;
  readonly enabled?: () => boolean;
}

const MODULES: readonly DomainModule[] = [
  org,
  dm,
  e2eB,
  e2eUnified,
  e2eEngaged,
  soak,
  e2eLinearSignedDelivery,
  e2eMemory,
  e2eConnector,
  e2eCap,
  itMemory,
  itMemoryB,
  itNotionWithhold,
  itWorkReadFixtureDiscord,
  itWorkReadFixtureTeams,
  itWorkReadFixtureNotion,
];

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
