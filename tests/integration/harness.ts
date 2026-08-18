import { createHash, createHmac, generateKeyPairSync, randomBytes, sign as signEd25519 } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach } from "vitest";

import { reserveEphemeralPort } from "../../scripts/ephemeral-port.js";
import { REDELIVERY_SIGNATURE, REDELIVERY_STORM_THRESHOLD, RedeliveryStormGuard } from "./redelivery-storm-guard";
import { ROLLOWN_OUTPUT_DIR, rollOwnMissingMessage, rollOwnTargetExists } from "./rollown-target";

import {
  ANY_SESSION,
  beginScriptedEpoch,
  registerScript,
  scriptedStore,
  staleHoldExpiryNote,
  __resetStaleHoldExpiriesForTest,
  type RecordedRequest,
  type ScriptedHandle,
  type SeatScript,
} from "../../agent/model/scripted-model";
export { registerScript, type RecordedRequest, type ResolveObservation, type ScriptedHandle, type ScriptedStep, type SeatScript, type ToolDefinitionRecord } from "../../agent/model/scripted-model";

const oePerTestCleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of oePerTestCleanups.splice(0)) cleanup();
  beginScriptedEpoch();
  __resetStaleHoldExpiriesForTest();
});
export function afterThisTest(cleanup: () => void): void {
  oePerTestCleanups.push(cleanup);
}
export function disposeLater<T extends { dispose(): void }>(handle: T): T {
  afterThisTest(() => handle.dispose());
  return handle;
}

export { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "@open-everywhere/core/agent/adapter-api.js";
export { REPLAYED_DELIVERY_CALLER_BODY } from "@open-everywhere/core/agent/webhooks/replay-dedupe.js";
export { PENDING_WORK_FRAME } from "@open-everywhere/core/agent/channels/turn-delivery.js";
import { PENDING_WORK_FRAME as OE_PENDING_WORK_FRAME, withPendingWorkFrame } from "@open-everywhere/core/agent/channels/turn-delivery.js";

export function pendingFramedChars(text: string): number {
  return withPendingWorkFrame(text, true).length;
}

if (OE_PENDING_WORK_FRAME.length === 0) throw new Error("harness: PENDING_WORK_FRAME is empty — pendingFramedChars cannot distinguish a framed row");
export { installSlackWebApiStub, type SlackApiCall, type SlackApiResponder, type SlackWebApiStub } from "./slack-web-api";
export { installNotionApiStub, type NotionApiCall, type NotionApiResponder, type NotionApiStub } from "./notion-web-api";

const ROOT = process.cwd();

const redeliveryGuard = new RedeliveryStormGuard();
let redeliveryWatchInstalled = false;
function installRedeliveryStormWatch(): void {
  if (redeliveryWatchInstalled) return;
  redeliveryWatchInstalled = true;
  for (const stream of [process.stdout, process.stderr] as const) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      if (text.length > 0) redeliveryGuard.observe(text);
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
  }
}
installRedeliveryStormWatch();

export function __resetRedeliveryStormGuardForTest(): void {
  redeliveryGuard.reset();
}

export function redeliveryRecoveryNote(): string {
  const seen = redeliveryGuard.observed();
  if (seen === 0) return "";
  return (
    ` — NOTE: ${seen} inline-step recovery log line(s) were seen in this fork (eve's "${REDELIVERY_SIGNATURE}",` +
    ` the OPE-465 class), below the storm threshold of ${REDELIVERY_STORM_THRESHOLD}. A single mid-body` +
    " crash-recovery re-runs that step's whole body. Check whether the line came from eve or from a test" +
    " fixture before treating it as the cause."
  );
}

const RELAY_SECRET = randomBytes(32).toString("hex");
const READ_TOKEN = randomBytes(32).toString("hex");
const READ_TOKEN_NAME = "it";
export const CONTROL_SERVICE_PRINCIPAL = `svc:${READ_TOKEN_NAME}`;
const WEBHOOK_E2E_SECRET = randomBytes(32).toString("hex");
const SLACK_SIGNING_SECRET = randomBytes(32).toString("hex");

const NOTION_WEBHOOK_SECRET = randomBytes(32).toString("hex");

const CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const DISCORD_APP_KEYS = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKeyHex: spki.subarray(spki.length - 32).toString("hex") };
})();

