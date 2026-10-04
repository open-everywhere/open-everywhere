import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..");
const target = path.join(here, "sandbox-live-test.ts");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const SPAWN_CEILING_MS = 90_000;

function runGuard(overrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VERCEL_OIDC_TOKEN;
  delete env.VERCEL_TOKEN;
  delete env.OE_VERCEL_API_TOKEN;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const [cmd, args] =
    process.platform === "win32"
      ? [process.execPath, [path.join(pkgRoot, "..", "..", "node_modules", "tsx", "dist", "cli.mjs"), target]]
      : ["npx", ["tsx", target]];
  return spawnSync(cmd, args, {
    cwd: pkgRoot,
    env,
    timeout: SPAWN_CEILING_MS,
    encoding: "utf8",
  });
}

function assertRefusedFast(r: ReturnType<typeof runGuard>, label: string) {
  ok(
    r.signal === null,
    `${label} → the child exited on its own; it was KILLED at the ${SPAWN_CEILING_MS} ms ceiling (signal ${r.signal}), which means the guard did not refuse`,
  );
  ok(r.status === 2, `${label} → exit 2 (got ${r.status}, signal ${r.signal})`);
  ok(r.stderr.includes("SKIPPED"), `${label} → SKIPPED message on stderr`);
}

assertRefusedFast(runGuard({}), "no credentials");

assertRefusedFast(runGuard({ VERCEL_TOKEN: "fake-bare-api-token-not-oidc" }), "VERCEL_TOKEN alone");

assertRefusedFast(runGuard({ OE_VERCEL_API_TOKEN: "fake-bare-api-token-not-oidc" }), "OE_VERCEL_API_TOKEN alone");

console.log(`\n✓ sandbox-live-guard: ${n} assertions passed\n`);
