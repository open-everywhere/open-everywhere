import { readBindingBridge, bridgedContext } from "../identity/binding-bridge.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { emitTelemetry } from "./telemetry.js";
import { getSettings, settingsRegistered } from "../settings/settings.js";
import { operatorSecret } from "../credentials/operator-secrets.js";

const LOG_SHIP_TOKEN_SECRET = "OE_LOG_SHIP_TOKEN";
const DEFAULT_SERVICE = "open-everywhere";

function surfaceKeyForLog(): string | undefined {
  try {
    const bridged = readBindingBridge();
    if (!bridged) return undefined;
    return domainKeyOf(resolvePartition(bridgedContext(bridged)));
  } catch {
    return undefined;
  }
}

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface LogRecord {
  [key: string]: unknown;
  ts: string;
  level: LogLevel;
  service: string;
  env: string;
  component: string;
  message: string;
  surfaceKey?: string;
  error?: { name: string; message: string; stack?: string };
}

interface ShipConfig {
  url: string;
  tokenHeader: string;
  service: string;
  batchMax: number;
  flushMs: number;
}

const rawConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const QUEUE_HARD_CAP = 500;

let config: ShipConfig | null | undefined;
let queue: LogRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let fetchImpl: typeof fetch = (...args) => fetch(...args);
let capturedConsole: { log: typeof console.log; warn: typeof console.warn; error: typeof console.error } | null = null;
let processCaptured = false;
let droppedRecords = 0;
const warnedReasons = new Set<string>();

function warnOnce(reason: string): void {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  rawConsole.warn(`[open-everywhere:log-ship] ${reason}`);
}

const LOG_SHIP_BATCH_MAX = 20;
const LOG_SHIP_FLUSH_MS = 1000;
let tuning: { batchMax: number; flushMs: number } = { batchMax: LOG_SHIP_BATCH_MAX, flushMs: LOG_SHIP_FLUSH_MS };

function readConfig(): ShipConfig | null | undefined {
  if (config !== undefined) return config;
  if (!settingsRegistered()) return undefined;
  const ship = getSettings().observability.logShip;
  const url = ship.url.trim();
  if (!url) {
    config = null;
    queue = [];
    return config;
  }
  config = {
    url,
    tokenHeader: ship.tokenHeader?.trim() || "authorization",
    service: ship.service?.trim() || DEFAULT_SERVICE,
    batchMax: tuning.batchMax,
    flushMs: tuning.flushMs,
  };
  for (const r of queue) if (r.service === DEFAULT_SERVICE) r.service = config.service;
  return config;
}

async function resolveShipToken(): Promise<string | undefined> {
  try {
    return await operatorSecret(LOG_SHIP_TOKEN_SECRET);
  } catch (err) {
    warnOnce(`token unreadable (${err instanceof Error ? err.message : String(err)}) — shipping without it`);
    return undefined;
  }
}

export function logShipEnabled(): boolean {
  return readConfig() != null;
}

export function shapeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: "NonError", message: safeString(err) };
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

export function buildRecord(
  level: LogLevel,
  component: string,
  message: string,
  opts: { fields?: LogFields; err?: unknown; service?: string } = {},
): LogRecord {
  const surfaceKey =
    typeof opts.fields?.surfaceKey === "string" ? (opts.fields.surfaceKey as string) : surfaceKeyForLog();
  const record: LogRecord = {
    ...opts.fields,
    ts: new Date().toISOString(),
    level,
    service: opts.service ?? readConfig()?.service ?? DEFAULT_SERVICE,
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "local",
    component,
    message,
  };
  if (surfaceKey) record.surfaceKey = surfaceKey;
  if (opts.err !== undefined) record.error = shapeError(opts.err);
  return record;
}

export function parseConsoleArgs(args: unknown[]): { component: string; message: string; err?: unknown } {
  let component = "console";
  let err: unknown;
  const parts: string[] = [];
  for (const arg of args) {
    if (err === undefined && arg instanceof Error) {
      err = arg;
      parts.push(arg.message);
      continue;
    }
    parts.push(safeString(arg));
  }
  let message = parts.join(" ");
  const match = /^\[open-everywhere:([^\]]+)\]\s*/.exec(message);
  if (match) {
    component = match[1];
    message = message.slice(match[0].length);
  }
  return err === undefined ? { component, message } : { component, message, err };
}

