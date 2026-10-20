import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  EVENT_SCHEMA,
  FEATURE_VALUES,
  OUTCOME_VALUES,
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
  registerSurfaceCredentialProbe,
  __resetTelemetryForTest,
  __queueLengthForTest,
  __setInstanceForTest,
  __setLastHeartbeatForTest,
} from "../agent/observability/telemetry.js";
import { resetOperationalStore } from "../agent/operational/provider.js";
import { getSettings, overrideSettingsForTest, registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";
import { _resetOperationalDbForTest } from "../agent/operational/sqlite.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const TELEMETRY_ENV = ["OE_TELEMETRY", "DO_NOT_TRACK", "OE_TELEMETRY_DEBUG", "OE_TELEMETRY_OTLP_URL", "OE_TELEMETRY_OTLP_HEADERS"];
function clearTelemetryEnv(): void {
  for (const key of TELEMETRY_ENV) delete process.env[key];
  resetSettingsForTest();
}
function tele(t: { enabled?: boolean; debug?: boolean; url?: string }): void {
  overrideSettingsForTest({ telemetry: t });
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
  tele({ url: "https://example.test/v1/logs" });
  __resetTelemetryForTest();
  ok(telemetryEnabled(), "URL alone -> still enabled");
  ok(telemetryStatusLine() === "on (custom endpoint)", "URL alone -> custom endpoint status line");

  clearTelemetryEnv();
  process.env.DO_NOT_TRACK = "1";
  tele({ url: "https://example.test/v1/logs" });
  __resetTelemetryForTest();
  ok(!telemetryEnabled(), "DO_NOT_TRACK wins over a configured URL");

  clearTelemetryEnv();
  tele({ enabled: false });
  process.env.DO_NOT_TRACK = "0";
  __resetTelemetryForTest();
  ok(!telemetryEnabled(), "telemetry.enabled: false disables even with DO_NOT_TRACK=0");

  clearTelemetryEnv();
  tele({ enabled: false, url: "https://example.test/v1/logs" });
  __resetTelemetryForTest();
  ok(!telemetryEnabled(), "telemetry.enabled: false wins over a configured URL (the full precedence order)");
  ok(telemetryStatusLine() === "off", '"off" status line when disabled');

  clearTelemetryEnv();
  process.env.OE_TELEMETRY = "off";
  process.env.OE_TELEMETRY_OTLP_URL = "https://example.test/v1/logs";
  __resetTelemetryForTest();
  ok(telemetryEnabled(), "🔴 a stale OE_TELEMETRY=off does not disable telemetry (the setting decides)");
  ok(telemetryStatusLine() === "on (default collector)", "🔴 …and a stale OE_TELEMETRY_OTLP_URL is not a redirect");

  clearTelemetryEnv();
  __resetTelemetryForTest();
}

{
  clearTelemetryEnv();
  tele({ debug: true });
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
  const DOCUMENTED_RESOURCE_KEYS = [
    "deployment.environment.name",
    "oe.host",
    "oe.instance.ephemeral",
    "oe.node.major",
    "service.instance.id",
    "service.name",
    "service.version",
  ];
  const sentResourceKeys = async (ephemeral: boolean): Promise<string[]> => {
    clearTelemetryEnv();
    const { calls, impl } = fakeFetch();
    __resetTelemetryForTest({ fetchImpl: impl });
    __setInstanceForTest({ id: "instance-resource", ephemeral });
    emitTelemetry("oe.turn.failed", { "oe.surface": "slack", "oe.error.code": "x" });
    await flushTelemetry();
    const body = calls[0]?.body as { resourceLogs: { resource: { attributes: { key: string }[] } }[] } | undefined;
    clearTelemetryEnv();
    __resetTelemetryForTest();
    return (body?.resourceLogs[0]?.resource.attributes ?? []).map((a) => a.key).sort();
  };
  assert.deepEqual(await sentResourceKeys(true), DOCUMENTED_RESOURCE_KEYS, "resource: an ephemeral instance sends exactly the seven documented keys");
  n++;
  assert.deepEqual(
    await sentResourceKeys(false),
    DOCUMENTED_RESOURCE_KEYS.filter((k) => k !== "oe.instance.ephemeral"),
    "resource: a durable instance sends the six others and omits oe.instance.ephemeral",
  );
  n++;
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
    "oe.turn.first_output": ["oe.surface", "oe.kind", "oe.latency.bucket"],
    "oe.turn.failed": ["oe.surface", "oe.error.code"],
    "oe.error.uncaught": ["oe.component", "oe.error.name"],
    "oe.feature.used": ["oe.feature", "oe.outcome"],
    "oe.audit.dropped": ["oe.action", "oe.platform"],
    "oe.reaction.added": ["oe.surface", "oe.on_bot_reply", "oe.emoji_class"],
    "oe.reaction.removed": ["oe.surface", "oe.on_bot_reply", "oe.emoji_class"],
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

  const calls0 = (captured: readonly { body: unknown }[]): { key: string; value: unknown }[] | undefined =>
    (captured[0]?.body as { resourceLogs?: { scopeLogs: { logRecords: { attributes?: { key: string; value: unknown }[] }[] }[] }[] } | undefined)
      ?.resourceLogs?.[0]?.scopeLogs[0]?.logRecords[0]?.attributes;

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

  {
    clearTelemetryEnv();
    const { calls: valueCalls, impl: valueImpl } = fakeFetch();
    __resetTelemetryForTest({ fetchImpl: valueImpl });
    __setInstanceForTest({ id: "instance-values", ephemeral: false });

    const undeclared: string = "err_ENOTFOUND";
    emitTelemetry("oe.feature.used", { "oe.feature": "skill_created", "oe.outcome": undeclared });
    ok(__queueLengthForTest() === 1, "values: the EVENT still sends — a slip loses one attribute, not a whole count");
    await flushTelemetry();
    const attrs = (calls0(valueCalls) ?? []).reduce<Record<string, string>>((acc, a) => {
      acc[a.key] = JSON.stringify(a.value);
      return acc;
    }, {});
    ok(attrs["oe.outcome"] === undefined, "values: an undeclared oe.outcome never reaches the wire");
    ok(attrs["oe.feature"] !== undefined, "values: …while the declared oe.feature on the same event still does");

    const declared: string = "failed";
    __resetTelemetryForTest({ fetchImpl: valueImpl });
    __setInstanceForTest({ id: "instance-values", ephemeral: false });
    emitTelemetry("oe.feature.used", { "oe.feature": "skill_created", "oe.outcome": declared });
    await flushTelemetry();
    const okAttrs = (calls0(valueCalls.slice(1)) ?? []).reduce<Record<string, string>>((acc, a) => {
      acc[a.key] = JSON.stringify(a.value);
      return acc;
    }, {});
    ok(okAttrs["oe.outcome"] !== undefined, "values: negative control — a DECLARED value passed by variable still reaches the wire");

    const undeclaredFeature: string = "made_up_feature";
    __resetTelemetryForTest({ fetchImpl: valueImpl });
    __setInstanceForTest({ id: "instance-values", ephemeral: false });
    emitTelemetry("oe.feature.used", { "oe.feature": undeclaredFeature, "oe.outcome": "ok" });
    await flushTelemetry();
    const featureAttrs = (calls0(valueCalls.slice(2)) ?? []).reduce<Record<string, string>>((acc, a) => {
      acc[a.key] = JSON.stringify(a.value);
      return acc;
    }, {});
    ok(featureAttrs["oe.feature"] === undefined, "values: an undeclared oe.feature is refused the same way");
    ok(featureAttrs["oe.outcome"] !== undefined, "values: …and its event still carries the declared outcome");
  }

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

  function literalValuesFor(attr: string, callArgs: string): string[] {
    const re = new RegExp(`"${attr}"\\s*:\\s*"([^"]*)"`, "g");
    return [...callArgs.matchAll(re)].map((m) => m[1]);
  }

  function scanEmitTelemetryCalls(source: string): { eventName: string; keys: string[]; features: string[]; outcomes: string[] }[] {
    const found: { eventName: string; keys: string[]; features: string[]; outcomes: string[] }[] = [];
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
      found.push({ eventName, keys, features: literalValuesFor("oe.feature", rest), outcomes: literalValuesFor("oe.outcome", rest) });
    }
    return found;
  }

  const files: string[] = [];
  for (const root of scanRoots) walk(root, files);
  ok(files.length > 0, "vocabulary scan: found source files to scan (the roots resolved)");

  let sitesScanned = 0;
  const seenFeatures = new Set<string>();
  const seenOutcomes = new Set<string>();
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
      for (const value of site.features) {
        ok(
          (FEATURE_VALUES as readonly string[]).includes(value),
          `vocabulary scan: ${path.relative(repoRoot, file)} emits oe.feature="${value}", which is not in FEATURE_VALUES — ` +
            `add it to agent/observability/telemetry.ts and to the docs/deploy/telemetry.md row, or emit a declared value`,
        );
        seenFeatures.add(value);
      }
      for (const value of site.outcomes) {
        ok(
          (OUTCOME_VALUES as readonly string[]).includes(value),
          `vocabulary scan: ${path.relative(repoRoot, file)} emits oe.outcome="${value}", which is not in OUTCOME_VALUES — ` +
            `add it to agent/observability/telemetry.ts and to the docs/deploy/telemetry.md row, or emit a declared value`,
        );
        seenOutcomes.add(value);
      }
    }
  }
  ok(sitesScanned > 0, "vocabulary scan: found at least one real emitTelemetry(...) call site to check");
  ok(seenFeatures.size > 0 && seenOutcomes.size > 0, "vocabulary scan: the value scan actually captured literal oe.feature/oe.outcome values");

  const DYNAMIC_ONLY_OUTCOMES: Record<string, { readonly sites: readonly string[]; readonly why: string }> = {
    noop: { sites: ["approvals/routine-cancel.ts", "approvals/skill-delete.ts"], why: 'the `cancelled/deleted ? "ok" : "noop"` ternaries' },
    deadline: { sites: ["routines/permission-card-wait.ts"], why: "the routine permission card wait's auto-decline arm" },
    stale: { sites: ["routines/permission-card-wait.ts"], why: "an approval that armed nothing" },
    gone: { sites: ["routines/permission-card-wait.ts"], why: "a card that stopped being answerable" },
    unreadable: { sites: ["routines/permission-card-wait.ts"], why: "a window whose last look at the card failed" },
    unknown: { sites: ["approvals/judge-contradiction.ts"], why: "a contradictJudgeAllow outcome" },
    "not-judge-lift": { sites: ["approvals/judge-contradiction.ts"], why: "a contradictJudgeAllow outcome" },
    "already-recorded": { sites: ["approvals/judge-contradiction.ts"], why: "a contradictJudgeAllow outcome" },
    recorded: { sites: ["approvals/judge-contradiction.ts"], why: "a contradictJudgeAllow outcome" },
  };
  for (const value of FEATURE_VALUES) {
    ok(seenFeatures.has(value), `vocabulary reverse arm: FEATURE_VALUES declares "${value}", which no call site emits — delete it or emit it`);
  }
  for (const value of OUTCOME_VALUES) {
    ok(
      seenOutcomes.has(value) || DYNAMIC_ONLY_OUTCOMES[value] !== undefined,
      `vocabulary reverse arm: OUTCOME_VALUES declares "${value}", which no call site emits as a literal — delete it, ` +
        `or add it to DYNAMIC_ONLY_OUTCOMES naming the site that produces it`,
    );
  }
  for (const [value, excuse] of Object.entries(DYNAMIC_ONLY_OUTCOMES)) {
    ok((OUTCOME_VALUES as readonly string[]).includes(value), `vocabulary reverse arm: DYNAMIC_ONLY_OUTCOMES excuses "${value}", which OUTCOME_VALUES does not declare`);
    ok(
      !seenOutcomes.has(value),
      `vocabulary reverse arm: "${value}" IS emitted as a literal, so its DYNAMIC_ONLY_OUTCOMES excuse is dead weight — delete the excuse`,
    );
    ok(excuse.sites.length > 0, `vocabulary reverse arm: the excuse for "${value}" names at least one producing site`);
    for (const site of excuse.sites) {
      const sitePath = path.join(repoRoot, "packages/core/agent", site);
      ok(fs.existsSync(sitePath), `vocabulary reverse arm: "${value}" is excused by ${site}, which does not exist — the producer moved or went away`);
      if (fs.existsSync(sitePath)) {
        ok(
          fs.readFileSync(sitePath, "utf8").includes(`"${value}"`),
          `vocabulary reverse arm: "${value}" is excused by ${site}, which no longer contains it — delete the value from ` +
            `OUTCOME_VALUES, the operator doc row and this excuse, or point the excuse at the site that produces it now`,
        );
      }
    }
  }

  {
    const foreignSource = [
      'emitTelemetry("oe.feature.used", { "oe.feature": "totally_foreign_feature", "oe.outcome": "totally_foreign_outcome" });',
      'emitTelemetry("oe.feature.used", { "oe.feature": "webhook_received", "oe.outcome": "ok" });',
    ].join("\n");
    const scanned = scanEmitTelemetryCalls(foreignSource);
    ok(scanned.length === 2, `scanner red: the fixture's two call sites are both found (got ${scanned.length})`);
    ok(scanned[0]?.features.includes("totally_foreign_feature"), "scanner red: the foreign oe.feature literal is read off the call site");
    ok(scanned[0]?.outcomes.includes("totally_foreign_outcome"), "scanner red: the foreign oe.outcome literal is read off the call site");
    ok(
      !(FEATURE_VALUES as readonly string[]).includes("totally_foreign_feature") &&
        !(OUTCOME_VALUES as readonly string[]).includes("totally_foreign_outcome"),
      "scanner red: the fixture's values are genuinely outside the declared vocabulary — the membership check REJECTS them",
    );
    ok(
      (FEATURE_VALUES as readonly string[]).includes(scanned[1]?.features[0] ?? "") &&
        (OUTCOME_VALUES as readonly string[]).includes(scanned[1]?.outcomes[0] ?? ""),
      "scanner red: a declared pair on the same fixture is accepted",
    );
  }

  const telemetryDoc = fs.readFileSync(path.join(repoRoot, "docs/deploy/telemetry.md"), "utf8");
  const featureRow = /`oe\.feature` \(bounded enum: ([^)]+)\)/.exec(telemetryDoc);
  const outcomeRow = /`oe\.outcome` \(bounded enum: ([^)]+)\)/.exec(telemetryDoc);
  ok(featureRow !== null, "doc row: docs/deploy/telemetry.md still states the oe.feature enum in the shape this test reads");
  ok(outcomeRow !== null, "doc row: docs/deploy/telemetry.md still states the oe.outcome enum in the shape this test reads");
  ok(
    [...telemetryDoc.matchAll(/`oe\.feature` \(bounded enum:/g)].length === 1,
    "doc row: the oe.feature enum is stated exactly once in docs/deploy/telemetry.md",
  );
  ok(
    [...telemetryDoc.matchAll(/`oe\.outcome` \(bounded enum:/g)].length === 1,
    "doc row: the oe.outcome enum is stated exactly once in docs/deploy/telemetry.md",
  );
  const docListed = (capture: string): string[] => [...capture.matchAll(/`([a-z_-]+)`/g)].map((m) => m[1]).sort();
  if (featureRow) {
    ok(
      docListed(featureRow[1]).join(",") === [...FEATURE_VALUES].sort().join(","),
      `doc row: the oe.feature enum in docs/deploy/telemetry.md must equal FEATURE_VALUES — doc has [${docListed(featureRow[1]).join(", ")}]`,
    );
  }
  if (outcomeRow) {
    ok(
      docListed(outcomeRow[1]).join(",") === [...OUTCOME_VALUES].sort().join(","),
      `doc row: the oe.outcome enum in docs/deploy/telemetry.md must equal OUTCOME_VALUES — doc has [${docListed(outcomeRow[1]).join(", ")}]`,
    );
  }

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
  registerSettings({});

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

{
  type HeartbeatBody = {
    resourceLogs: { scopeLogs: { logRecords: { eventName: string; attributes: { key: string; value: unknown }[] }[] }[] }[];
  };
  async function heartbeatSurfaces(instanceId: string): Promise<string[]> {
    const { calls, impl } = fakeFetch();
    __resetTelemetryForTest({ fetchImpl: impl });
    __setInstanceForTest({ id: instanceId, ephemeral: false });
    __setLastHeartbeatForTest(0);
    maybeHeartbeat();
    await flushTelemetry();
    const body = calls[0].body as HeartbeatBody;
    const record = body.resourceLogs[0].scopeLogs[0].logRecords.find((r) => r.eventName === "oe.instance.heartbeat")!;
    const attr = record.attributes.find((a) => a.key === "oe.surfaces")!;
    return (attr.value as { arrayValue: { values: { stringValue: string }[] } }).arrayValue.values.map((v) => v.stringValue);
  }

  const savedDiscordToken = process.env.DISCORD_BOT_TOKEN;
  const savedGithubAppId = getSettings().github.appId;
  const savedTeamsAppId = getSettings().teams.appId;
  try {
    clearTelemetryEnv();
    overrideSettingsForTest({ teams: { appId: "test-app-id" }, github: { appId: "" } });
    delete process.env.DISCORD_BOT_TOKEN;
    let surfaces = await heartbeatSurfaces("instance-surfaces-a");
    ok(surfaces.includes("teams") === false, "surfaces: teams.appId alone no longer reports teams (core's inline arm is gone)");

    registerSurfaceCredentialProbe("teams", () => getSettings().teams.appId !== "");
    surfaces = await heartbeatSurfaces("instance-surfaces-b");
    ok(surfaces.filter((s) => s === "teams").length === 1, "surfaces: a registered probe reports teams exactly once");

    process.env.DISCORD_BOT_TOKEN = "test-discord-token";
    surfaces = await heartbeatSurfaces("instance-surfaces-c");
    ok(surfaces.includes("discord") === false, "surfaces: DISCORD_BOT_TOKEN alone no longer reports discord (core's inline arm is gone)");

    registerSurfaceCredentialProbe("discord", () => Boolean(process.env.DISCORD_BOT_TOKEN));
    surfaces = await heartbeatSurfaces("instance-surfaces-d");
    ok(surfaces.filter((s) => s === "discord").length === 1, "surfaces: a registered probe reports discord exactly once");

    overrideSettingsForTest({ github: { appId: "test-app-id" } });
    surfaces = await heartbeatSurfaces("instance-surfaces-e");
    ok(surfaces.includes("github") === false, "surfaces: github.appId alone no longer reports github (core's inline arm is gone)");

    registerSurfaceCredentialProbe("github", () => getSettings().github.appId !== "");
    surfaces = await heartbeatSurfaces("instance-surfaces-f");
    ok(surfaces.filter((s) => s === "github").length === 1, "surfaces: a registered probe reports github exactly once");

    registerSurfaceCredentialProbe("discord", () => true);
    surfaces = await heartbeatSurfaces("instance-surfaces-g");
    ok(surfaces.filter((s) => s === "discord").length === 1, "surfaces: replacing an already-registered probe still reports its platform exactly once");

    registerSurfaceCredentialProbe("slack", async () => true);
    registerSurfaceCredentialProbe("linear", async () => false);
    registerSurfaceCredentialProbe("github", async () => {
      throw new Error("store unreachable");
    });
    surfaces = await heartbeatSurfaces("instance-surfaces-h");
    ok(surfaces.includes("slack"), "surfaces: an async probe that resolves true reports its surface");
    ok(!surfaces.includes("linear"), "surfaces: an async probe that resolves false does NOT report its surface (a Promise is not a yes)");
    ok(!surfaces.includes("github"), "surfaces: a rejecting async probe reports absent, and the heartbeat still sends");

    registerSurfaceCredentialProbe("teams", () => new Promise<boolean>(() => {}));
    const started = Date.now();
    surfaces = await heartbeatSurfaces("instance-surfaces-i");
    const waited = Date.now() - started;
    ok(!surfaces.includes("teams"), "surfaces: a probe that never settles reports absent");
    ok(surfaces.includes("slack"), "surfaces: a hung probe does not cost the other surfaces their answers");
    ok(waited < 10_000, `surfaces: a hung probe delays the heartbeat by its bound only (waited ${waited} ms)`);
  } finally {
    registerSurfaceCredentialProbe("teams", () => false);
    if (savedDiscordToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = savedDiscordToken;
    overrideSettingsForTest({ github: { appId: savedGithubAppId }, teams: { appId: savedTeamsAppId } });
    clearTelemetryEnv();
    __resetTelemetryForTest();
  }
}

{
  const { AsyncLocalStorage } = await import("node:async_hooks");
  class FakeSession {
    private readonly store = new Map<string, unknown>();
    get<T>(key: { name: string }): T | undefined {
      return this.store.get(key.name) as T | undefined;
    }
    has(key: { name: string }): boolean {
      return this.store.has(key.name);
    }
    require<T>(key: { name: string }): T {
      if (!this.has(key)) throw new Error(`missing ${key.name}`);
      return this.get(key) as T;
    }
    set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
      const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
      this.store.set(key.name, next);
      return next;
    }
    ensure<T>(key: { name: string }, create: () => T): T {
      return this.has(key) ? this.require(key) : this.set(key, create());
    }
    clearVirtualContext(): void {}
    setVirtualContext(): void {}
    *entries(): Generator<readonly [unknown, unknown]> {}
  }
  function eveContextStorage(): InstanceType<typeof AsyncLocalStorage<unknown>> {
    const g = globalThis as Record<PropertyKey, unknown>;
    const key = Symbol.for("eve.context-storage");
    g[key] ??= new AsyncLocalStorage();
    return g[key] as InstanceType<typeof AsyncLocalStorage<unknown>>;
  }
  const inSession = async <T>(fn: () => T | Promise<T>): Promise<T> => eveContextStorage().run(new FakeSession(), fn);

  const hookModule = (await import("../agent/hooks/telemetry.js")) as {
    default: { events: Record<string, (event: unknown, ctx: unknown) => Promise<void>> };
  };
  const events = hookModule.default.events;
  const stepCompleted = events["step.completed"];
  const turnStarted = events["turn.started"];
  ok(typeof stepCompleted === "function" && typeof turnStarted === "function", "first-output: the shipped hook really registers turn.started and step.completed");

  const ctx = { session: { id: "s-first-output", auth: { current: { attributes: {} } } } };

  function firstOutputRows(captured: readonly { body: Record<string, unknown> }[]): { keys: string[]; latency: string | undefined }[] {
    const rows: { keys: string[]; latency: string | undefined }[] = [];
    for (const call of captured) {
      const body = call.body as {
        resourceLogs?: { scopeLogs: { logRecords: { eventName: string; attributes?: { key: string; value: { stringValue?: string } }[] }[] }[] }[];
      };
      for (const rl of body.resourceLogs ?? []) {
        for (const sl of rl.scopeLogs) {
          for (const record of sl.logRecords) {
            if (record.eventName !== "oe.turn.first_output") continue;
            const attrs = record.attributes ?? [];
            rows.push({
              keys: attrs.map((a) => a.key),
              latency: attrs.find((a) => a.key === "oe.latency.bucket")?.value?.stringValue,
            });
          }
        }
      }
    }
    return rows;
  }

  clearTelemetryEnv();
  const { calls, impl } = fakeFetch();
  __resetTelemetryForTest({ fetchImpl: impl });
  __setInstanceForTest({ id: "instance-first-output", ephemeral: false });
  try {
    await inSession(async () => {
      await turnStarted({ data: { turnId: "turn_0" } }, ctx);
      await flushTelemetry();
      ok(firstOutputRows(calls).length === 0, "🔴 first-output: a started turn with NO completed step has emitted nothing yet");

      await stepCompleted({ data: { usage: { inputTokens: 10, outputTokens: 3 } } }, ctx);
      await flushTelemetry();
      const afterOne = firstOutputRows(calls);
      ok(afterOne.length === 1, "🔴 first-output: the turn's FIRST completed step emits exactly one oe.turn.first_output row");
      ok(
        JSON.stringify([...(afterOne[0]?.keys ?? [])].sort()) === JSON.stringify(["oe.kind", "oe.latency.bucket", "oe.surface"]),
        "first-output: the row carries exactly its three declared attributes and nothing else",
      );
      ok(
        (EVENT_SCHEMA["oe.turn.first_output"] ?? []).includes("oe.latency.bucket") && afterOne[0]?.latency === latencyBucket(0),
        "first-output: the latency is a declared BUCKET, not a raw millisecond count — a fresh turn buckets at the floor",
      );

      await stepCompleted({ data: { usage: { outputTokens: 40 } } }, ctx);
      await stepCompleted({ data: { usage: { outputTokens: 5 } } }, ctx);
      await flushTelemetry();
      ok(firstOutputRows(calls).length === 1, "🔴 first-output: later steps of the SAME turn emit nothing more — one row per turn");

      await turnStarted({ data: { turnId: "turn_1" } }, ctx);
      await stepCompleted({ data: { usage: { outputTokens: 7 } } }, ctx);
      await flushTelemetry();
      ok(firstOutputRows(calls).length === 2, "🔴 first-output: the NEXT turn on the same session reports its own first output");

      const { readTurnClock } = await import("../agent/observability/turn-clock.js");
      await turnStarted({ data: { turnId: "turn_2" } }, ctx);
      await stepCompleted({ data: { usage: { inputTokens: 9_000, outputTokens: 500, cacheReadTokens: 8_000, cacheWriteTokens: 500 } } }, ctx);
      ok(readTurnClock()?.tokens === 9_500, `🔴 turn clock: a cache-heavy step counts inputTokens + outputTokens, never the cache subsets again (got ${readTurnClock()?.tokens})`);
    });
  } finally {
    clearTelemetryEnv();
    __resetTelemetryForTest();
  }
}

{
  clearTelemetryEnv();
  const lines: string[] = [];
  const realLog = console.log;
  console.log = ((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  }) as typeof console.log;
  const tmpPath = path.join(os.tmpdir(), `oe-telemetry-boot-${process.pid}-${Date.now()}.sqlite3`);
  process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
  process.env.OE_SQLITE_PATH = tmpPath;
  resetOperationalStore();
  _resetOperationalDbForTest();
  try {
    const disclosures = () => lines.filter((l) => l.includes("anonymous usage telemetry is"));
    const { calls, impl } = fakeFetch();

    resetSettingsForTest();
    __resetTelemetryForTest({ fetchImpl: impl });
    await initTelemetry();
    ok(disclosures().length === 0, "🔴 boot: initTelemetry before the registration prints NO disclosure line (it would print the shipped ON)");
    emitTelemetry("oe.feature.used", { "oe.feature": "agent_created", "oe.outcome": "ok" });
    ok(disclosures().length === 0, "boot: an emit before the registration does not start the module either");
    registerSettings({ telemetry: { enabled: false } });
    __setInstanceForTest({ id: "boot-off", ephemeral: false });
    emitTelemetry("oe.feature.used", { "oe.feature": "agent_created", "oe.outcome": "ok" });
    ok(disclosures().length === 1 && disclosures()[0]!.includes("is OFF (telemetry.enabled / DO_NOT_TRACK)"), "🔴 the first emit after the registration prints the OFF line the deployment declared");
    await flushTelemetry();
    ok(calls.length === 0 && __queueLengthForTest() === 0, "…and nothing is queued or sent");
    emitTelemetry("oe.feature.used", { "oe.feature": "agent_created", "oe.outcome": "ok" });
    ok(disclosures().length === 1, "…and the line prints once per process, not once per emit");

    lines.length = 0;
    resetSettingsForTest();
    __resetTelemetryForTest({ fetchImpl: impl });
    await initTelemetry();
    ok(disclosures().length === 0, "boot (on): still nothing before the registration");
    registerSettings({});
    maybeHeartbeat();
    ok(disclosures().length === 1 && disclosures()[0]!.includes("is ON") && disclosures()[0]!.includes("telemetry.enabled: false or DO_NOT_TRACK=1 disables"), "the first heartbeat after the registration prints the ON line, naming the setting");

    lines.length = 0;
    __resetTelemetryForTest({ fetchImpl: impl });
    emitTelemetry("oe.feature.used", { "oe.feature": "agent_created", "oe.outcome": "ok" });
    ok(disclosures().length === 0, "a module that initTelemetry never armed prints nothing (scripts and tests stay quiet)");
  } finally {
    console.log = realLog;
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

{
  clearTelemetryEnv();
  process.env.OE_TELEMETRY_OTLP_HEADERS = "authorization=Bearer acme-collector-token,x-tenant=acme";
  const record = () => emitTelemetry("oe.feature.used", { "oe.feature": "agent_created", "oe.outcome": "ok" });

  const toDefault = fakeFetch();
  __resetTelemetryForTest({ fetchImpl: toDefault.impl });
  __setInstanceForTest({ id: "instance-headers", ephemeral: false });
  record();
  await flushTelemetry();
  ok(toDefault.calls.length === 1 && toDefault.calls[0]!.url === DEFAULT_TELEMETRY_URL, "default collector: the batch goes to the default URL");
  ok(toDefault.calls[0]!.headers.authorization === undefined && toDefault.calls[0]!.headers["x-tenant"] === undefined, "🔴 default collector: the operator's collector headers are NEVER sent there");

  tele({ url: "https://otel.acme.example/v1/logs" });
  const toRedirect = fakeFetch();
  __resetTelemetryForTest({ fetchImpl: toRedirect.impl });
  __setInstanceForTest({ id: "instance-headers", ephemeral: false });
  record();
  await flushTelemetry();
  ok(toRedirect.calls.length === 1 && toRedirect.calls[0]!.url === "https://otel.acme.example/v1/logs", "redirect: the batch goes to the operator's collector");
  ok(toRedirect.calls[0]!.headers.authorization === "Bearer acme-collector-token" && toRedirect.calls[0]!.headers["x-tenant"] === "acme", "redirect: the headers from the operator secret ride the request");

  delete process.env.OE_TELEMETRY_OTLP_HEADERS;
  const later = fakeFetch();
  __resetTelemetryForTest({ fetchImpl: later.impl });
  __setInstanceForTest({ id: "instance-headers", ephemeral: false });
  record();
  await flushTelemetry();
  ok(later.calls.length === 1 && later.calls[0]!.headers.authorization === undefined, "redirect, no secret yet: no auth header");
  process.env.OE_TELEMETRY_OTLP_HEADERS = "authorization=Bearer later-token";
  record();
  await flushTelemetry();
  ok(later.calls.length === 2 && later.calls[1]!.headers.authorization === "Bearer later-token", "🔴 a secret that appears later reaches the NEXT flush");

  clearTelemetryEnv();
  __resetTelemetryForTest();
}

console.log(`✓ ${n} telemetry assertions passed`);

// proves: SET-102, SET-103, SET-104
