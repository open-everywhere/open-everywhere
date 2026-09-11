import type { Partition } from "./partition.js";
import type { MemorySilo } from "./silo.js";
import type { CredentialBoundDomain } from "../access/domain-credentials.js";
import { sqliteProvider } from "./sqlite.js";
import { makePostgresProvider, type PgClient } from "./postgres.js";
import { onVercel } from "../access/platform.js";
import {
  deleteTier as gitDeleteTier,
  deleteFile as gitDeleteFile,
  ensureTier as gitEnsureTier,
  readTier as gitReadTier,
  storeRoot as gitStoreRoot,
  tierVersion as gitTierVersion,
  writeTier as gitWriteTier,
  type MemoryFiles,
  type Tier,
} from "./store.js";

export interface MemoryAccess {
  readonly domain?: CredentialBoundDomain;
}

export interface MemoryProvider {
  readonly id: string;

  readTier(p: Partition, tier: Tier, silo?: MemorySilo, access?: MemoryAccess): Promise<MemoryFiles>;

  ensureTier(p: Partition, tier: Tier, silo?: MemorySilo, access?: MemoryAccess): Promise<MemoryFiles>;

  writeTier(
    p: Partition,
    tier: Tier,
    files: MemoryFiles,
    message: string,
    silo?: MemorySilo,
    access?: MemoryAccess,
  ): Promise<string | null>;

  deleteTier(p: Partition, tier: Tier, silo?: MemorySilo, access?: MemoryAccess): Promise<void>;

  tierVersion?(p: Partition, tier: Tier, silo?: MemorySilo, access?: MemoryAccess): Promise<string | null>;

  deleteFile?(p: Partition, tier: Tier, relPath: string, silo?: MemorySilo, access?: MemoryAccess): Promise<string | null>;

  root?(): string;
}

export const gitProvider: MemoryProvider = {
  id: "git",
  readTier: gitReadTier,
  ensureTier: gitEnsureTier,
  writeTier: gitWriteTier,
  tierVersion: gitTierVersion,
  deleteTier: gitDeleteTier,
  deleteFile: gitDeleteFile,
  root: gitStoreRoot,
};

const REGISTRY: Record<string, MemoryProvider> = {
  git: gitProvider,
  sqlite: sqliteProvider,
};

export function registerPostgres(client: PgClient): MemoryProvider {
  const provider = makePostgresProvider(client);
  registerProvider(provider);
  return provider;
}

let active: MemoryProvider | null = null;

export function getProvider(): MemoryProvider {
  if (active) return active;
  const id = process.env.OE_MEMORY_PROVIDER ?? "git";
  const provider = REGISTRY[id];
  if (!provider) {
    if (id === "postgres") {
      throw new Error(
        'OE_MEMORY_PROVIDER="postgres" but no client is registered — call ' +
          "registerPostgres(client) at startup (see docs/setup.md).",
      );
    }
    throw new Error(
      `unknown OE_MEMORY_PROVIDER "${id}" (have: ${Object.keys(REGISTRY).join(", ")})`,
    );
  }
  active = provider;
  return provider;
}

export function registerProvider(provider: MemoryProvider): void {
  REGISTRY[provider.id] = provider;
}

export function providerById(id: string | undefined): MemoryProvider {
  if (!id) {
    throw new Error("memory provider requested for a silo with no provider — malformed silo (wiring bug).");
  }
  const provider = REGISTRY[id];
  if (!provider) {
    throw new Error(
      `unknown memory provider "${id}" — a silo references it but it isn't registered ` +
        `(have: ${Object.keys(REGISTRY).join(", ")}). For "postgres" call registerPostgres(); ` +
        `for "github"/"notion" wire the adapter (docs/capabilities/memory.md).`,
    );
  }
  return provider;
}

export function dbProviderId(): string {
  if (process.env.OE_MEMORY_PROVIDER === "postgres" && REGISTRY["postgres"]) return "postgres";
  if (onVercel() && process.env.OE_ALLOW_EPHEMERAL_MEMORY !== "1") {
    throw new Error(
      "DM/personal memory has no durable backing on Vercel — sqlite is per-instance and ephemeral " +
        "(a memory write would report success but be lost on the next cold start). Set " +
        "OE_MEMORY_PROVIDER=postgres and register a client (docs/deploy/setup-runbook.md), or " +
        "OE_ALLOW_EPHEMERAL_MEMORY=1 to accept ephemeral personal memory on a single-instance host.",
    );
  }
  return "sqlite";
}

export function resetProvider(): void {
  active = null;
}
