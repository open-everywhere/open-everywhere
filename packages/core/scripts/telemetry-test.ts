import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  EVENT_SCHEMA,
  tokensBucket,
  stepsBucket,
  latencyBucket,
  domainsBucket,
  emitTelemetry,
  flushTelemetry,
  telemetryEnabled,
  telemetryStatusLine,
  DEFAULT_TELEMETRY_URL,
  droppedTelemetryCount,
  initTelemetry,
  maybeHeartbeat,
  __resetTelemetryForTest,
  __queueLengthForTest,
  __setInstanceForTest,
  __setLastHeartbeatForTest,
} from "../agent/observability/telemetry.js";
import { resetOperationalStore } from "../agent/operational/provider.js";
import { _resetOperationalDbForTest } from "../agent/operational/sqlite.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const TELEMETRY_ENV = ["OE_TELEMETRY", "DO_NOT_TRACK", "OE_TELEMETRY_DEBUG", "OE_TELEMETRY_OTLP_URL", "OE_TELEMETRY_OTLP_HEADERS"];
function clearTelemetryEnv(): void {
  for (const key of TELEMETRY_ENV) delete process.env[key];
}

function fakeFetch(status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return { ok: status < 400, status } as Response;
  }) as typeof fetch;
  return { calls, impl };
}

function throwingFetch(): typeof fetch {
  return (async () => {
    throw new Error("network is down");
  }) as typeof fetch;
}

{
  clearTelemetryEnv();
  __resetTelemetryForTest();
  ok(telemetryEnabled(), "nothing set -> enabled by default");
  ok(telemetryStatusLine() === "on (default collector)", "nothing set -> default collector status line");

  clearTelemetryEnv();
  process.env.OE_TELEMETRY_OTLP_URL = "https://example.test/v1/logs";
  __resetTelemetryForTest();
  ok(telemetryEnabled(), "URL alone -> still enabled");
  ok(telemetryStatusLine() === "on (custom endpoint)", "URL alone -> custom endpoint status line");

  clearTelemetryEnv();
  process.env.DO_NOT_TRACK = "1";
  process.env.OE_TELEMETRY_OTLP_URL = "https://example.test/v1/logs";
  __resetTelemetryForTest();
  ok(!telemetryEnabled(), "DO_NOT_TRACK wins over a configured URL");

  clearTelemetryEnv();
  process.env.OE_TELEMETRY = "off";
  process.env.DO_NOT_TRACK = "0";
  __resetTelemetryForTest();
  ok(!telemetryEnabled(), "OE_TELEMETRY=off disables even with DO_NOT_TRACK=0");

  clearTelemetryEnv();
  process.env.OE_TELEMETRY = "off";
  process.env.OE_TELEMETRY_OTLP_URL = "https://example.test/v1/logs";
  __resetTelemetryForTest();
  ok(!telemetryEnabled(), "OE_TELEMETRY=off wins over a configured URL (the full precedence order)");
  ok(telemetryStatusLine() === "off", '"off" status line when disabled');

  clearTelemetryEnv();
  __resetTelemetryForTest();
}

{
  clearTelemetryEnv();
  process.env.OE_TELEMETRY_DEBUG = "1";
  const { calls, impl } = fakeFetch();
  __resetTelemetryForTest({ fetchImpl: impl });
  __setInstanceForTest({ id: "instance-debug", ephemeral: false });

  emitTelemetry("oe.error.uncaught", { "oe.component": "process", "oe.error.name": "TypeError" });
  ok(__queueLengthForTest() === 0, "debug mode never queues a record");
  await flushTelemetry();
  ok(calls.length === 0, "debug mode never calls fetch");

  clearTelemetryEnv();
  __resetTelemetryForTest();
}

