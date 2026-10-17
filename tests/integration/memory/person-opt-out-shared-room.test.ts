// proves: person.opt_out.set, person.opt_out.cleared, person.opt_out.refused

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  awaitWindowQuiet,
  installSlackWebApiStub,
  registerScript,
  readAuditRows,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackMentionWake,
  slackTs,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type AuditCursor,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";
import { auditCursorSinceIso, selectRowsAfterCursor } from "../audit-cursor";

const ORG = "default";
const CHANNEL_ID = "C0EXOPTOUT1";
const SILO = "it-opt-out-brain";
const BOT_USER_ID = "U0OPE2497BOT";
const ALICE = "U0OPE2497ALI";
const BOB = "U0OPE2497BOB";

let tsCounter = 2497;
let base: string | undefined;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: BOT_USER_ID, bot_id: "B0OPE2497BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      const name = id === BOT_USER_ID ? "ottobot" : `ope2497-${id.slice(-3).toLowerCase()}`;
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name, real_name: name, is_restricted: false, profile: { display_name: name, real_name: name } } };
    }
    if (method === "conversations.members") return { ok: true, members: [ALICE, BOB], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "it-ope2497", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 3 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
    if (method === "reactions.add" || method === "reactions.remove") return { ok: true };
    return undefined;
  });
  cleanups.push(() => slack.uninstall());
}

async function oeCommand(userId: string, text: string): Promise<{ status: number; text: string }> {
  const { buildSlashCommandBody, signSlackRequest, SYNTHETIC_COMMANDS_ROUTE } = await import("../../../packages/core/scripts/e2e/synthetic");
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (base === undefined || !secret) throw new Error("person-opt-out: call oeCommand() after bootAgent().");
  const rawBody = buildSlashCommandBody({ text, userId, channelId: CHANNEL_ID, teamId: SLACK_TEAM_ID });
  const signed = signSlackRequest(rawBody, secret);
  const res = await fetch(`${base}${SYNTHETIC_COMMANDS_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": signed.timestamp, "x-slack-signature": signed.signature },
    body: rawBody,
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  return { status: res.status, text: res.status === 200 && body ? String((JSON.parse(body) as { text?: unknown }).text ?? "") : body };
}

function siloFilePath(rel: string): string {
  const dir = process.env.OE_MEMORY_DIR;
  if (!dir) throw new Error("person-opt-out: OE_MEMORY_DIR is not set — call siloFilePath() after bootAgent().");
  return join(dir, ORG, "@silos", SILO, rel);
}

function memoryRootHits(needle: string): string[] {
  const root = process.env.OE_MEMORY_DIR;
  if (!root) throw new Error("person-opt-out: OE_MEMORY_DIR is not set.");
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === ".git") {
        const log = execFileSync("git", ["-C", dir, "log", "--all", "-p", "--format=%H%n%B"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
        if (log.includes(needle)) hits.push(`${dir} (git history)`);
        continue;
      }
      if (statSync(path).isDirectory()) walk(path);
      else if (readFileSync(path).includes(needle)) hits.push(path);
    }
  };
  if (existsSync(root)) walk(root);
  return hits;
}

async function memoryRowHits(cursor: AuditCursor, needle: string): Promise<string[]> {
  const page = await readAuditRows({ actions: [], sinceIso: auditCursorSinceIso(cursor), limit: 1000 });
  expect(page.length, "the audit page is full, so memory.* rows may be cut").toBeLessThan(1000);
  const rows = selectRowsAfterCursor(page, cursor);
  const escaped = JSON.stringify(needle).slice(1, -1);
  return rows.filter((r) => r.action.startsWith("memory.") && JSON.stringify(r).includes(escaped)).map((r) => `${r.action}#${r.seq} principal=${r.principalId ?? "-"}`);
}

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

async function rememberAsk(cursor: AuditCursor, userId: string, tag: string, fact: string, file: string): Promise<void> {
  const callId = `ope2497-${tag}-forward`;
  const job = registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: `remember this for the room: ${fact}` }, id: callId }] }, { say: NO_REPLY_SENTINEL }],
      child: [
        { delayMs: 120_000, calls: [{ tool: "write_file", input: { filePath: `/workspace/memory/${SILO}/${file}`, content: `# Note\n\n- ${fact}\n` }, id: `ope2497-${tag}-write` }] },
        { say: "noted" },
      ],
    });
  const ts = slackTs(Date.now(), (tsCounter += 1));
  const woke = await slackMentionWake({ channelId: CHANNEL_ID, userId, text: `<@${BOT_USER_ID}> please remember: ${fact}`, ts, eventId: `EvOpt2497${tag}${ts.replace(".", "")}` });
  expect(woke.status, `${tag}: the Slack front refused the mention: ${woke.body.slice(0, 200)}`).toBe(200);
  await waitFor(() => job.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${tag}: the seat's receipt step`);
  const settle = armSettlement(job, { parent: [{ say: NO_REPLY_SENTINEL }] });
  job.releaseHolds();
  await waitForChildren(job, { count: 1, lastStepIndex: 1, label: `${tag}: the child to serve its whole arm` });
  const taskId = await workTaskIdOfCall(cursor, job, callId, tag);
  await awaitWorkResult({ handle: settle, taskId, label: `${tag}: the seat's result-wake step` });
  assertNoFault(job, tag);
  assertNoFault(settle, `${tag} settlement`);
  await awaitWindowQuiet();
  settle.dispose();
  job.dispose();
}

