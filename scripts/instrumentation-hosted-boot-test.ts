import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPS = {
  reference: join(REPO, "agent"),
  template: join(REPO, "packages", "create", "template", "agent"),
} as const;
type AppName = keyof typeof APPS;
const AGENT_NAME = "open-everywhere";
const REPORT_PREFIX = "OE_INSTRUMENTATION_BOOT=";
const TSX = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

interface PolicyRow {
  readonly audience: string;
  readonly environment: string;
  readonly action: string;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

interface BootReport {
  readonly booted: boolean;
  readonly error?: string;
  readonly slots: readonly string[];
  readonly ownsAgentSpans: boolean;
  readonly processCaptureBefore: number;
  readonly processCaptureAfter: number;
  readonly policyDeclared: boolean;
  readonly policy: readonly PolicyRow[];
  readonly defaultPolicyPublicProduction: PolicyRow;
  readonly probeSpan: string;
}

async function child(app: AppName, traceDrains: boolean): Promise<void> {
  const eveSrc = dirname(createRequire(import.meta.url).resolve("eve"));
  const load = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(join(eveSrc, rel)).href)) as T;
  const layoutModule = await load<{ resolveInstrumentationLayout(i: { agentRoot: string }): { modulePathsBySlot: Record<string, string> } }>(
    "internal/instrumentation-layout.js",
  );
  const providers = await load<{
    seedInstrumentationProviders(): void;
    registerInstrumentationProvider(i: { agentName: string; slot: string; value: unknown }): Promise<void>;
    finalizeInstrumentationProviders(i: { serviceName: string }): void;
    getInstrumentationProviders(): { slot: string }[];
    shutdownInstrumentationProviders(): Promise<void>;
  }>("instrumentation/providers.js");
  const runtimeModule = await load<{
    getInstrumentationRuntime(): { ownsAgentSpans?: boolean; otelSettings?: { tracePolicy?: unknown }; forceFlush(): Promise<void> } | undefined;
  }>("instrumentation/runtime.js");
  const policyModule = await load<{ resolveTracePolicy(policy: unknown, ctx: Record<string, unknown>): Record<string, unknown> }>(
    "shared/trace-policy.js",
  );
  const api = await load<{ trace: { getTracer(n: string): { startSpan(n: string): { end(): void } } } }>("compiled/@opentelemetry/api/index.js");

  const processCaptureBefore = process.listenerCount("uncaughtExceptionMonitor");
  let booted = false;
  let error: string | undefined;
  try {
    const layout = layoutModule.resolveInstrumentationLayout({ agentRoot: APPS[app] });
    providers.seedInstrumentationProviders();
    for (const [slot, path] of Object.entries(layout.modulePathsBySlot)) {
      const value = ((await import(pathToFileURL(path).href)) as { default: unknown }).default;
      await providers.registerInstrumentationProvider({ agentName: AGENT_NAME, slot, value });
    }
    providers.finalizeInstrumentationProviders({ serviceName: AGENT_NAME });
    booted = true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const runtime = runtimeModule.getInstrumentationRuntime();
  const tracePolicy = runtime?.otelSettings?.tracePolicy;
  const row = (policy: unknown, audience: string, environment: string): PolicyRow => {
    const d = policyModule.resolveTracePolicy(policy, { agentName: AGENT_NAME, audience, environment, principalType: "user" });
    return { audience, environment, action: String(d.action), recordInputs: d.recordInputs === true, recordOutputs: d.recordOutputs === true };
  };
  const policy: PolicyRow[] = [];
  for (const audience of ["public", "private", "unknown"]) {
    for (const environment of ["development", "preview", "production"]) policy.push(row(tracePolicy, audience, environment));
  }

  const probeSpan = `oe-otlp-probe-${process.pid}`;
  if (booted) {
    if (traceDrains) {
      (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] = {
        get: () => ({ headers: {}, url: "/", waitUntil: (task: () => Promise<unknown>) => void task().catch(() => undefined), telemetry: { traceDrains: [{}], reportSpans: () => undefined } }),
      };
    }
    api.trace.getTracer("oe.instrumentation-boot-test").startSpan(probeSpan).end();
    await runtime?.forceFlush();
    await providers.shutdownInstrumentationProviders();
  }

  const report: BootReport = {
    booted,
    ...(error === undefined ? {} : { error }),
    slots: providers.getInstrumentationProviders().map((p) => p.slot),
    ownsAgentSpans: runtime?.ownsAgentSpans === true,
    processCaptureBefore,
    processCaptureAfter: process.listenerCount("uncaughtExceptionMonitor"),
    policyDeclared: typeof tracePolicy === "function",
    policy,
    defaultPolicyPublicProduction: row(undefined, "public", "production"),
    probeSpan,
  };
  process.stdout.write(`\n${REPORT_PREFIX}${JSON.stringify(report)}\n`);
  process.exit(0);
}

