import { getSettings } from "@open-everywhere/core/agent/adapter-api.js";

export function awsAccessEnabled(): boolean {
  return getSettings().aws.enabled;
}

export interface AwsAccessConfig {
  readonly defaultRegion?: string;
}

export function loadAwsAccessConfig(): AwsAccessConfig {
  const defaultRegion = getSettings().aws.region.trim() || process.env.AWS_REGION?.trim();
  return { ...(defaultRegion ? { defaultRegion } : {}) };
}

export interface AwsSsoConfig {
  readonly region?: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
}

export function loadAwsSsoConfig(): AwsSsoConfig {
  const aws = getSettings().aws;
  const region = aws.ssoRegion.trim() || aws.region.trim() || process.env.AWS_REGION?.trim();
  const clientId = aws.ssoClientId.trim();
  const scopes = aws.ssoScopes;
  return {
    ...(region ? { region } : {}),
    ...(clientId ? { clientId } : {}),
    ...(scopes && scopes.length ? { scopes } : {}),
  };
}
