import { randomUUID } from "node:crypto";
import { getOperationalStore } from "../operational/provider.js";
import { getAppInfo } from "../commands/core.js";
import { getProvider as getMemoryProvider } from "../memory/provider.js";
import { getConfig } from "../access/config.js";
import { onVercel } from "../access/platform.js";
import { linearCredentialsConfigured } from "../channels/linear-credentials.js";

export const EVENT_SCHEMA: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "oe.instance.first_boot": Object.freeze([]),
  "oe.instance.heartbeat": Object.freeze([
    "oe.surfaces",
    "oe.memory_provider",
    "oe.operational_provider",
    "oe.model.primary",
    "oe.model.utility",
    "oe.domains.bucket",
    "oe.telemetry.dropped",
  ]),
  "oe.turn.completed": Object.freeze([
    "oe.surface",
    "oe.kind",
    "gen_ai.request.model",
    "oe.tokens.bucket",
    "oe.steps.bucket",
    "oe.latency.bucket",
  ]),
  "oe.turn.failed": Object.freeze(["oe.surface", "oe.error.code"]),
  "oe.error.uncaught": Object.freeze(["oe.component", "oe.error.name"]),
  "oe.feature.used": Object.freeze(["oe.feature", "oe.outcome"]),
  "oe.audit.dropped": Object.freeze(["oe.action", "oe.platform"]),
  "oe.reaction.added": Object.freeze(["oe.surface", "oe.on_bot_reply", "oe.emoji_class"]),
  "oe.reaction.removed": Object.freeze(["oe.surface", "oe.on_bot_reply", "oe.emoji_class"]),
  "wizard.started": Object.freeze(["oe.wizard.version", "oe.wizard.platform"]),
  "wizard.completed": Object.freeze(["oe.wizard.version", "oe.wizard.platform", "oe.wizard.steps_completed"]),
});

export const RESOURCE_ATTR_KEYS: readonly string[] = Object.freeze([
  "service.name",
  "service.version",
  "service.instance.id",
  "deployment.environment.name",
  "oe.host",
  "oe.node.major",
  "oe.instance.ephemeral",
]);

export const FEATURE_VALUES = Object.freeze([
  "approval_requested",
  "approval_decided",
  "routine_created",
  "routine_fired",
  "webhook_received",
  "skill_created",
  "memory_admin",
  "spend_cap_hit",
  "spend_checkpoint",
] as const);
export const OUTCOME_VALUES = Object.freeze(["ok", "failed", "approved", "rejected", "expired", "unverified"] as const);

export function tokensBucket(total: number): string {
  if (total < 1_000) return "<1k";
  if (total < 10_000) return "1-10k";
  if (total < 100_000) return "10-100k";
  if (total < 1_000_000) return "100k-1M";
  return ">1M";
}

export function stepsBucket(steps: number): string {
  if (steps <= 1) return "1";
  if (steps <= 5) return "2-5";
  if (steps <= 20) return "6-20";
  return ">20";
}

export function latencyBucket(ms: number): string {
  if (ms < 5_000) return "<5s";
  if (ms < 15_000) return "5-15s";
  if (ms < 60_000) return "15-60s";
  if (ms < 300_000) return "1-5m";
  return ">5m";
}

export function domainsBucket(count: number): string {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  return "6+";
}

export interface TelemetryConfig {
  readonly enabled: boolean;
  readonly debug: boolean;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly redirected: boolean;
}

export const DEFAULT_TELEMETRY_URL = "https://oe-telemetry.vercel.app/v1/logs";

