import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { sweepStaleForkAppRoots } from "./fork-app-root";
import { GLOBAL_SETUP_PID_ENV, INTEGRATION_SANDBOX_BACKEND } from "./global-setup-contract";
import { sweepStaleSandboxSessions } from "./sandbox-session-sweep";
import { createStateDir, sweepAbandonedStateDirs } from "./state-dir";
import { sweepAbandonedFixtureDirs } from "./temp-dir-fixtures";

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
  const setupStartedAt = Date.now();
  const templateDir = join(root, ".eve", "sandbox-cache", "just-bash", "templates");
  if (process.env.OE_IT_SKIP_BUILD === "1") {
    if (!existsSync(join(root, ".output", "server", "index.mjs"))) {
      throw new Error("OE_IT_SKIP_BUILD=1 but .output/server/index.mjs does not exist — run the build first.");
    }
    if (!existsSync(templateDir)) {
      throw new Error(
        "OE_IT_SKIP_BUILD=1 but .eve/sandbox-cache/just-bash/templates does not exist — the just-bash " +
          "sandbox template was never prewarmed on this tree and every turn would die on " +
          "SandboxTemplateNotProvisionedError. Run `npm run test:integration` once without the flag.",
      );
    }
    return;
  }
  execFileSync("npm", ["run", "oe:build"], { cwd: root, stdio: "inherit" });
  const inheritedNodeOptions = process.env.NODE_OPTIONS ?? "";
  const eveBuildNodeOptions = inheritedNodeOptions.includes("--max-old-space-size")
    ? inheritedNodeOptions
    : [inheritedNodeOptions, "--max-old-space-size=6144"].filter(Boolean).join(" ");
  execFileSync("npx", ["eve", "build"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: eveBuildNodeOptions },
  });
  await prewarmJustBashTemplate(root);
  console.log(`integration global-setup: total ${((Date.now() - setupStartedAt) / 1000).toFixed(1)}s (oe:build + eve build + prewarm, all serial).`);
}

async function prewarmJustBashTemplate(root: string): Promise<void> {
  const state = createStateDir();
  const restoreStateEnv = pinStateEnvForPrewarm(state);
  delete process.env.NODE_ENV;

  const prewarmPath = join(root, "node_modules", "eve", "dist", "src", "execution", "sandbox", "prewarm.js");
  try {
    let mod: { prewarmBuiltAppSandboxes?: (input: { appRoot: string; log?: (m: string) => void }) => Promise<void> };
    try {
      mod = (await import(pathToFileURL(prewarmPath).href)) as typeof mod;
    } catch (err) {
      throw new Error(
        `integration global-setup: eve's sandbox prewarm module is gone from ${prewarmPath} — an eve bump moved it. ` +
          "Find the new home of prewarmBuiltAppSandboxes under eve/dist and update tests/integration/global-setup.ts " +
          "(and the eve-upgrade-check skill's checklist).",
        { cause: err },
      );
    }
    if (typeof mod.prewarmBuiltAppSandboxes !== "function") {
      throw new Error(
        `integration global-setup: ${prewarmPath} no longer exports prewarmBuiltAppSandboxes — an eve bump renamed it. ` +
          "Update tests/integration/global-setup.ts to the new export.",
      );
    }
    await mod.prewarmBuiltAppSandboxes({ appRoot: root, log: (m) => console.log(m) });
  } finally {
    restoreStateEnv();
  }
  if (!existsSync(join(root, ".eve", "sandbox-cache", "just-bash", "templates"))) {
    throw new Error(
      "integration global-setup: prewarm completed but .eve/sandbox-cache/just-bash/templates is still absent — " +
        "the backend selection did not land on just-bash. Check OE_SANDBOX_BACKEND handling above.",
    );
  }
}

export const PREWARM_STATE_ENV = ["OE_PGLITE_DIR", "OE_MEMORY_DIR"] as const;

function pinStateEnvForPrewarm(state: string): () => void {
  const before = PREWARM_STATE_ENV.map((k) => [k, process.env[k]] as const);
  process.env.OE_PGLITE_DIR ??= join(state, "pglite");
  process.env.OE_MEMORY_DIR ??= join(state, "memory");
  return () => {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
