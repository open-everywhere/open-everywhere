import { trace } from "@opentelemetry/api";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
delete process.env.VERCEL;

const instrumentation = (await import("../agent/instrumentation.js")).default;

ok(typeof instrumentation === "object" && instrumentation !== null, "default export is an object");
ok(typeof instrumentation.setup === "function", "exposes a setup() callback");

const providerBefore = trace.getTracerProvider();
instrumentation.setup?.({ agentName: "open-everywhere" });
ok(trace.getTracerProvider() === providerBefore, "no collector → no provider registered (no-op)");

console.log(`✓ instrumentation: ${passed} assertions passed (loads + no-ops cleanly without an OTLP collector)`);
