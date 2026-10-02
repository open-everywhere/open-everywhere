import { existsSync } from "node:fs";
import { join } from "node:path";

import { sweepStaleForkAppRoots } from "./fork-app-root.js";
import { GLOBAL_SETUP_PID_ENV, INTEGRATION_SANDBOX_BACKEND, PGLITE_TEMPLATE_DIR_ENV, PREPARED_PGLITE_TEMPLATE_PARENT } from "./global-setup-contract.js";
import { PGLITE_TEMPLATE_DIR_NAME, mintPgliteTemplate } from "./pglite-template.js";
import { PREPARED_ARTIFACTS, missingPreparedArtifacts } from "./prepare-cache.js";
import { sweepStaleSandboxSessions } from "./sandbox-session-sweep.js";
import { createStateDir, sweepAbandonedStateDirs } from "./state-dir.js";
import { sweepAbandonedFixtureDirs } from "./temp-dir-fixtures.js";

export function unpreparedTreeRefusal(missing: readonly string[]): string {
  return (
    `integration global-setup: this tree is missing ${missing.join(", ")}, so no fork could boot on it. ` +
    `The integration tier builds its own target in a SEPARATE step since OPE-2235: run ` +
    "`npm run test:integration` (which runs that step for you), or `npm run test:integration:prepare` once before a bare " +
    `\`vitest run\`. Every one of ${PREPARED_ARTIFACTS.join(", ")} must exist.`
  );
}

export function preparedPgliteTemplate(root: string): string | undefined {
  const dir = join(root, PREPARED_PGLITE_TEMPLATE_PARENT, PGLITE_TEMPLATE_DIR_NAME);
  return existsSync(join(dir, "PG_VERSION")) ? dir : undefined;
}

export default async function globalSetup(): Promise<void> {
  const root = process.cwd();
  process.env[GLOBAL_SETUP_PID_ENV] = String(process.pid);
  process.env.OE_SANDBOX_BACKEND = INTEGRATION_SANDBOX_BACKEND;
  const swept = sweepStaleForkAppRoots();
  if (swept > 0) console.log(`integration global-setup: removed ${swept} abandoned fork app root(s).`);
  const sweptState = sweepAbandonedStateDirs();
  if (sweptState > 0) console.log(`integration global-setup: removed ${sweptState} abandoned state dir(s).`);
  const sweptFixtures = sweepAbandonedFixtureDirs();
  if (sweptFixtures > 0) console.log(`integration global-setup: removed ${sweptFixtures} abandoned fixture dir(s).`);
  const sweptSessions = sweepStaleSandboxSessions(root);
  if (sweptSessions > 0) {
    console.log(`integration global-setup: removed ${sweptSessions} stale just-bash sandbox session(s).`);
  }

  const missing = missingPreparedArtifacts(root);
  if (missing.length > 0) throw new Error(unpreparedTreeRefusal(missing));

  const prepared = preparedPgliteTemplate(root);
  if (prepared !== undefined) {
    process.env[PGLITE_TEMPLATE_DIR_ENV] = prepared;
    console.log(`integration global-setup: reusing the PGlite template the prepare step minted (${prepared}).`);
    return;
  }
  const startedAt = Date.now();
  process.env[PGLITE_TEMPLATE_DIR_ENV] = await mintPgliteTemplate(createStateDir());
  console.log(
    `integration global-setup: no prepared template on this tree, so this process minted one in ` +
      `${((Date.now() - startedAt) / 1000).toFixed(1)}s — every PGlite-booting fork copies it.`,
  );
}
