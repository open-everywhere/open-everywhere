import { SETTINGS, getSettings, type AgentSettings, type OktaAppSetting } from "@open-everywhere/core/agent/adapter-api.js";

export const OKTA_API_TOKEN_SECRET = "OKTA_API_TOKEN";

export type OktaAppIdField = "externalId" | "userName";

export interface OktaAppMapping {
  readonly platform: string;
  readonly tenant?: string;
  readonly appId: string;
  readonly field: OktaAppIdField;
}

export interface OktaDirectoryConfig {
  readonly orgUrl: string;
  readonly apps: readonly OktaAppMapping[];
  readonly groupAllowlist?: readonly string[];
}

type DirectorySettings = Pick<AgentSettings["directory"], "provider" | "oktaOrgUrl" | "oktaApps" | "groupAllowlist">;

export function oktaDirectoryEnabled(directory: Pick<DirectorySettings, "provider"> = getSettings().directory): boolean {
  return directory.provider === "okta";
}

export function oktaAppMappings(entries: readonly OktaAppSetting[]): readonly OktaAppMapping[] {
  const problem = SETTINGS.directory.oktaApps.validate(entries);
  if (problem !== undefined) throw new Error(`directory.oktaApps: ${problem}`);
  return entries.map((a) => ({
    platform: a.platform,
    ...(a.tenant !== undefined ? { tenant: a.tenant } : {}),
    appId: a.appId,
    field: a.field ?? "externalId",
  }));
}

export function loadOktaDirectoryConfig(directory: DirectorySettings = getSettings().directory): OktaDirectoryConfig {
  const orgUrl = directory.oktaOrgUrl.trim();
  if (orgUrl === "") {
    throw new Error(
      `directory.provider is "okta" but directory.oktaOrgUrl is not set — directory sync cannot be armed. ` +
        `Set directory.oktaOrgUrl to your Okta org URL, e.g. "https://acme.okta.com", in agent/settings/settings.ts.`,
    );
  }
  const problem = SETTINGS.directory.oktaOrgUrl.validate(orgUrl);
  if (problem !== undefined) throw new Error(`directory.oktaOrgUrl: ${problem} — refusing to arm directory sync.`);
  return {
    orgUrl: orgUrl.replace(/\/+$/u, ""),
    apps: oktaAppMappings(directory.oktaApps),
    groupAllowlist: directory.groupAllowlist,
  };
}
