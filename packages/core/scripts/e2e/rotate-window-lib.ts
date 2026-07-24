import { unifiedDomainSessionKey } from "../../agent/channels/unified-supervisor.js";
import { formatWindowToken, formatDmSeatToken, dmSeatRegistryKey, saltSupervisorGeneration } from "../../agent/channels/window-key.js";
import { registerOperationalPostgres, getOperationalStore } from "../../agent/operational/provider.js";
import type { PgClient } from "../../agent/operational/postgres.js";
import type { OperationalStore, ChannelSessionRow } from "../../agent/operational/store.js";

export async function wireNeonOperationalStore(dbUrl: string): Promise<OperationalStore> {
  const pkg = "@neondatabase/serverless";
  const { neon } = (await import(pkg)) as {
    neon: (url: string) => { query(text: string, params?: unknown[]): Promise<unknown> };
  };
  const sql = neon(dbUrl);
  const client: PgClient = {
    query: async (text, params) => ({ rows: (await sql.query(text, (params ?? []) as unknown[])) as unknown[] }),
  };
  process.env.OE_OPERATIONAL_PROVIDER = "postgres";
  registerOperationalPostgres(client);
  return getOperationalStore();
}

export interface RotateResult {
  readonly registryKey: string;
  readonly oldGeneration: number | null;
  readonly oldToken: string | null;
  readonly mintedGeneration: number;
  readonly newRow: ChannelSessionRow;
}

export async function rotateUnifiedWindow(
  store: OperationalStore,
  org: string,
  domain: string,
  windowId?: string,
): Promise<RotateResult> {
  const window = windowId ?? domain;
  const registryKey = unifiedDomainSessionKey(window);
  const cur = await store.getChannelSession(org, registryKey);
  const generation = Date.now();
  const newToken = saltSupervisorGeneration(formatWindowToken({ domain, windowId: window, generation }));
  const newRow = await store.rotateChannelSession(org, registryKey, newToken, new Date().toISOString());
  return {
    registryKey,
    oldGeneration: cur ? cur.generation : null,
    oldToken: cur?.token ?? null,
    mintedGeneration: generation,
    newRow,
  };
}

export async function rotateDmSeat(store: OperationalStore, org: string, dmChannelId: string): Promise<RotateResult> {
  const registryKey = dmSeatRegistryKey(dmChannelId);
  const cur = await store.getChannelSession(org, registryKey);
  const generation = (cur?.generation ?? 0) + 1;
  const newToken = formatDmSeatToken(dmChannelId, generation);
  const newRow = await store.rotateChannelSession(org, registryKey, newToken, new Date().toISOString());
  return {
    registryKey,
    oldGeneration: cur ? cur.generation : null,
    oldToken: cur?.token ?? null,
    mintedGeneration: generation,
    newRow,
  };
}
