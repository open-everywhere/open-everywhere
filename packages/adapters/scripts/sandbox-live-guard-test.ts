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

function runGuard(overrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VERCEL_OIDC_TOKEN;
  delete env.VERCEL_TOKEN;
  delete env.OE_VERCEL_API_TOKEN;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return spawnSync("npx", ["tsx", target], {
    cwd: pkgRoot,
    env,
    timeout: 8_000,
    encoding: "utf8",
  });
}

{
  const r = runGuard({});
  ok(r.status === 2, `no credentials → exit 2 (got ${r.status}, signal ${r.signal})`);
  ok(r.stderr.includes("SKIPPED"), "no credentials → SKIPPED message on stderr");
}

{
  const r = runGuard({ VERCEL_TOKEN: "fake-bare-api-token-not-oidc" });
  ok(r.status === 2, `VERCEL_TOKEN alone → exit 2, the SDK never reads it implicitly (got ${r.status}, signal ${r.signal})`);
  ok(r.stderr.includes("SKIPPED"), "VERCEL_TOKEN alone → SKIPPED message on stderr");
}

{
  const r = runGuard({ OE_VERCEL_API_TOKEN: "fake-bare-api-token-not-oidc" });
  ok(r.status === 2, `OE_VERCEL_API_TOKEN alone → exit 2, the SDK never reads it implicitly (got ${r.status}, signal ${r.signal})`);
  ok(r.stderr.includes("SKIPPED"), "OE_VERCEL_API_TOKEN alone → SKIPPED message on stderr");
}

console.log(`\n✓ sandbox-live-guard: ${n} assertions passed\n`);
