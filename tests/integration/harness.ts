import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { reserveEphemeralPort } from "../../scripts/ephemeral-port.js";

export { registerScript, type RecordedRequest, type ResolveObservation, type ScriptedHandle, type ScriptedStep, type SeatScript } from "../../agent/model/scripted-model";
export { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "@open-everywhere/core/agent/adapter-api.js";

const ROOT = process.cwd();

const RELAY_SECRET = randomBytes(32).toString("hex");
const READ_TOKEN = randomBytes(32).toString("hex");

let booted: { base: string } | undefined;
let bootedWith: string | undefined;

export interface BootOptions {
  readonly sharedSqlite?: boolean;
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
  process.env.OE_CONTROL_READ_TOKENS = `it:${createHash("sha256").update(READ_TOKEN, "utf8").digest("hex")}`;
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
  await reserved.release();

  await import(pathToFileURL(join(ROOT, ".output", "server", "index.mjs")).href);
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
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await sleep(400);
  }
}

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

export async function discordMentionWake(input: { channelId: string; text: string; messageId?: string }): Promise<void> {
  if (booted === undefined) throw new Error("integration harness: discordMentionWake before bootAgent.");
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

export const DISCORD_GUILD_ID = "1300000000000000100";
export const DISCORD_LISTED_CHANNEL_ID = "1300000000000000101";
const DISCORD_USER_ID = "9000000000000000042";
const DISCORD_BOT_ID = "9000000000000000001";

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
  const dir = join(ROOT, ".output", "server", "_virtual");
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
