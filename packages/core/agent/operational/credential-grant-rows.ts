import { createHash } from "node:crypto";
import { connectorDisplayName, grantActionIsReviewed, grantActionPhrase, grantExpiryPhrase, grantOwnerPhrase } from "../access/credential-grant-copy.js";

export type CredentialGrantMode = "once" | "session" | "standing";

export type CredentialGrantState = "active" | "used" | "revoked" | "expired";

export type CredentialGrantAskState = "pending" | "approved" | "declined" | "expired";

export type GrantJsonObject = Readonly<Record<string, unknown>>;

export interface CredentialGrantAskRow {
  readonly id: string;
  readonly requesterPrincipalId: string;
  readonly ownerPrincipalId: string;
  readonly ownerSlug: string;
  readonly ownerPlatform: string;
  readonly ownerNativeId: string;
  readonly connector: string;
  readonly verb: string;
  readonly resource: string;
  readonly mcpTool?: string;
  readonly frozenArgs?: GrantJsonObject;
  readonly toolName?: string;
  readonly scopeKey: string;
  readonly purpose: string;
  readonly requesterTarget?: string;
  readonly requestedMode: CredentialGrantMode;
  readonly cardSurfaceId?: string;
  readonly cardMessageId?: string;
  readonly status: CredentialGrantAskState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt?: string;
  readonly grantId?: string;
}

export interface CredentialGrantRow {
  readonly id: string;
  readonly askId: string;
  readonly requesterPrincipalId: string;
  readonly ownerPrincipalId: string;
  readonly ownerSlug: string;
  readonly connector: string;
  readonly verb: string;
  readonly resource: string;
  readonly mcpTool?: string;
  readonly frozenArgs?: GrantJsonObject;
  readonly toolName?: string;
  readonly inputSchema?: GrantJsonObject;
  readonly scopeKey: string;
  readonly mode: CredentialGrantMode;
  readonly tier: "read" | "write" | "destructive";
  readonly status: CredentialGrantState;
  readonly purpose: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt?: string;
  readonly revokedAt?: string;
}

const CREDENTIAL_GRANT_NAMESPACE = "grant";

export function isGrantNameSegment(segment: string): boolean {
  return /^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(segment);
}

export function grantOwnerSlug(handle: string): string | undefined {
  return grantNameSlug(handle);
}

export function grantToolSlug(mcpTool: string): string | undefined {
  return grantNameSlug(mcpTool);
}

export function grantTargetSlug(targetLabel: string): string | undefined {
  return grantNameSlug(targetLabel);
}

function grantNameSlug(raw: string): string | undefined {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .replace(/_{2,}/gu, "_");
  return slug.length > 0 && isGrantNameSegment(slug) ? slug : undefined;
}

export function isGrantToolName(name: string): boolean {
  const segments = name.split("__");
  if (segments.length !== 3) return false;
  return segments[0] === CREDENTIAL_GRANT_NAMESPACE && isGrantNameSegment(segments[1] ?? "") && isGrantNameSegment(segments[2] ?? "");
}

export const GRANT_TOOL_NAME_MAX = 64;

const GRANT_ROW_SUFFIX_LEN = 6;

export function grantBorrowVerbSegment(toolSlug: string, targetSlug: string | undefined, budget: number): string | undefined {
  if (!isGrantNameSegment(toolSlug) || toolSlug.length > budget) return undefined;
  if (targetSlug === undefined || !isGrantNameSegment(targetSlug)) return toolSlug;
  const room = budget - toolSlug.length - 1;
  if (room < 1) return toolSlug;
  const cut = targetSlug.slice(0, room).replace(/_+$/u, "");
  const tail = cut.length > 0 && isGrantNameSegment(cut) ? cut : undefined;
  return tail === undefined ? toolSlug : `${toolSlug}_${tail}`;
}

export function grantBorrowRowSuffix(rowId: string): string | undefined {
  const usable = rowId.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  const suffix = usable.slice(0, GRANT_ROW_SUFFIX_LEN);
  return suffix.length === GRANT_ROW_SUFFIX_LEN ? suffix : undefined;
}

export function grantBorrowToolName(ownerSlug: string, connector: string, verbSegment: string): string {
  if (!isGrantNameSegment(ownerSlug)) throw new Error(`grantBorrowToolName: illegal owner segment "${ownerSlug}" (a segment may not contain "__")`);
  if (!isGrantNameSegment(connector)) throw new Error(`grantBorrowToolName: illegal connector segment "${connector}" (a segment may not contain "__")`);
  if (!isGrantNameSegment(verbSegment)) throw new Error(`grantBorrowToolName: illegal verb segment "${verbSegment}" (compose it with grantBorrowVerbSegment first)`);
  const name = `${CREDENTIAL_GRANT_NAMESPACE}__${ownerSlug}_${connector}__${verbSegment}`;
  if (!isGrantToolName(name)) throw new Error(`grantBorrowToolName: composed an unreadable name "${name}"`);
  if (name.length > GRANT_TOOL_NAME_MAX) throw new Error(`grantBorrowToolName: composed a ${String(name.length)}-character name, past the ${String(GRANT_TOOL_NAME_MAX)}-character bound`);
  return name;
}

