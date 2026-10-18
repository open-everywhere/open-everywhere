import { deploymentTranscriptPages, deploymentTranscriptReader, type TranscriptExportReader, type TranscriptPageReader } from "../agent/control/transcript-export.js";

type Env = NodeJS.ProcessEnv;

export interface TranscriptSourceResolution {
  readonly reader?: TranscriptExportReader;
  readonly pages?: TranscriptPageReader;
  readonly baseUrl?: string;
  readonly missing: readonly string[];
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

function resolveBaseUrl(env: Env): string {
  const alias = trimmed(env.OE_DEPLOY_ALIAS);
  const url = trimmed(env.E2E_TARGET_URL) || trimmed(env.OE_DEPLOY_BASE_URL) || (alias ? `https://${alias}` : "");
  return url.replace(/\/+$/, "");
}

export function resolveTranscriptSource(env: Env = process.env): TranscriptSourceResolution {
  const token = trimmed(env.OE_DEPLOY_CONTROL_TOKEN) || trimmed(env.E2E_CONTROL_READ_TOKEN);
  const baseUrl = resolveBaseUrl(env);
  const missing: string[] = [];
  if (!baseUrl) missing.push("E2E_TARGET_URL (or OE_DEPLOY_BASE_URL / OE_DEPLOY_ALIAS)");
  if (!token) missing.push("OE_DEPLOY_CONTROL_TOKEN (or E2E_CONTROL_READ_TOKEN)");
  if (missing.length > 0) return { missing };
  return { reader: deploymentTranscriptReader({ baseUrl, token }), pages: deploymentTranscriptPages({ baseUrl, token }), baseUrl, missing: [] };
}
