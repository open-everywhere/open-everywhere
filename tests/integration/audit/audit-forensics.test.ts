import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  awaitWindowQuiet,
  auditCursor,
  bootAgent,
  CONTROL_SERVICE_PRINCIPAL,
  controlGet,
  DISCORD_GUILD_ID,
  DISCORD_USER_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  seatReply,
  waitFor,
  type AuditCursor,
  type AuditRow,
} from "../harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

interface DrivenTurn {
  readonly channelId: string;
  readonly nonce: string;
  readonly replyChars: number;
  readonly cursor: AuditCursor;
  readonly reply: AuditRow;
}
let driven: DrivenTurn | undefined;

async function turnOnce(): Promise<DrivenTurn> {
  if (driven !== undefined) return driven;
  const channelId = freshUnlistedChannelId();
  const nonce = randomBytes(6).toString("hex");
  const replyText = `oe-audit-forensics-ok ${nonce}`;
  const handle = disposeLater(registerScript({ parent: [seatReply(replyText, "forensics-reply")] }));
  const cursor = await auditCursor();

  await discordMentionWake({ channelId, text: `<@9000000000000000001> ${nonce} please answer` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the scripted model to see the wake");
  const reply = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.find((r) => r.surface === channelId);
  }, `a reply.post audit row for channel ${channelId}`);
  await awaitWindowQuiet();
  expect(handle.requests.some((r) => r.role === "parent" && r.stepIndex !== 0), "a step after the reply was requested").toBe(false);

  expect(reply.detail?.chars).toBe(replyText.length);
  driven = { channelId, nonce, replyChars: replyText.length, cursor, reply };
  return driven;
}

function sessionIdOf(row: AuditRow): string {
  const id = row.detail?.sessionId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`audit-forensics test: the ${row.action} row carries no detail.sessionId (detail: ${JSON.stringify(row.detail)}).`);
  }
  return id;
}

interface TranscriptBody {
  readonly sessionId?: string;
  readonly found?: boolean;
  readonly count?: number;
  readonly startIndex?: number;
  readonly nextIndex?: number;
  readonly events?: readonly { readonly index: number; readonly type: string; readonly data: unknown }[];
  readonly error?: string;
  readonly hint?: string;
}

async function readTranscript(
  sessionId: string,
  opts: { readonly token?: string | null; readonly startIndex?: number; readonly limit?: number } = {},
): Promise<{ status: number; body: TranscriptBody }> {
  const query = new URLSearchParams();
  if (opts.startIndex !== undefined) query.set("startIndex", String(opts.startIndex));
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  const qs = query.size > 0 ? `?${query.toString()}` : "";
  const res = await controlGet(`/control/v1/session/${encodeURIComponent(sessionId)}/transcript${qs}`, { token: opts.token });
  let parsed: TranscriptBody = {};
  try {
    parsed = JSON.parse(res.body) as TranscriptBody;
  } catch {
    throw new Error(`audit-forensics test: the transcript route answered ${res.status} with a non-JSON body: ${res.body.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

async function serviceCallRows(cursor: AuditCursor): Promise<AuditRow[]> {
  return rowsSinceCursor(cursor, ["control.service_call"], { limit: 200 });
}

test("a reply.post row's detail.sessionId OPENS that turn's transcript — the join the row exists for", async () => {
  await bootAgent();
  const { reply, nonce } = await turnOnce();
  const sessionId = sessionIdOf(reply);

  const { status, body } = await readTranscript(sessionId);
  expect(status).toBe(200);
  expect(body.found).toBe(true);
  expect(body.sessionId).toBe(sessionId);
  expect(body.count).toBeGreaterThan(0);
  expect(body.events?.length).toBe(body.count);

  // `startIndex` and `nextIndex` count stored LINES, and one line can hold several events, so
  // `nextIndex` is not `startIndex + count`. The guarantee is the resume cursor: every event read
  // lies in [startIndex, nextIndex), and a read that resumes at `nextIndex` neither skips nor
  // repeats an event.
  const events = body.events ?? [];
  const startIndex = body.startIndex ?? 0;
  const nextIndex = body.nextIndex ?? 0;
  expect(startIndex).toBe(0);
  expect(nextIndex).toBeGreaterThan(startIndex);
  for (const [i, ev] of events.entries()) {
    expect(ev.index).toBeGreaterThanOrEqual(startIndex);
    expect(ev.index).toBeLessThan(nextIndex);
    if (i > 0) expect(ev.index).toBeGreaterThanOrEqual(events[i - 1]!.index);
  }
  const paged: { readonly index: number; readonly type: string; readonly data: unknown }[] = [];
  let resumeAt = 0;
  let pages = 0;
  while (paged.length < events.length) {
    const page = await readTranscript(sessionId, { startIndex: resumeAt, limit: 1 });
    expect(page.status).toBe(200);
    expect(page.body.startIndex).toBe(resumeAt);
    const got = page.body.events ?? [];
    expect(got.length, `the page at line ${resumeAt} returned no event before the single read's ${events.length} were covered`).toBeGreaterThan(0);
    for (const ev of got) {
      expect(ev.index).toBeGreaterThanOrEqual(resumeAt);
      expect(ev.index).toBeLessThan(page.body.nextIndex ?? 0);
    }
    expect(page.body.nextIndex ?? 0).toBeGreaterThan(resumeAt);
    paged.push(...got);
    resumeAt = page.body.nextIndex ?? 0;
    expect(++pages).toBeLessThanOrEqual(events.length);
  }
  expect(paged.slice(0, events.length)).toEqual(events);
  expect(pages).toBeGreaterThan(1);

  expect(JSON.stringify(body.events)).toContain(nonce);

  const impostor = `${sessionId.slice(0, -8)}${randomBytes(4).toString("hex")}`;
  expect(impostor).not.toBe(sessionId);
  expect(impostor.length).toBe(sessionId.length);
  const missing = await readTranscript(impostor);
  expect(missing.status).toBe(404);
  expect(missing.body.found).toBe(false);
  expect(missing.body.count).toBeUndefined();

  const { classifySessionId } = await import("@open-everywhere/core/agent/channels/window-key.js");
  const dmSeatToken = "D0EXCHAN003:oe-dm:g2";
  expect(classifySessionId(dmSeatToken).kind).not.toBe("native");
  const wrongAddress = await readTranscript(dmSeatToken);
  expect(wrongAddress.status).toBe(404);
  expect(wrongAddress.body.hint).toContain("/control/v1/audit");
});

