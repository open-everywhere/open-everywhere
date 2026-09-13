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

const content = instrumentation as { recordInputs?: unknown; recordOutputs?: unknown };
ok(content.recordInputs === undefined, "🔴 OPE-1798: the adapter declares no `recordInputs` — eve reads an absent field as false, so model INPUT never reaches a span");
ok(content.recordOutputs === undefined, "🔴 OPE-1798: the adapter declares no `recordOutputs` — model OUTPUT never reaches a span either");
ok(content.recordInputs !== true && content.recordOutputs !== true, "…and neither is turned on by any other route through the module");

console.log(`✓ instrumentation: ${passed} assertions passed (loads + no-ops cleanly without an OTLP collector; declares no model-content capture)`);
