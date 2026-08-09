import { connectorGrantName, type Binding, type Bundle, type Connection, type HttpMethod, type Scope } from "./bundle.js";
import { HTTP_METHODS, requestingScopeProblem, sameScope, type AccessDelta, type RequestingScope } from "./delta.js";
import { overlayModuleHeader, unwrapOverlayModule, wrapOverlayModule, type OverlayModuleGrammar } from "./overlay-module.js";

export interface GrantsFile {
  readonly bundles: readonly Bundle[];
  readonly bindings: readonly Binding[];
}

export class GrantsCodemodError extends Error {}

export function emptyGrantsFile(): GrantsFile {
  return { bundles: [], bindings: [] };
}

export function overlayBundleName(scope: RequestingScope): string {
  switch (scope.level) {
    case "surface":
      return `grants:${scope.surface}`;
    case "principal":
      return `grants:principal:${scope.principal}`;
    case "group":
      return `grants:group:${scope.group}`;
  }
}

function bindingScope(scope: RequestingScope): Scope {
  switch (scope.level) {
    case "surface":
      return { level: "surface", surface: scope.surface };
    case "principal":
      return { level: "principal", principal: scope.principal };
    case "group":
      return { level: "group", group: scope.group };
  }
}

function requestingScopeOf(s: Scope): RequestingScope | undefined {
  if (s.level === "surface" && typeof s.surface === "string") return { level: "surface", surface: s.surface };
  if (s.level === "principal" && typeof s.principal === "string") return { level: "principal", principal: s.principal };
  if (s.level === "group" && typeof s.group === "string") return { level: "group", group: s.group };
  return undefined;
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
      throw new GrantsCodemodError(`grants bundle "${b.name}" connectors must be a string array (a \`{ name, contentOrigin }\` declaration is an operator assertion — put it in a code bundle, not the machine-written overlay)`);
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
    for (const k of Object.keys(bd)) {
      if (!["bundle", "scope", "allowBroad"].includes(k)) {
        throw new GrantsCodemodError(`grants binding for "${bd.bundle}" has field "${k}" — an overlay binding carries { bundle, scope } and at most allowBroad`);
      }
    }
    if (bd.allowBroad !== undefined && (typeof bd.allowBroad !== "string" || bd.allowBroad.trim() === "")) {
      throw new GrantsCodemodError(`grants binding for "${bd.bundle}" has an empty/malformed allowBroad — the escape must NAME the reason a broad grant is deliberate (access/lint.ts)`);
    }
    const raw = bd.scope as Record<string, unknown>;
    const scope = requestingScopeOf(raw as unknown as Scope);
    if (!scope) {
      throw new GrantsCodemodError(
        `grants binding for "${bd.bundle}" must be surface-, principal- or group-scoped with that level's own address field (got level="${String(raw.level)}") — the overlay never binds wider than one room, one person or one declared group`,
      );
    }
    const stray = ["tenant", "domain", "surface", "group", "principal"].filter(
      (f) => raw[f] !== undefined && f !== scope.level,
    );
    if (stray.length > 0) {
      throw new GrantsCodemodError(`grants binding for "${bd.bundle}" is ${scope.level}-scoped but also sets scope.${stray.join("/scope.")} — a scope carries exactly its own address field`);
    }
    const problem = requestingScopeProblem(scope);
    if (problem) throw new GrantsCodemodError(`grants binding for "${bd.bundle}": ${problem}`);
    bindings.push(bd as unknown as Binding);
  }

  return { bundles, bindings };
}

const BUNDLE_KEYS = ["name", "connections", "connectors"];
const CONNECTION_KEYS = ["id", "credentialType", "secretRef", "allowedWebsites", "pathPrefixes", "customHeaders", "methods", "authorizationDetails"];
const BINDING_KEYS = ["bundle", "scope", "allowBroad"];
const SCOPE_KEYS = ["level", "tenant", "domain", "surface", "group", "principal"];

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
  if (b.connectors) obj.connectors = [...b.connectors].sort((x, y) => connectorGrantName(x).localeCompare(connectorGrantName(y)));
  return orderKeys(obj, BUNDLE_KEYS);
}

