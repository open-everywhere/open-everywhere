import { createHash } from "node:crypto";
import type { ExitTableAccess, OperationalStore } from "../operational/store.js";
import type { MemoryProvider } from "../memory/provider.js";
import { SURFACE } from "../memory/store.js";
import type { Partition } from "../memory/partition.js";
import { EXIT_TABLES } from "./catalogue.js";
import type { ExitRowFilter } from "./sql.js";
import { deleteLocalRun } from "./workflow-world.js";
import type { TranscriptStore } from "./transcript-store.js";

export const EXIT_PERSON_ERASED_ACTION = "exit.person_erased";

const PERSON_KEY = /^[a-z0-9][a-z0-9-]*\/[^/\s]+(?:\/[^/\s]+)?$/u;

export interface PersonIds {
  readonly key: string;
  readonly platform: string;
  readonly nativeId: string;
  readonly all: readonly string[];
}

export function personIds(key: string): PersonIds {
  const trimmed = key.trim();
  if (!PERSON_KEY.test(trimmed)) {
    throw new Error(`"${key}" is not a person key — write it as platform/id or platform/workspace/id, for example slack/T0123/U0456`);
  }
  const parts = trimmed.split("/");
  const platform = parts[0]!;
  const nativeId = parts[parts.length - 1]!;
  return { key: trimmed, platform, nativeId, all: [...new Set([trimmed, nativeId, `${platform}:person/${nativeId}`])] };
}

const ROOM_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._:@-]+$/u;

function dmPartition(org: string, roomKey: string): Partition | undefined {
  const parts = roomKey.split("/");
  if (parts.length < 3 || !parts.every((p) => ROOM_SEGMENT.test(p))) return undefined;
  const [platform, workspace] = parts as [string, string];
  const surface = parts.slice(2).join("/");
  const workspaceKey = [platform, workspace].join("/");
  const surfaceKey = [workspaceKey, surface].join("/");
  return { org, platform, workspace, surface, workspaceKey, surfaceKey, key: surfaceKey };
}

export interface ErasePersonOptions {
  readonly store: OperationalStore;
  readonly org: string;
  readonly person: string;
  readonly dmRooms?: readonly string[];
  readonly memory?: readonly MemoryProvider[];
  readonly transcripts?: TranscriptStore;
  readonly actor: string;
  readonly now?: Date;
}

export interface ErasePersonReport {
  readonly personSha256: string;
  readonly rows: Readonly<Record<string, number>>;
  readonly refused: readonly string[];
  readonly kept: Readonly<Record<string, string>>;
  readonly dmRooms: readonly string[];
  readonly memoryTiers: number;
  readonly transcripts: {
    readonly store: "local" | "hosted" | "none";
    readonly deleted: number;
    readonly live: number;
    readonly shared: readonly string[];
  };
}

function requireExitTables(store: OperationalStore): ExitTableAccess {
  if (store.exitTables === undefined) throw new Error(`the ${store.id} operational store has no exit-kit table access, so it cannot erase`);
  return store.exitTables;
}

