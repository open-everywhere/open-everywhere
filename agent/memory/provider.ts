import type { Partition } from "./partition.js";
import { sqliteProvider } from "./sqlite.js";
import {
  deleteTier as gitDeleteTier,
  ensureTier as gitEnsureTier,
  readTier as gitReadTier,
  storeRoot as gitStoreRoot,
  writeTier as gitWriteTier,
  type MemoryFiles,
  type Tier,
} from "./store.js";

export interface MemoryProvider {
  readonly id: string;

  readTier(p: Partition, tier: Tier): Promise<MemoryFiles>;

  ensureTier(p: Partition, tier: Tier): Promise<MemoryFiles>;

  writeTier(p: Partition, tier: Tier, files: MemoryFiles, message: string): Promise<string | null>;

  deleteTier(p: Partition, tier: Tier): Promise<void>;

  root?(): string;
}

export const gitProvider: MemoryProvider = {
  id: "git",
  readTier: gitReadTier,
  ensureTier: gitEnsureTier,
  writeTier: gitWriteTier,
  deleteTier: gitDeleteTier,
  root: gitStoreRoot,
};

const REGISTRY: Record<string, MemoryProvider> = {
  git: gitProvider,
  sqlite: sqliteProvider,
};

let active: MemoryProvider | null = null;

export function getProvider(): MemoryProvider {
  if (active) return active;
  const id = process.env.OE_MEMORY_PROVIDER ?? "git";
  const provider = REGISTRY[id];
  if (!provider) {
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

export function resetProvider(): void {
  active = null;
}
