import { classifyConnectorOpTier } from "./consequence.js";
import { neverTierMatch } from "./never-tier.js";
import { connectorDisplayName, grantDuplicateRefusalText, type GrantCopyAudience, type GrantDuplicateFacts } from "./credential-grant-copy.js";
import { grantScopeKeyForMode } from "./credential-grant-scope.js";
import {
  grantOwnerSlug,
  grantTargetSlug,
  grantToolSlug,
  isGrantNameSegment,
  nextGrantBorrowToolName,
  type CredentialGrantAskRow,
  type CredentialGrantMode,
  type CredentialGrantRow,
  type GrantJsonObject,
} from "../operational/credential-grant-rows.js";
import { isQualifiedPrincipalKey } from "../identity/principal-key.js";

export interface GrantBoundDomain {
  readonly name?: string;
  readonly credentialGrants?: readonly string[];
}

export interface CredentialGrantRole {
  readonly connector: string;
  readonly role: string;
}

export const CREDENTIAL_GRANT_ROLES: readonly CredentialGrantRole[] = [
  { connector: "notion", role: "user-oauth" },
];

export function isCredentialGrantConnector(connector: string): boolean {
  return CREDENTIAL_GRANT_ROLES.some((r) => r.connector === connector);
}

export function credentialGrantConnectors(): readonly string[] {
  return [...new Set(CREDENTIAL_GRANT_ROLES.map((r) => r.connector))].sort();
}

export function domainsAdmitCredentialGrant(domains: readonly (GrantBoundDomain | undefined)[], connector: string): boolean {
  if (!isCredentialGrantConnector(connector)) return false;
  return domains.some((domain) => (domain?.credentialGrants ?? []).includes(connector));
}

export function credentialGrantDeclarationProblems(domain: GrantBoundDomain): readonly string[] {
  const declared = domain.credentialGrants;
  if (declared === undefined) return [];
  const name = domain.name ?? "(unnamed)";
  const bad: string[] = [];
  if (!Array.isArray(declared)) return [`  "${name}" \`credentialGrants\` must be a list of connector ids`];
  const seen = new Set<string>();
  const admitted = credentialGrantConnectors();
  for (const connector of declared) {
    if (typeof connector !== "string" || connector.trim().length === 0) {
      bad.push(`  "${name}" \`credentialGrants\` holds an entry that is not a non-empty connector id`);
      continue;
    }
    if (seen.has(connector)) bad.push(`  "${name}" \`credentialGrants\` names "${connector}" more than once`);
    seen.add(connector);
    if (!admitted.includes(connector)) {
      bad.push(
        `  "${name}" \`credentialGrants\` names "${connector}", which this tree admits no credential-grant role for — ` +
          `add the (connector, personal credential) pair to CREDENTIAL_GRANT_ROLES ` +
          `(packages/core/agent/access/credential-grant.ts) in the same diff, or delete the entry ` +
          `(admitted today: ${admitted.length > 0 ? admitted.join(", ") : "none"})`,
      );
    }
  }
  return bad;
}

export type GrantMintRefusal =
  | "no_domain_grant"
  | "unverified_requester"
  | "illegal_owner_handle"
  | "unresolvable_owner"
  | "owner_unresolved"
  | "grant_already_live"
  | "ask_already_pending"
  | "write_verb_out_of_slice"
  | "illegal_tool_name"
  | "illegal_connector_id"
  | "never_tier"
  | "never_tier_config_unavailable";

export interface GrantBorrowMintInput {
  readonly mcpTool: string;
  readonly targetLabel: string;
  readonly rowId: string;
  readonly takenToolNames: readonly string[];
}

export interface GrantMintInput {
  readonly domainGrantsConnector: boolean;
  readonly requesterPrincipalId: string | undefined;
  readonly ownerPrincipalId: string;
  readonly ownerHandle: string;
  readonly connector: string;
  readonly borrow: GrantBorrowMintInput;
  readonly liveGrant: CredentialGrantRow | undefined;
  readonly liveAsk: CredentialGrantAskRow | undefined;
}