function canonicalBinding(bd: Binding): Record<string, unknown> {
  return orderKeys({ ...bd, scope: orderKeys({ ...bd.scope } as Record<string, unknown>, SCOPE_KEYS) }, BINDING_KEYS);
}

function scopeSortKey(s: Scope): string {
  return `${s.surface ?? ""}/${s.tenant ?? ""}/${s.domain ?? ""}/${s.group ?? ""}/${s.principal ?? ""}/${s.level}`;
}

export function stringifyGrants(grants: GrantsFile): string {
  const canonical = {
    bundles: [...grants.bundles].sort((a, b) => a.name.localeCompare(b.name)).map(canonicalBundle),
    bindings: [...grants.bindings]
      .sort((a, b) => a.bundle.localeCompare(b.bundle) || scopeSortKey(a.scope).localeCompare(scopeSortKey(b.scope))),
  };
  return JSON.stringify({ bundles: canonical.bundles, bindings: canonical.bindings.map(canonicalBinding) }, null, 2) + "\n";
}

export const GRANTS_MODULE: OverlayModuleGrammar = {
  what: "grants overlay",
  header: overlayModuleHeader("grants overlay", "packages/core/agent/access/grants-codemod.ts"),
  typeImport: 'import type { GrantsFile } from "@open-everywhere/core/agent/access/grants-codemod.js";',
  typeName: "GrantsFile",
};

export function emitGrantsModule(grants: GrantsFile): string {
  return wrapOverlayModule(GRANTS_MODULE, stringifyGrants(grants));
}

export function parseGrantsModule(text: string): GrantsFile {
  const grants = parseGrantsFile(unwrapOverlayModule(GRANTS_MODULE, text, (m) => new GrantsCodemodError(m)));
  if (emitGrantsModule(grants) !== text) {
    throw new GrantsCodemodError(
      "grants overlay is not in canonical form — re-emitting its own data does not reproduce the file, so it has been hand-edited. Run `npm run overlays:normalize` and commit the result (the codemod refuses to rewrite a file it did not write).",
    );
  }
  return grants;
}

export function renormalizeGrantsModule(text: string): string {
  return emitGrantsModule(parseGrantsFile(unwrapOverlayModule(GRANTS_MODULE, text, (m) => new GrantsCodemodError(m))));
}

export interface ApplyDeltaResult {
  readonly grants: GrantsFile;
  readonly changed: boolean;
  readonly bundleName: string;
}

function scopeEquals(s: Scope, scope: RequestingScope): boolean {
  const other = requestingScopeOf(s);
  return other !== undefined && sameScope(other, scope);
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

function withBundle(grants: GrantsFile, name: string, next: Bundle, hadBundle: boolean, delta: AccessDelta): GrantsFile {
  const scope = delta.scope;
  const isTarget = (b: Binding): boolean => b.bundle === name && scopeEquals(b.scope, scope);
  const hadBinding = grants.bindings.some(isTarget);
  return {
    bundles: hadBundle ? grants.bundles.map((b) => (b.name === name ? next : b)) : [...grants.bundles, next],
    bindings: hadBinding
      ? grants.bindings.map((b) => (isTarget(b) && delta.allowBroad && b.allowBroad === undefined ? { ...b, allowBroad: delta.allowBroad } : b))
      : [...grants.bindings, { bundle: name, scope: bindingScope(scope), ...(delta.allowBroad ? { allowBroad: delta.allowBroad } : {}) }],
  };
}

export function applyDelta(grants: GrantsFile, delta: AccessDelta): ApplyDeltaResult {
  const problem = requestingScopeProblem(delta.scope);
  if (problem) throw new GrantsCodemodError(`delta scope is invalid — ${problem}`);
  if (delta.allowBroad !== undefined && delta.allowBroad.trim() === "") {
    throw new GrantsCodemodError("delta carries an EMPTY allowBroad — the escape must name the reason a broad grant is deliberate (access/lint.ts)");
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
    return { grants: withBundle(grants, name, next, existing !== undefined, delta), changed: true, bundleName: name };
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
  return { grants: withBundle(grants, name, next, existing !== undefined, delta), changed: true, bundleName: name };
}
