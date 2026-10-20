import { processRegistryMap } from "../lib/process-registry.js";

const CORE_OPERATOR_SECRET_NAMES = [
  "AI_GATEWAY_API_KEY",
  "OE_AWS_WEB_IDENTITY_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_TOKEN",
  "OE_CONTROL_READ_TOKENS",
  "OE_CONTROL_INJECT_TOKENS",
  "OE_CONTROL_OAUTH_SIGNING_SECRET",
  "OE_ADMIN_STATIC_TOKEN",
  "OE_EGRESS_PROXY_TOKEN",
  "OE_LOG_SHIP_TOKEN",
  "OE_TELEMETRY_OTLP_HEADERS",
] as const;

const ROSTER = processRegistryMap<true>("operator-secret-names.v1");
for (const name of CORE_OPERATOR_SECRET_NAMES) ROSTER.set(name, true);

export function registerOperatorSecretNames(names: readonly string[]): void {
  for (const name of names) ROSTER.set(name, true);
}

export function isOperatorSecretName(name: string): boolean {
  return ROSTER.has(name);
}

export function operatorSecretNames(): readonly string[] {
  return [...ROSTER.keys()].sort();
}
