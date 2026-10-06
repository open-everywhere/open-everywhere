import { disableInstrumentation } from "eve/instrumentation";
import { otel, otelIntegration, type OtelDeclaration, type SpanExporter } from "eve/instrumentation/otel";
import { OTLPHttpJsonTraceExporter, OTLPHttpProtoTraceExporter } from "@vercel/otel";
import { installLogShipping, initTelemetry } from "@open-everywhere/core/agent/adapter-api.js";

const METADATA_ONLY = { emit: true, recordInputs: false, recordOutputs: false } as const;

function setup(): void {
  installLogShipping();
  void initTelemetry();
}

const declaration: OtelDeclaration = { ...otel({ tracePolicy: () => METADATA_ONLY }), setup };
export default declaration;

type OtlpProtocol = "http/protobuf" | "http/json";

export interface OtlpTarget {
  readonly url: string;
  readonly protocol: OtlpProtocol;
  readonly headers: Readonly<Record<string, string>>;
}

export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (key === "") continue;
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return headers;
}

export function resolveOtlpTarget(env: NodeJS.ProcessEnv = process.env): OtlpTarget | undefined {
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const url = tracesEndpoint ? tracesEndpoint : endpoint ? `${endpoint.replace(/\/+$/, "")}/v1/traces` : undefined;
  if (url === undefined) return undefined;
  const requested = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf").trim();
  let protocol: OtlpProtocol = "http/protobuf";
  if (requested === "http/json") protocol = "http/json";
  else if (requested !== "http/protobuf") {
    console.warn(`[open-everywhere:instrumentation] OTLP traces protocol "${requested}" is not supported — exporting with http/protobuf`);
  }
  const headers = { ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS), ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) };
  return { url, protocol, headers };
}

function otlpExporter(target: OtlpTarget): SpanExporter {
  const config = { url: target.url, headers: { ...target.headers } };
  return target.protocol === "http/json" ? new OTLPHttpJsonTraceExporter(config) : new OTLPHttpProtoTraceExporter(config);
}

const OTLP_TARGET = resolveOtlpTarget();

export const otlpDestination = OTLP_TARGET === undefined ? disableInstrumentation() : otelIntegration({ traceExporter: otlpExporter(OTLP_TARGET) });
