import type { Binding, Bundle, Connection, HttpMethod } from "./bundle.js";
import type { EffectiveAccess } from "./resolver.js";

export const OUT_OF_VOCABULARY =
  "that isn't something I can request automatically — an admin needs to PR this by hand (edit agent/access/bundles.ts in the config repo).";

export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

export interface RequestingScope {
  readonly workspace: string;
  readonly channel: string;
}

export interface WidenConnectionDelta {
  readonly kind: "widen-connection";
  readonly scope: RequestingScope;
  readonly connectionId: string;
  readonly addMethods: readonly HttpMethod[];
  readonly addPathPrefixes: readonly string[];
  readonly baseConnection: Connection;
}

export interface GrantConnectorDelta {
  readonly kind: "grant-connector";
  readonly scope: RequestingScope;
  readonly connector: string;
}

export type AccessDelta = WidenConnectionDelta | GrantConnectorDelta;

export interface AccessAsk {
  readonly kind: string;
  readonly connection?: string;
  readonly addMethods?: readonly string[];
  readonly addPathPrefixes?: readonly string[];
  readonly connector?: string;
}

export interface PlanContext {
  readonly scope: RequestingScope;
  readonly access: EffectiveAccess;
  readonly bundles: readonly Bundle[];
}

function isHttpMethod(v: string): v is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(v);
}

export function definedConnectors(bundles: readonly Bundle[]): readonly string[] {
  return [...new Set(bundles.flatMap((b) => b.connectors ?? []))].sort();
}

function planWidenConnection(ask: AccessAsk, ctx: PlanContext): WidenConnectionDelta {
  if (!ask.connection || !ask.connection.trim()) {
    throw new Error(`widen-connection needs the connection id to widen — ${OUT_OF_VOCABULARY}`);
  }
  const id = ask.connection.trim();

  const base = ctx.access.connections.find((c) => c.id === id);
  if (!base) {
    throw new Error(
      `connection "${id}" isn't effective in this channel (effective: ${
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
        ? `connection "${id}" already allows ${unrestricted.join(" and ")} here — nothing to widen.`
        : `connection "${id}" already grants everything requested in this channel — nothing to request.`,
    );
  }

  return {
    kind: "widen-connection",
    scope: ctx.scope,
    connectionId: id,
    addMethods,
    addPathPrefixes,
    baseConnection: base,
  };
}

function planGrantConnector(ask: AccessAsk, ctx: PlanContext): GrantConnectorDelta {
  if (!ask.connector || !ask.connector.trim()) {
    throw new Error(`grant-connector needs the connector name to grant — ${OUT_OF_VOCABULARY}`);
  }
  const name = ask.connector.trim();

  if (ctx.access.connectors.includes(name)) {
    throw new Error(`connector "${name}" is already granted to this channel — nothing to request.`);
  }

  const defined = definedConnectors(ctx.bundles);
  if (!defined.includes(name)) {
    throw new Error(
      `connector "${name}" isn't defined in this deployment's config (defined: ${defined.length ? defined.join(", ") : "none"}) — ${OUT_OF_VOCABULARY}`,
    );
  }

  return { kind: "grant-connector", scope: ctx.scope, connector: name };
}

export function planAccessDelta(ask: AccessAsk, ctx: PlanContext): AccessDelta {
  if (!ctx.scope.workspace || !ctx.scope.channel || ctx.scope.workspace.includes("/") || ctx.scope.channel.includes("/")) {
    throw new Error(`invalid requesting scope (workspace="${ctx.scope.workspace}", channel="${ctx.scope.channel}") — bare platform ids required.`);
  }
  switch (ask.kind) {
    case "widen-connection":
      return planWidenConnection(ask, ctx);
    case "grant-connector":
      return planGrantConnector(ask, ctx);
    default:
      throw new Error(`unknown access-request kind "${ask.kind}" — the vocabulary is widen-connection | grant-connector; ${OUT_OF_VOCABULARY}`);
  }
}

export function grantSentence(delta: AccessDelta): string {
  const where = `channel ${delta.scope.channel} (workspace ${delta.scope.workspace})`;
  if (delta.kind === "grant-connector") {
    return `Grant connector "${delta.connector}" to ${where}`;
  }
  const parts: string[] = [];
  if (delta.addMethods.length > 0) parts.push(`method${delta.addMethods.length > 1 ? "s" : ""} ${delta.addMethods.join(", ")}`);
  if (delta.addPathPrefixes.length > 0) parts.push(`path prefix${delta.addPathPrefixes.length > 1 ? "es" : ""} ${delta.addPathPrefixes.join(", ")}`);
  return `Allow ${parts.join(" and ")} on connection "${delta.connectionId}" for ${where}`;
}

export function renderDelta(delta: AccessDelta): string[] {
  if (delta.kind === "grant-connector") {
    return [`\`\`\`grant-connector: ${delta.connector} → ${delta.scope.workspace}/${delta.scope.channel}\`\`\``];
  }
  const lines = [
    `widen-connection: ${delta.connectionId} → ${delta.scope.workspace}/${delta.scope.channel}`,
    ...(delta.addMethods.length > 0 ? [`  + methods: ${delta.addMethods.join(", ")}`] : []),
    ...(delta.addPathPrefixes.length > 0 ? [`  + pathPrefixes: ${delta.addPathPrefixes.join(", ")}`] : []),
    `  base: ${delta.baseConnection.allowedWebsites.join(", ")} (methods: ${delta.baseConnection.methods?.join(",") ?? "all"}; paths: ${delta.baseConnection.pathPrefixes?.join(",") ?? "all"})`,
  ];
  return ["```" + lines.join("\n") + "```"];
}

export function bindingsFor(bundleName: string, bindings: readonly Binding[]): readonly Binding[] {
  return bindings.filter((b) => b.bundle === bundleName);
}