let booted: { base: string } | undefined;
let bootedWith: string | undefined;
let bootedOutputDir: string | undefined;

function bootedBuildDir(): string {
  if (bootedOutputDir === undefined) throw new Error("integration harness: the built tree was read before bootAgent.");
  return bootedOutputDir;
}

export interface BootOptions {
  readonly sharedSqlite?: boolean;
  readonly target?: "rollOwn";
  readonly selfBaseUrl?: boolean;
}

function guardProcess(): void {
  if (process.env.NODE_ENV === "test") {
    throw new Error(
      "integration harness: NODE_ENV=test would make eve strip the scripted model and substitute " +
        "its own fixture mock, silently. The vitest config clears it (test.env.NODE_ENV) — restore that.",
    );
  }
  if (process.env.EVE_MOCK_AUTHORED_MODELS === "1") {
    throw new Error("integration harness: EVE_MOCK_AUTHORED_MODELS=1 would defeat the scripted model. Unset it.");
  }
}

async function assertOwnHost(base: string): Promise<void> {
  const { buildAuditQuery } = await import("../../packages/core/scripts/e2e/audit-read");
  const url = `${base}/control/v1/audit?${buildAuditQuery({ sinceIso: new Date().toISOString(), actions: ["reply.post"], limit: 1 })}`;
  const deadline = Date.now() + 10_000;
  let refused = false;
  for (;;) {
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${READ_TOKEN}`, accept: "application/json" },
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
      if (res.status === 401 || res.status === 403) refused = true;
    } catch {
    }
    if (Date.now() > deadline) break;
    await sleep(250);
  }
  if (refused) {
    throw new Error(
      `integration harness: the agent answering ${base} REFUSED this fork's control read token, so it is a DIFFERENT ` +
        "agent host — almost certainly another worktree's integration run that bound the port between our free-port " +
        "probe and our own listen. Every signed wake would have gone to it. Re-run when the box is not running a " +
        "second integration suite (the tier is sized for ONE suite at a time).",
    );
  }
}

export async function bootAgent(opts: BootOptions = {}): Promise<{ base: string }> {
  const want = JSON.stringify(opts, Object.keys(opts).sort());
  if (booted !== undefined) {
    if (want !== bootedWith) {
      throw new Error(
        `integration harness: bootAgent() was already called in this fork with ${bootedWith || "{}"} and cannot re-boot with ${want || "{}"} — ` +
          "the env assembly and the entry import both happen once. Move the differently-booted test into its own file (vitest forks per file).",
      );
    }
    return booted;
  }
  bootedWith = want;
  guardProcess();

  for (const k of ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_KEY", "DATABASE_URL", "VERCEL"]) {
    delete process.env[k];
  }

  const state = mkdtempSync(join(tmpdir(), "oe-it-"));
  process.env.OE_SCRIPTED_MODEL = "1";
  process.env.OE_EGRESS_SPOOF = "1";
  process.env.OE_RELAY_SECRET = RELAY_SECRET;
  process.env.OE_CONTROL_READ_TOKENS = `${READ_TOKEN_NAME}:${createHash("sha256").update(READ_TOKEN, "utf8").digest("hex")}`;
  process.env.OE_WEBHOOK_E2E_SECRET = WEBHOOK_E2E_SECRET;
  process.env.SLACK_SIGNING_SECRET = SLACK_SIGNING_SECRET;
  process.env.NOTION_WEBHOOK_SECRET = NOTION_WEBHOOK_SECRET;
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY ??= CREDENTIAL_ENCRYPTION_KEY;
  if (process.env.DISCORD_PUBLIC_KEY === undefined) process.env.DISCORD_PUBLIC_KEY = DISCORD_APP_KEYS.publicKeyHex;
  if (opts.sharedSqlite === true) {
    process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
    process.env.OE_SQLITE_PATH = join(state, "ops.sqlite3");
    delete process.env.OE_PGLITE_DIR;
  } else {
    process.env.OE_PGLITE_DIR = join(state, "pglite");
  }
  process.env.OE_MEMORY_DIR = join(state, "memory");

  rmSync(join(ROOT, ".eve", ".workflow-data"), { recursive: true, force: true });
  process.env.OE_SANDBOX_BACKEND = "justbash";

  const reserved = await reserveEphemeralPort();
  process.env.PORT = String(reserved.port);
  process.env.NITRO_PORT = String(reserved.port);
  process.env.HOST = "127.0.0.1";
  process.env.NITRO_HOST = "127.0.0.1";
  if (opts.selfBaseUrl === true) process.env.OE_PUBLIC_BASE_URL = `http://127.0.0.1:${reserved.port}`;
  else delete process.env.OE_PUBLIC_BASE_URL;
  await reserved.release();

  if (opts.target === "rollOwn" && !rollOwnTargetExists(ROOT)) {
    throw new Error(`integration harness: ${rollOwnMissingMessage(ROOT)}`);
  }
  bootedOutputDir = join(ROOT, opts.target === "rollOwn" ? ROLLOWN_OUTPUT_DIR : ".output");
  await import(pathToFileURL(join(bootedOutputDir, "server", "index.mjs")).href);
  const base = `http://127.0.0.1:${reserved.port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(`${base}/eve/v1/health`, { signal: AbortSignal.timeout(2_000) });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("integration harness: the in-process agent never answered its health route.");
      await sleep(250);
    }
  }
  await assertOwnHost(base);

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ egress: { allowUnenforced: true } });
  if (opts.target === "rollOwn") settings.overrideSettingsForTest({ delegation: { nativeSubagent: false } });

  booted = { base };
  return booted;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, label: string, timeoutMs = 360_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await probe();
    if (got !== undefined) return got;
    const storm = redeliveryGuard.tripped();
    if (storm !== undefined) {
      throw new Error(
        `integration harness: a durable-queue REDELIVERY STORM (OPE-559) tripped while waiting for "${label}" — ` +
          `eve's local workflow world re-executed an inline step's body ${storm.count}+ times` +
          (storm.runId !== undefined ? ` (run ${storm.runId}${storm.stepIds !== undefined ? `, steps ${storm.stepIds}` : ""})` : "") +
          ". This is a HARNESS artifact under load, not a product failure. Do not bisect your diff — " +
          "check `ps -eo pid,rss,etime,cmd --sort=-rss` and `free -m` for a co-tenant, and re-run on a quiet box.",
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}${staleHoldExpiryNote()}${redeliveryRecoveryNote()}`);
    }
    await sleep(400);
  }
}

