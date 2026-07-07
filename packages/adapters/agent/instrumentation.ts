import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";
import { installLogShipping } from "@open-everywhere/core/agent/observability/ship.js";

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
    if (!collectorConfigured()) return;
    registerOTel({ serviceName: agentName });
  },
});
