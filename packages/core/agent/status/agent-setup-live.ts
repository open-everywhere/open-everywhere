import { getConfig } from "../access/config.js";
import { resolveAccessFor } from "../access/request.js";
import { adminControlRoles, resolveRole } from "../access/roles.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { criteriaDomain, domainForChannel } from "../memory/domain.js";
import { surfaceStatuses } from "../ops/status.js";
import { loadGitHubAppConfig } from "../scm/config.js";
import { resolveGitHubInstallationId } from "../scm/installations.js";
import { githubTokenFallbackSet } from "../scm/write-token.js";
import { type AgentSetupFacts, type AskerStanding, type SetupVerdict } from "./agent-setup.js";

export async function gatherAgentSetupFacts(ctx: BindableContext): Promise<AgentSetupFacts> {
  const binding = bindFrom(ctx);
  const domains = getConfig().loadDomains();
  const role = resolveRole(ctx);
  const standing: AskerStanding =
    role.unverified !== undefined
      ? { kind: "unknown" }
      : role.isOrgAdmin
        ? { kind: "org-admin" }
        : role.isDomainAdmin
          ? { kind: "domain-admin", domain: role.domain ?? "this room" }
          : { kind: "member" };

  let adminElsewhere: string[] = [];
  if (standing.kind === "member" && role.principalId !== undefined) {
    const names = adminControlRoles(role.principalId, domains, binding.platform, binding.workspace, binding.enterprise)
      .filter((r) => r.startsWith("domain:"))
      .map((r) => r.slice("domain:".length));
    adminElsewhere = names.map((n) => domains.find((d) => d.name === n)?.title?.trim() || n);
  }

  const channelKey = `${binding.platform}/${binding.workspace}/${binding.domainSurface ?? binding.surface}`;
  const room = domainForChannel(channelKey, domains);

  let surfaces: { platform: string; installed: SetupVerdict }[] = [];
  try {
    const reported = await surfaceStatuses();
    surfaces = Object.keys(reported)
      .filter((p) => p !== "github")
      .sort()
      .map((platform) => ({ platform, installed: reported[platform]!.installed }));
  } catch {
  }

  let connectors: readonly string[] = [];
  let repos: readonly string[] = [];
  try {
    const access = resolveAccessFor(ctx);
    connectors = access.connectors;
    repos = access.repos;
  } catch {
  }
  const surfaceNames = new Set(surfaces.map((s) => s.platform));

  const app = loadGitHubAppConfig();
  const ar = getConfig().loadAccessRequests?.() ?? null;
  const repo = ar?.configRepo?.trim() ? ar.configRepo.trim() : undefined;
  let appInstalled: SetupVerdict = "unknown";
  if (app === null) appInstalled = "no";
  else if (repo !== undefined && repo.includes("/")) {
    try {
      appInstalled = (await resolveGitHubInstallationId(repo.slice(0, repo.indexOf("/")))) !== undefined ? "yes" : "no";
    } catch {
      appInstalled = "unknown";
    }
  }

  return {
    ...(role.principalId !== undefined ? { asker: role.principalId } : {}),
    ...(binding.platform ? { askerPlatform: binding.platform } : {}),
    standing,
    ...(adminElsewhere.length > 0 ? { adminElsewhere } : {}),
    domainAdminsExist: domains.some((d) => d.match === undefined && (d.admins?.length ?? 0) > 0),
    orgAdmins: criteriaDomain("org", domains)?.admins ?? [],
    ...(room !== undefined ? { roomDomain: { name: room.name, ...(room.title !== undefined ? { title: room.title } : {}), admins: room.admins ?? [] } } : {}),
    surfaces,
    connectors: connectors.filter((c) => !surfaceNames.has(c)),
    repos,
    github: { appConfigured: app !== null, ...(app !== null ? { appSlug: app.appSlug } : {}), tokenSet: githubTokenFallbackSet() },
    configChanges: { ...(repo !== undefined ? { repo } : {}), adminChannel: Boolean(ar?.adminChannel?.trim()), appInstalled, ...(ar?.dryRun === true ? { dryRun: true } : {}) },
  };
}

export function seatSetupFacts(domainName: string | undefined): AgentSetupFacts {
  const domains = getConfig().loadDomains();
  const room = domainName !== undefined ? domains.find((d) => d.name === domainName && d.match === undefined) : undefined;
  const app = loadGitHubAppConfig();
  const ar = getConfig().loadAccessRequests?.() ?? null;
  const repo = ar?.configRepo?.trim() ? ar.configRepo.trim() : undefined;
  let appInstalled: SetupVerdict = app === null ? "no" : "unknown";
  if (app !== null && repo !== undefined && repo.includes("/")) {
    const owner = repo.slice(0, repo.indexOf("/"));
    if (app.installations[owner] !== undefined) appInstalled = "yes";
  }
  return {
    standing: { kind: "unknown" },
    domainAdminsExist: domains.some((d) => d.match === undefined && (d.admins?.length ?? 0) > 0),
    orgAdmins: criteriaDomain("org", domains)?.admins ?? [],
    ...(room !== undefined ? { roomDomain: { name: room.name, ...(room.title !== undefined ? { title: room.title } : {}), admins: room.admins ?? [] } } : {}),
    surfaces: [],
    connectors: [],
    repos: [],
    github: { appConfigured: app !== null, ...(app !== null ? { appSlug: app.appSlug } : {}), tokenSet: githubTokenFallbackSet() },
    configChanges: { ...(repo !== undefined ? { repo } : {}), adminChannel: Boolean(ar?.adminChannel?.trim()), appInstalled, ...(ar?.dryRun === true ? { dryRun: true } : {}) },
  };
}