export async function waitForChildren(
  handle: ScriptedHandle,
  input: { readonly count: number; readonly lastStepIndex: number; readonly label: string },
): Promise<void> {
  await waitFor(() => {
    const done = new Set(
      handle.requests.filter((r) => r.role === "child" && r.stepIndex === input.lastStepIndex).map((r) => String(r.sessionId)),
    );
    return done.size >= input.count ? done.size : undefined;
  }, input.label);
}

export function taskIdOfDelegation(handle: ScriptedHandle, callLabel: string): string {
  const delegation = handle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "agent");
  const taskId = (delegation?.output as { taskId?: unknown } | undefined)?.taskId;
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new Error(
      `integration harness: no background-task receipt on the "agent" result for ${callLabel} — ` +
        `got ${JSON.stringify(delegation?.output)}. Either the delegation never happened, or this build ` +
        "has `delegation.backgroundTasks` OFF and the delegation returned the child's prose inline.",
    );
  }
  return taskId;
}

export function armSettlement(dispatched: ScriptedHandle, script: SeatScript): ScriptedHandle {
  const sessionId = dispatched.requests.find((r) => r.role === "parent")?.sessionId;
  if (sessionId === undefined) {
    throw new Error(
      "integration harness: armSettlement could not read the dispatch turn's own session id off its " +
        "parent request — wait for the dispatch turn's own terminal step before calling this.",
    );
  }
  if (scriptedStore().get(sessionId)?.requests === dispatched.requests) dispatched.dispose();
  const primary = registerScript(script, sessionId);
  return {
    requests: primary.requests,
    resolves: primary.resolves,
    dispose: () => {
      const store = scriptedStore();
      const mine = store.get(sessionId);
      if (mine !== undefined && store.get(ANY_SESSION) === mine) store.delete(ANY_SESSION);
      primary.dispose();
    },
  };
}

export async function consumeSettlement(input: {
  readonly armed: ScriptedHandle;
  readonly dispatched: ScriptedHandle;
  readonly taskId: string;
  readonly label: string;
}): Promise<RecordedRequest> {
  const sessionId = input.dispatched.requests.find((r) => r.role === "parent")?.sessionId;
  input.dispatched.dispose();
  if (sessionId !== undefined) {
    const store = scriptedStore();
    const entry = store.get(sessionId);
    if (entry !== undefined && !store.has(ANY_SESSION)) store.set(ANY_SESSION, entry);
  }
  return await waitFor(
    () => input.armed.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes(input.taskId))),
    input.label,
  );
}

