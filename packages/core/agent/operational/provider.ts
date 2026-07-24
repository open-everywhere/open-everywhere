import { sqliteOperationalStore } from "./sqlite.js";
import { makeOperationalPostgresStore, type PgClient } from "./postgres.js";
import type { OperationalStore } from "./store.js";
import { onVercel } from "../access/platform.js";

const REGISTRY: Record<string, OperationalStore> = {
  sqlite: sqliteOperationalStore,
};

let active: OperationalStore | null = null;
let sqliteFloorNagged = false;
let pgliteFloorNoticed = false;

export type OperationalFloor = "pglite" | "sqlite" | "none";

export function resolveOperationalSelection(env: NodeJS.ProcessEnv = process.env): { id: string; floor: OperationalFloor } {
  const explicit = env.OE_OPERATIONAL_PROVIDER?.trim();
  if (explicit) return { id: explicit, floor: explicit === "sqlite" ? "sqlite" : "none" };
  if (!env.DATABASE_URL?.trim()) return { id: "postgres", floor: "pglite" };
  return { id: "sqlite", floor: "sqlite" };
}

export function operationalSqliteFloorWarning(): string {
  return (
    "[open-everywhere:operational] ⚠ operational store is SQLite — a DEPRECATED floor. The default is now " +
    "the embedded-Postgres (PGlite) floor; sqlite has NO managed durability, backups, or replication (one file " +
    "on one box). Move off it with `migrate-operational` (from packages/core: " +
    "`DATABASE_URL=… npx tsx scripts/migrate-operational.ts` onto hosted Postgres, or " +
    "`npx tsx scripts/migrate-operational.ts --pglite-dir <dir>` onto the embedded-Postgres floor; " +
    "docs/deploy/database-graduation.md)."
  );
}

export function operationalPgliteFloorNotice(): string {
  return (
    "[open-everywhere:operational] running on the embedded Postgres floor (PGlite) — single-process, " +
    "local-disk durability only, fine for dev / a small self-host. For production org data point " +
    "DATABASE_URL at hosted Postgres (`migrate-operational` migrates you — same Postgres dialect, no rewrite)."
  );
}

function nagSqliteFloorOnce(): void {
  if (sqliteFloorNagged) return;
  sqliteFloorNagged = true;
  console.warn(operationalSqliteFloorWarning());
}

function noticePgliteFloorOnce(): void {
  if (pgliteFloorNoticed) return;
  pgliteFloorNoticed = true;
  console.warn(operationalPgliteFloorNotice());
}

export function getOperationalStore(): OperationalStore {
  if (active) return active;
  const { id, floor } = resolveOperationalSelection();

  if (floor !== "none" && onVercel() && process.env.OE_ALLOW_EPHEMERAL_OPERATIONAL !== "1") {
    throw new Error(
      `operational store is the ${floor === "pglite" ? "embedded-Postgres (PGlite)" : "sqlite"} floor on Vercel — ` +
        "audit, spend caps, and break-glass revocations would be per-instance and ephemeral (a revoke would " +
        "report success but never take effect). Set OE_OPERATIONAL_PROVIDER=postgres and register a client " +
        "(see docs/deploy/setup-runbook.md), or OE_ALLOW_EPHEMERAL_OPERATIONAL=1 to accept ephemeral " +
        "operational state on a single-instance host.",
    );
  }

  if (floor === "pglite") {
    const armed = REGISTRY.postgres;
    if (armed) {
      active = armed;
      noticePgliteFloorOnce();
      return armed;
    }
    active = REGISTRY.sqlite;
    return active;
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
  if (floor === "sqlite") nagSqliteFloorOnce();
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
  sqliteFloorNagged = false;
  pgliteFloorNoticed = false;
}