interface Received {
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

function childEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LANG", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.DO_NOT_TRACK = "1";
  env.NODE_NO_WARNINGS = "1";
  return { ...env, ...extra };
}

function runChild(app: AppName, extra: Readonly<Record<string, string>>, traceDrains = false): Promise<BootReport> {
  return new Promise((done, fail) => {
    const args = [TSX, fileURLToPath(import.meta.url), "--child", app, ...(traceDrains ? ["--trace-drains"] : [])];
    const proc = spawn(process.execPath, args, {
      cwd: REPO,
      env: childEnv(extra),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    proc.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    proc.on("error", fail);
    proc.on("close", (code) => {
      const line = out.split(/\r?\n/).find((l) => l.startsWith(REPORT_PREFIX));
      if (line === undefined) {
        fail(new Error(`child ${app} exited ${code} with no report.\nstdout:\n${out.slice(-2000)}\nstderr:\n${err.slice(-2000)}`));
        return;
      }
      done(JSON.parse(line.slice(REPORT_PREFIX.length)) as BootReport);
    });
  });
}

function runScript(path: string, extra: Readonly<Record<string, string>>): Promise<{ code: number | null; out: string; tail: string }> {
  return new Promise((done, fail) => {
    const proc = spawn(process.execPath, [TSX, path], { cwd: REPO, env: childEnv(extra), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    proc.stderr.on("data", (b: Buffer) => (out += b.toString("utf8")));
    proc.on("error", fail);
    proc.on("close", (code) => done({ code, out, tail: out.slice(-1500) }));
  });
}

let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  assert.ok(cond, detail === undefined ? label : `${label}\n  got: ${JSON.stringify(detail)}`);
  passed++;
}

function assertBootContract(arm: string, r: BootReport, expectOtlpSlot: boolean): void {
  check(r.booted, `${arm}: eve's registration path completes — no "another runtime already owns the global tracer provider"`, r.error);
  check(r.ownsAgentSpans === true, `${arm}: eve owns the OpenTelemetry pipeline (ownsAgentSpans)`, r);
  check(r.slots.includes("otel"), `${arm}: the app's otel slot registered`, r.slots);
  check(r.slots.includes("otlp") === expectOtlpSlot, `${arm}: the otlp destination slot is ${expectOtlpSlot ? "declared" : "absent"}`, r.slots);
  check(r.processCaptureBefore === 0, `${arm}: negative control — no process capture before the boot`, r.processCaptureBefore);
  check(r.processCaptureAfter > 0, `${arm}: the boot setup ran (log shipping and telemetry init)`, r.processCaptureAfter);
  check(r.policyDeclared === true, `${arm}: the app declares a process-wide trace policy`, r.policyDeclared);
  check(r.policy.length === 9, `${arm}: the policy matrix covers 3 audiences × 3 environments`, r.policy.length);
  for (const p of r.policy) {
    check(p.action === "record" && p.recordInputs === false && p.recordOutputs === false,
      `${arm}: ${p.audience}/${p.environment} — spans are emitted with NO model input and NO model output`, p);
  }
  const d = r.defaultPolicyPublicProduction;
  check(d.recordInputs === true && d.recordOutputs === true, `${arm}: negative control — eve's DEFAULT policy records content for public/production`, d);
}

async function main(): Promise<void> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const vercelCollector = createServer(server.listeners("request")[0] as Parameters<typeof createServer>[0]);
  await new Promise<void>((r) => vercelCollector.listen(0, () => r()));
  const vercelPort = String((vercelCollector.address() as AddressInfo).port);
  const hits = (prefix: string): Received[] => received.filter((h) => h.path.startsWith(prefix));

  try {
    const a = await runChild("reference", { VERCEL: "1", VERCEL_ENV: "production" });
    assertBootContract("A vercel-production", a, false);
    check(a.slots.includes("agent-runs"), "A vercel-production: eve's Agent Runs destination is seeded (the registration that collided)", a.slots);

    const b = await runChild("template", { VERCEL: "1", VERCEL_ENV: "preview" });
    assertBootContract("B vercel-preview template", b, false);
    check(b.slots.includes("agent-runs"), "B vercel-preview template: eve's Agent Runs destination is seeded", b.slots);

    const c = await runChild("reference", { VERCEL: "1", VERCEL_ENV: "production", OTEL_EXPORTER_OTLP_ENDPOINT: `${base}/c` });
    assertBootContract("C vercel-production+otlp", c, true);
    const cHits = hits("/c/v1/traces");
    check(cHits.length > 0, "C vercel-production+otlp: the collector received a trace export at <endpoint>/v1/traces", received.map((h) => h.path));
    check(cHits.some((h) => h.body.includes(Buffer.from(c.probeSpan))), "C vercel-production+otlp: the export carries the probe span", c.probeSpan);
    check(cHits.every((h) => String(h.headers["content-type"]).includes("protobuf")), "C vercel-production+otlp: the default protocol is http/protobuf", cHits.map((h) => h.headers["content-type"]));

    const d = await runChild("template", {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/d/traces`,
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_HEADERS: "x-oe-probe=one%20two,x-oe-other=3",
    });
    assertBootContract("D self-host+otlp", d, true);
    const dHits = hits("/d/traces");
    check(dHits.length > 0, "D self-host+otlp: the collector received a trace export at the traces endpoint, unchanged", received.map((h) => h.path));
    check(dHits.some((h) => h.body.toString("utf8").includes(d.probeSpan)), "D self-host+otlp: the JSON export carries the probe span", d.probeSpan);
    check(dHits.every((h) => h.headers["x-oe-probe"] === "one two" && h.headers["x-oe-other"] === "3"),
      "D self-host+otlp: OTEL_EXPORTER_OTLP_HEADERS reach the collector, percent-decoded", dHits.map((h) => h.headers));
    check(!d.slots.includes("agent-runs"), "D self-host+otlp: no Agent Runs destination off Vercel", d.slots);

    const before = received.length;
    const e = await runChild("reference", {});
    assertBootContract("E local", e, false);
    check(!e.slots.includes("agent-runs"), "E local: no Agent Runs destination", e.slots);
    check(received.length === before, "E local: nothing is exported anywhere", received.length - before);

    const gBefore = received.length;
    const g = await runChild("reference", { VERCEL: "1", VERCEL_ENV: "production", VERCEL_OTEL_ENDPOINTS: "1", VERCEL_OTEL_ENDPOINTS_PORT: vercelPort });
    assertBootContract("G vercel-production+vercel-collector", g, true);
    const gHits = received.slice(gBefore).filter((h) => h.path === "/v1/traces");
    check(gHits.some((h) => h.body.includes(Buffer.from(g.probeSpan))),
      "G vercel-production+vercel-collector: 🔴 OPE-2358 — the probe span reaches Vercel's collector at http://localhost:<VERCEL_OTEL_ENDPOINTS_PORT>/v1/traces",
      received.slice(gBefore).map((h) => h.path));
    check(gHits.every((h) => String(h.headers["content-type"]).includes("protobuf")), "G vercel-production+vercel-collector: the default protocol is http/protobuf",
      gHits.map((h) => h.headers["content-type"]));
    check(g.slots.includes("agent-runs"), "G vercel-production+vercel-collector: the Agent Runs destination stays seeded beside the collector", g.slots);

    const gjBefore = received.length;
    const gj = await runChild("template", {
      VERCEL: "1", VERCEL_ENV: "preview", VERCEL_OTEL_ENDPOINTS: "1", VERCEL_OTEL_ENDPOINTS_PORT: vercelPort, VERCEL_OTEL_ENDPOINTS_PROTOCOL: "http/json",
    });
    assertBootContract("G vercel-preview+vercel-collector template", gj, true);
    const gjHits = received.slice(gjBefore).filter((h) => h.path === "/v1/traces");
    check(gjHits.some((h) => h.body.toString("utf8").includes(gj.probeSpan)) && gjHits.every((h) => String(h.headers["content-type"]).includes("json")),
      "G vercel-preview+vercel-collector template: VERCEL_OTEL_ENDPOINTS_PROTOCOL=http/json sends the probe span as JSON",
      gjHits.map((h) => h.headers["content-type"]));

    const hBefore = received.length;
    const h = await runChild("reference", { VERCEL: "1", VERCEL_ENV: "production", VERCEL_OTEL_ENDPOINTS: "1", VERCEL_OTEL_ENDPOINTS_PORT: vercelPort }, true);
    assertBootContract("H vercel-production+vercel-collector+trace-drains", h, true);
    check(received.length === hBefore, "H vercel-production+vercel-collector+trace-drains: the collector receives nothing — the runtime delivers to the drains",
      received.slice(hBefore).map((r) => r.path));

    const f = await runScript(join(REPO, "scripts", "boot-smoke-test.ts"), { VERCEL: "1", VERCEL_ENV: "production" });
    check(f.code === 0 && f.out.includes("✓ boot-smoke:"), "F vercel-production: every agent module loads clean (test:boot under VERCEL=1, VERCEL_ENV=production)", f.tail);
  } finally {
    server.close();
    vercelCollector.close();
  }
  console.log(`✓ instrumentation-hosted-boot: ${passed} assertions passed (Vercel production/preview, OTLP on Vercel and self-host, Vercel's OTel collector, local, every agent module under the Vercel env)`);
}

const childIndex = process.argv.indexOf("--child");
if (childIndex !== -1) await child(process.argv[childIndex + 1] as AppName, process.argv.includes("--trace-drains"));
else await main();