function detail(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

test("🔴 a person who opts out has nothing saved to memory in a shared room, and the person beside them still does", async () => {
  armSlack();
  ({ base } = await bootAgent());
  const cursor = await auditCursor();
  const run = Date.now();
  const aliceFact = `OPE2497-ALICE-${run}`;
  const bobFact = `OPE2497-BOB-${run}`;
  const aliceFile = `ope2497-alice-${run}.md`;
  const bobFile = `ope2497-bob-${run}.md`;

  const on = await oeCommand(ALICE, "optout on");
  expect(on.status).toBe(200);
  expect(on.text).toContain("Your opt-out is now on.");
  const setRow = await waitFor(async () => (await rowsSinceCursor(cursor, ["person.opt_out.set"])).find((r) => (r.principalId ?? "").includes(ALICE)), "Alice's person.opt_out.set row");
  const aliceKey = setRow.principalId as string;

  await rememberAsk(cursor, ALICE, "alice", aliceFact, aliceFile);
  const refused = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["person.opt_out.refused"])).find((r) => r.principalId === aliceKey && detail(r)["silo"] === SILO),
    "Alice's person.opt_out.refused row for the silo",
  );
  expect(detail(refused)["act"]).toBe("memory-write");
  expect(detail(refused)["road"]).toBe("session-persist");
  expect(detail(refused)["storeReadable"]).toBe(true);
  expect(existsSync(siloFilePath(aliceFile)), "Alice's fact reached the durable store").toBe(false);
  expect((await rowsSinceCursor(cursor, ["memory.write"])).filter((r) => r.principalId === aliceKey && detail(r)["silo"] === SILO)).toEqual([]);

  await rememberAsk(cursor, BOB, "bob", bobFact, bobFile);
  const bobPath = siloFilePath(bobFile);
  await waitFor(() => (existsSync(bobPath) ? true : undefined), "Bob's fact on the durable store");
  expect(readFileSync(bobPath, "utf-8")).toContain(bobFact);
  const bobKey = aliceKey.replace(ALICE, BOB);
  const bobWrite = (await rowsSinceCursor(cursor, ["memory.write"])).find((r) => detail(r)["silo"] === SILO && Number(detail(r)["files"]) > 0 && r.principalId === bobKey);
  expect(bobWrite, `a memory.write row for the silo keyed ${bobKey}`).toBeDefined();
  expect(existsSync(siloFilePath(aliceFile)), "Alice's refused fact rode in on Bob's persist").toBe(false);

  const bobHits = memoryRootHits(bobFact);
  expect(bobHits.some((h) => !h.endsWith("(git history)")), "the file scan finds Bob's fact").toBe(true);
  expect(bobHits.some((h) => h.endsWith("(git history)")), "the git-history scan finds Bob's fact").toBe(true);
  const bobRequest = detail(bobWrite)["request"];
  expect(typeof bobRequest, "Bob's memory.write row carries its request line").toBe("string");
  expect((await memoryRowHits(cursor, String(bobRequest))).length, "the row scan reads the request line").toBeGreaterThan(0);
  expect(memoryRootHits(aliceFact), "Alice's fact is in the memory root").toEqual([]);
  expect(await memoryRowHits(cursor, aliceFact), "Alice's fact is in a memory.* audit row").toEqual([]);

  const off = await oeCommand(ALICE, "optout off");
  expect(off.status).toBe(200);
  expect(off.text).toContain("Your opt-out is now off.");
  await waitFor(async () => (await rowsSinceCursor(cursor, ["person.opt_out.cleared"])).find((r) => r.principalId === aliceKey), "Alice's person.opt_out.cleared row");
});
