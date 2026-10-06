import { getOperationalStore } from "../operational/provider.js";
import { deploymentOrg, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { noteConnectorRead, rememberRecordName, type ConnectorRead } from "./reply-provenance.js";
import { resolveUnifiedWakeTarget, sameUnifiedConversation } from "./unified-window.js";
import type { TaskWakeInstall } from "./task-wake.js";

const DELEGATED_PROVENANCE_PREFIX = "oe-delegated-provenance:";

const DELEGATED_PROVENANCE_TTL_MS = 6 * 60 * 60 * 1000;

const MAX_DELEGATED_READS = 32;

const MAX_DELEGATED_RECORD_NAME_CHARS = 120;

export interface DelegatedReadRecord {
  readonly kind: string;
  readonly id: string;
  readonly name: string;
}

export interface DelegatedRead {
  readonly connection: string;
  readonly op: string;
  readonly record?: DelegatedReadRecord;
}

export interface DelegatingParentLink {
  readonly sessionId: string;
  readonly callId: string;
}

export function delegatingParentLink(ctx: unknown): DelegatingParentLink | null {
  try {
    const parent = (ctx as { session?: { parent?: { sessionId?: unknown; callId?: unknown } } }).session?.parent;
    const sessionId = parent?.sessionId;
    const callId = parent?.callId;
    if (typeof sessionId === "string" && sessionId.length > 0 && typeof callId === "string" && callId.length > 0) {
      return { sessionId, callId };
    }
    return null;
  } catch {
    return null;
  }
}

function delegationRowKey(link: DelegatingParentLink): string {
  return `subagent:${link.sessionId}:${link.callId}`;
}

export function delegatedProvenanceKey(childToken: string): string {
  return `${DELEGATED_PROVENANCE_PREFIX}${childToken}`;
}

function capRecordName(name: string): string {
  const chars = Array.from(name);
  return chars.length <= MAX_DELEGATED_RECORD_NAME_CHARS ? name : chars.slice(0, MAX_DELEGATED_RECORD_NAME_CHARS).join("");
}

function parseDelegatedReads(raw: string | null): readonly DelegatedRead[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const reads = (parsed as { reads?: unknown } | null)?.reads;
    if (!Array.isArray(reads)) return [];
    return reads.flatMap((r): DelegatedRead[] => {
      const row = r as { connection?: unknown; op?: unknown; record?: unknown } | null;
      if (typeof row?.connection !== "string" || row.connection.length === 0) return [];
      if (typeof row.op !== "string" || row.op.length === 0) return [];
      const rec = row.record as { kind?: unknown; id?: unknown; name?: unknown } | null | undefined;
      const record =
        typeof rec?.kind === "string" &&
        rec.kind.length > 0 &&
        typeof rec.id === "string" &&
        rec.id.length > 0 &&
        typeof rec.name === "string" &&
        rec.name.length > 0
          ? { kind: rec.kind, id: rec.id, name: capRecordName(rec.name) }
          : undefined;
      return [{ connection: row.connection, op: row.op, ...(record === undefined ? {} : { record }) }];
    });
  } catch {
    return [];
  }
}

async function readDelegatedReads(org: string, childToken: string): Promise<readonly DelegatedRead[]> {
  try {
    if (childToken.length === 0) return [];
    return parseDelegatedReads(await getOperationalStore().getTaskResult(org, delegatedProvenanceKey(childToken)));
  } catch {
    return [];
  }
}

async function writeDelegatedReads(org: string, childToken: string, reads: readonly DelegatedRead[]): Promise<void> {
  await getOperationalStore().putTaskResult(
    org,
    delegatedProvenanceKey(childToken),
    JSON.stringify({ reads: [...reads] }),
    new Date().toISOString(),
    DELEGATED_PROVENANCE_TTL_MS,
  );
}

async function writeSpentDelegatedReads(org: string, childToken: string, replayKey: string, reads: readonly DelegatedRead[]): Promise<void> {
  await getOperationalStore().putTaskResult(
    org,
    delegatedProvenanceKey(childToken),
    JSON.stringify({ reads: [], spent: { by: replayKey, reads: [...reads] } }),
    new Date().toISOString(),
    DELEGATED_PROVENANCE_TTL_MS,
  );
}

async function readSpentDelegatedReads(org: string, childToken: string, replayKey: string): Promise<readonly DelegatedRead[]> {
  try {
    const raw = await getOperationalStore().getTaskResult(org, delegatedProvenanceKey(childToken));
    if (raw === null) return [];
    const spent = (JSON.parse(raw) as { spent?: { by?: unknown; reads?: unknown } } | null)?.spent;
    if (spent?.by !== replayKey) return [];
    return parseDelegatedReads(JSON.stringify({ reads: spent.reads }));
  } catch {
    return [];
  }
}

let appendQueue: Promise<unknown> = Promise.resolve();

