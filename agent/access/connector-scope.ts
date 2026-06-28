import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BindableContext } from "../identity/binding.js";
import { buildResolveRequest } from "./request.js";
import { resolveAccess } from "./resolver.js";
import { loadBindings, loadBundles } from "./bundles.js";
import { resolvePartition } from "../memory/partition.js";
import { getOperationalStore } from "../operational/provider.js";

export class ConnectorScopeError extends Error {}

interface ContextStore {
  get(key: unknown): unknown;
}
interface EveInternals {
  contextStorage: { getStore(): ContextStore | undefined };
  AuthKey: unknown;
  InitiatorAuthKey: unknown;
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
      const [container, keys, runtimeKeys] = await Promise.all([
        import(abs("dist/src/context/container.js")),
        import(abs("dist/src/context/keys.js")),
        import(abs("dist/src/runtime/sessions/runtime-context-keys.js")),
      ]);
      if (!container?.contextStorage || !keys?.AuthKey || !runtimeKeys?.ChannelKey) return null;
      return {
        contextStorage: container.contextStorage,
        AuthKey: keys.AuthKey,
        InitiatorAuthKey: keys.InitiatorAuthKey,
        ChannelKey: runtimeKeys.ChannelKey,
      };
    } catch {
      return null;
    }
  })();
  return internalsPromise;
}

async function readSurfaceContext(): Promise<BindableContext | null> {
  const eve = await loadEveInternals();
  if (!eve) return null;
  const store = eve.contextStorage.getStore();
  if (!store) return null;
  const current = store.get(eve.AuthKey) ?? null;
  const initiator = store.get(eve.InitiatorAuthKey) ?? current;
  if (current === null && initiator === null) return null;
  const channel = store.get(eve.ChannelKey) as { kind?: string } | undefined;
  type SessionAuth = NonNullable<NonNullable<BindableContext["session"]>["auth"]>;
  return {
    session: { auth: { current, initiator } as SessionAuth },
    channel: { kind: channel?.kind },
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

export async function grantedConnectors(): Promise<readonly string[] | null> {
  const ctx = await readSurfaceContext();
  if (!ctx) return null;
  try {
    const base = resolveAccess(buildResolveRequest(ctx), loadBundles(), loadBindings()).connectors;
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

export async function assertConnectorGranted(connectionName: string): Promise<void> {
  const granted = await grantedConnectors();
  if (granted === null) {
    throw new ConnectorScopeError(
      `connection "${connectionName}": refusing — could not resolve the calling surface ` +
        `(no eve session context, or unresolvable identity). Fail closed.`,
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