export async function awaitTaskSettlement(input: {
  readonly dispatched: ScriptedHandle;
  readonly taskId: string;
  readonly script: SeatScript;
  readonly label: string;
}): Promise<{ readonly handle: ScriptedHandle; readonly notification: RecordedRequest }> {
  const handle = armSettlement(input.dispatched, input.script);
  const notification = await consumeSettlement({ armed: handle, dispatched: input.dispatched, taskId: input.taskId, label: input.label });
  return { handle, notification };
}

export const SETTLEMENT_DRAIN_SCRIPT: SeatScript = { parent: [{ say: "acknowledged" }] };

type ToolsetTool = { execute?: (...args: unknown[]) => unknown };

export function wrapToolExecute(toolName: string, stub: (...args: unknown[]) => unknown): () => void {
  if (booted === undefined) {
    throw new Error("integration harness: wrapToolExecute before bootAgent — the boot overwrites the hook and would clobber this wrap.");
  }
  const g = globalThis as { __oeToolResultProjection?: (toolset: Record<string, ToolsetTool>) => unknown };
  const original = g.__oeToolResultProjection;
  if (typeof original !== "function") {
    throw new Error("integration harness: globalThis.__oeToolResultProjection is not installed — did the agent really boot from a patched eve?");
  }
  g.__oeToolResultProjection = (toolset: Record<string, ToolsetTool>) => {
    const out = original(toolset);
    try {
      const tool = toolset[toolName];
      if (tool !== undefined && typeof tool.execute === "function") tool.execute = stub;
    } catch {
    }
    return out;
  };
  return () => {
    g.__oeToolResultProjection = original;
  };
}

export async function discordMentionWake(input: { channelId: string; text: string; messageId?: string; userId?: string }): Promise<void> {
  if (booted === undefined) throw new Error("integration harness: discordMentionWake before bootAgent.");
  const { buildDiscordGuildMentionRelayEnvelope, signDiscordRelayRequest } = await import(
    "../../packages/core/scripts/e2e/discord-synthetic"
  );
  const body = JSON.stringify(
    buildDiscordGuildMentionRelayEnvelope({
      text: input.text,
      guildId: DISCORD_GUILD_ID,
      channelId: input.channelId,
      userId: input.userId ?? DISCORD_USER_ID,
      botId: DISCORD_BOT_ID,
      botName: "open-everywhere",
      messageId: input.messageId ?? `it${Date.now()}`,
    }),
  );
  const res = await fetch(`${booted.base}/eve/v1/discord-gateway`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-oe-relay-signature": signDiscordRelayRequest(body, RELAY_SECRET) },
    body,
  });
  const ack = await res.text();
  if (res.status !== 200 || ack.trim() !== "ok") {
    throw new Error(`integration harness: relay wake refused — ${res.status}: ${ack.slice(0, 200)}`);
  }
}

export async function discordAmbientWake(input: { channelId: string; text: string; messageId?: string }): Promise<void> {
  if (booted === undefined) throw new Error("integration harness: discordAmbientWake before bootAgent.");
  const { buildDiscordGuildAmbientRelayEnvelope, signDiscordRelayRequest } = await import(
    "../../packages/core/scripts/e2e/discord-synthetic"
  );
  const body = JSON.stringify(
    buildDiscordGuildAmbientRelayEnvelope({
      text: input.text,
      guildId: DISCORD_GUILD_ID,
      channelId: input.channelId,
      userId: DISCORD_USER_ID,
      messageId: input.messageId ?? `it${Date.now()}`,
    }),
  );
  const res = await fetch(`${booted.base}/eve/v1/discord-gateway`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-oe-relay-signature": signDiscordRelayRequest(body, RELAY_SECRET) },
    body,
  });
  const ack = await res.text();
  if (res.status !== 200 || ack.trim() !== "ok") {
    throw new Error(`integration harness: relay ambient wake refused — ${res.status}: ${ack.slice(0, 200)}`);
  }
}

