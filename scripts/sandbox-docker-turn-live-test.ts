import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { builtTreeArtifactsSource } from "../tests/integration/prewarm.js";

const ROOT = process.cwd();
const RELAY_SECRET = randomBytes(32).toString("hex");

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function dockerReachable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
if (!dockerReachable()) {
  console.error("sandbox-docker-turn-live-test: SKIPPED — no reachable docker daemon (`docker info` failed).");
  process.exit(2);
}

const createdContainers = new Set<string>();
function dockerPsLabel(sessionId: string): { name: string; status: string }[] {
  const raw = execFileSync("docker", ["ps", "-a", "--no-trunc", "--filter", `label=eve.sandbox.tag.sessionId=${sessionId}`, "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  const names = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return names.map((name) => {
    createdContainers.add(name);
    const state = execFileSync("docker", ["inspect", "--format", "{{.State.Status}}", name], { encoding: "utf8" }).trim();
    return { name, status: state };
  });
}
function cleanupContainers(): void {
  for (const name of createdContainers) {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      console.log(`  cleanup: removed ${name}`);
    } catch {
    }
  }
}

async function main(): Promise<void> {
  const entry = join(ROOT, ".output", "server", "index.mjs");
  if (!existsSync(entry)) {
    console.log("-- .output/server/index.mjs missing, building --");
    execFileSync("npm", ["run", "oe:build"], { cwd: ROOT, stdio: "inherit" });
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
  }

  for (const k of ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_KEY", "DATABASE_URL", "VERCEL"]) {
    delete process.env[k];
  }
  if (process.env.NODE_ENV === "test") {
    throw new Error("sandbox-docker-turn-live-test: NODE_ENV=test would make eve substitute its own fixture mock. Unset it.");
  }
  delete process.env.EVE_MOCK_AUTHORED_MODELS;
  delete process.env.OE_SANDBOX_BACKEND;

  const state = mkdtempSync(join(tmpdir(), "oe-docker-live-"));
  process.env.OE_SCRIPTED_MODEL = "1";
  process.env.OE_EGRESS_SPOOF = "1";
  process.env.OE_RELAY_SECRET = RELAY_SECRET;
  process.env.OE_CONTROL_READ_TOKENS = `dlt:${createHash("sha256").update("unused", "utf8").digest("hex")}`;
  process.env.OE_PGLITE_DIR = join(state, "pglite");
  process.env.OE_MEMORY_DIR = join(state, "memory");
  rmSync(join(ROOT, ".eve", ".workflow-data"), { recursive: true, force: true });

  let port = 3170;
  for (; port <= 3220; port++) if (await portFree(port)) break;
  process.env.PORT = String(port);
  process.env.NITRO_PORT = String(port);
  process.env.HOST = "127.0.0.1";
  process.env.NITRO_HOST = "127.0.0.1";

  console.log("-- prewarming the docker sandbox template (real daemon; reuses the shared image cache) --");
  const prewarmPath = join(ROOT, "node_modules", "eve", "dist", "src", "execution", "sandbox", "prewarm.js");
  let prewarmMod: {
    prewarmAppSandboxes?: (input: {
      readonly appRoot: string;
      readonly compiledArtifactsSource?: unknown;
      readonly log?: (m: string) => void;
    }) => Promise<void>;
  };
  try {
    prewarmMod = (await import(pathToFileURL(prewarmPath).href)) as typeof prewarmMod;
  } catch (err) {
    throw new Error(
      `sandbox-docker-turn-live-test: eve's sandbox prewarm module is gone from ${prewarmPath} — an eve bump moved it. ` +
        "Find the new home of prewarmAppSandboxes under eve/dist (same fix tests/integration/prewarm.ts needs).",
      { cause: err },
    );
  }
  if (typeof prewarmMod.prewarmAppSandboxes !== "function") {
    throw new Error(
      `sandbox-docker-turn-live-test: ${prewarmPath} no longer exports prewarmAppSandboxes — an eve bump renamed it. ` +
        "eve 0.69.0 removed prewarmBuiltAppSandboxes and made prewarmSandboxes module-private, leaving this one " +
        "export (OPE-2248); see tests/integration/prewarm.ts for the same fix.",
    );
  }
  await prewarmMod.prewarmAppSandboxes({
    appRoot: ROOT,
    compiledArtifactsSource: builtTreeArtifactsSource(ROOT),
    log: (m) => console.log(`  ${m}`),
  });

  console.log(`-- booting the built agent in-process on port ${port} (docker sandbox backend) --`);
  await import(pathToFileURL(entry).href);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(`${base}/eve/v1/health`, { signal: AbortSignal.timeout(2_000) });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("sandbox-docker-turn-live-test: the in-process agent never answered its health route.");
      await sleep(250);
    }
  }

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ egress: { allowUnenforced: true } });

  const { registerScript } = await import("../agent/model/scripted-model.js");
  const { buildDiscordGuildMentionRelayEnvelope, signDiscordRelayRequest } = await import("../packages/core/scripts/e2e/discord-synthetic.js");

  const GUILD_ID = "1300000000000000100";
  const USER_ID = "9000000000000000042";
  const BOT_ID = "9000000000000000001";
  const CHANNEL_A = "1900000000000000001";
  const CHANNEL_B = "1900000000000000002";

  async function wake(channelId: string, text: string): Promise<void> {
    const body = JSON.stringify(
      buildDiscordGuildMentionRelayEnvelope({ text, guildId: GUILD_ID, channelId, userId: USER_ID, botId: BOT_ID, botName: "open-everywhere", messageId: `dlt${Date.now()}` }),
    );
    const res = await fetch(`${base}/eve/v1/discord-gateway`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-oe-relay-signature": signDiscordRelayRequest(body, RELAY_SECRET) },
      body,
    });
    const ack = await res.text();
    if (res.status !== 200 || ack.trim() !== "ok") throw new Error(`relay wake refused — ${res.status}: ${ack.slice(0, 200)}`);
  }

  async function waitFor<T>(probe: () => T | undefined, label: string, timeoutMs = 90_000): Promise<T> {
    const dl = Date.now() + timeoutMs;
    for (;;) {
      const got = probe();
      if (got !== undefined) return got;
      if (Date.now() > dl) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
      await sleep(400);
    }
  }

  console.log("\n== scenario A: stopAfterTurn ON (default) — the container must stop ==");
  const handleA = registerScript({ parent: [{ calls: [{ tool: "bash", input: { command: "echo hello-from-oe-live-proof-a" }, id: "dlt-a1" }] }, { say: "done a" }] });
  await wake(CHANNEL_A, `<@${BOT_ID}> run a command`);
  await waitFor(() => handleA.requests.find((r) => r.stepIndex === 1), "scenario A's terminal step to be served");
  const bashResultA = handleA.requests.flatMap((r) => r.toolResults).find((t) => t.name === "bash");
  console.log(`  scenario A bash tool result (informational, not gated): ${JSON.stringify(bashResultA)}`);
  const sessionA = handleA.requests[0]?.sessionId;
  if (sessionA === undefined) throw new Error("scenario A: no sessionId recorded on the scripted request — cannot filter docker ps.");
  console.log(`  scenario A session id: ${sessionA}`);
  handleA.dispose();

  const beforeA = await waitFor(() => {
    const listing = dockerPsLabel(sessionA);
    const running = listing.filter((c) => c.status === "running");
    return running.length > 0 ? running : undefined;
  }, "scenario A's session container to appear RUNNING via `docker ps` (label=eve.sandbox.tag.sessionId)");
  console.log(`  BEFORE (as observed): ${JSON.stringify(beforeA)}`);
  const containerNameA = beforeA[0]?.name;
  if (containerNameA === undefined || containerNameA.length === 0) {
    throw new Error("scenario A: no container name captured from the running snapshot — cannot track the transition.");
  }

  const afterA = await waitFor(() => {
    const listing = dockerPsLabel(sessionA);
    const same = listing.find((c) => c.name === containerNameA);
    return same !== undefined && same.status !== "running" ? same : undefined;
  }, `scenario A's container ${containerNameA} to leave the running state after turn end`);
  console.log(`  AFTER (as observed): ${JSON.stringify(afterA)}`);
  ok(afterA.status === "exited", `scenario A: the docker turn-end stop hook transitioned container ${containerNameA} from running to exited (observed: ${afterA.status})`);

  console.log("\n== scenario B: stopAfterTurn OFF — negative control, the container must stay running ==");
  settings.overrideSettingsForTest({ sandbox: { stopAfterTurn: false } });
  ok(settings.getSettings().sandbox.stopAfterTurn === false, "scenario B: the override actually took (stopAfterTurn === false)");

  const handleB = registerScript({ parent: [{ calls: [{ tool: "bash", input: { command: "echo hello-from-oe-live-proof-b" }, id: "dlt-b1" }] }, { say: "done b" }] });
  await wake(CHANNEL_B, `<@${BOT_ID}> run a command too`);
  await waitFor(() => handleB.requests.find((r) => r.stepIndex === 1), "scenario B's terminal step to be served");
  const bashResultB = handleB.requests.flatMap((r) => r.toolResults).find((t) => t.name === "bash");
  console.log(`  scenario B bash tool result (informational, not gated): ${JSON.stringify(bashResultB)}`);
  const sessionB = handleB.requests[0]?.sessionId;
  if (sessionB === undefined) throw new Error("scenario B: no sessionId recorded on the scripted request.");
  console.log(`  scenario B session id: ${sessionB}`);
  handleB.dispose();

  const beforeB = await waitFor(() => {
    const listing = dockerPsLabel(sessionB);
    return listing.length > 0 ? listing : undefined;
  }, "scenario B's session container to appear via `docker ps`");
  console.log(`  BEFORE (as observed): ${JSON.stringify(beforeB)}`);

  await sleep(8_000);
  const afterB = dockerPsLabel(sessionB);
  console.log(`  AFTER 8s grace (as observed): ${JSON.stringify(afterB)}`);
  ok(afterB.length > 0 && afterB.every((c) => c.status === "running"), "scenario B (negative control): with stopAfterTurn=false the REAL container is STILL running — the hook is a no-op, not vacuously absent");

  settings.resetSettingsForTest();

  console.log(`\npassed=${passed} failed=${failures.length}`);
  if (failures.length > 0) {
    console.error(`\n✗ sandbox-docker-turn-live-test: ${failures.length} FAILED\n${failures.map((f) => `  ✗ ${f}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    console.log(`\n✓ sandbox-docker-turn-live-test: ${passed} assertions passed against a real docker daemon (live turn, real container, real stop, real negative control)\n`);
  }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

main()
  .catch((err) => {
    console.error(`sandbox-docker-turn-live-test: FATAL — ${String(err?.stack ?? err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanupContainers();
    process.exit(process.exitCode ?? 0);
  });
