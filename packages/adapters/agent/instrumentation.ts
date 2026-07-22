import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";
import { installLogShipping, initTelemetry } from "@open-everywhere/core/agent/adapter-api.js";

function collectorConfigured(): boolean {
  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      process.env.VERCEL,
  );
}

export default defineInstrumentation({
  setup({ agentName }) {
    installLogShipping();
    initTelemetry();
    if (!collectorConfigured()) return;
    registerOTel({ serviceName: agentName });
  },
});