async function appendDelegatedRead(org: string, childToken: string, read: DelegatedRead): Promise<void> {
  const cur = await readDelegatedReads(org, childToken);
  if (cur.length >= MAX_DELEGATED_READS) return;
  if (cur.some((r) => r.connection === read.connection && r.op === read.op && r.record?.kind === read.record?.kind && r.record?.id === read.record?.id)) return;
  await writeDelegatedReads(org, childToken, [...cur, read]);
}

export function noteDelegatedRead(bind: BindableContext, connection: string, op: string, record?: DelegatedReadRecord): void {
  try {
    if (connection.length === 0 || op.length === 0) return;
    if (!isSubagentChildContext(bind)) return;
    const link = delegatingParentLink(bind);
    if (link === null) return;
    const org = deploymentOrg();
    const childToken = delegationRowKey(link);
    const carried =
      record !== undefined && record.kind.length > 0 && record.id.length > 0 && record.name.length > 0
        ? { kind: record.kind, id: record.id, name: capRecordName(record.name) }
        : undefined;
    const read: DelegatedRead = { connection, op, ...(carried === undefined ? {} : { record: carried }) };
    appendQueue = appendQueue.then(() => appendDelegatedRead(org, childToken, read)).catch(() => undefined);
  } catch {
  }
}

export interface DelegatedReadSettlement {
  readonly found: number;
  readonly carried: number;
}

async function sameConversationAsTaskWake(org: string, taskWake: string, inherited: string): Promise<boolean> {
  if (taskWake === inherited) return false;
  try {
    const store = getOperationalStore();
    const [a, b] = await Promise.all([resolveUnifiedWakeTarget(store, org, taskWake), resolveUnifiedWakeTarget(store, org, inherited)]);
    if (a === null || b === null) return false;
    return sameUnifiedConversation(a, b);
  } catch {
    return false;
  }
}

export async function delegatedSecondAddress(input: {
  readonly org: string;
  readonly taskWakeId: string | null;
  readonly inheritedWakeId: string | undefined;
  readonly outcome: TaskWakeInstall["outcome"];
}): Promise<string | undefined> {
  const { taskWakeId, inheritedWakeId } = input;
  if (input.outcome !== "installed") return undefined;
  if (taskWakeId === null || taskWakeId.length === 0) return undefined;
  if (inheritedWakeId === undefined || inheritedWakeId.length === 0) return undefined;
  return (await sameConversationAsTaskWake(input.org, taskWakeId, inheritedWakeId)) ? inheritedWakeId : undefined;
}

export async function heldTurnWakeProvable(input: {
  readonly org: string;
  readonly outcome: TaskWakeInstall["outcome"];
  readonly sameSession: boolean | undefined;
  readonly taskWakeId: string | null;
  readonly turnWakeId: string | undefined;
}): Promise<boolean> {
  if (input.outcome !== "ingressed" || input.sameSession !== true) return false;
  if (input.taskWakeId === null || input.taskWakeId.length === 0) return false;
  if (input.turnWakeId === undefined || input.turnWakeId.length === 0) return false;
  return await sameConversationAsTaskWake(input.org, input.taskWakeId, input.turnWakeId);
}

export async function settleDelegatedReads(input: {
  readonly org: string;
  readonly childToken: string;
  readonly sessionId: string | undefined;
  readonly turnId: string | undefined;
  readonly reach: Pick<ConnectorRead, "proof" | "surfaceKey" | "wakeId" | "alsoWakeId"> | undefined;
  readonly replayKey?: string;
}): Promise<DelegatedReadSettlement> {
  const none: DelegatedReadSettlement = { found: 0, carried: 0 };
  try {
    if (input.childToken.length === 0) return none;
    let reads = await readDelegatedReads(input.org, input.childToken);
    if (reads.length === 0 && input.replayKey !== undefined && input.replayKey.length > 0) {
      reads = await readSpentDelegatedReads(input.org, input.childToken, input.replayKey);
    }
    if (reads.length === 0) return none;
    const reach = input.reach;
    if (reach !== undefined) {
      for (const read of reads) {
        noteConnectorRead(input.turnId, {
          ...reach,
          connection: read.connection,
          op: read.op,
          ...(read.record === undefined ? {} : { record: { kind: read.record.kind, id: read.record.id } }),
        });
        if (read.record !== undefined) {
          rememberRecordName(input.sessionId, input.turnId, read.record.kind, read.record.id, read.record.name);
        }
      }
    }
    if (input.replayKey !== undefined && input.replayKey.length > 0) {
      await writeSpentDelegatedReads(input.org, input.childToken, input.replayKey, reads).catch(() => undefined);
    } else {
      await writeDelegatedReads(input.org, input.childToken, []).catch(() => undefined);
    }
    return { found: reads.length, carried: reach === undefined ? 0 : reads.length };
  } catch {
    return none;
  }
}