test("every authenticated control read leaves its OWN receipt in the trail, and an unauthenticated one leaves none", async () => {
  await bootAgent();
  const { reply, cursor } = await turnOnce();
  const sessionId = sessionIdOf(reply);

  expect((await readTranscript(sessionId)).status).toBe(200);

  const rows = await waitFor(async () => {
    const got = await serviceCallRows(cursor);
    return got.some((r) => r.detail?.view === "transcript") ? got : undefined;
  }, "a control.service_call receipt for the transcript read");

  const transcriptReceipt = rows.find((r) => r.detail?.view === "transcript" && r.detail?.sessionId === sessionId);
  expect(transcriptReceipt).toBeDefined();
  expect(transcriptReceipt?.principalId).toBe(CONTROL_SERVICE_PRINCIPAL);
  expect(transcriptReceipt?.detail?.service).toBe(CONTROL_SERVICE_PRINCIPAL);
  expect(transcriptReceipt?.platform).toBe("control");
  expect(transcriptReceipt?.workspace).toBe("control");

  const auditReceipts = rows.filter((r) => r.detail?.view === "audit" && r.principalId === CONTROL_SERVICE_PRINCIPAL);
  expect(auditReceipts.length).toBeGreaterThan(0);

  expect(rows.length).toBeGreaterThan(0);
  expect((await rowsSinceCursor(cursor, ["reply.post"])).some((r) => r.detail?.sessionId === sessionId)).toBe(true);
  expect(rows.length).toBeLessThan(200);

  const refusedSince = "1999-01-02T03:04:05.678Z";
  const refused = await controlGet(`/control/v1/audit?since=${encodeURIComponent(refusedSince)}&actions=reply.post`, { token: null });
  expect(refused.status).toBe(401);
  const wrongToken = await controlGet(`/control/v1/audit?since=${encodeURIComponent(refusedSince)}&actions=reply.post`, { token: "not-the-token" });
  expect(wrongToken.status).toBe(401);
  await new Promise((r) => setTimeout(r, 500));
  const after = await serviceCallRows(cursor);
  expect(after.find((r) => r.detail?.since === refusedSince)).toBeUndefined();
  expect(after.some((r) => r.detail?.view === "audit")).toBe(true);
});

test("a chat turn names the human on both its firewall row and its reply row (OPE-645, fixed)", async () => {
  await bootAgent();
  const { reply, channelId, cursor } = await turnOnce();

  expect(reply.workspace).toBe(DISCORD_GUILD_ID);
  expect(reply.surface).toBe(channelId);

  const policy = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["egress.policy"], { limit: 200 });
    return rows.find((r) => r.surface === channelId);
  }, `an egress.policy audit row for channel ${channelId}`);
  expect(policy.principalId).toBe(DISCORD_USER_ID);

  expect(reply.principalId).toBe(DISCORD_USER_ID);
  expect(reply.principalId).toBe(policy.principalId);
  expect(policy.surface).toBe(reply.surface);
  expect(policy.workspace).toBe(reply.workspace);

  const receipts = await serviceCallRows(cursor);
  expect(receipts.length).toBeGreaterThan(0);
  expect(receipts.every((r) => r.principalId === CONTROL_SERVICE_PRINCIPAL)).toBe(true);
  expect(receipts.some((r) => r.principalId === policy.principalId)).toBe(false);
});