export async function erasePerson(opts: ErasePersonOptions): Promise<ErasePersonReport> {
  const tables = requireExitTables(opts.store);
  const ids = personIds(opts.person);
  const { org } = opts;

  const rooms = new Set(opts.dmRooms ?? []);
  for (const room of await tables.selectDistinct("dm_rule", org, "surface_key", { anyOf: [{ column: "owner_id", values: ids.all }] })) rooms.add(room);
  const dmRooms = [...rooms].sort();

  const personSessions = new Set<string>();
  const roomSessions = new Set<string>();
  for (const spec of EXIT_TABLES) {
    if (spec.sessionColumn === undefined) continue;
    if (spec.personColumns !== undefined) {
      const anyOf = spec.personColumns.map((column) => ({ column, values: ids.all }));
      const allOf = spec.platformColumn !== undefined ? [{ column: spec.platformColumn, values: [ids.platform] }] : undefined;
      for (const s of await tables.selectDistinct(spec.table, org, spec.sessionColumn, { anyOf, ...(allOf ? { allOf } : {}) })) personSessions.add(s);
    }
    if (spec.surfaceColumn !== undefined && dmRooms.length > 0) {
      for (const s of await tables.selectDistinct(spec.table, org, spec.sessionColumn, { anyOf: [{ column: spec.surfaceColumn, values: dmRooms }] })) roomSessions.add(s);
    }
  }
  const own = new Set(roomSessions);
  const shared: string[] = [];
  const idSet = new Set(ids.all);
  for (const session of personSessions) {
    if (own.has(session)) continue;
    const callers = await tables.selectDistinct("usage_events", org, "principal_id", { anyOf: [{ column: "session_id", values: [session] }] });
    if (callers.length > 0 && callers.every((c) => idSet.has(c))) own.add(session);
    else shared.push(session);
  }

  const rows: Record<string, number> = {};
  const refused: string[] = [];
  for (const spec of EXIT_TABLES) {
    if (spec.appendOnly || spec.orgColumn === null) continue;
    const byPerson = spec.keptOnErase === undefined ? (spec.personColumns ?? []) : [];
    const byRoom = spec.surfaceColumn !== undefined && dmRooms.length > 0 ? [{ column: spec.surfaceColumn, values: dmRooms }] : [];
    const filters: ExitRowFilter[] =
      spec.platformColumn !== undefined && byPerson.length > 0
        ? [
            { anyOf: byPerson.map((column) => ({ column, values: ids.all })), allOf: [{ column: spec.platformColumn, values: [ids.platform] }] },
            ...(byRoom.length > 0 ? [{ anyOf: byRoom }] : []),
          ]
        : [{ anyOf: [...byPerson.map((column) => ({ column, values: ids.all })), ...byRoom] }];
    if (filters.every((f) => (f.anyOf ?? []).length === 0)) continue;
    try {
      let n = 0;
      for (const f of filters) if ((f.anyOf ?? []).length > 0) n += await tables.deleteRows(spec.table, org, f);
      if (n > 0) rows[spec.table] = n;
    } catch (err) {
      if (!/permission denied/iu.test(String(err instanceof Error ? err.message : err))) throw err;
      refused.push(spec.table);
    }
  }

  let memoryTiers = 0;
  for (const room of dmRooms) {
    const p = dmPartition(org, room);
    if (p === undefined) continue;
    for (const provider of opts.memory ?? []) {
      if (provider.id === "git") continue;
      const before = await provider.readTier(p, SURFACE);
      await provider.deleteTier(p, SURFACE);
      if (Object.keys(before).length > 0) memoryTiers++;
    }
  }

  let deleted = 0;
  let live = 0;
  if (opts.transcripts?.kind === "local") {
    for (const session of [...own].sort()) {
      if (!/^wrun_[A-Za-z0-9]+$/u.test(session)) continue;
      const r = deleteLocalRun(opts.transcripts.dataDir, session);
      if (r.outcome === "deleted") deleted++;
      else if (r.outcome === "refused-live") live++;
    }
  }

  const personSha256 = createHash("sha256").update(ids.key).digest("hex");
  const report: ErasePersonReport = {
    personSha256,
    rows,
    refused,
    kept: Object.fromEntries(EXIT_TABLES.filter((t) => t.keptOnErase !== undefined).map((t) => [t.table, t.keptOnErase!])),
    dmRooms,
    memoryTiers,
    transcripts: { store: opts.transcripts?.kind ?? "none", deleted, live, shared: shared.sort() },
  };
  await opts.store.appendAudit({
    ts: (opts.now ?? new Date()).toISOString(),
    org,
    platform: "exit",
    workspace: "erase",
    principalId: opts.actor,
    action: EXIT_PERSON_ERASED_ACTION,
    detail: {
      personSha256,
      rows,
      refused: [...refused],
      dmRooms: dmRooms.length,
      memoryTiers,
      transcriptStore: report.transcripts.store,
      transcriptsDeleted: deleted,
      transcriptsLive: live,
      transcriptsShared: shared.length,
    },
  });
  return report;
}
