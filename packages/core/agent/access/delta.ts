import { SURFACE_KEY, type Binding, type Bundle, type Connection, type HttpMethod } from "./bundle.js";
import { DIRECTORY_GROUP_PREFIX, type Group } from "../identity/groups.js";
import { isQualifiedPrincipalKey } from "../identity/principal-key.js";
import { tenantRungRemedy } from "./tenant-admission.js";
import { groupWidth } from "./lint.js";
import type { EffectiveAccess } from "./resolver.js";

export const OUT_OF_VOCABULARY =
  "that isn't something I can request automatically — an admin needs to PR this by hand (edit agent/access/bundles.ts in the config repo).";

export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

export type RequestingScope =
  | { readonly level: "surface"; readonly surface: string }
  | { readonly level: "principal"; readonly principal: string }
  | { readonly level: "group"; readonly group: string };

export function scopeAddress(scope: RequestingScope): string {
  switch (scope.level) {
    case "surface":
      return scope.surface;
    case "principal":
      return scope.principal;
    case "group":
      return scope.group;
  }
}

export function sameScope(a: RequestingScope, b: RequestingScope): boolean {
  return a.level === b.level && scopeAddress(a) === scopeAddress(b);
}

export function requestingScopeProblem(scope: RequestingScope): string | undefined {
  switch (scope.level) {
    case "surface":
      return SURFACE_KEY.test(scope.surface ?? "")
        ? undefined
        : `surface="${scope.surface}" is not the fully-qualified surface key "platform/<tenant-id>/<container-id>"`;
    case "principal":
      return isQualifiedPrincipalKey(scope.principal)
        ? undefined
        : `principal="${scope.principal}" is not a well-formed principal key — "platform/<principal-id>", or "platform/<tenant-id>/<principal-id>" on a tenant-scoped platform (e.g. "slack/T0AB1CD2E/U0123ABC", "discord/300000000000000104")${tenantRungRemedy(scope.principal ?? "")}`;
    case "group": {
      const name = scope.group ?? "";
      if (name.trim().length === 0) return "group name is empty — a group grant needs the bare name of a declared person-group";
      if (/[\s/]/u.test(name)) {
        return `group="${name}" must be a BARE name with no whitespace or "/" (it names the overlay bundle \`grants:group:<name>\`)`;
      }
      if (name.startsWith(DIRECTORY_GROUP_PREFIX)) {
        return `group="${name}" is in the reserved "${DIRECTORY_GROUP_PREFIX}" namespace, which belongs to the machine-owned IdP-group overlay — a grant onto a directory-synced group is a hand PR`;
      }
      return undefined;
    }
  }
}

interface DeltaBase {
  readonly scope: RequestingScope;
  readonly allowBroad?: string;
}

export interface WidenConnectionDelta extends DeltaBase {
  readonly kind: "widen-connection";
  readonly connectionId: string;
  readonly addMethods: readonly HttpMethod[];
  readonly addPathPrefixes: readonly string[];
  readonly baseConnection: Connection;
}

export interface GrantConnectorDelta extends DeltaBase {
  readonly kind: "grant-connector";
  readonly connector: string;
}

export type AccessDelta = WidenConnectionDelta | GrantConnectorDelta;

export interface AccessAsk {
  readonly kind: string;
  readonly connection?: string;
  readonly addMethods?: readonly string[];
  readonly addPathPrefixes?: readonly string[];
  readonly connector?: string;
  readonly reason?: string;
}

export interface PlanContext {
  readonly scope: RequestingScope;
  readonly access: EffectiveAccess;
  readonly bundles: readonly Bundle[];
  readonly groups?: readonly Group[];
}

function isHttpMethod(v: string): v is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(v);
}

export function definedConnectors(bundles: readonly Bundle[]): readonly string[] {
  return [...new Set(bundles.flatMap((b) => b.connectors ?? []))].sort();
}

export function scopeWhere(scope: RequestingScope): string {
  switch (scope.level) {
    case "surface":
      return `surface ${scope.surface}`;
    case "principal":
      return `the personal DM universe of ${scope.principal}`;
    case "group":
      return `person-group "${scope.group}" (every member's own DM)`;
  }
}