{
  ok(tokensBucket(0) === "<1k", "tokens: 0 -> <1k");
  ok(tokensBucket(999) === "<1k", "tokens: 999 -> <1k");
  ok(tokensBucket(1_000) === "1-10k", "tokens: 1000 -> 1-10k (boundary)");
  ok(tokensBucket(9_999) === "1-10k", "tokens: 9999 -> 1-10k");
  ok(tokensBucket(10_000) === "10-100k", "tokens: 10000 -> 10-100k (boundary)");
  ok(tokensBucket(99_999) === "10-100k", "tokens: 99999 -> 10-100k");
  ok(tokensBucket(100_000) === "100k-1M", "tokens: 100000 -> 100k-1M (boundary)");
  ok(tokensBucket(999_999) === "100k-1M", "tokens: 999999 -> 100k-1M");
  ok(tokensBucket(1_000_000) === ">1M", "tokens: 1000000 -> >1M (boundary)");

  ok(stepsBucket(1) === "1", "steps: 1 -> 1");
  ok(stepsBucket(2) === "2-5", "steps: 2 -> 2-5 (boundary)");
  ok(stepsBucket(5) === "2-5", "steps: 5 -> 2-5");
  ok(stepsBucket(6) === "6-20", "steps: 6 -> 6-20 (boundary)");
  ok(stepsBucket(20) === "6-20", "steps: 20 -> 6-20");
  ok(stepsBucket(21) === ">20", "steps: 21 -> >20 (boundary)");

  ok(latencyBucket(4_999) === "<5s", "latency: 4999ms -> <5s");
  ok(latencyBucket(5_000) === "5-15s", "latency: 5000ms -> 5-15s (boundary)");
  ok(latencyBucket(14_999) === "5-15s", "latency: 14999ms -> 5-15s");
  ok(latencyBucket(15_000) === "15-60s", "latency: 15000ms -> 15-60s (boundary)");
  ok(latencyBucket(59_999) === "15-60s", "latency: 59999ms -> 15-60s");
  ok(latencyBucket(60_000) === "1-5m", "latency: 60000ms -> 1-5m (boundary)");
  ok(latencyBucket(299_999) === "1-5m", "latency: 299999ms -> 1-5m");
  ok(latencyBucket(300_000) === ">5m", "latency: 300000ms -> >5m (boundary)");

  ok(domainsBucket(0) === "0", "domains: 0 -> 0");
  ok(domainsBucket(1) === "1", "domains: 1 -> 1");
  ok(domainsBucket(2) === "2-5", "domains: 2 -> 2-5 (boundary)");
  ok(domainsBucket(5) === "2-5", "domains: 5 -> 2-5");
  ok(domainsBucket(6) === "6+", "domains: 6 -> 6+ (boundary)");
}

{
  clearTelemetryEnv();
  const { calls, impl } = fakeFetch();
  __resetTelemetryForTest({ fetchImpl: impl });
  __setInstanceForTest({ id: "instance-envelope", ephemeral: false });

  emitTelemetry("oe.turn.completed", {
    "oe.surface": "slack",
    "oe.kind": "channel",
    "gen_ai.request.model": "zai/glm-5.2",
    "oe.tokens.bucket": "1-10k",
    "oe.steps.bucket": "1",
    "oe.latency.bucket": "<5s",
  });
  await flushTelemetry();

  ok(calls.length === 1, "envelope: exactly one POST for one flush");
  const body = calls[0].body as {
    resourceLogs: { resource: { attributes: { key: string; value: unknown }[] }; scopeLogs: { logRecords: { eventName: string; timeUnixNano: string; attributes: { key: string; value: unknown }[] }[] }[] }[];
  };
  const resourceLogs = body.resourceLogs[0];
  const attrKeys = resourceLogs.resource.attributes.map((a) => a.key);
  ok(attrKeys.includes("service.instance.id"), "envelope: resource attrs include service.instance.id");
  ok(attrKeys.includes("service.name"), "envelope: resource attrs include service.name");
  ok(attrKeys.includes("deployment.environment.name"), "envelope: resource attrs include deployment.environment.name");

  const record = resourceLogs.scopeLogs[0].logRecords[0];
  ok(record.eventName === "oe.turn.completed", "envelope: eventName field carries the event name");
  ok(/^\d+$/.test(record.timeUnixNano), "envelope: timeUnixNano is a decimal string (int64-as-string, OTLP 1.10.0)");
  const recordKeys = record.attributes.map((a) => a.key);
  ok(recordKeys.includes("oe.surface") && recordKeys.includes("gen_ai.request.model"), "envelope: event attributes present");

  clearTelemetryEnv();
  __resetTelemetryForTest();
}