export async function rawDiscordRelayPost(
  input: { channelId: string; text: string; messageId?: string },
  signature?: string | null,
): Promise<{ status: number; text: string }> {
  if (booted === undefined) throw new Error("integration harness: rawDiscordRelayPost before bootAgent.");
  const { buildDiscordGuildMentionRelayEnvelope, signDiscordRelayRequest } = await import(
    "../../packages/core/scripts/e2e/discord-synthetic"
  );
  const body = JSON.stringify(
    buildDiscordGuildMentionRelayEnvelope({
      text: input.text,
      guildId: DISCORD_GUILD_ID,
      channelId: input.channelId,
      userId: DISCORD_USER_ID,
      botId: DISCORD_BOT_ID,
      botName: "open-everywhere",
      messageId: input.messageId ?? `it${Date.now()}`,
    }),
  );
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["x-oe-relay-signature"] = signature ?? signDiscordRelayRequest(body, RELAY_SECRET);
  const res = await fetch(`${booted.base}/eve/v1/discord-gateway`, { method: "POST", headers, body });
  return { status: res.status, text: await res.text() };
}

export async function rawDiscordRelayHeartbeatPost(
  input: { readonly relayId: string; readonly ts?: number },
  signature?: string | null,
): Promise<{ status: number; text: string }> {
  if (booted === undefined) throw new Error("integration harness: rawDiscordRelayHeartbeatPost before bootAgent.");
  const { buildDiscordRelayHeartbeatEnvelope, signDiscordRelayRequest } = await import("../../packages/core/scripts/e2e/discord-synthetic");
  const body = JSON.stringify(buildDiscordRelayHeartbeatEnvelope(input));
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["x-oe-relay-signature"] = signature ?? signDiscordRelayRequest(body, RELAY_SECRET);
  const res = await fetch(`${booted.base}/eve/v1/discord-gateway`, { method: "POST", headers, body });
  return { status: res.status, text: await res.text() };
}

export const WEBHOOK_E2E_HOOK_ID = "e2e-smoke";

export async function webhookDeliveryPost(
  payload: unknown,
  opts: { signed?: boolean; staleSeconds?: number; deliveryId?: string } = {},
): Promise<{ status: number; body: string }> {
  if (booted === undefined) throw new Error("integration harness: webhookDeliveryPost before bootAgent.");
  const { WebhookDriver } = await import("../../packages/core/scripts/e2e/webhook");
  const driver = new WebhookDriver({ hookId: WEBHOOK_E2E_HOOK_ID, secret: WEBHOOK_E2E_SECRET, targetUrl: booted.base });
  return driver.post(payload, opts);
}