export function nextGrantBorrowToolName(
  ownerSlug: string,
  connector: string,
  toolSlug: string,
  targetSlug: string | undefined,
  rowId: string,
  taken: readonly string[],
): string | undefined {
  const fixed = CREDENTIAL_GRANT_NAMESPACE.length + 2 + ownerSlug.length + 1 + connector.length + 2;
  const suffix = grantBorrowRowSuffix(rowId);
  if (suffix === undefined) return undefined;
  const verb = grantBorrowVerbSegment(toolSlug, targetSlug, GRANT_TOOL_NAME_MAX - fixed - (suffix.length + 1));
  if (verb === undefined) return undefined;
  const claimed = new Set(taken);
  for (const candidate of [verb, `${verb}_${suffix}`]) {
    const name = grantBorrowToolName(ownerSlug, connector, candidate);
    if (!claimed.has(name)) return name;
  }
  return undefined;
}

export function grantJsonColumn(value: GrantJsonObject | undefined): string | null {
  return value === undefined ? null : canonicalJson(value, "value");
}

export function grantJsonFromColumn(text: string | null | undefined, column: string): GrantJsonObject | undefined {
  if (text === null || text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`credential grant row: column "${column}" does not hold JSON (${String(err)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`credential grant row: column "${column}" holds ${Array.isArray(parsed) ? "an array" : String(parsed === null ? "null" : typeof parsed)}, not a JSON object`);
  }
  return parsed as GrantJsonObject;
}

export function grantBorrowColumnsProblem(row: {
  readonly mcpTool?: string;
  readonly frozenArgs?: GrantJsonObject;
  readonly toolName?: string;
  readonly inputSchema?: GrantJsonObject;
}): string | undefined {
  if (row.inputSchema !== undefined && row.mcpTool === undefined) return "a schema snapshot was written without the vendor tool it snapshots";
  const present = [
    ["mcpTool", row.mcpTool !== undefined],
    ["frozenArgs", row.frozenArgs !== undefined],
    ["toolName", row.toolName !== undefined],
  ] as const;
  const missing = present.filter(([, has]) => !has).map(([name]) => name);
  if (missing.length > 0) {
    return `the row names ${missing.join(", ")} nowhere — a grant lends one vendor MCP tool, and mcpTool, frozenArgs and toolName are decided together at the ask and must be written together`;
  }
  return undefined;
}

export function grantFrozenArgsDigest(frozenArgs: GrantJsonObject): string {
  return createHash("sha256").update(canonicalJson(frozenArgs, "frozenArgs")).digest("hex");
}

const GRANT_JSON_MAX_DEPTH = 64;

function canonicalJson(value: unknown, path: string, depth = 0): string {
  if (depth > GRANT_JSON_MAX_DEPTH) throw new Error(`credential grant row: ${path} nests deeper than ${String(GRANT_JSON_MAX_DEPTH)} levels (a cycle, or a value no vendor tool takes)`);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`credential grant row: ${path} is ${String(value)}, which JSON cannot hold`);
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item, i) => canonicalJson(item, `${path}[${String(i)}]`, depth + 1)).join(",")}]`;
  if (typeof value !== "object") throw new Error(`credential grant row: ${path} is a ${typeof value}, which JSON cannot hold`);
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) throw new Error(`credential grant row: ${path} is a ${(value as object).constructor?.name ?? "non-plain"} object, not a JSON object`);
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries) {
    if (v === undefined) throw new Error(`credential grant row: ${path}.${k} is undefined, which JSON cannot hold — a dropped key is a lost narrowing`);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, `${path}.${k}`, depth + 1)}`).join(",")}}`;
}

export type CredentialGrantRefusal =
  | "revoked"
  | "expired"
  | "burned"
  | "out_of_scope"
  | "no_lent_tool"
  | "no_transport"
  | "owner_unresolvable"
  | "unverified_requester"
  | "unattended_wake"
  | "halted"
  | "connector_delisted";

export function credentialGrantStateRefusal(row: CredentialGrantRow, nowIso: string): CredentialGrantRefusal | undefined {
  if (row.status === "revoked") return "revoked";
  if (row.status === "used") return "burned";
  if (row.status === "expired") return "expired";
  if (row.expiresAt <= nowIso) return "expired";
  return undefined;
}

export class GrantUndispatchedError extends Error {}

export function asGrantUndispatched(err: unknown): GrantUndispatchedError {
  if (err instanceof GrantUndispatchedError) return err;
  const marked = new GrantUndispatchedError(err instanceof Error ? err.message : String(err));
  if (err !== undefined && err !== null) marked.cause = err;
  return marked;
}