{
  const EXPECTED_SCHEMA: Record<string, readonly string[]> = {
    "oe.instance.first_boot": [],
    "oe.instance.heartbeat": [
      "oe.surfaces",
      "oe.memory_provider",
      "oe.operational_provider",
      "oe.model.primary",
      "oe.model.utility",
      "oe.domains.bucket",
      "oe.telemetry.dropped",
    ],
    "oe.turn.completed": ["oe.surface", "oe.kind", "gen_ai.request.model", "oe.tokens.bucket", "oe.steps.bucket", "oe.latency.bucket"],
    "oe.turn.failed": ["oe.surface", "oe.error.code"],
    "oe.error.uncaught": ["oe.component", "oe.error.name"],
    "oe.feature.used": ["oe.feature", "oe.outcome"],
    "wizard.started": ["oe.wizard.version", "oe.wizard.platform"],
    "wizard.completed": ["oe.wizard.version", "oe.wizard.platform", "oe.wizard.steps_completed"],
  };
  ok(Object.keys(EVENT_SCHEMA).sort().join(",") === Object.keys(EXPECTED_SCHEMA).sort().join(","), "vocabulary: event NAMES match the plan exactly");
  for (const [event, attrs] of Object.entries(EXPECTED_SCHEMA)) {
    ok(
      JSON.stringify([...EVENT_SCHEMA[event]].sort()) === JSON.stringify([...attrs].sort()),
      `vocabulary: "${event}" attributes match the plan exactly`,
    );
  }

  clearTelemetryEnv();
  const { calls, impl } = fakeFetch();
  __resetTelemetryForTest({ fetchImpl: impl });
  __setInstanceForTest({ id: "instance-vocab", ephemeral: false });

  emitTelemetry("oe.totally.made.up", { anything: "x" });
  ok(__queueLengthForTest() === 0, "vocabulary: an unregistered event name is dropped whole");

  emitTelemetry("oe.feature.used", { "oe.feature": "skill_created", "oe.outcome": "ok", "oe.surfaceKey": "slack/T1/C1" });
  ok(__queueLengthForTest() === 1, "vocabulary: the event itself still sends with the bad key stripped");
  await flushTelemetry();
  const sentKeys = ((calls[0].body as { resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string }[] }[] }[] }[] }).resourceLogs[0]
    .scopeLogs[0].logRecords[0].attributes ?? []).map((a) => a.key);
  ok(!sentKeys.includes("oe.surfaceKey"), "vocabulary: the out-of-schema attribute never reached the wire");
  ok(sentKeys.includes("oe.feature") && sentKeys.includes("oe.outcome"), "vocabulary: the allowed attributes still reached the wire");

  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const scanRoots = [
    path.join(repoRoot, "packages/core/agent"),
    path.join(repoRoot, "packages/adapters/agent"),
    path.join(repoRoot, "agent"),
    path.join(repoRoot, "packages/create/src"),
  ];

  function walk(dir: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (e.isFile() && e.name.endsWith(".ts")) out.push(full);
    }
  }

  function extractBalancedParen(text: string, openIdx: number): string {
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) return text.slice(openIdx, i + 1);
      }
    }
    return text.slice(openIdx);
  }

  function scanEmitTelemetryCalls(source: string): { eventName: string; keys: string[] }[] {
    const found: { eventName: string; keys: string[] }[] = [];
    const callRe = /emitTelemetry\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(source))) {
      const openParenIdx = m.index + "emitTelemetry".length;
      const call = extractBalancedParen(source, openParenIdx);
      const inner = call.slice(1, -1);
      const eventMatch = /^\s*"([^"]+)"/.exec(inner);
      if (!eventMatch) continue;
      const eventName = eventMatch[1];
      const rest = inner.slice((eventMatch.index ?? 0) + eventMatch[0].length);
      const keys = [...rest.matchAll(/"([a-zA-Z0-9_.]+)"\s*:/g)].map((mm) => mm[1]);
      found.push({ eventName, keys });
    }
    return found;
  }

  const files: string[] = [];
  for (const root of scanRoots) walk(root, files);
  ok(files.length > 0, "vocabulary scan: found source files to scan (the roots resolved)");

  let sitesScanned = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const site of scanEmitTelemetryCalls(source)) {
      sitesScanned++;
      const allowed = EVENT_SCHEMA[site.eventName];
      ok(allowed !== undefined, `vocabulary scan: ${path.relative(repoRoot, file)} emits a registered event ("${site.eventName}")`);
      if (!allowed) continue;
      for (const key of site.keys) {
        ok(allowed.includes(key), `vocabulary scan: ${path.relative(repoRoot, file)}'s "${site.eventName}" attribute "${key}" is inside its closed vocabulary`);
      }
    }
  }
  ok(sitesScanned > 0, "vocabulary scan: found at least one real emitTelemetry(...) call site to check");

  clearTelemetryEnv();
  __resetTelemetryForTest();
}

