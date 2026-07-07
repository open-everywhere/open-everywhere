import type { Binding, Bundle, Connection, HttpMethod, Scope } from "./bundle.js";
import { HTTP_METHODS, type AccessDelta, type RequestingScope } from "./delta.js";

export interface GrantsFile {
  readonly bundles: readonly Bundle[];
  readonly bindings: readonly Binding[];
}

export class GrantsCodemodError extends Error {}

export function emptyGrantsFile(): GrantsFile {
  return { bundles: [], bindings: [] };
}

export function overlayBundleName(scope: RequestingScope): string {
  return `grants:${scope.workspace}/${scope.channel}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function parseGrantsFile(value: unknown): GrantsFile {
  if (!isRecord(value)) throw new GrantsCodemodError("grants file must be a JSON object with `bundles` and `bindings` arrays");
  const keys = Object.keys(value).filter((k) => k !== "$comment");
  const unknown = keys.filter((k) => k !== "bundles" && k !== "bindings");
  if (unknown.length > 0) throw new GrantsCodemodError(`grants file has unknown top-level key(s): ${unknown.join(", ")}`);
  if (!Array.isArray(value.bundles) || !Array.isArray(value.bindings)) {
    throw new GrantsCodemodError("grants file needs `bundles` and `bindings` arrays (use [] when empty)");
  }

  const bundles: Bundle[] = [];
  for (const b of value.bundles) {
    if (!isRecord(b) || typeof b.name !== "string" || !b.name.startsWith("grants:")) {
      throw new GrantsCodemodError(`every grants bundle needs a "grants:"-prefixed name (got: ${JSON.stringify(isRecord(b) ? b.name : b)})`);
    }
    for (const k of Object.keys(b)) {
      if (!["name", "connections", "connectors"].includes(k)) {
        throw new GrantsCodemodError(`grants bundle "${b.name}" has field "${k}" — the overlay carries only connections/connectors (v1 vocabulary); put anything else in a code bundle`);
      }
    }
    if (b.connectors !== undefined && !isStringArray(b.connectors)) {
      throw new GrantsCodemodError(`grants bundle "${b.name}" connectors must be a string array`);
    }
    if (b.connections !== undefined) {
      if (!Array.isArray(b.connections)) throw new GrantsCodemodError(`grants bundle "${b.name}" connections must be an array`);
      for (const c of b.connections) {
        if (!isRecord(c) || typeof c.id !== "string" || typeof c.credentialType !== "string" || typeof c.secretRef !== "string" || !isStringArray(c.allowedWebsites)) {
          throw new GrantsCodemodError(`grants bundle "${b.name}" has a malformed connection (needs id/credentialType/secretRef/allowedWebsites)`);
        }
      }
    }
    bundles.push(b as unknown as Bundle);
  }

  const bindings: Binding[] = [];
  for (const bd of value.bindings) {
    if (!isRecord(bd) || typeof bd.bundle !== "string" || !isRecord(bd.scope)) {
      throw new GrantsCodemodError("every grants binding needs { bundle, scope }");
    }
    const scope = bd.scope as Record<string, unknown>;
    if (scope.level !== "channel" || typeof scope.workspace !== "string" || typeof scope.channel !== "string") {
      throw new GrantsCodemodError(`grants binding for "${bd.bundle}" must be channel-scoped with bare workspace/channel ids (the overlay never binds wider)`);
    }
    bindings.push(bd as unknown as Binding);
  }

  return { bundles, bindings };
}

export function parseGrantsText(text: string): GrantsFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new GrantsCodemodError(`grants file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseGrantsFile(json);
}

const BUNDLE_KEYS = ["name", "connections", "connectors"];
const CONNECTION_KEYS = ["id", "credentialType", "secretRef", "allowedWebsites", "pathPrefixes", "customHeaders", "methods", "authorizationDetails"];
const BINDING_KEYS = ["bundle", "scope"];
const SCOPE_KEYS = ["level", "workspace", "domain", "channel"];

function orderKeys(obj: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of order) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj).sort()) if (!(k in out)) out[k] = obj[k];
  return out;
}

function methodSort(methods: readonly HttpMethod[]): HttpMethod[] {
  return [...methods].sort((a, b) => HTTP_METHODS.indexOf(a) - HTTP_METHODS.indexOf(b));
}

function canonicalConnection(c: Connection): Record<string, unknown> {
  const obj: Record<string, unknown> = { ...c };
  if (c.methods) obj.methods = methodSort(c.methods);
  if (c.pathPrefixes) obj.pathPrefixes = [...c.pathPrefixes].sort();
  return orderKeys(obj, CONNECTION_KEYS);
}

function canonicalBundle(b: Bundle): Record<string, unknown> {
  const obj: Record<string, unknown> = { ...b };
  if (b.connections) obj.connections = [...b.connections].sort((x, y) => x.id.localeCompare(y.id)).map(canonicalConnection);
  if (b.connectors) obj.connectors = [...b.connectors].sort();
  return orderKeys(obj, BUNDLE_KEYS);
}

function canonicalBinding(bd: Binding): Record<string, unknown> {
  return orderKeys({ ...bd, scope: orderKeys({ ...bd.scope } as Record<string, unknown>, SCOPE_KEYS) }, BINDING_KEYS);
}

function scopeSortKey(s: Scope): string {
  return `${s.workspace ?? ""}/${s.channel ?? ""}/${s.domain ?? ""}/${s.level}`;
}

