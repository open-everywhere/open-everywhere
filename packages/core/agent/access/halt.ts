import { bindFrom, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { domainForChannel } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";
import { getOperationalStore } from "../operational/provider.js";
import type { CapLevel, HaltAddress, HaltRow } from "../operational/store.js";
import { getConfig } from "./config.js";
import { USER_SCOPE_PREFIX, parseScopeKey, userScopeKey } from "./scope-key.js";

export interface HaltScope {
  readonly org: string;
  readonly surfaceKey?: string;
  readonly workspaceKey?: string;
  readonly domain?: string;
  readonly userScopeKey?: string;
}

export type HaltState =
  | { readonly halted: false }
  | { readonly halted: true; readonly row: HaltRow; readonly unreadable?: undefined }
  | { readonly halted: true; readonly row?: undefined; readonly unreadable: string };

export const NOT_HALTED: HaltState = { halted: false };

export function haltRowCovers(row: HaltRow, scope: HaltScope): boolean {
  if (row.org !== scope.org) return false;
  if (row.address.orgWide) return true;
  switch (row.address.level) {
    case "surface":
      return scope.surfaceKey !== undefined && row.address.scopeKey === scope.surfaceKey;
    case "workspace":
      return scope.workspaceKey !== undefined && row.address.scopeKey === scope.workspaceKey;
    case "domain":
      return scope.domain !== undefined && row.address.scopeKey === scope.domain;
    case "user":
      return scope.userScopeKey !== undefined && row.address.scopeKey === scope.userScopeKey;
  }
}

export function haltCovering(rows: readonly HaltRow[], scope: HaltScope): HaltRow | undefined {
  const covering = rows.filter((r) => haltRowCovers(r, scope));
  return covering.find((r) => r.address.orgWide) ?? covering[0];
}

export interface HaltDeps {
  readonly rows?: (org: string) => Promise<readonly HaltRow[]>;
}

async function activeHaltRows(org: string, deps: HaltDeps): Promise<readonly HaltRow[] | { readonly unreadable: string }> {
  try {
    return await (deps.rows ?? ((o: string) => getOperationalStore().activeHalts(o)))(org);
  } catch (err) {
    return { unreadable: String(err) };
  }
}

export async function resolveHalt(scope: HaltScope, deps: HaltDeps = {}): Promise<HaltState> {
  const rows = await activeHaltRows(scope.org, deps);
  if ("unreadable" in rows) return { halted: true, unreadable: rows.unreadable };
  const row = haltCovering(rows, scope);
  return row === undefined ? NOT_HALTED : { halted: true, row };
}

export async function resolveHaltUnaddressed(org: string, deps: HaltDeps = {}): Promise<HaltState> {
  const rows = await activeHaltRows(org, deps);
  if ("unreadable" in rows) return { halted: true, unreadable: rows.unreadable };
  const inOrg = rows.filter((r) => r.org === org);
  const row = inOrg.find((r) => r.address.orgWide) ?? inOrg[0];
  return row === undefined ? NOT_HALTED : { halted: true, row };
}

export function haltDomainForSurfaceKey(surfaceKey: string): string | undefined {
  try {
    return domainForChannel(surfaceKey, getConfig().loadDomains())?.name;
  } catch {
    return undefined;
  }
}

export function haltScopeFor(input: {
  readonly org: string;
  readonly scopeKey?: string;
  readonly domain?: string | null;
  readonly principalId?: string;
  readonly principalKey?: string;
}): HaltScope {
  const base = {
    org: input.org,
    ...(input.domain != null && input.domain !== "" ? { domain: input.domain } : {}),
    ...(input.principalKey ? { userScopeKey: `${USER_SCOPE_PREFIX}${input.principalKey}` } : {}),
  };
  if (input.scopeKey === undefined || input.scopeKey === "") return base;
  const shape = parseScopeKey(input.scopeKey);
  const surfaceDomain = (surfaceKey: string): { domain?: string } => {
    if (base.domain !== undefined) return {};
    const name = haltDomainForSurfaceKey(surfaceKey);
    return name === undefined ? {} : { domain: name };
  };
  const person = (platform: string, tenant: string | undefined): { userScopeKey?: string } => {
    if (input.principalKey) return {};
    if (input.principalId === undefined || input.principalId === "") return {};
    try {
      return { userScopeKey: userScopeKey(platform, tenant, input.principalId) };
    } catch {
      return {};
    }
  };
  switch (shape.kind) {
    case "surface":
      return {
        ...base,
        surfaceKey: input.scopeKey,
        workspaceKey: `${shape.platform}/${shape.workspace}`,
        ...surfaceDomain(input.scopeKey),
        ...person(shape.platform, shape.workspace),
      };
    case "tenant":
      return { ...base, workspaceKey: input.scopeKey, ...person(shape.platform, shape.workspace) };
    case "domain":
      return shape.name === "" ? base : { ...base, domain: base.domain ?? shape.name };
    case "principal":
      return { ...base, userScopeKey: input.scopeKey };
    case "malformed":
      return base;
  }
}

export function haltScopeForCtx(ctx: BindableContext): HaltScope {
  try {
    const p = resolvePartition(ctx);
    const principalId = bindFrom(ctx).principalId;
    return haltScopeFor({ org: p.org, scopeKey: p.surfaceKey, ...(principalId ? { principalId } : {}) });
  } catch {
    return { org: deploymentOrg() };
  }
}

export function haltAddressFromParts(parts: { readonly orgWide?: boolean; readonly level?: string; readonly scopeKey?: string }): HaltAddress {
  if (parts.orgWide === true) {
    if (parts.level !== undefined || parts.scopeKey !== undefined) {
      throw new Error('name exactly one halt address: "orgWide": true, or a (level, scopeKey) pair — never both');
    }
    return { orgWide: true };
  }
  if (parts.level === undefined || parts.scopeKey === undefined) {
    throw new Error('name exactly one halt address: "orgWide": true, or a (level, scopeKey) pair — never neither');
  }
  return { orgWide: false, level: parts.level as CapLevel, scopeKey: parts.scopeKey };
}

export function haltAddressFields(address: HaltAddress): Record<string, unknown> {
  return address.orgWide ? { orgWide: true } : { level: address.level, scopeKey: address.scopeKey };
}

function haltWidthClause(state: HaltState): string {
  if (!state.halted || state.row === undefined) return "";
  const a = state.row.address;
  if (a.orgWide) return " everywhere in this deployment";
  switch (a.level) {
    case "surface":
      return " at least in this conversation";
    case "workspace":
      return " at least across this workspace";
    case "domain":
      return " at least across this domain";
    case "user":
      return " at least for one person here";
  }
}

export function haltSeatParagraph(state: HaltState): string | null {
  if (!state.halted) return null;
  return (
    `**Consequential work is paused right now${haltWidthClause(state)}.** Someone pulled the stop ` +
    "switch, so nothing whose effect would LEAVE this conversation will run — no messages sent on " +
    "your behalf, no tickets, no pull requests, no scheduled or event-driven work, no borrowed " +
    "credential. Your sandbox reaches no host, and `web_fetch` and `web_search` are not available " +
    "while the pause stands. **Reading and replying still work, and so does handing a read to a " +
    "worker.** A question you can answer by reading, you should still answer — reading is not a way " +
    "round the pause, and neither is delegating one. Posting a file into THIS conversation and " +
    "saving what is said here to memory are not paused either: both stay inside the conversation you " +
    "are still allowed to have. TWO reads the pause does reach, so neither surprises you: a tool from " +
    "a connected integration, and reading an image from a URL. Say so plainly if you reach for " +
    "either. If someone asks you for one of the paused things, say " +
    "plainly that it is paused and that an admin can start it again with `resume`."
  );
}

export function haltRefusalMessage(state: HaltState, what: string): string {
  const why = state.halted && state.unreadable !== undefined ? " (the halt state could not be read, so this refuses fail-closed)" : "";
  return (
    `Refused: ${what} is halted${why}. A break-glass halt is in force for this deployment — every ` +
    `consequential act is stopped until an admin runs \`resume\`. Do not retry and do not look for ` +
    `another route: the same halt covers them.`
  );
}

export function haltAuditDetail(state: HaltState): Record<string, unknown> {
  if (!state.halted) return {};
  if (state.unreadable !== undefined) return { halt: "unreadable" };
  const a = state.row.address;
  return a.orgWide ? { halt: "orgWide" } : { halt: "addressed", haltLevel: a.level, haltScopeKey: a.scopeKey };
}

export type { HaltAddress, HaltRow };