function isOffValue(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

function isDntTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

let config: TelemetryConfig | undefined;

function readTelemetryConfig(): TelemetryConfig {
  if (config !== undefined) return config;
  const enabled = !isOffValue(process.env.OE_TELEMETRY) && !isDntTruthy(process.env.DO_NOT_TRACK);
  const debug = process.env.OE_TELEMETRY_DEBUG === "1";
  const redirectUrl = process.env.OE_TELEMETRY_OTLP_URL?.trim();
  config = {
    enabled,
    debug,
    url: redirectUrl || DEFAULT_TELEMETRY_URL,
    headers: parseHeaders(process.env.OE_TELEMETRY_OTLP_HEADERS),
    redirected: Boolean(redirectUrl),
  };
  return config;
}

export function resetTelemetryConfigCache(): void {
  config = undefined;
}

export function telemetryEnabled(): boolean {
  return readTelemetryConfig().enabled;
}

export function telemetryStatusLine(): string {
  const cfg = readTelemetryConfig();
  if (!cfg.enabled) return "off";
  return cfg.redirected ? "on (custom endpoint)" : "on (default collector)";
}

const INSTANCE_ID_META_KEY = "telemetry.instanceId";
const FIRST_BOOT_PENDING_META_KEY = "telemetry.firstBootPending";

interface InstanceInfo {
  readonly id: string;
  readonly ephemeral: boolean;
}

let cachedInstance: InstanceInfo | null = null;
let initStarted = false;

let ephemeralState: { id: string; pending: boolean } | null = null;

function rawLog(line: string): void {
  console.log(line);
}

const warnedReasons = new Set<string>();
function warnOnce(reason: string): void {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  rawLog(`[open-everywhere:telemetry] ${reason}`);
}

const BOOT_LINE_ON =
  "[open-everywhere:telemetry] anonymous usage telemetry is ON — see docs/deploy/telemetry.md; " +
  "OE_TELEMETRY=off or DO_NOT_TRACK=1 disables";
const BOOT_LINE_OFF =
  "[open-everywhere:telemetry] anonymous usage telemetry is OFF (OE_TELEMETRY / DO_NOT_TRACK) — see docs/deploy/telemetry.md";

function printBootDisclosureLine(): void {
  rawLog(telemetryEnabled() ? BOOT_LINE_ON : BOOT_LINE_OFF);
}

export interface ResolvedInstance {
  readonly id: string;
  readonly ephemeral: boolean;
  readonly justMinted: boolean;
}

export async function resolveInstanceId(): Promise<ResolvedInstance> {
  try {
    const store = getOperationalStore();
    const existing = await store.getMeta(INSTANCE_ID_META_KEY);
    if (existing == null) {
      const id = randomUUID();
      await store.setMeta(INSTANCE_ID_META_KEY, id);
      await store.setMeta(FIRST_BOOT_PENDING_META_KEY, "1");
      cachedInstance = { id, ephemeral: false };
      return { id, ephemeral: false, justMinted: true };
    }
    cachedInstance = { id: existing, ephemeral: false };
    return { id: existing, ephemeral: false, justMinted: false };
  } catch {
    if (!ephemeralState) {
      ephemeralState = { id: randomUUID(), pending: true };
      cachedInstance = { id: ephemeralState.id, ephemeral: true };
      return { id: ephemeralState.id, ephemeral: true, justMinted: true };
    }
    cachedInstance = { id: ephemeralState.id, ephemeral: true };
    return { id: ephemeralState.id, ephemeral: true, justMinted: false };
  }
}

async function resolveInstanceAndMaybeEmitFirstBoot(): Promise<void> {
  const resolved = await resolveInstanceId();
  if (resolved.justMinted) return;

  if (resolved.ephemeral) {
    if (ephemeralState?.pending) {
      ephemeralState.pending = false;
      emitTelemetry("oe.instance.first_boot", {});
    }
    maybeHeartbeat();
    return;
  }

  try {
    const store = getOperationalStore();
    const pending = await store.getMeta(FIRST_BOOT_PENDING_META_KEY);
    if (pending === "1") {
      await store.setMeta(FIRST_BOOT_PENDING_META_KEY, "0");
      emitTelemetry("oe.instance.first_boot", {});
    }
    maybeHeartbeat();
  } catch {
  }
}

export async function initTelemetry(): Promise<void> {
  printBootDisclosureLine();
  if (initStarted) return;
  initStarted = true;
  if (!telemetryEnabled()) return;
  await resolveInstanceAndMaybeEmitFirstBoot();
}

const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastHeartbeatAt = 0;

function surfacesWithCreds(): string[] {
  const present: string[] = [];
  if (process.env.SLACK_BOT_TOKEN) present.push("slack");
  if (process.env.DISCORD_BOT_TOKEN) present.push("discord");
  if (process.env.MICROSOFT_APP_ID) present.push("teams");
  if (process.env.TELEGRAM_BOT_TOKEN) present.push("telegram");
  if (process.env.OE_GITHUB_APP_ID) present.push("github");
  if (linearCredentialsConfigured()) present.push("linear");
  try {
    if ((getConfig().loadWebhooks?.() ?? []).length > 0) present.push("webhooks");
  } catch {
  }
  return present.sort();
}

function domainsCount(): number {
  try {
    return getConfig().loadDomains().length;
  } catch {
    return 0;
  }
}

function memoryProviderId(): string {
  try {
    return getMemoryProvider().id;
  } catch {
    return "unknown";
  }
}

function operationalProviderId(): string {
  try {
    return getOperationalStore().id;
  } catch {
    return "unknown";
  }
}

export function maybeHeartbeat(now: number = Date.now()): void {
  if (!cachedInstance) return;
  if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatAt = now;
  const appInfo = getAppInfo();
  emitTelemetry("oe.instance.heartbeat", {
    "oe.surfaces": surfacesWithCreds(),
    "oe.memory_provider": memoryProviderId(),
    "oe.operational_provider": operationalProviderId(),
    "oe.model.primary": appInfo.primaryModel,
    "oe.model.utility": appInfo.utilityModel,
    "oe.domains.bucket": domainsBucket(domainsCount()),
    "oe.telemetry.dropped": droppedTelemetryCount(),
  });
}

export type TelemetryAttrValue = string | number | boolean | readonly string[];
export type TelemetryAttrs = Readonly<Record<string, TelemetryAttrValue>>;

interface QueuedTelemetryRecord {
  readonly eventName: string;
  readonly attributes: TelemetryAttrs;
  readonly timeUnixNano: string;
}

const QUEUE_HARD_CAP = 200;
const BATCH_MAX = 20;
const FLUSH_MS = 2_000;

let queue: QueuedTelemetryRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let droppedCount = 0;
let fetchImpl: typeof fetch = (...args) => fetch(...args);

export function droppedTelemetryCount(): number {
  return droppedCount;
}

function nowUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function environmentName(): "production" | "preview" | "development" {
  const v = process.env.VERCEL_ENV;
  if (v === "production" || v === "preview" || v === "development") return v;
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

function nodeMajorVersion(): number {
  const major = Number(process.versions.node.split(".")[0]);
  return Number.isFinite(major) ? major : 0;
}

function resourceAttributes(): Record<string, string | number | boolean> {
  const appInfo = getAppInfo();
  const attrs: Record<string, string | number | boolean> = {
    "service.name": "open-everywhere",
    "service.version": appInfo.version,
    "service.instance.id": cachedInstance?.id ?? "unknown",
    "deployment.environment.name": environmentName(),
    "oe.host": onVercel() ? "vercel" : "node",
    "oe.node.major": nodeMajorVersion(),
  };
  if (cachedInstance?.ephemeral) attrs["oe.instance.ephemeral"] = true;
  return attrs;
}

function otlpValue(v: TelemetryAttrValue): Record<string, unknown> {
  if (Array.isArray(v)) return { arrayValue: { values: v.map((s) => ({ stringValue: String(s) })) } };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}

function otlpAttributes(attrs: Record<string, TelemetryAttrValue>): { key: string; value: Record<string, unknown> }[] {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: otlpValue(value) }));
}