export type GrantMintVerdict =
  | { readonly ok: true; readonly ownerSlug: string; readonly tier: "read" | "write" | "destructive"; readonly toolName: string }
  | { readonly ok: false; readonly reason: GrantMintRefusal };

export function credentialGrantMintVerdict(input: GrantMintInput): GrantMintVerdict {
  if (!input.domainGrantsConnector) return { ok: false, reason: "no_domain_grant" };
  if (input.requesterPrincipalId === undefined) return { ok: false, reason: "unverified_requester" };
  if (!isQualifiedPrincipalKey(input.ownerPrincipalId)) return { ok: false, reason: "unresolvable_owner" };
  const shape = borrowShape(input.connector, input.borrow);
  if (!shape.ok) return shape;
  const ownerSlug = grantOwnerSlug(input.ownerHandle);
  if (ownerSlug === undefined) return { ok: false, reason: "illegal_owner_handle" };
  if (input.liveGrant !== undefined) return { ok: false, reason: "grant_already_live" };
  if (input.liveAsk !== undefined) return { ok: false, reason: "ask_already_pending" };
  const toolName = shape.name(ownerSlug);
  if (toolName === undefined) return { ok: false, reason: "illegal_tool_name" };
  return { ok: true, ownerSlug, tier: shape.tier, toolName };
}

type GrantMintShape =
  | { readonly ok: true; readonly tier: "read" | "write" | "destructive"; name(ownerSlug: string): string | undefined }
  | { readonly ok: false; readonly reason: GrantMintRefusal };

function borrowShape(connector: string, borrow: GrantBorrowMintInput): GrantMintShape {
  if (!isGrantNameSegment(connector)) return { ok: false, reason: "illegal_connector_id" };
  const toolSlug = grantToolSlug(borrow.mcpTool);
  if (toolSlug === undefined) return { ok: false, reason: "illegal_tool_name" };
  const never = neverTierMatch(`${connector}__${borrow.mcpTool}`);
  if (never !== undefined) return { ok: false, reason: never.source === "config-unavailable" ? "never_tier_config_unavailable" : "never_tier" };
  const tier = classifyConnectorOpTier(`${connector}__${borrow.mcpTool}`);
  if (tier !== "read") return { ok: false, reason: "write_verb_out_of_slice" };
  const targetSlug = grantTargetSlug(borrow.targetLabel);
  return {
    name: (ownerSlug) => tryCompose(() => nextGrantBorrowToolName(ownerSlug, connector, toolSlug, targetSlug, borrow.rowId, borrow.takenToolNames)),
    ok: true,
    tier,
  };
}

function tryCompose(compose: () => string | undefined): string | undefined {
  try {
    return compose();
  } catch {
    return undefined;
  }
}

export interface GrantDuplicateContext extends Omit<GrantDuplicateFacts, "connector"> {
  readonly audience: GrantCopyAudience;
}

