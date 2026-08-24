import { credentialOverrideFor, type CredentialBoundDomain } from "./domain-credentials.js";
import {
  grantOwnerSlug,
  isGrantNameSegment,
  type CredentialGrantAskRow,
  type CredentialGrantMode,
  type CredentialGrantRow,
} from "../operational/credential-grant-rows.js";
import { isQualifiedPrincipalKey } from "../identity/principal-key.js";

export function credentialGrantRole(domain: CredentialBoundDomain | undefined, connector: string, grantRole: string): string | undefined {
  const declared = credentialOverrideFor(domain, connector, grantRole);
  if (!declared) return undefined;
  return declared.use;
}

export interface GrantResource {
  readonly connector: string;
  readonly kind: string;
  readonly id: string;
}

export function parseGrantResource(address: string): GrantResource | undefined {
  const m = /^([a-z0-9-]+):([a-z0-9_-]+)\/(.+)$/u.exec(address);
  if (!m) return undefined;
  const id = m[3];
  if (id.includes("*") || id.trim().length === 0) return undefined;
  return { connector: m[1], kind: m[2], id };
}

export interface GrantedRequest {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface GrantableVerb {
  readonly connector: string;
  readonly verb: string;
  readonly resourceKind: string;
  readonly tier: "read" | "write" | "destructive";
  readonly inputSchema: Readonly<Record<string, unknown>>;
  describe(grant: CredentialGrantRow): string;
  compose(grant: CredentialGrantRow, input: Readonly<Record<string, unknown>>): GrantedRequest;
}

const GRANTABLE_VERBS = new Map<string, GrantableVerb>();

export function registerGrantableVerb(definition: GrantableVerb): void {
  if (!isGrantNameSegment(definition.verb)) {
    throw new Error(`registerGrantableVerb: "${definition.verb}" is not a legal tool-name segment (a segment may not contain "__")`);
  }
  const held = GRANTABLE_VERBS.get(definition.verb);
  if (held !== undefined && held.connector !== definition.connector) {
    throw new Error(`registerGrantableVerb: "${definition.verb}" is already registered for connector "${held.connector}" — verb ids are globally unique`);
  }
  GRANTABLE_VERBS.set(definition.verb, definition);
}

export function grantableVerb(verb: string): GrantableVerb | undefined {
  return GRANTABLE_VERBS.get(verb);
}

export function registeredGrantableVerbs(): readonly string[] {
  return [...GRANTABLE_VERBS.keys()].sort();
}

export function _resetGrantableVerbsForTest(): void {
  GRANTABLE_VERBS.clear();
}

export type GrantMintRefusal =
  | "no_domain_grant"
  | "unverified_requester"
  | "unknown_verb"
  | "resource_unparseable"
  | "resource_kind_mismatch"
  | "connector_mismatch"
  | "illegal_owner_handle"
  | "unresolvable_owner"
  | "grant_already_live"
  | "write_verb_out_of_slice";

export interface GrantMintInput {
  readonly domainGrantsConnector: boolean;
  readonly requesterPrincipalId: string | undefined;
  readonly ownerPrincipalId: string;
  readonly ownerHandle: string;
  readonly connector: string;
  readonly verb: string;
  readonly resource: string;
  readonly liveGrant: CredentialGrantRow | undefined;
}

export type GrantMintVerdict =
  | { readonly ok: true; readonly ownerSlug: string; readonly tier: "read" | "write" | "destructive"; readonly toolName: string }
  | { readonly ok: false; readonly reason: GrantMintRefusal };

export function credentialGrantMintVerdict(input: GrantMintInput): GrantMintVerdict {
  if (!input.domainGrantsConnector) return { ok: false, reason: "no_domain_grant" };
  if (input.requesterPrincipalId === undefined) return { ok: false, reason: "unverified_requester" };
  if (!isQualifiedPrincipalKey(input.ownerPrincipalId)) return { ok: false, reason: "unresolvable_owner" };
  const definition = grantableVerb(input.verb);
  if (definition === undefined) return { ok: false, reason: "unknown_verb" };
  if (definition.connector !== input.connector) return { ok: false, reason: "connector_mismatch" };
  const resource = parseGrantResource(input.resource);
  if (resource === undefined) return { ok: false, reason: "resource_unparseable" };
  if (resource.connector !== input.connector) return { ok: false, reason: "connector_mismatch" };
  if (resource.kind !== definition.resourceKind) return { ok: false, reason: "resource_kind_mismatch" };
  if (definition.tier !== "read") return { ok: false, reason: "write_verb_out_of_slice" };
  const ownerSlug = grantOwnerSlug(input.ownerHandle);
  if (ownerSlug === undefined) return { ok: false, reason: "illegal_owner_handle" };
  if (input.liveGrant !== undefined) return { ok: false, reason: "grant_already_live" };
  return { ok: true, ownerSlug, tier: definition.tier, toolName: `grant__${ownerSlug}__${input.verb}` };
}

export function grantMintRefusalMessage(connector: string, reason: GrantMintRefusal): string {
  switch (reason) {
    case "no_domain_grant":
      return `This room's domain does not admit credential grants for ${connector}. An operator declares the grant role on the domain before anyone can ask.`;
    case "unverified_requester":
      return "This turn names no single verified requester, so there is nobody to record as having asked. Ask again in a turn that carries one verified author.";
    case "unknown_verb":
      return `That verb is not a registered grantable verb for ${connector}. A grant names a reviewed verb, never a raw vendor permission.`;
    case "resource_unparseable":
      return "The resource must be a single explicit address such as `notion:page/<id>`. Wildcards are not admitted — a grant names its resource or it is not a grant.";
    case "resource_kind_mismatch":
      return "The resource address names a different kind of thing than that verb grants over.";
    case "connector_mismatch":
      return `The verb and the resource must both belong to ${connector}.`;
    case "illegal_owner_handle":
      return "That owner's handle carries no characters a tool name can hold, so the grant could not be named. Link the account to a readable handle first.";
    case "unresolvable_owner":
      return "That owner is not named in a form this deployment can resolve a credential for, so nothing could ever be spent under the grant. Ask again naming the owner by their linked account.";
    case "grant_already_live":
      return "A live grant for that owner, verb and conversation already exists. Use it, or ask the owner to revoke it before asking again.";
    case "write_verb_out_of_slice":
      return "That verb mutates. Credential grants admit read verbs today; a write grant records the owner's name at the vendor on the requester's act, and it needs its own slice.";
  }
}

export const GRANT_ONCE_TTL_MS = 60 * 60 * 1000;
export const GRANT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const GRANT_STANDING_MAX_MS = 30 * 24 * 60 * 60 * 1000;

export function credentialGrantExpiry(mode: CredentialGrantMode, nowMs: number, requestedMs?: number): string {
  const ceiling = mode === "once" ? GRANT_ONCE_TTL_MS : mode === "session" ? GRANT_SESSION_TTL_MS : GRANT_STANDING_MAX_MS;
  const span = mode === "standing" && typeof requestedMs === "number" && requestedMs > 0 ? Math.min(requestedMs, ceiling) : ceiling;
  return new Date(nowMs + span).toISOString();
}

export const GRANT_ASK_TTL_MS = 30 * 60 * 1000;

export function credentialGrantFromAsk(
  ask: CredentialGrantAskRow,
  fields: { readonly grantId: string; readonly ownerSlug: string; readonly tier: "read" | "write" | "destructive"; readonly mode: CredentialGrantMode; readonly nowIso: string; readonly expiresAt: string },
): CredentialGrantRow {
  return {
    id: fields.grantId,
    askId: ask.id,
    requesterPrincipalId: ask.requesterPrincipalId,
    ownerPrincipalId: ask.ownerPrincipalId,
    ownerSlug: fields.ownerSlug,
    connector: ask.connector,
    verb: ask.verb,
    resource: ask.resource,
    scopeKey: ask.scopeKey,
    mode: fields.mode,
    tier: fields.tier,
    status: "active",
    purpose: ask.purpose,
    createdAt: fields.nowIso,
    expiresAt: fields.expiresAt,
  };
}