{
  clearTelemetryEnv();
  __resetTelemetryForTest({ fetchImpl: throwingFetch() });
  __setInstanceForTest({ id: "instance-fail", ephemeral: false });

  let threw = false;
  try {
    emitTelemetry("oe.error.uncaught", { "oe.component": "process", "oe.error.name": "RangeError" });
    await flushTelemetry();
  } catch {
    threw = true;
  }
  ok(!threw, "a throwing fetch never propagates out of emit/flush");
  ok(droppedTelemetryCount() > 0, "a failed flush counts the batch as dropped");
  ok(__queueLengthForTest() === 0, "the queue is cleared even when the flush fails (never retried forever)");

  clearTelemetryEnv();
  __resetTelemetryForTest();
}

{
  clearTelemetryEnv();
  const tmpPath = path.join(os.tmpdir(), `oe-telemetry-test-${process.pid}-${Date.now()}.sqlite3`);
  process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
  process.env.OE_SQLITE_PATH = tmpPath;
  resetOperationalStore();
  _resetOperationalDbForTest();

  try {
    let { calls, impl } = fakeFetch();
    __resetTelemetryForTest({ fetchImpl: impl });
    await initTelemetry();
    ok(__queueLengthForTest() === 0, "first boot: nothing queued");
    await flushTelemetry();
    ok(calls.length === 0, "first boot: no transport call at all");

    ({ calls, impl } = fakeFetch());
    __resetTelemetryForTest({ fetchImpl: impl });
    await initTelemetry();
    await flushTelemetry();
    ok(calls.length === 1, "second boot: exactly one flush POST");
    const eventNames = (
      (calls[0].body as { resourceLogs: { scopeLogs: { logRecords: { eventName: string }[] }[] }[] }).resourceLogs[0].scopeLogs[0]
        .logRecords
    ).map((r) => r.eventName);
    ok(eventNames.includes("oe.instance.first_boot"), "second boot: the deferred first_boot event fires now");

    ({ calls, impl } = fakeFetch());
    __resetTelemetryForTest({ fetchImpl: impl });
    __setLastHeartbeatForTest(Date.now());
    await initTelemetry();
    maybeHeartbeat();
    await flushTelemetry();
    ok(calls.length === 0, "third boot: first_boot never re-fires, and the throttled heartbeat stays quiet");
  } finally {
    delete process.env.OE_OPERATIONAL_PROVIDER;
    delete process.env.OE_SQLITE_PATH;
    resetOperationalStore();
    _resetOperationalDbForTest();
    try {
      fs.unlinkSync(tmpPath);
    } catch {
    }
    clearTelemetryEnv();
    __resetTelemetryForTest();
  }
}

console.log(`✓ ${n} telemetry assertions passed`);
