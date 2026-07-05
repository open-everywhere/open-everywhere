import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionAuth } from "eve/context";
import type { BindableContext } from "../identity/binding.js";
import { resolveAccessFor } from "./request.js";
import { resolvePartition } from "../memory/partition.js";
import { getOperationalStore } from "../operational/provider.js";

export class ConnectorScopeError extends Error {}

interface ContextStore {
  get(key: unknown): unknown;
}
interface EveInternals {
  contextStorage: { getStore(): ContextStore | undefined };
  ChannelKey: unknown;
}

let internalsPromise: Promise<EveInternals | null> | undefined;
function loadEveInternals(): Promise<EveInternals | null> {
  if (internalsPromise) return internalsPromise;
  internalsPromise = (async () => {
    try {
      const require = createRequire(import.meta.url);
      const root = dirname(require.resolve("eve/package.json"));
      const abs = (rel: string) => pathToFileURL(join(root, rel)).href;
      const [container, runtimeKeys] = await Promise.all([
        import(abs("dist/src/context/container.js")),
        import(abs("dist/src/runtime/sessions/runtime-context-keys.js")),
      ]);
      if (!container?.contextStorage || !runtimeKeys?.ChannelKey) {
        internalsLoadError = "internal modules loaded but expected exports are missing";
        return null;
      }
      return { contextStorage: container.contextStorage, ChannelKey: runtimeKeys.ChannelKey };
    } catch (err) {
      internalsLoadError = String(err);
      return null;
    }
  })();
  return internalsPromise;
}

let internalsLoadError: string | undefined;

const loggedReasons = new Set<string>();
function logOnce(reason: string): void {
  if (!loggedReasons.has(reason)) {
    loggedReasons.add(reason);
    console.warn(`[open-everywhere:surface-context] ${reason}`);
  }
}

async function readChannelKind(): Promise<string | undefined> {
  const eve = await loadEveInternals();
  if (!eve) {
    logOnce(`channel kind unresolvable: eve internals failed to load: ${internalsLoadError ?? "(unknown)"}`);
    return undefined;
  }
  const store = eve.contextStorage.getStore();
  if (!store) {
    logOnce("channel kind unresolvable: no ALS store — outside an eve session scope (expected on a hosted build)");
    return undefined;
  }
  const channel = store.get(eve.ChannelKey) as { kind?: string } | undefined;
  return channel?.kind;
}

export async function surfaceContextFromAuth(auth: SessionAuth): Promise<BindableContext | null> {
  const current = auth.current ?? null;
  const initiator = auth.initiator ?? current;
  if (current === null && initiator === null) {
    logOnce("resolver ctx carried no auth identity (current/initiator both null) — fail closed");
    return null;
  }
  const kind = await readChannelKind();
  type SessionAuthShape = NonNullable<NonNullable<BindableContext["session"]>["auth"]>;
  return {
    session: { auth: { current, initiator } as SessionAuthShape },
    channel: { kind },
  } as BindableContext;
}

export function applyConnectorOverrides(
  base: readonly string[],
  overrides: readonly { connector: string; granted: boolean }[],
): string[] {
  const set = new Set(base);
  for (const o of overrides) {
    if (!o.granted) set.delete(o.connector);
  }
  return [...set].sort();
}

export async function grantedConnectors(auth: SessionAuth): Promise<readonly string[] | null> {
  const ctx = await surfaceContextFromAuth(auth);
  if (!ctx) return null;
  try {
    const base = resolveAccessFor(ctx).connectors;
    try {
      const p = resolvePartition(ctx);
      const overrides = await getOperationalStore().connectorOverrides(p.org, p.surfaceKey);
      return overrides.length ? applyConnectorOverrides(base, overrides) : base;
    } catch (err) {
      console.warn(`[open-everywhere:connector-scope] override lookup failed; using config grants only: ${String(err)}`);
      return base;
    }
  } catch {
    return null;
  }
}

export async function boundConnectorCredential(
  connection: string,
  auth: SessionAuth,
): Promise<import("./providers.js").ResolvedConnectorCredential | null> {
  const ctx = await surfaceContextFromAuth(auth);
  if (!ctx) return null;
  try {
    return resolveAccessFor(ctx).connectorCredentials[connection] ?? null;
  } catch {
    return null;
  }
}

export async function assertConnectorGranted(connectionName: string, auth: SessionAuth): Promise<void> {
  const granted = await grantedConnectors(auth);
  if (granted === null) {
    throw new ConnectorScopeError(
      `connection "${connectionName}": refusing — could not resolve the calling surface ` +
        `(no auth identity on the resolver ctx). Fail closed.`,
    );
  }
  if (!granted.includes(connectionName)) {
    throw new ConnectorScopeError(
      `connection "${connectionName}" is not granted to this surface. ` +
        `Grant it with \`connectors: ["${connectionName}"]\` on a bundle bound to this scope ` +
        `(see agent/access/bundles.ts).`,
    );
  }
}