export function scopeHere(scope: RequestingScope): string {
  switch (scope.level) {
    case "surface":
      return "this channel";
    case "principal":
      return "your own DM universe";
    case "group":
      return `person-group "${scope.group}"`;
  }
}

export function scopeTarget(scope: RequestingScope): string {
  return scope.level === "surface" ? scope.surface : `${scope.level}:${scopeAddress(scope)}`;
}

export const ALLOW_BROAD_REASON_MAX = 200;

export function normalizeAllowBroadReason(reason: string): string {
  const flat = reason.replace(/\s+/gu, " ").trim();
  return flat.length > ALLOW_BROAD_REASON_MAX ? `${flat.slice(0, ALLOW_BROAD_REASON_MAX - 1)}…` : flat;
}

function planGroupTarget(ask: AccessAsk, ctx: PlanContext): string | undefined {
  if (ctx.scope.level !== "group") return undefined;
  const name = ctx.scope.group;
  const declared = ctx.groups ?? [];
  const group = declared.find((g) => g.name === name);
  if (!group) {
    throw new Error(
      `"${name}" isn't a declared person-group (declared: ${declared.length ? declared.map((g) => g.name).join(", ") : "none"}) — ` +
        `groups live in agent/identity/groups.ts and are added by PR, so ${OUT_OF_VOCABULARY}`,
    );
  }
  const width = groupWidth(group);
  if (!width) return undefined;
  const reason = (ask.reason ?? "").trim();
  if (reason.length === 0) {
    throw new Error(
      `granting "${name}" is a BROAD grant — ${width}. CI refuses a broad credentialed grant that nobody acknowledged, ` +
        `so this request needs a reason: say why the whole group should have it, and I'll record it on the binding as \`allowBroad\` for the merging admin to read.`,
    );
  }
  return normalizeAllowBroadReason(reason);
}

function planWidenConnection(ask: AccessAsk, ctx: PlanContext, allowBroad: string | undefined): WidenConnectionDelta {
  if (!ask.connection || !ask.connection.trim()) {
    throw new Error(`widen-connection needs the connection id to widen — ${OUT_OF_VOCABULARY}`);
  }
  const id = ask.connection.trim();

  const base = ctx.access.connections.find((c) => c.id === id);
  if (!base) {
    throw new Error(
      `connection "${id}" isn't effective in ${scopeHere(ctx.scope)} (effective there: ${
        ctx.access.connections.length ? ctx.access.connections.map((c) => c.id).join(", ") : "none"
      }) — ${OUT_OF_VOCABULARY}`,
    );
  }

  const rawMethods = [...new Set((ask.addMethods ?? []).map((m) => m.trim().toUpperCase()))];
  const badMethods = rawMethods.filter((m) => !isHttpMethod(m));
  if (badMethods.length > 0) {
    throw new Error(`unknown HTTP method(s) ${badMethods.join(", ")} — the vocabulary covers ${HTTP_METHODS.join(", ")} only.`);
  }

  const rawPrefixes = [...new Set((ask.addPathPrefixes ?? []).map((p) => p.trim()))].filter((p) => p.length > 0);
  const badPrefixes = rawPrefixes.filter((p) => !p.startsWith("/") || /\s/u.test(p));
  if (badPrefixes.length > 0) {
    throw new Error(`path prefix(es) ${badPrefixes.join(", ")} must start with "/" and contain no whitespace.`);
  }

  if (rawMethods.length === 0 && rawPrefixes.length === 0) {
    throw new Error("widen-connection needs at least one method or path prefix to add — nothing was requested.");
  }

  const addMethods =
    base.methods === undefined ? [] : rawMethods.filter((m) => !base.methods!.includes(m as HttpMethod)) as HttpMethod[];
  const addPathPrefixes = base.pathPrefixes === undefined ? [] : rawPrefixes.filter((p) => !base.pathPrefixes!.includes(p));

  if (addMethods.length === 0 && addPathPrefixes.length === 0) {
    const unrestricted: string[] = [];
    if (rawMethods.length > 0 && base.methods === undefined) unrestricted.push("every method");
    if (rawPrefixes.length > 0 && base.pathPrefixes === undefined) unrestricted.push("every path");
    throw new Error(
      unrestricted.length > 0
        ? `connection "${id}" already allows ${unrestricted.join(" and ")} in ${scopeHere(ctx.scope)} — nothing to widen.`
        : `connection "${id}" already grants everything requested in ${scopeHere(ctx.scope)} — nothing to request.`,
    );
  }

  return {
    kind: "widen-connection",
    scope: ctx.scope,
    ...(allowBroad ? { allowBroad } : {}),
    connectionId: id,
    addMethods,
    addPathPrefixes,
    baseConnection: base,
  };
}

