import { getOperationalStore } from "../operational/provider.js";
import type { AttentionRow } from "../operational/store.js";
import { ATTENTION_ROW_TTL_DAYS } from "../operational/store.js";
import type { PendingActionRow } from "../approvals/types.js";
import { actionKind } from "../approvals/actions.js";
import { clickerMayDecide } from "../approvals/flow.js";
import { plainSummaryForRow } from "../approvals/plain-summary.js";
import { pendingCardExpiryClause } from "../approvals/session-grant.js";
import { resolveMessagePermalink } from "../channels/surface-message-ops.js";
import { ATTENTION_LABEL } from "./attention.js";

const WAITING_ITEMS_MAX = 25;

export interface WaitingPerson {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly personId: string;
  readonly enterprise?: string;
}

export interface WaitingItem {
  readonly kind: "approval" | "attention";
  readonly sentence: string;
  readonly status: string;
  readonly where: string;
  readonly link?: string;
  readonly since: string;
}

export interface WaitingQueue {
  readonly items: readonly WaitingItem[];
  readonly omitted: number;
  readonly message: string;
}

export interface WaitingDeps {
  readonly now?: () => Date;
  readonly permalink?: typeof resolveMessagePermalink;
  readonly mayDecide?: (row: PendingActionRow, person: WaitingPerson) => boolean;
}

function platformOfKey(key: string | null | undefined): string | undefined {
  const first = key?.split("/")[0];
  return first && first.length > 0 ? first : undefined;
}

function workspaceOfKey(key: string | null | undefined): string | undefined {
  const second = key?.split("/")[1];
  return second && second.length > 0 ? second : undefined;
}

function liveMayDecide(row: PendingActionRow, person: WaitingPerson): boolean {
  try {
    return clickerMayDecide(row, person.personId, person.platform, person.workspace, person.enterprise);
  } catch {
    return false;
  }
}

function approvalStatus(row: PendingActionRow, person: WaitingPerson, mayDecide: (row: PendingActionRow, person: WaitingPerson) => boolean): string | undefined {
  const kind = actionKind(row.kind);
  if (!kind) return undefined;
  const raisedByThem = row.requestedBy === person.personId;
  if (kind.policy === "member") return raisedByThem ? "you can decide" : undefined;
  if (mayDecide(row, person)) return "you can decide (admin)";
  return raisedByThem ? "your request — waiting for an admin" : undefined;
}

async function linkOr(permalink: typeof resolveMessagePermalink, platform: string | undefined, ref: { channelId: string; messageId: string | null; workspace?: string }): Promise<string | undefined> {
  if (!platform || !ref.messageId) return undefined;
  return permalink(platform, { channelId: ref.channelId, messageId: ref.messageId, ...(ref.workspace ? { workspace: ref.workspace } : {}) }).catch(() => undefined);
}

async function approvalItems(person: WaitingPerson, nowIso: string, deps: WaitingDeps): Promise<WaitingItem[]> {
  const permalink = deps.permalink ?? resolveMessagePermalink;
  const mayDecide = deps.mayDecide ?? liveMayDecide;
  const rows = await getOperationalStore().listPendingActions(person.org);
  const items: WaitingItem[] = [];
  for (const row of rows) {
    if (!row.messageTs || row.expiresAt <= nowIso) continue;
    if (platformOfKey(row.postedTo) !== person.platform) continue;
    const status = approvalStatus(row, person, mayDecide);
    if (status === undefined) continue;
    const link = await linkOr(permalink, person.platform, { channelId: row.channelId, messageId: row.messageTs, workspace: workspaceOfKey(row.postedTo) });
    items.push({
      kind: "approval",
      sentence: plainSummaryForRow(row),
      status: `${status} · ${pendingCardExpiryClause(row.expiresAt)}`,
      where: row.postedTo ?? row.scopeKey,
      ...(link ? { link } : {}),
      since: row.createdAt,
    });
  }
  return items;
}

async function attentionItems(person: WaitingPerson, nowIso: string, deps: WaitingDeps): Promise<WaitingItem[]> {
  const permalink = deps.permalink ?? resolveMessagePermalink;
  const sinceIso = new Date(Date.parse(nowIso) - ATTENTION_ROW_TTL_DAYS * 24 * 60 * 60_000).toISOString();
  const rows: readonly AttentionRow[] = await getOperationalStore().listAttentionWaitingOn(person.org, person.platform, person.personId, sinceIso);
  const items: WaitingItem[] = [];
  for (const row of rows) {
    const link = await linkOr(permalink, platformOfKey(row.surfaceKey), { channelId: row.channelId, messageId: row.threadTs, workspace: workspaceOfKey(row.surfaceKey) });
    items.push({
      kind: "attention",
      sentence: row.summary,
      status: `a job is ${ATTENTION_LABEL[row.state]}`,
      where: row.surfaceKey,
      ...(link ? { link } : {}),
      since: row.since,
    });
  }
  return items;
}

function renderWaitingMessage(items: readonly WaitingItem[], omitted: number, unread: readonly string[]): string {
  const lines: string[] = [];
  if (items.length === 0) lines.push("Nothing is waiting on you right now: no open approval card you can decide, and no job blocked on you.");
  else lines.push(`${items.length} thing${items.length === 1 ? " is" : "s are"} waiting on you:`);
  items.forEach((item, n) => {
    lines.push(`${n + 1}. ${item.sentence} — ${item.status} — ${item.link ?? `in ${item.where}`}`);
  });
  if (omitted > 0) lines.push(`…and ${omitted} more not shown.`);
  for (const what of unread) lines.push(`(I could not read ${what} just now, so this list may be missing some.)`);
  return lines.join("\n");
}

export async function waitingOnPerson(person: WaitingPerson, deps: WaitingDeps = {}): Promise<WaitingQueue> {
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const unread: string[] = [];
  const approvals = await approvalItems(person, nowIso, deps).catch(() => {
    unread.push("the open approval cards");
    return [] as WaitingItem[];
  });
  const attention = await attentionItems(person, nowIso, deps).catch(() => {
    unread.push("the job states");
    return [] as WaitingItem[];
  });
  const newestFirst = (a: WaitingItem, b: WaitingItem): number => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0);
  const all = [...approvals.sort(newestFirst), ...attention.sort(newestFirst)];
  const items = all.slice(0, WAITING_ITEMS_MAX);
  const omitted = all.length - items.length;
  return { items, omitted, message: renderWaitingMessage(items, omitted, unread) };
}