export function enqueue(record: LogRecord): void {
  const cfg = readConfig();
  if (cfg === null) return;
  try {
    queue.push(record);
    if (queue.length > QUEUE_HARD_CAP) {
      queue.splice(0, queue.length - QUEUE_HARD_CAP);
      droppedRecords++;
    }
    if (cfg === undefined) return;
    if (queue.length >= cfg.batchMax) {
      void flushLogShip();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => void flushLogShip(), cfg.flushMs);
      (flushTimer as { unref?: () => void }).unref?.();
    }
  } catch {
  }
}

export async function flushLogShip(): Promise<void> {
  const cfg = readConfig();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (!cfg || queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = await resolveShipToken();
    if (token) headers[cfg.tokenHeader] = token;
    const res = await fetchImpl(cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      droppedRecords += batch.length;
      warnOnce(`ingest rejected ${res.status} — dropping batches with this status until it recovers`);
    }
  } catch (err) {
    droppedRecords += batch.length;
    warnOnce(`ingest unreachable (${err instanceof Error ? err.message : String(err)}) — dropping batches`);
  }
}

export interface OeLogger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, err?: unknown, fields?: LogFields): void;
}

export function oeLogger(component: string): OeLogger {
  const prefix = `[open-everywhere:${component}]`;
  return {
    info(msg, fields) {
      rawConsole.log(`${prefix} ${msg}`);
      enqueue(buildRecord("info", component, msg, { fields }));
    },
    warn(msg, fields) {
      rawConsole.warn(`${prefix} ${msg}`);
      enqueue(buildRecord("warn", component, msg, { fields }));
    },
    error(msg, err, fields) {
      if (err === undefined) rawConsole.error(`${prefix} ${msg}`);
      else rawConsole.error(`${prefix} ${msg}`, err);
      enqueue(buildRecord("error", component, msg, { fields, err }));
    },
  };
}

export function installConsoleCapture(): void {
  if (capturedConsole || readConfig() === null) return;
  capturedConsole = { log: console.log, warn: console.warn, error: console.error };
  const wrap = (level: LogLevel, original: (...args: unknown[]) => void) =>
    ((...args: unknown[]) => {
      try {
        if (readConfig() === null) return original(...args);
        const { component, message, err } = parseConsoleArgs(args);
        enqueue(buildRecord(level, component, message, err === undefined ? {} : { err }));
      } catch {
      }
      original(...args);
    }) as typeof console.log;
  console.log = wrap("info", capturedConsole.log);
  console.warn = wrap("warn", capturedConsole.warn);
  console.error = wrap("error", capturedConsole.error);
}

function installProcessCapture(): void {
  if (processCaptured) return;
  processCaptured = true;
  process.on("uncaughtExceptionMonitor", (err, origin) => {
    enqueue(buildRecord("error", "process", `uncaught (${origin})`, { err }));
    void flushLogShip();
    emitTelemetry("oe.error.uncaught", {
      "oe.component": "process",
      "oe.error.name": err instanceof Error ? err.name : "NonError",
    });
  });
  process.on("beforeExit", () => void flushLogShip());
}

export function installLogShipping(): void {
  installConsoleCapture();
  installProcessCapture();
}

export function droppedRecordCount(): number {
  return droppedRecords;
}

export function __resetLogShipForTest(overrides: { fetchImpl?: typeof fetch; batchMax?: number; flushMs?: number } = {}): void {
  config = undefined;
  tuning = { batchMax: overrides.batchMax ?? LOG_SHIP_BATCH_MAX, flushMs: overrides.flushMs ?? LOG_SHIP_FLUSH_MS };
  queue = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  droppedRecords = 0;
  warnedReasons.clear();
  fetchImpl = overrides.fetchImpl ?? ((...args) => fetch(...args));
  if (capturedConsole) {
    console.log = capturedConsole.log;
    console.warn = capturedConsole.warn;
    console.error = capturedConsole.error;
    capturedConsole = null;
  }
  processCaptured = false;
}

export function __queueLengthForTest(): number {
  return queue.length;
}