export async function slackInteractivityPost(
  payload: Record<string, unknown>,
  opts: { signature?: string | null; staleSeconds?: number; timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  if (booted === undefined) throw new Error("integration harness: slackInteractivityPost before bootAgent.");
  const { SYNTHETIC_SLACK_ROUTE, encodeInteractionBody, signSlackRequest } = await import("../../packages/core/scripts/e2e/synthetic");
  const rawBody = encodeInteractionBody(payload);
  const signed = signSlackRequest(rawBody, SLACK_SIGNING_SECRET, Date.now() - (opts.staleSeconds ?? 0) * 1_000);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": signed.timestamp,
  };
  if (opts.signature !== null) headers["x-slack-signature"] = opts.signature ?? signed.signature;
  const res = await fetch(`${booted.base}${SYNTHETIC_SLACK_ROUTE}`, {
    method: "POST",
    headers,
    body: rawBody,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  return { status: res.status, body: await res.text() };
}

export async function discordOeCommandPost(
  interaction: Record<string, unknown>,
  opts: { readonly signature?: string | null; readonly timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  if (booted === undefined) throw new Error("integration harness: discordOeCommandPost before bootAgent.");
  const rawBody = JSON.stringify(interaction);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "content-type": "application/json", "x-signature-timestamp": timestamp };
  if (opts.signature !== null) {
    headers["x-signature-ed25519"] =
      opts.signature ?? signEd25519(null, Buffer.from(`${timestamp}${rawBody}`, "utf8"), DISCORD_APP_KEYS.privateKey).toString("hex");
  }
  const res = await fetch(`${booted.base}/eve/v1/discord`, {
    method: "POST",
    headers,
    body: rawBody,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  return { status: res.status, body: await res.text() };
}

export function discordOeStopInteraction(input: { readonly channelId: string; readonly userId: string }): Record<string, unknown> {
  return {
    type: 2,
    guild_id: DISCORD_GUILD_ID,
    channel_id: input.channelId,
    channel: { id: input.channelId, type: 0 },
    member: { user: { id: input.userId, username: "it-stopper", bot: false } },
    data: { name: "oe", type: 1, options: [{ name: "stop", type: 1 }] },
  };
}

export async function slackMessageEventPost(input: {
  readonly channelId: string;
  readonly userId: string;
  readonly text: string;
  readonly ts: string;
  readonly teamId?: string;
  readonly eventId?: string;
  readonly timeoutMs?: number;
  readonly threadTs?: string;
}): Promise<{ status: number; body: string }> {
  if (booted === undefined) throw new Error("integration harness: slackMessageEventPost before bootAgent.");
  const { SYNTHETIC_SLACK_ROUTE, signSlackRequest } = await import("../../packages/core/scripts/e2e/synthetic");
  const teamId = input.teamId ?? SLACK_TEAM_ID;
  const rawBody = JSON.stringify({
    type: "event_callback",
    team_id: teamId,
    event_id: input.eventId ?? `EvIT${input.ts.replace(".", "")}`,
    event_time: Math.floor(Number.parseFloat(input.ts)),
    event: {
      type: "message",
      channel: input.channelId,
      channel_type: "channel",
      user: input.userId,
      text: input.text,
      ts: input.ts,
      event_ts: input.ts,
      team: teamId,
      ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
    },
  });
  const signed = signSlackRequest(rawBody, SLACK_SIGNING_SECRET);
  const res = await fetch(`${booted.base}${SYNTHETIC_SLACK_ROUTE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": signed.timestamp,
      "x-slack-signature": signed.signature,
    },
    body: rawBody,
    signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
  });
  return { status: res.status, body: await res.text() };
}

export async function slackChannelJoinEventPost(input: {
  readonly channelId: string;
  readonly userId: string;
  readonly inviterId?: string;
  readonly ts: string;
  readonly teamId?: string;
  readonly eventId?: string;
  readonly timeoutMs?: number;
}): Promise<{ status: number; body: string }> {
  if (booted === undefined) throw new Error("integration harness: slackChannelJoinEventPost before bootAgent.");
  const { SYNTHETIC_SLACK_ROUTE, signSlackRequest } = await import("../../packages/core/scripts/e2e/synthetic");
  const teamId = input.teamId ?? SLACK_TEAM_ID;
  const rawBody = JSON.stringify({
    type: "event_callback",
    team_id: teamId,
    event_id: input.eventId ?? `EvJoinIT${input.ts.replace(".", "")}`,
    event_time: Math.floor(Number.parseFloat(input.ts)),
    event: {
      type: "member_joined_channel",
      channel: input.channelId,
      channel_type: "C",
      user: input.userId,
      ...(input.inviterId === undefined ? {} : { inviter: input.inviterId }),
      team: teamId,
      event_ts: input.ts,
    },
  });
  const signed = signSlackRequest(rawBody, SLACK_SIGNING_SECRET);
  const res = await fetch(`${booted.base}${SYNTHETIC_SLACK_ROUTE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": signed.timestamp,
      "x-slack-signature": signed.signature,
    },
    body: rawBody,
    signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
  });
  return { status: res.status, body: await res.text() };
}

export async function slackMentionWake(input: {
  readonly channelId: string;
  readonly userId: string;
  readonly text: string;
  readonly ts: string;
  readonly threadTs?: string;
  readonly teamId?: string;
  readonly eventId?: string;
  readonly timeoutMs?: number;
}): Promise<{ status: number; body: string }> {
  if (booted === undefined) throw new Error("integration harness: slackMentionWake before bootAgent.");
  const { buildChannelMentionEnvelope, SYNTHETIC_SLACK_ROUTE, signSlackRequest } = await import("../../packages/core/scripts/e2e/synthetic");
  const teamId = input.teamId ?? SLACK_TEAM_ID;
  const env = buildChannelMentionEnvelope({
    text: input.text,
    channelId: input.channelId,
    userId: input.userId,
    teamId,
    ts: input.ts,
    eventId: input.eventId ?? `EvMentIT${input.ts.replace(".", "")}`,
  }) as { event: Record<string, unknown> };
  if (input.threadTs !== undefined) env.event.thread_ts = input.threadTs;
  const rawBody = JSON.stringify(env);
  const signed = signSlackRequest(rawBody, SLACK_SIGNING_SECRET);
  const res = await fetch(`${booted.base}${SYNTHETIC_SLACK_ROUTE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": signed.timestamp,
      "x-slack-signature": signed.signature,
    },
    body: rawBody,
    signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
  });
  return { status: res.status, body: await res.text() };
}

export function slackTs(atMs: number, micros: number): string {
  return `${Math.floor(atMs / 1_000)}.${String(micros % 1_000_000).padStart(6, "0")}`;
}

export const SLACK_TEAM_ID = "T0EXAMPLE";

export const SLACK_NAME_DROP_CHANNEL_ID = "C0EXCHAN013";

export const DISCORD_GUILD_ID = "1300000000000000100";
export const DISCORD_LISTED_CHANNEL_ID = "1300000000000000101";
export const DISCORD_USER_ID = "9000000000000000042";
const DISCORD_BOT_ID = "9000000000000000001";

export const NOTION_WORKSPACE_ID = "6f7ea678-0000-4000-8000-000000000001";
export const NOTION_PAGE_ID = "6f7ea678-0000-4000-8000-000000000002";
export const NOTION_PAGE_ID_2 = "6f7ea678-0000-4000-8000-000000000003";

export async function notionCommentEventPost(input: {
  readonly workspaceId: string;
  readonly commentId: string;
  readonly eventId?: string;
  readonly timeoutMs?: number;
}): Promise<{ status: number; body: string }> {
  if (booted === undefined) throw new Error("integration harness: notionCommentEventPost before bootAgent.");
  const rawBody = JSON.stringify({
    type: "comment.created",
    workspace_id: input.workspaceId,
    id: input.eventId ?? `ev-it-${randomBytes(8).toString("hex")}`,
    timestamp: new Date().toISOString(),
    entity: { id: input.commentId, type: "comment" },
  });
  const signature = "sha256=" + createHmac("sha256", NOTION_WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex");
  const res = await fetch(`${booted.base}/eve/v1/notion`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-notion-signature": signature },
    body: rawBody,
    signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
  });
  return { status: res.status, body: await res.text() };
}

export async function seedNotionChannelKey(apiKey = "it-notion-stub-key"): Promise<void> {
  if (booted === undefined) throw new Error("integration harness: seedNotionChannelKey before bootAgent.");
  if (process.env.OE_OPERATIONAL_PROVIDER !== "sqlite") {
    throw new Error("integration harness: seedNotionChannelKey needs bootAgent({ sharedSqlite: true }) — PGlite is single-writer.");
  }
  const { storeDbSecret } = await import("@open-everywhere/core/agent/credentials/db-broker.js");
  const { deploymentOrg } = await import("@open-everywhere/core/agent/identity/binding.js");
  await storeDbSecret({ org: deploymentOrg(), ref: "db:notion:channel-key", plaintext: apiKey, createdBy: "it-harness" });
}

export interface AuditRow {
  readonly ts: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
  readonly action: string;
  readonly detail?: Record<string, unknown>;
}

export async function readAuditRows(input: { actions: readonly string[]; sinceIso: string; limit?: number }): Promise<AuditRow[]> {
  if (booted === undefined) throw new Error("integration harness: readAuditRows before bootAgent.");
  const { buildAuditQuery } = await import("../../packages/core/scripts/e2e/audit-read");
  const q = buildAuditQuery({ sinceIso: input.sinceIso, actions: [...input.actions], limit: input.limit ?? 50 });
  const res = await fetch(`${booted.base}/control/v1/audit?${q}`, {
    headers: { authorization: `Bearer ${READ_TOKEN}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`integration harness: audit read failed ${res.status}`);
  const parsed = (await res.json()) as { entries?: AuditRow[] };
  return parsed.entries ?? [];
}

export async function controlGet(path: string, opts: { readonly token?: string | null } = {}): Promise<{ status: number; body: string }> {
  if (booted === undefined) throw new Error("integration harness: controlGet before bootAgent.");
  const token = opts.token === undefined ? READ_TOKEN : opts.token;
  const res = await fetch(`${booted.base}${path}`, {
    headers: { accept: "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
}

export interface UsageWindowRow {
  readonly surfaceKey: string;
  readonly model?: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedUsd?: number;
}

export async function readUsageWindow(input: {
  sinceIso: string;
  workspaceKeys: readonly string[];
}): Promise<{ rows: UsageWindowRow[]; totalUsd: number; unpricedModels: readonly string[] }> {
  if (booted === undefined) throw new Error("integration harness: readUsageWindow before bootAgent.");
  const qs = new URLSearchParams({ since: input.sinceIso, workspaces: input.workspaceKeys.join(",") });
  const res = await fetch(`${booted.base}/control/v1/usage?${qs.toString()}`, {
    headers: { authorization: `Bearer ${READ_TOKEN}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`integration harness: usage-window read failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as { rows: UsageWindowRow[]; totalUsd: number; unpricedModels: readonly string[] };
}

function scheduleTaskName(logicalPath: string): string {
  return `eve.schedule.${Buffer.from(logicalPath, "utf8").toString("base64url")}`;
}

export async function seedDueRoutine(input: {
  readonly surfaceKey: string;
  readonly channelId: string;
  readonly prompt: string;
  readonly createdBy: string;
  readonly id?: string;
  readonly org?: string;
}): Promise<string> {
  if (booted === undefined) throw new Error("integration harness: seedDueRoutine before bootAgent.");
  if (process.env.OE_OPERATIONAL_PROVIDER !== "sqlite") {
    throw new Error("integration harness: seedDueRoutine needs bootAgent({ sharedSqlite: true }) — PGlite is single-writer.");
  }
  const { addRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const org = input.org ?? "default";
  const id = input.id ?? `r-it-${randomBytes(4).toString("hex")}`;
  const [platform = "slack", workspace = "", surface = ""] = input.surfaceKey.split("/");
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  await addRoutine(
    {
      org,
      platform,
      workspace,
      surface,
      workspaceKey: `${platform}/${workspace}`,
      surfaceKey: input.surfaceKey,
      domainKey: input.surfaceKey,
      key: input.surfaceKey,
    },
    {
      id,
      org,
      surfaceKey: input.surfaceKey,
      target: { channelId: input.channelId },
      trigger: { kind: "once", at: dueAt },
      prompt: input.prompt,
      createdBy: input.createdBy,
      status: "active",
      nextRunAt: dueAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      promptGeneration: 1,
      consecutiveFailures: 0,
    },
  );
  return id;
}

export async function runRoutineDispatchTick(): Promise<readonly string[]> {
  if (booted === undefined) throw new Error("integration harness: runRoutineDispatchTick before bootAgent.");
  const taskName = scheduleTaskName("schedules/dispatch.ts");
  const dir = join(bootedBuildDir(), "server", "_virtual");
  const candidates = readdirSync(dir).filter((f) => f.endsWith(".schedule.mjs"));
  for (const file of candidates) {
    if (!readFileSync(join(dir, file), "utf8").includes(taskName)) continue;
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as {
      default: { run(e: { name: string }): Promise<{ result?: { sessionIds?: readonly string[] } }> };
    };
    const out = await mod.default.run({ name: taskName });
    return out.result?.sessionIds ?? [];
  }
  throw new Error(
    `integration harness: no compiled virtual handler in ${dir} dispatches "${taskName}" ` +
      `(found: ${candidates.join(", ") || "none"}). The routine dispatcher schedule was renamed, ` +
      "removed, or eve changed its task-name derivation — fix scheduleTaskName() rather than skipping.",
  );
}

export async function runScheduleTask(logicalPath: string): Promise<unknown> {
  if (booted === undefined) throw new Error("integration harness: runScheduleTask before bootAgent.");
  const taskName = scheduleTaskName(logicalPath);
  const dir = join(bootedBuildDir(), "server", "_virtual");
  const candidates = readdirSync(dir).filter((f) => f.endsWith(".schedule.mjs"));
  for (const file of candidates) {
    if (!readFileSync(join(dir, file), "utf8").includes(taskName)) continue;
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default: { run(e: { name: string }): Promise<unknown> } };
    return await mod.default.run({ name: taskName });
  }
  throw new Error(
    `integration harness: no compiled virtual handler in ${dir} dispatches "${taskName}" ` +
      `(found: ${candidates.join(", ") || "none"}). "${logicalPath}" was renamed, removed, or eve ` +
      "changed its task-name derivation — fix scheduleTaskName() rather than skipping.",
  );
}