export function stringifyGrants(grants: GrantsFile): string {
  const canonical = {
    bundles: [...grants.bundles].sort((a, b) => a.name.localeCompare(b.name)).map(canonicalBundle),
    bindings: [...grants.bindings]
      .sort((a, b) => a.bundle.localeCompare(b.bundle) || scopeSortKey(a.scope).localeCompare(scopeSortKey(b.scope))),
  };
  return JSON.stringify({ bundles: canonical.bundles, bindings: canonical.bindings.map(canonicalBinding) }, null, 2) + "\n";
}

export interface ApplyDeltaResult {
  readonly grants: GrantsFile;
  readonly changed: boolean;
  readonly bundleName: string;
}

function scopeEquals(s: Scope, scope: RequestingScope): boolean {
  return s.level === "channel" && s.workspace === scope.workspace && s.channel === scope.channel;
}

function bundlesBoundToScope(grants: GrantsFile, scope: RequestingScope): readonly Bundle[] {
  const names = new Set(grants.bindings.filter((b) => scopeEquals(b.scope, scope)).map((b) => b.bundle));
  return grants.bundles.filter((b) => names.has(b.name));
}

function writeTarget(grants: GrantsFile, scope: RequestingScope): { name: string; existing: Bundle | undefined } {
  const base = overlayBundleName(scope);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}#${n}`;
    const existing = grants.bundles.find((b) => b.name === name);
    if (!existing) return { name, existing: undefined };
    const bindings = grants.bindings.filter((b) => b.bundle === name);
    const singleBound = bindings.length === 1 && scopeEquals(bindings[0].scope, scope);
    if (singleBound) return { name, existing };
  }
}

function withBundle(grants: GrantsFile, name: string, next: Bundle, hadBundle: boolean, hadBinding: boolean, scope: RequestingScope): GrantsFile {
  return {
    bundles: hadBundle ? grants.bundles.map((b) => (b.name === name ? next : b)) : [...grants.bundles, next],
    bindings: hadBinding
      ? grants.bindings
      : [...grants.bindings, { bundle: name, scope: { level: "channel", workspace: scope.workspace, channel: scope.channel } }],
  };
}

export function applyDelta(grants: GrantsFile, delta: AccessDelta): ApplyDeltaResult {
  if (!delta.scope.workspace || !delta.scope.channel || delta.scope.workspace.includes("/") || delta.scope.channel.includes("/")) {
    throw new GrantsCodemodError(`delta scope must be bare platform ids (got workspace="${delta.scope.workspace}", channel="${delta.scope.channel}")`);
  }

  if (delta.kind === "grant-connector") {
    if (!delta.connector || delta.connector.includes(" ")) {
      throw new GrantsCodemodError(`invalid connector name "${delta.connector}"`);
    }
    if (bundlesBoundToScope(grants, delta.scope).some((b) => b.connectors?.includes(delta.connector))) {
      return { grants, changed: false, bundleName: overlayBundleName(delta.scope) };
    }
    const { name, existing } = writeTarget(grants, delta.scope);
    const next: Bundle = {
      ...(existing ?? { name }),
      connectors: [...new Set([...(existing?.connectors ?? []), delta.connector])].sort(),
    };
    return { grants: withBundle(grants, name, next, existing !== undefined, existing !== undefined, delta.scope), changed: true, bundleName: name };
  }

  const { connectionId, addMethods, addPathPrefixes, baseConnection } = delta;
  if (baseConnection.id !== connectionId) {
    throw new GrantsCodemodError(`delta baseConnection.id "${baseConnection.id}" doesn't match connectionId "${connectionId}"`);
  }
  if (addMethods.length === 0 && addPathPrefixes.length === 0) {
    throw new GrantsCodemodError("widen-connection delta adds nothing");
  }
  if (addMethods.length > 0 && baseConnection.methods === undefined) {
    throw new GrantsCodemodError(`connection "${connectionId}" has no methods restriction — nothing to widen`);
  }
  if (addPathPrefixes.length > 0 && baseConnection.pathPrefixes === undefined) {
    throw new GrantsCodemodError(`connection "${connectionId}" has no pathPrefixes restriction — adding prefixes would narrow, not widen`);
  }

  const { name, existing } = writeTarget(grants, delta.scope);
  const current = existing?.connections?.find((c) => c.id === connectionId) ?? baseConnection;
  const widened: Connection = {
    ...current,
    ...(current.methods !== undefined ? { methods: methodSort([...new Set([...current.methods, ...addMethods])]) } : {}),
    ...(current.pathPrefixes !== undefined ? { pathPrefixes: [...new Set([...current.pathPrefixes, ...addPathPrefixes])].sort() } : {}),
  };

  const alreadyEffective =
    existing?.connections?.some(
      (c) =>
        c.id === connectionId &&
        addMethods.every((m) => c.methods?.includes(m)) &&
        addPathPrefixes.every((p) => c.pathPrefixes?.includes(p)),
    ) === true;
  if (alreadyEffective) return { grants, changed: false, bundleName: name };

  const others = (existing?.connections ?? []).filter((c) => c.id !== connectionId);
  const next: Bundle = { ...(existing ?? { name }), connections: [...others, widened] };
  return { grants: withBundle(grants, name, next, existing !== undefined, existing !== undefined, delta.scope), changed: true, bundleName: name };
}
