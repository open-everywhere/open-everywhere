import { sqliteOperationalStore } from "./sqlite.js";
import { makeOperationalPostgresStore, type PgClient } from "./postgres.js";
import type { OperationalStore } from "./store.js";
import { onVercel } from "../access/platform.js";

const REGISTRY: Record<string, OperationalStore> = {
  sqlite: sqliteOperationalStore,
};

let active: OperationalStore | null = null;
let floorNagged = false;

export function operationalSqliteFloorWarning(): string {
  return (
    "[open-everywhere:operational] ⚠ operational store is SQLite — the zero-wiring floor for dev / a tiny " +
    "single-instance self-host: NO managed durability, backups, or replication (one file on one box). " +
    "For production org data (audit log, spend ledger, break-glass revocations) set DATABASE_URL to hosted " +
    "Postgres + OE_OPERATIONAL_PROVIDER=postgres, then graduate the data with the migration " +
    "(from packages/core: `DATABASE_URL=… npx tsx scripts/migrate-operational.ts`; docs/deploy/database-graduation.md)."
  );
}

function nagOperationalFloorOnce(id: string): void {
  if (floorNagged || id !== "sqlite") return;
  floorNagged = true;
  console.warn(operationalSqliteFloorWarning());
}

export function getOperationalStore(): OperationalStore {
  if (active) return active;
  const id = process.env.OE_OPERATIONAL_PROVIDER ?? "sqlite";

  if (id === "sqlite" && onVercel() && process.env.OE_ALLOW_EPHEMERAL_OPERATIONAL !== "1") {
    throw new Error(
      "operational store is sqlite on Vercel — audit, spend caps, and break-glass revocations " +
        "would be per-instance and ephemeral (a revoke would report success but never take effect). " +
        "Set OE_OPERATIONAL_PROVIDER=postgres and register a client (see docs/deploy/setup-runbook.md), " +
        "or OE_ALLOW_EPHEMERAL_OPERATIONAL=1 to accept ephemeral operational state on a single-instance host.",
    );
  }

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
  nagOperationalFloorOnce(id);
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

export function _resetFloorNagForTest(): void {
  floorNagged = false;
}
