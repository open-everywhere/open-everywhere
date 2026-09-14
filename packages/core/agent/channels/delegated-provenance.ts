import { getOperationalStore } from "../operational/provider.js";
import { deploymentOrg, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { noteConnectorRead, type ConnectorRead } from "./reply-provenance.js";

const DELEGATED_PROVENANCE_PREFIX = "oe-delegated-provenance:";

const DELEGATED_PROVENANCE_TTL_MS = 6 * 60 * 60 * 1000;

const MAX_DELEGATED_READS = 32;

export interface DelegatedRead {
  readonly connection: string;
  readonly op: string;
}

export interface DelegatingParentLink {
  readonly sessionId: string;
  readonly callId: string;
}

export function delegatingParentLink(ctx: unknown): DelegatingParentLink | null {
  try {
    const token = (ctx as { channel?: { continuationToken?: unknown } }).channel?.continuationToken;
    if (typeof token === "string") {
      const m = /^subagent:([^:]+):([^:]+)$/.exec(token);
      if (m !== null) return { sessionId: m[1]!, callId: m[2]! };
    }
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

function childContinuationToken(link: DelegatingParentLink): string {
  return `subagent:${link.sessionId}:${link.callId}`;
}

export function delegatedProvenanceKey(childToken: string): string {
  return `${DELEGATED_PROVENANCE_PREFIX}${childToken}`;
}

function parseDelegatedReads(raw: string | null): readonly DelegatedRead[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const reads = (parsed as { reads?: unknown } | null)?.reads;
    if (!Array.isArray(reads)) return [];
    return reads.flatMap((r): DelegatedRead[] => {
      const row = r as { connection?: unknown; op?: unknown } | null;
      if (typeof row?.connection !== "string" || row.connection.length === 0) return [];
      if (typeof row.op !== "string" || row.op.length === 0) return [];
      return [{ connection: row.connection, op: row.op }];
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

let appendQueue: Promise<unknown> = Promise.resolve();

async function appendDelegatedRead(org: string, childToken: string, read: DelegatedRead): Promise<void> {
  const cur = await readDelegatedReads(org, childToken);
  if (cur.length >= MAX_DELEGATED_READS) return;
  if (cur.some((r) => r.connection === read.connection && r.op === read.op)) return;
  await writeDelegatedReads(org, childToken, [...cur, read]);
}

export function noteDelegatedRead(bind: BindableContext, connection: string, op: string): void {
  try {
    if (connection.length === 0 || op.length === 0) return;
    if (!isSubagentChildContext(bind)) return;
    const link = delegatingParentLink(bind);
    if (link === null) return;
    const org = deploymentOrg();
    const childToken = childContinuationToken(link);
    appendQueue = appendQueue.then(() => appendDelegatedRead(org, childToken, { connection, op })).catch(() => undefined);
  } catch {
  }
}

export interface DelegatedReadSettlement {
  readonly found: number;
  readonly carried: number;
}

export async function settleDelegatedReads(input: {
  readonly org: string;
  readonly childToken: string;
  readonly turnId: string | undefined;
  readonly reach: Pick<ConnectorRead, "proof" | "surfaceKey" | "wakeId"> | undefined;
}): Promise<DelegatedReadSettlement> {
  const none: DelegatedReadSettlement = { found: 0, carried: 0 };
  try {
    if (input.childToken.length === 0) return none;
    const reads = await readDelegatedReads(input.org, input.childToken);
    if (reads.length === 0) return none;
    const reach = input.reach;
    if (reach !== undefined) {
      for (const read of reads) {
        noteConnectorRead(input.turnId, { ...reach, connection: read.connection, op: read.op });
      }
    }
    await writeDelegatedReads(input.org, input.childToken, []).catch(() => undefined);
    return { found: reads.length, carried: reach === undefined ? 0 : reads.length };
  } catch {
    return none;
  }
}
