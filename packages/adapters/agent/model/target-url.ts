import { DEFAULT_MODEL_VIA, type ModelTarget } from "@open-everywhere/core/agent/adapter-api.js";

export const DEPRECATED_GATEWAY_URL_ENV = "OE_AI_GATEWAY_URL";

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

export function targetBaseUrl(name: string, t: ModelTarget, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = name === DEFAULT_MODEL_VIA ? env[DEPRECATED_GATEWAY_URL_ENV]?.trim() || undefined : undefined;
  if (t.url !== undefined) {
    if (fromEnv !== undefined && fromEnv !== t.url) {
      warnOnce("env-ignored", `[open-everywhere:model] ${DEPRECATED_GATEWAY_URL_ENV} is set and ignored: models.targets.${name}.url wins. Unset the env var.`);
    }
    return t.url;
  }
  if (fromEnv !== undefined) {
    warnOnce(
      "env-deprecated",
      `[open-everywhere:model] ${DEPRECATED_GATEWAY_URL_ENV} is deprecated and goes away in the next release. Move it to models.targets.${name}.url in agent/settings/settings.ts.`,
    );
  }
  return fromEnv;
}

