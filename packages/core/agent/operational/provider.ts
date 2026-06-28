import { sqliteOperationalStore } from "./sqlite.js";
import { makeOperationalPostgresStore, type PgClient } from "./postgres.js";
import type { OperationalStore } from "./store.js";

const REGISTRY: Record<string, OperationalStore> = {
  sqlite: sqliteOperationalStore,
};

let active: OperationalStore | null = null;

export function getOperationalStore(): OperationalStore {
  if (active) return active;
  const id = process.env.OE_OPERATIONAL_PROVIDER ?? "sqlite";
  const store = REGISTRY[id];
  if (!store) {
    if (id === "postgres") {
      throw new Error(
        'OE_OPERATIONAL_PROVIDER="postgres" but no client is registered — call ' +
          "registerOperationalPostgres(client) at startup (see docs/setup.md).",
      );
    }
    throw new Error(`unknown OE_OPERATIONAL_PROVIDER "${id}" (have: ${Object.keys(REGISTRY).join(", ")})`);
  }
  active = store;
  return store;
}

export function registerOperationalPostgres(client: PgClient): OperationalStore {
  const store = makeOperationalPostgresStore(client);
  REGISTRY[store.id] = store;
  return store;
}

export function registerOperationalStore(store: OperationalStore): void {
  REGISTRY[store.id] = store;
}

export function resetOperationalStore(): void {
  active = null;
}
