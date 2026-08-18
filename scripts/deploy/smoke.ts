import { resolveWebhook } from "../../packages/core/scripts/e2e/env.js";
import { renderSmokeReport, runGithubInstallationSmoke, runWebhookSmoke } from "./smoke-lib.js";
import { DeployConfigError, parseArgs } from "./lib.js";

const args = parseArgs(process.argv.slice(2));
const log = (line: string): void => console.log(`  ${line}`);

function resolveTarget(): string {
  const explicit = args.values.get("target")?.trim();
  const alias = process.env.OE_DEPLOY_ALIAS?.trim();
  const url = explicit || process.env.E2E_TARGET_URL?.trim() || process.env.OE_DEPLOY_BASE_URL?.trim() || (alias ? `https://${alias}` : "");
  if (!url) {
    throw new DeployConfigError(
      "no deployment to probe — pass --target https://<host>, or set E2E_TARGET_URL (or OE_DEPLOY_BASE_URL / OE_DEPLOY_ALIAS).",
    );
  }
  return url.replace(/\/+$/, "");
}

function num(name: string, fallback: number): number {
  const raw = args.values.get(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new DeployConfigError(`--${name} must be a positive number (got ${JSON.stringify(raw)})`);
  return parsed;
}

try {
  const target = resolveTarget();
  const webhook = resolveWebhook({ ...process.env, E2E_TARGET_URL: target });
  if (!webhook.ok) {
    throw new DeployConfigError(
      `the webhook fixture is not configured — missing ${webhook.missing.join(", ")}.\n` +
        "  The secret must match what the deployment resolves from the hook's secretRef (OE_WEBHOOK_E2E_SECRET for the shipped e2e-smoke hook).",
    );
  }
  const controlToken = (process.env.OE_DEPLOY_CONTROL_TOKEN?.trim() || process.env.E2E_CONTROL_READ_TOKEN?.trim()) ?? "";
  if (!controlToken) {
    throw new DeployConfigError(
      "no control-plane read token — set OE_DEPLOY_CONTROL_TOKEN (or E2E_CONTROL_READ_TOKEN).\n" +
        "  Its sha256 must be listed in the deployment's OE_CONTROL_READ_TOKENS. The smoke reads its\n" +
        "  evidence back over GET /control/v1/audit, so without this it cannot assert anything at all.",
    );
  }

  console.log(`  deterministic smoke against ${target} (hook "${webhook.cfg.hookId}") — no judge involved`);
  const result = await runWebhookSmoke({
    webhook: webhook.cfg,
    controlToken,
    fetchImpl: (url, init) => fetch(url, init.method === "GET" ? { method: "GET", headers: init.headers } : init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    firedTimeoutMs: num("fired-timeout-ms", 60_000),
    replyTimeoutMs: num("reply-timeout-ms", 240_000),
    unsignedGraceMs: num("unsigned-grace-ms", 15_000),
  });

  for (const line of renderSmokeReport(result)) console.log(line);
  let ok = result.ok;

  const githubSecret = process.env.E2E_GITHUB_WEBHOOK_SECRET?.trim() || process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (githubSecret) {
    console.log(`\n  github installation rung against ${target} — no judge involved`);
    const githubResult = await runGithubInstallationSmoke({
      targetUrl: target,
      webhookSecret: githubSecret,
      controlToken,
      fetchImpl: (url, init) => fetch(url, init.method === "GET" ? { method: "GET", headers: init.headers } : init),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
      firedTimeoutMs: num("fired-timeout-ms", 60_000),
      unsignedGraceMs: num("unsigned-grace-ms", 15_000),
    });
    for (const line of renderSmokeReport(githubResult)) console.log(line);
    ok = ok && githubResult.ok;
  } else {
    console.log("\n  skipping the github installation rung — no E2E_GITHUB_WEBHOOK_SECRET/GITHUB_WEBHOOK_SECRET configured for this runner");
  }

  process.exit(ok ? 0 : 1);
} catch (err) {
  if (err instanceof DeployConfigError) {
    console.error(`✗ deploy:smoke: ${err.message}`);
    process.exit(2);
  }
  console.error(`✗ deploy:smoke: could not complete — ${String(err instanceof Error ? err.message : err)}`);
  process.exit(2);
}
