import { trace } from "@opentelemetry/api";
import { isOtelDeclaration, isOtelIntegration } from "eve/instrumentation/otel";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
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

console.log(`✓ instrumentation: ${passed} assertions passed (otel() declaration, metadata-only policy, OTLP env resolution)`);
