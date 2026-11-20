import { trace } from "@opentelemetry/api";
import { otel, otelIntegration } from "eve/instrumentation/otel";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// eve 1.0 no longer exports its brand guards. These read the same cross-instance `Symbol.for`
// brands that eve stamps on `otel()` and `otelIntegration()` values. The controls below prove the
// brands still match eve's own values, so a renamed brand fails here instead of passing silently.
const OTEL_DECLARATION_BRAND = Symbol.for("eve.instrumentation.otel");
const OTEL_INTEGRATION_BRAND = Symbol.for("eve.instrumentation.otel-integration");
const isOtelDeclaration = (v: unknown): boolean => typeof v === "object" && v !== null && Reflect.get(v, OTEL_DECLARATION_BRAND) === true;
const isOtelIntegration = (v: unknown): boolean => typeof v === "object" && v !== null && Reflect.get(v, OTEL_INTEGRATION_BRAND) === true;
ok(isOtelDeclaration(otel({})) && !isOtelIntegration(otel({})), "control: eve's own otel() value carries the declaration brand only");
const controlIntegration = otelIntegration({ spanProcessors: [] });
ok(isOtelIntegration(controlIntegration) && !isOtelDeclaration(controlIntegration), "control: eve's own otelIntegration() value carries the integration brand only");
ok(!isOtelDeclaration({}) && !isOtelIntegration({}), "control: a plain object carries neither brand");

delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
delete process.env.VERCEL_OTEL_ENDPOINTS;
delete process.env.VERCEL_OTEL_ENDPOINTS_PORT;
delete process.env.VERCEL_OTEL_ENDPOINTS_PROTOCOL;
process.env.DO_NOT_TRACK = "1";

const mod = await import("../agent/instrumentation.js");
const declaration = mod.default;

ok(isOtelDeclaration(declaration), "default export is an eve otel() declaration");
ok(!isOtelIntegration(declaration), "default export is not a destination");
ok(typeof declaration.setup === "function", "default export carries the boot setup()");
const providerBefore = trace.getTracerProvider();
declaration.setup?.({ agentName: "open-everywhere", environment: "production", frameworkVersion: "0.71.0" });
ok(trace.getTracerProvider() === providerBefore, "setup() registers no tracer provider — eve owns that (OPE-2262)");

const policy = declaration.options.tracePolicy;
ok(typeof policy === "function", "the declaration sets a tracePolicy");
for (const audience of ["public", "private", "unknown"] as const) {
  for (const environment of ["development", "preview", "production"] as const) {
    const d = policy?.({ agentName: "open-everywhere", audience, environment, principalType: "user" } as never);
    ok(same(d, { emit: true, recordInputs: false, recordOutputs: false }), `🔴 OPE-1798: ${audience}/${environment} — emit, with no model input and no model output`);
  }
}

// proves: ENV-138, ENV-139, ENV-152, ENV-153, ENV-154, ENV-155
ok(mod.resolveOtlpTarget({}) === undefined, "no endpoint → no target");
ok(mod.otlpDestination !== undefined && !isOtelIntegration(mod.otlpDestination), "no endpoint at load → the otlp destination is disabled");
ok(
  same(mod.resolveOtlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.example/otlp/" }), {
    url: "https://c.example/otlp/v1/traces",
    protocol: "http/protobuf",
    headers: {},
  }),
  "general endpoint → `/v1/traces` appended once, http/protobuf by default",
);
ok(
  mod.resolveOtlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://a.example", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://t.example/x" })?.url ===
    "https://t.example/x",
  "the traces endpoint wins over the general one and is used unchanged",
);
ok(
  mod.resolveOtlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://a.example", OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" })?.protocol === "http/json",
  "OTEL_EXPORTER_OTLP_PROTOCOL=http/json selects JSON",
);
ok(
  mod.resolveOtlpTarget({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://a.example",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
  })?.protocol === "http/protobuf",
  "the traces protocol wins over the general one",
);
const warn = console.warn;
let warned = "";
console.warn = (...args: unknown[]) => void (warned += args.join(" "));
const grpc = mod.resolveOtlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://a.example", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" });
console.warn = warn;
ok(grpc?.protocol === "http/protobuf" && warned.includes("grpc"), "grpc is not supported → http/protobuf, with a warning");
ok(
  same(mod.parseOtlpHeaders("Authorization=Bearer%20abc, X-Dataset = d1 ,broken,=v,k=a=b"), { Authorization: "Bearer abc", "X-Dataset": "d1", k: "a=b" }),
  "headers: comma pairs, trimmed, percent-decoded, a value may hold `=`, malformed pairs skipped",
);
ok(same(mod.parseOtlpHeaders(undefined), {}), "headers: unset → none");
ok(
  same(
    mod.resolveOtlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://a.example", OTEL_EXPORTER_OTLP_HEADERS: "a=1,b=2", OTEL_EXPORTER_OTLP_TRACES_HEADERS: "b=3" })?.headers,
    { a: "1", b: "3" },
  ),
  "traces headers override general headers key by key",
);

// proves: ENV-156, ENV-157, ENV-158
ok(mod.resolveVercelCollectorTarget({}) === undefined, "vercel collector: VERCEL_OTEL_ENDPOINTS unset → no target");
ok(
  same(mod.resolveVercelCollectorTarget({ VERCEL_OTEL_ENDPOINTS: "1" }), { url: "http://localhost:4318/v1/traces", protocol: "http/protobuf", headers: {} }),
  "vercel collector: set → http://localhost:4318/v1/traces, http/protobuf by default",
);
ok(
  same(mod.resolveVercelCollectorTarget({ VERCEL_OTEL_ENDPOINTS: "1", VERCEL_OTEL_ENDPOINTS_PORT: "9999", VERCEL_OTEL_ENDPOINTS_PROTOCOL: "http/json" }), {
    url: "http://localhost:9999/v1/traces",
    protocol: "http/json",
    headers: {},
  }),
  "vercel collector: the port and the protocol come from VERCEL_OTEL_ENDPOINTS_PORT and VERCEL_OTEL_ENDPOINTS_PROTOCOL",
);
ok(
  mod.resolveVercelCollectorTarget({ VERCEL_OTEL_ENDPOINTS: "1", VERCEL_OTEL_ENDPOINTS_PROTOCOL: "grpc" })?.protocol === "http/json",
  "vercel collector: a protocol other than http/protobuf selects JSON, as @vercel/otel does",
);
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const slot = globalThis as Record<symbol, unknown>;
ok(mod.vercelTraceDrainsConfigured() === false, "trace drains: no Vercel request context → not configured");
slot[REQUEST_CONTEXT] = { get: () => ({ telemetry: { traceDrains: [] } }) };
ok(mod.vercelTraceDrainsConfigured() === false, "trace drains: an empty drain list → not configured");
slot[REQUEST_CONTEXT] = { get: () => ({ telemetry: { traceDrains: [{}] } }) };
ok(mod.vercelTraceDrainsConfigured() === true, "trace drains: one drain on the request → configured, so the collector skips the span");
delete slot[REQUEST_CONTEXT];

console.log(`✓ instrumentation: ${passed} assertions passed (otel() declaration, metadata-only policy, OTLP env resolution, Vercel's OTel collector)`);