export function grantMintRefusalMessage(connector: string, reason: GrantMintRefusal, duplicate?: GrantDuplicateContext): string {
  switch (reason) {
    case "no_domain_grant":
      return `This room's domain does not admit credential grants for ${connectorDisplayName(connector)}. An operator declares the grant role on the domain before anyone can ask.`;
    case "unverified_requester":
      return "This turn names no single verified requester, so there is nobody to record as having asked. Ask again in a turn that carries one verified author.";
    case "illegal_owner_handle":
      return "That owner's handle carries no characters a tool name can hold, so the grant could not be named. Link the account to a readable handle first.";
    case "unresolvable_owner":
      return "That owner is not named in a form this deployment can resolve a credential for, so nothing could ever be spent under the grant. Ask again naming the owner by their linked account.";
    case "owner_unresolved":
      return "That owner id is not a user id on this conversation's platform, so it names nobody here. Name the owner as they appear in this room, or give their full principal key.";
    case "grant_already_live":
      return grantDuplicateRefusalText(duplicate?.audience ?? "seat", {
        connector,
        conversationLabel: duplicate?.conversationLabel,
        expiresAt: duplicate?.expiresAt,
        mcpTool: duplicate?.mcpTool,
        nowMs: duplicate?.nowMs ?? 0,
        ownerLabel: duplicate?.ownerLabel,
      });
    case "ask_already_pending":
      return "You already asked that person for this, and they have not answered yet. Do not ask again — they were sent one card, and a second ask would page them again for the same decision. Say in the room that the ask is still with them, and carry on with something else.";
    case "write_verb_out_of_slice":
      return "That call mutates. Credential grants admit read operations today; a write grant records the owner's name at the vendor on the requester's act, and it needs its own slice.";
    case "illegal_tool_name":
      return `That tool name carries no characters a mounted tool name can hold, so the grant could not be named. Name the ${connectorDisplayName(connector)} tool exactly as the connection publishes it.`;
    case "never_tier":
      return `That ${connectorDisplayName(connector)} tool is never allowed on this deployment, so no grant can lend it. No owner's approval can change this, and this is not waiting for approval. Do not ask again.`;
    case "never_tier_config_unavailable":
      return "This deployment's configuration could not be read, so I cannot prove that tool is allowed, and no grant can lend it now. An operator must fix the configuration. Do not ask again until they have.";
    case "illegal_connector_id":
      return `This deployment spells the ${connectorDisplayName(connector)} connector id in a form a mounted tool name cannot hold, so no grant for it can be named. Nothing about the ask was wrong — an operator fixes this, not a retry.`;
  }
}

const GRANT_ONCE_TTL_MS = 60 * 60 * 1000;
const GRANT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const GRANT_STANDING_MAX_MS = 30 * 24 * 60 * 60 * 1000;

export function credentialGrantExpiry(mode: CredentialGrantMode, nowMs: number, requestedMs?: number): string {
  const ceiling = mode === "once" ? GRANT_ONCE_TTL_MS : mode === "session" ? GRANT_SESSION_TTL_MS : GRANT_STANDING_MAX_MS;
  const span = mode === "standing" && typeof requestedMs === "number" && requestedMs > 0 ? Math.min(requestedMs, ceiling) : ceiling;
  return new Date(nowMs + span).toISOString();
}

export const GRANT_ASK_TTL_MS = 30 * 60 * 1000;

export function credentialGrantFromAsk(
  ask: CredentialGrantAskRow,
  fields: {
    readonly grantId: string;
    readonly ownerSlug: string;
    readonly tier: "read" | "write" | "destructive";
    readonly mode: CredentialGrantMode;
    readonly nowIso: string;
    readonly expiresAt: string;
    readonly inputSchema?: GrantJsonObject;
  },
): CredentialGrantRow | undefined {
  const scopeKey = grantScopeKeyForMode(fields.mode, ask.scopeKey, ask.domainScopeKey);
  if (scopeKey === undefined) return undefined;
  return {
    id: fields.grantId,
    askId: ask.id,
    requesterPrincipalId: ask.requesterPrincipalId,
    ownerPrincipalId: ask.ownerPrincipalId,
    ownerSlug: fields.ownerSlug,
    connector: ask.connector,
    verb: ask.verb,
    resource: ask.resource,
    ...(ask.mcpTool === undefined ? {} : { mcpTool: ask.mcpTool }),
    ...(ask.frozenArgs === undefined ? {} : { frozenArgs: ask.frozenArgs }),
    ...(ask.toolName === undefined ? {} : { toolName: ask.toolName }),
    ...(fields.inputSchema === undefined ? {} : { inputSchema: fields.inputSchema }),
    scopeKey,
    mode: fields.mode,
    tier: fields.tier,
    status: "active",
    purpose: ask.purpose,
    createdAt: fields.nowIso,
    expiresAt: fields.expiresAt,
  };
}