function planGrantConnector(ask: AccessAsk, ctx: PlanContext, allowBroad: string | undefined): GrantConnectorDelta {
  if (!ask.connector || !ask.connector.trim()) {
    throw new Error(`grant-connector needs the connector name to grant — ${OUT_OF_VOCABULARY}`);
  }
  const name = ask.connector.trim();

  if (ctx.access.connectors.includes(name)) {
    throw new Error(`connector "${name}" is already granted to ${scopeHere(ctx.scope)} — nothing to request.`);
  }

  const defined = definedConnectors(ctx.bundles);
  if (!defined.includes(name)) {
    throw new Error(
      `connector "${name}" isn't defined in this deployment's config (defined: ${defined.length ? defined.join(", ") : "none"}) — ${OUT_OF_VOCABULARY}`,
    );
  }

  return { kind: "grant-connector", scope: ctx.scope, ...(allowBroad ? { allowBroad } : {}), connector: name };
}

export function planAccessDelta(ask: AccessAsk, ctx: PlanContext): AccessDelta {
  const problem = requestingScopeProblem(ctx.scope);
  if (problem) {
    throw new Error(`invalid requesting scope (${ctx.scope.level}) — ${problem}.`);
  }
  const allowBroad = planGroupTarget(ask, ctx);
  switch (ask.kind) {
    case "widen-connection":
      return planWidenConnection(ask, ctx, allowBroad);
    case "grant-connector":
      return planGrantConnector(ask, ctx, allowBroad);
    default:
      throw new Error(`unknown access-request kind "${ask.kind}" — the vocabulary is widen-connection | grant-connector; ${OUT_OF_VOCABULARY}`);
  }
}

export function grantSentence(delta: AccessDelta): string {
  const where = scopeWhere(delta.scope);
  if (delta.kind === "grant-connector") {
    return `Grant connector "${delta.connector}" to ${where}`;
  }
  const parts: string[] = [];
  if (delta.addMethods.length > 0) parts.push(`method${delta.addMethods.length > 1 ? "s" : ""} ${delta.addMethods.join(", ")}`);
  if (delta.addPathPrefixes.length > 0) parts.push(`path prefix${delta.addPathPrefixes.length > 1 ? "es" : ""} ${delta.addPathPrefixes.join(", ")}`);
  return `Allow ${parts.join(" and ")} on connection "${delta.connectionId}" for ${where}`;
}

export function renderDelta(delta: AccessDelta): string[] {
  const ack = delta.allowBroad ? [`  allowBroad: ${delta.allowBroad}`] : [];
  if (delta.kind === "grant-connector") {
    return ["```" + [`grant-connector: ${delta.connector} → ${scopeTarget(delta.scope)}`, ...ack].join("\n") + "```"];
  }
  const lines = [
    `widen-connection: ${delta.connectionId} → ${scopeTarget(delta.scope)}`,
    ...(delta.addMethods.length > 0 ? [`  + methods: ${delta.addMethods.join(", ")}`] : []),
    ...(delta.addPathPrefixes.length > 0 ? [`  + pathPrefixes: ${delta.addPathPrefixes.join(", ")}`] : []),
    `  base: ${delta.baseConnection.allowedWebsites.join(", ")} (methods: ${delta.baseConnection.methods?.join(",") ?? "all"}; paths: ${delta.baseConnection.pathPrefixes?.join(",") ?? "all"})`,
    ...ack,
  ];
  return ["```" + lines.join("\n") + "```"];
}

export function bindingsFor(bundleName: string, bindings: readonly Binding[]): readonly Binding[] {
  return bindings.filter((b) => b.bundle === bundleName);
}