export function buildOtlpPayload(records: readonly QueuedTelemetryRecord[]): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        resource: { attributes: otlpAttributes(resourceAttributes()) },
        scopeLogs: [
          {
            scope: { name: "open-everywhere-telemetry" },
            logRecords: records.map((r) => ({
              timeUnixNano: r.timeUnixNano,
              eventName: r.eventName,
              attributes: otlpAttributes(r.attributes),
            })),
          },
        ],
      },
    ],
  };
}

export function emitTelemetry(eventName: string, attrs: TelemetryAttrs = {}): void {
  try {
    const allowed = EVENT_SCHEMA[eventName];
    if (!allowed) {
      warnOnce(`unknown event "${eventName}" — dropped (outside the closed vocabulary)`);
      return;
    }
    const filtered: Record<string, TelemetryAttrValue> = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (allowed.includes(key)) filtered[key] = value;
      else warnOnce(`event "${eventName}" attribute "${key}" is outside its closed vocabulary — dropped`);
    }

    const cfg = readTelemetryConfig();
    if (!cfg.enabled) return;
    if (!cachedInstance) {
      warnOnce("event dropped — instance id not resolved yet");
      return;
    }

    const record: QueuedTelemetryRecord = { eventName, attributes: filtered, timeUnixNano: nowUnixNano() };

    if (cfg.debug) {
      rawLog(`[open-everywhere:telemetry] (debug — not sent) ${JSON.stringify(buildOtlpPayload([record]))}`);
      return;
    }

    queue.push(record);
    if (queue.length > QUEUE_HARD_CAP) {
      queue.splice(0, queue.length - QUEUE_HARD_CAP);
      droppedCount++;
    }
    if (queue.length >= BATCH_MAX) {
      void flushTelemetry();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => void flushTelemetry(), FLUSH_MS);
      (flushTimer as { unref?: () => void }).unref?.();
    }
  } catch {
  }
}

export async function flushTelemetry(): Promise<void> {
  const cfg = readTelemetryConfig();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (!cfg.enabled || queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    const headers: Record<string, string> = { "content-type": "application/json", ...cfg.headers };
    const res = await fetchImpl(cfg.url, { method: "POST", headers, body: JSON.stringify(buildOtlpPayload(batch)) });
    if (!res.ok) {
      droppedCount += batch.length;
      warnOnce(`ingest rejected ${res.status} — dropping batches with this status until it recovers`);
    }
  } catch (err) {
    droppedCount += batch.length;
    warnOnce(`ingest unreachable (${err instanceof Error ? err.message : String(err)}) — dropping batches`);
  }
}

export function __resetTelemetryForTest(overrides: { fetchImpl?: typeof fetch } = {}): void {
  config = undefined;
  queue = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  droppedCount = 0;
  warnedReasons.clear();
  fetchImpl = overrides.fetchImpl ?? ((...args) => fetch(...args));
  cachedInstance = null;
  initStarted = false;
  ephemeralState = null;
  lastHeartbeatAt = 0;
}

export function __queueLengthForTest(): number {
  return queue.length;
}

export function __setInstanceForTest(info: InstanceInfo | null): void {
  cachedInstance = info;
}

export function __setLastHeartbeatForTest(at: number): void {
  lastHeartbeatAt = at;
}
