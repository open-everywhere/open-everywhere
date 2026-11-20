// The Bot Framework credentials the Teams provider resolves for its own Connector and Graph calls.
// eve 1.0 keeps its resolvers internal, so the provider owns these. The app password and the
// tenant id come from the same environment names that eve's own Teams channel reads, in the same
// order. The app id is NOT read from the environment: it is the `teams.appId` setting.
// Adapted from eve 1.0.0-rc.18 (Copyright 2026 Vercel, Inc. and contributors, Apache-2.0),
// `src/public/channels/teams/api`. The Open Everywhere authors changed it: no app-id env fallback.

/** A credential given directly, or by a function that produces it. */
export type TeamsCredentialValue = string | (() => string | Promise<string>);

async function materialize(value: TeamsCredentialValue): Promise<string> {
  return typeof value === "function" ? await value() : value;
}

/** Resolves the Teams app id. Throws when none is given: the provider has no environment fallback for it. */
export async function resolveTeamsAppId(appId: TeamsCredentialValue | undefined): Promise<string> {
  if (!appId) throw new Error("teams.appId is required: set it in agent/settings/settings.ts.");
  return materialize(appId);
}

/** Resolves the Teams app password from `MICROSOFT_APP_PASSWORD`, then `TEAMS_APP_PASSWORD`. Throws when both are unset. */
export async function resolveTeamsAppPassword(): Promise<string> {
  const password = process.env.MICROSOFT_APP_PASSWORD ?? process.env.TEAMS_APP_PASSWORD;
  if (!password) throw new Error("MICROSOFT_APP_PASSWORD or TEAMS_APP_PASSWORD is required.");
  return password;
}

/** Resolves the Teams tenant id from `MICROSOFT_TENANT_ID`, then `TEAMS_TENANT_ID`. Undefined for a multi-tenant bot. */
export async function resolveTeamsTenantId(): Promise<string | undefined> {
  const tenantId = process.env.MICROSOFT_TENANT_ID ?? process.env.TEAMS_TENANT_ID;
  return tenantId ? tenantId : undefined;
}
