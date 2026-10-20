import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

const INJECT_TOKEN = `it-adopt-${randomBytes(16).toString("hex")}`;
process.env.OE_CONTROL_INJECT_TOKENS = `it-adopt:${createHash("sha256").update(INJECT_TOKEN, "utf8").digest("hex")}`;
const SENTINEL = `it-adopt-SENTINEL-${randomBytes(8).toString("hex")}-DO-NOT-LEAK`;
const ADOPT = "OE_LOG_SHIP_TOKEN";
const UNSET = "OE_TELEMETRY_OTLP_HEADERS";
process.env[ADOPT] = SENTINEL;
delete process.env[UNSET];

import { expect, test } from "vitest";
import { buildAuditQuery } from "../../packages/core/scripts/e2e/audit-read";
import { bootAgent, controlGet } from "./harness";

const REPO = join(import.meta.dirname, "..", "..");
const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const OE_CLI = join(REPO, "packages", "core", "scripts", "oe-cli.ts");

function oe(args: readonly string[], stdin: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [TSX_CLI, OE_CLI, ...args], { cwd: REPO, timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1;
      resolve({ code, out: `${stdout}${stderr}` });
    });
    child.stdin?.end(stdin);
  });
}

test("an operator adopts a stranded env secret through the deployed REST door, with no OAuth plane", async () => {
  const { base } = await bootAgent();
  const since = new Date(Date.now() - 60_000).toISOString();
  const url = `${base}/control/v1/secrets/adopt`;
  const post = (body: unknown, token: string | null) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

  expect((await fetch(`${base}/control/v1/mcp`, { method: "POST", signal: AbortSignal.timeout(60_000) })).status).toBe(404);

  expect((await post({ names: [ADOPT] }, null)).status).toBe(401);
  expect((await post({ names: [ADOPT] }, "not-a-token")).status).toBe(401);

  const root = await post({ names: ["DATABASE_URL"] }, INJECT_TOKEN);
  expect(root.status).toBe(400);
  expect(await root.text()).toContain("root-of-trust");

  const first = await oe(["secret", "adopt", ADOPT, UNSET, "--url", base], `${INJECT_TOKEN}\n`);
  expect(first.code, first.out).toBe(0);
  expect(first.out).toContain(`${ADOPT}: stored`);
  expect(first.out).toContain(`${UNSET}: no-env-value`);
  expect(first.out, "🔴 the command prints no value").not.toContain(SENTINEL);
  expect(first.out, "🔴 the command prints no token").not.toContain(INJECT_TOKEN);

  const again = await post({ names: [ADOPT] }, INJECT_TOKEN);
  const againText = await again.text();
  expect(again.status).toBe(200);
  expect(JSON.parse(againText).results).toEqual([{ name: ADOPT, outcome: "already-stored" }]);
  expect(againText, "🔴 the reply carries no value").not.toContain(SENTINEL);

  const audit = await controlGet(`/control/v1/audit?${buildAuditQuery({ sinceIso: since, actions: ["admin.secret.adopt_env"], limit: 10 })}`);
  expect(audit.status).toBe(200);
  expect(audit.body).toContain(`"${ADOPT}":"stored"`);
  expect(audit.body).toContain(`"${ADOPT}":"already-stored"`);
  expect(audit.body).toContain("svc:it-adopt");
  expect(audit.body, "🔴 the audit row carries no value").not.toContain(SENTINEL);
}, 300_000);
