import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { auditRowSha, findChainBreak } from "@open-everywhere/core/agent/audit/chain.js";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import type { AuditChainRow } from "@open-everywhere/core/agent/operational/store.js";
import { auditCursor, bootAgent, discordMentionWake, disposeLater, registerScript, rowsSinceCursor, seatReply, waitFor } from "../harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

function org(): string {
  return deploymentOrg();
}

async function chainRows(): Promise<readonly AuditChainRow[]> {
  return getOperationalStore().readAuditChain(org());
}

function ascendingBySeq(arr: readonly AuditChainRow[]): boolean {
  return arr.every((r, i) => i === 0 || r.seq > arr[i - 1].seq);
}

function withTamperDb<T>(fn: (db: DatabaseSync) => T): T {
  const path = process.env.OE_SQLITE_PATH;
  if (path === undefined || path.length === 0) {
    throw new Error("audit-chain test: OE_SQLITE_PATH is unset — bootAgent({ sharedSqlite: true }) did not run.");
  }
  const db = new DatabaseSync(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

interface RawAuditRow {
  readonly seq: number;
  readonly ts: string;
  readonly org_id: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string | null;
  readonly principal_id: string | null;
  readonly action: string;
  readonly detail: string | null;
  readonly prev_sha: string | null;
}

function readRawRow(seq: number): RawAuditRow {
  return withTamperDb((db) => {
    const row = db.prepare("SELECT * FROM audit_entry WHERE seq = ?").get(seq) as RawAuditRow | undefined;
    if (row === undefined) throw new Error(`audit-chain test: no stored audit row at seq ${seq}.`);
    return { ...row, seq: Number(row.seq) };
  });
}

function setStoredDetail(seq: number, detailJson: string | null): void {
  withTamperDb((db) => {
    db.prepare("UPDATE audit_entry SET detail = ? WHERE seq = ?").run(detailJson, seq);
  });
}

function deleteStoredRow(seq: number): void {
  withTamperDb((db) => {
    db.prepare("DELETE FROM audit_entry WHERE seq = ?").run(seq);
  });
}

function restoreStoredRow(row: RawAuditRow): void {
  withTamperDb((db) => {
    db.prepare(
      `INSERT INTO audit_entry (seq, ts, org_id, platform, workspace, surface, principal_id, action, detail, prev_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.seq, row.ts, row.org_id, row.platform, row.workspace, row.surface, row.principal_id, row.action, row.detail, row.prev_sha);
  });
}

interface DrivenTurn {
  readonly channelId: string;
  readonly replyChars: number;
}
let driven: DrivenTurn | undefined;

async function turnOnce(): Promise<DrivenTurn> {
  if (driven !== undefined) return driven;
  const channelId = freshUnlistedChannelId();
  const nonce = randomBytes(6).toString("hex");
  const replyText = `oe-audit-chain-ok ${nonce}`;
  const handle = disposeLater(registerScript({ parent: [seatReply(replyText, "audit-chain-reply"), { say: "done" }] }));
  const cursor = await auditCursor();

  await discordMentionWake({ channelId, text: `<@9000000000000000001> ${nonce} please answer` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the scripted model to see the wake");
  const posted = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.find((r) => r.surface === channelId);
  }, `a reply.post audit row for channel ${channelId}`);
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the turn's last step");
  expect((posted.detail as { chars?: unknown }).chars).toBe(replyText.length);
  driven = { channelId, replyChars: replyText.length };
  return driven;
}

const TURN_ROW_SPINE = ["egress.policy", "reply.post"] as const;

function rowsForTurn(rows: readonly AuditChainRow[], channelId: string): readonly AuditChainRow[] {
  return rows.filter((r) => r.surface === channelId);
}

async function soundChainWithVictim(channelId: string): Promise<{
  readonly rows: readonly AuditChainRow[];
  readonly index: number;
  readonly victim: AuditChainRow;
  readonly successor: AuditChainRow;
}> {
  const rows = await chainRows();
  expect(findChainBreak(rows, { expectGenesis: true })).toBeNull();
  const index = rows.findIndex((r) => r.surface === channelId && r.action === "egress.policy");
  expect(index).toBeGreaterThanOrEqual(0);
  expect(index).toBeLessThan(rows.length - 1);
  return { rows, index, victim: rows[index], successor: rows[index + 1] };
}

test("a REAL turn's rows land in the store as an unbroken hash chain from the org's genesis", async () => {
  await bootAgent({ sharedSqlite: true });
  const { channelId } = await turnOnce();

  expect(await getOperationalStore().listAuditOrgs()).toContain(org());

  const rows = await chainRows();
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.some((r) => r.surface === channelId && r.action === "reply.post")).toBe(true);

  expect(rows[0].prevSha).toBeNull();

  for (let i = 1; i < rows.length; i++) {
    expect(rows[i].prevSha, `the stored link into seq ${rows[i].seq} ("${rows[i].action}")`).toBe(
      auditRowSha(rows[i - 1], rows[i - 1].prevSha),
    );
  }

  expect(findChainBreak(rows, { expectGenesis: true })).toBeNull();

  const truncated = findChainBreak(rows.slice(1), { expectGenesis: true });
  expect(truncated?.index).toBe(0);
  expect(truncated?.seq).toBe(rows[1].seq);
  expect(truncated?.reason).toContain("genesis");
});

test("the turn's rows are ordered and complete — egress policy first, exactly one reply, seq ascending", async () => {
  await bootAgent({ sharedSqlite: true });
  const { channelId, replyChars } = await turnOnce();

  const pre = await chainRows();
  expect(pre.length).toBeGreaterThan(2);
  expect(ascendingBySeq(pre)).toBe(true);
  expect(ascendingBySeq([...pre].reverse())).toBe(false);

  const mine = rowsForTurn(pre, channelId);
  const kinds = mine.map((r) => r.action);
  for (const kind of TURN_ROW_SPINE) expect(kinds).toContain(kind);
  expect(kinds.filter((k) => k === "reply.post")).toEqual(["reply.post"]);
  expect((mine.find((r) => r.action === "reply.post")?.detail as { chars?: unknown } | undefined)?.chars).toBe(replyChars);

  const seqOf = (action: string): number => {
    const hit = mine.find((r) => r.action === action);
    if (hit === undefined) throw new Error(`audit-chain test: no ${action} row for ${channelId} (saw: ${kinds.join(", ") || "none"}).`);
    return hit.seq;
  };
  expect(seqOf("egress.policy")).toBeLessThan(seqOf("reply.post"));

  const tail = await getOperationalStore().readAuditChain(org(), { tailLimit: 3 });
  const post = await chainRows();
  expect(tail.length).toBe(3);
  expect(ascendingBySeq(tail)).toBe(true);
  expect(tail[tail.length - 1].seq).toBeGreaterThanOrEqual(pre[pre.length - 1].seq);
  const at = post.findIndex((r) => r.seq === tail[0].seq);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(post.slice(at, at + tail.length).map((r) => r.seq)).toEqual(tail.map((r) => r.seq));
  expect(findChainBreak(tail, { expectGenesis: false })).toBeNull();
  expect(findChainBreak(tail, { expectGenesis: true })?.index).toBe(0);
});

test("NEGATIVE CONTROL — mutating one stored row's detail breaks the chain at exactly its successor", async () => {
  await bootAgent({ sharedSqlite: true });
  const { channelId } = await turnOnce();

  const { victim, successor } = await soundChainWithVictim(channelId);
  const original = readRawRow(victim.seq);

  setStoredDetail(victim.seq, JSON.stringify({ ...(victim.detail ?? {}), hosts: ["evil.example"], enforced: true }));
  try {
    const after = await chainRows();
    const tampered = after.find((r) => r.seq === victim.seq);
    if (tampered === undefined) throw new Error(`audit-chain test: the tampered row at seq ${victim.seq} vanished from the chain.`);
    expect(tampered.detail).not.toEqual(victim.detail);
    expect(tampered.prevSha).toBe(victim.prevSha);

    const brk = findChainBreak(after, { expectGenesis: true });
    expect(brk).not.toBeNull();
    expect(brk?.seq).toBe(successor.seq);
    expect(brk?.action).toBe(successor.action);
    expect(brk?.actualPrev).toBe(successor.prevSha);
    expect(brk?.expectedPrev).toBe(auditRowSha(tampered, tampered.prevSha));
    expect(brk?.expectedPrev).not.toBe(brk?.actualPrev);
  } finally {
    setStoredDetail(original.seq, original.detail);
  }

  expect(findChainBreak(await chainRows(), { expectGenesis: true })).toBeNull();
});

test("NEGATIVE CONTROL — deleting one stored row breaks the chain at the row that followed it", async () => {
  await bootAgent({ sharedSqlite: true });
  const { channelId } = await turnOnce();

  const { index, victim: victimRow, successor } = await soundChainWithVictim(channelId);
  const victim = readRawRow(victimRow.seq);

  deleteStoredRow(victim.seq);
  try {
    const after = await chainRows();
    expect(after.some((r) => r.seq === victim.seq)).toBe(false);
    const brk = findChainBreak(after, { expectGenesis: true });
    expect(brk).not.toBeNull();
    expect(brk?.index).toBe(index);
    expect(brk?.seq).toBe(successor.seq);
    expect(brk?.actualPrev).toBe(successor.prevSha);
  } finally {
    restoreStoredRow(victim);
  }

  expect(findChainBreak(await chainRows(), { expectGenesis: true })).toBeNull();
});