export function credentialGrantRefusalMessage(row: Pick<CredentialGrantRow, "ownerSlug" | "verb" | "resource">, reason: CredentialGrantRefusal): string {
  const owner = grantOwnerPhrase(row.ownerSlug);
  const what = `\`${row.verb}\` on \`${row.resource}\`, granted by ${owner}`;
  switch (reason) {
    case "revoked":
      return `Refused: ${owner} revoked this grant. ${what} is no longer spendable. Do not retry — ask again if it is still needed.`;
    case "expired":
      return `Refused: this grant has expired. ${what} is no longer spendable. Do not retry — ask again if it is still needed.`;
    case "burned":
      return `Refused: this was a one-shot grant and it is already spent. ${what} admitted exactly one call. Do not retry — ask again if it is still needed.`;
    case "out_of_scope":
      return `Refused: this grant was approved for a different conversation. ${what} is spendable only where its owner approved it.`;
    case "no_lent_tool":
      return `Refused: this grant names no vendor tool to run, so ${what} can never be spent. Do not retry — ask again so a fresh grant is minted.`;
    case "no_transport":
      return `Refused: this deployment carries no transport for the granted connector, so the call cannot be sent. The grant itself is valid.`;
    case "connector_delisted":
      return (
        `Refused: this deployment no longer admits credential grants for that connector. ${what} cannot be spent, ` +
        `even where a route to the vendor still exists. The grant itself stays as ${owner} approved it. Do not retry.`
      );
    case "owner_unresolvable":
      return `Refused: this grant does not name ${owner} in a form this deployment can resolve a credential for, so ${what} cannot be spent under anybody. Do not retry — ask again so a fresh grant is minted.`;
    case "unverified_requester":
      return `Refused: this turn names no single verified requester, so nobody can be recorded as having spent ${owner}'s credential. Do not retry.`;
    case "halted":
      return (
        `Refused: everything consequential is paused for this deployment right now — someone pulled the break-glass halt, ` +
        `so no credential is spendable, ${owner}'s included. ${what} stays granted and works again once an admin ` +
        `runs \`resume\`. Do not retry, and do not look for another route: the same halt covers them.`
      );
    case "unattended_wake":
      return (
        `Refused: the scheduler started this turn and nobody is in the room. A grant is spendable only where a person asked for it: ` +
        `there is no requester to record against ${owner}'s credential, and nobody to read the "acting as ${owner}" notice. ` +
        `${what} stays granted. Do not retry — it is spendable the next time a person addresses this conversation.`
      );
  }
}

export function credentialGrantDisclosureLine(
  row: Pick<CredentialGrantRow, "ownerSlug" | "connector" | "mcpTool" | "resource" | "frozenArgs" | "expiresAt" | "purpose">,
  nowMs: number,
): string {
  const owner = grantOwnerPhrase(row.ownerSlug);
  const target = grantResourceTargetLabel(row);
  const on = target === undefined || target.length === 0 ? "" : ` — "${target}"`;
  const vague = grantActionIsReviewed(row.connector, row.mcpTool) ? "" : " (the exact vendor tool is not one this deployment has a reviewed description for)";
  const reason = quotedPurpose(row.purpose);
  const why = reason.length === 0 ? "" : ` The reason given was "${reason}".`;
  return (
    `acting as ${owner} — used ${owner}'s ${connectorDisplayName(row.connector)} account to ` +
    `${grantActionPhrase(row.connector, row.mcpTool)}${on}${vague}, ${grantExpiryPhrase(row.expiresAt, nowMs)}.${why}`
  );
}

export function grantBorrowResourceLabel(targetLabel: string, mcpTool: string, frozenArgs: GrantJsonObject): string {
  const call = `${mcpTool}(${JSON.stringify(frozenArgs)})`;
  const label = targetLabel.trim();
  return quotedPurpose(label.length === 0 ? call : `${label} — ${call}`);
}

export function grantResourceTargetLabel(row: { readonly resource: string; readonly mcpTool?: string; readonly frozenArgs?: GrantJsonObject }): string | undefined {
  const tool = row.mcpTool === undefined ? "" : quotedPurpose(row.mcpTool);
  if (tool.length === 0) return undefined;
  const marker = ` — ${tool}(`;
  const cut = row.resource.lastIndexOf(marker);
  if (cut <= 0) return undefined;
  if (!row.resource.endsWith(")")) return undefined;
  const label = row.resource.slice(0, cut).trim();
  return label.length === 0 ? undefined : label;
}

export function grantAuditResource(row: { readonly resource: string; readonly mcpTool?: string; readonly frozenArgs?: GrantJsonObject }): string {
  if (row.mcpTool === undefined) return row.resource;
  const keys = quotedPurpose(Object.keys(row.frozenArgs ?? {}).sort().join(","));
  return `${quotedPurpose(row.mcpTool)} keys:${keys}`;
}

export function quotedPurpose(purpose: string): string {
  const flat = purpose.replace(/[\r\n]+/gu, " ").replace(/["'`]/gu, "").trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}

export function flatDisplayName(label: string): string {
  const flat = label.replace(/[\r\n]+/gu, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}
