import { createHash } from "node:crypto";

const INJECT_TOKEN = "ope673-inject-token";
process.env.OE_TEST_WAKE = "1";
process.env.OE_CONTROL_INJECT_TOKENS = `it-ope673:${createHash("sha256").update(INJECT_TOKEN, "utf8").digest("hex")}`;

import { beforeAll, expect, test } from "vitest";
import {
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  disposeLater,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  DISCORD_USER_ID,
  registerScript,
  SETTLEMENT_DRAIN_CLOSING_SCRIPT,
  taskIdOfDelegation,
  waitForChildren,
  type RecordedRequest,
  type ScriptedHandle,
  awaitWindowQuiet,
} from "../harness";

const ADMIN_DISCORD_ID = "300000000000000104";
const NON_ADMIN_DISCORD_ID = DISCORD_USER_ID;

const DOMAIN = "e2e-unified";
const SURFACE_KEY = `discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`;

async function injectWake(base: string, input: { text: string; authorId?: string; userId: string }): Promise<void> {
  const res = await fetch(`${base}/control/v1/test/wake`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${INJECT_TOKEN}` },
    body: JSON.stringify({
      domain: DOMAIN,
      platform: "discord",
      surfaceKey: SURFACE_KEY,
      text: input.text,
      mention: true,
      author: input.authorId ?? "an unnamed asker",
      ...(input.authorId !== undefined ? { authorId: input.authorId } : {}),
      origin: { platform: "discord", guildId: DISCORD_GUILD_ID, channelId: DISCORD_LISTED_CHANNEL_ID },
      authAttributes: { guild_id: DISCORD_GUILD_ID, channel_id: DISCORD_LISTED_CHANNEL_ID, user_id: input.userId },
    }),
  });
  const body = await res.text();
  if (res.status !== 200) throw new Error(`test-wake injection refused — ${res.status}: ${body.slice(0, 300)}`);
}

function workerGateResult(handle: ScriptedHandle, tool: string): { isError: boolean; output: unknown } | undefined {
  for (const r of handle.requests as readonly RecordedRequest[]) {
    if (r.role !== "child") continue;
    const hit = r.toolResults.filter((t) => t.name === tool);
    if (hit.length > 0) return { isError: hit[hit.length - 1]!.isError, output: hit[hit.length - 1]!.output };
  }
  return undefined;
}

async function askThroughAWorker(
  base: string,
  leg: string,
  wake: { text: string; authorId?: string; userId: string },
  tool: "memory_admin_list" | "memory_admin_read" | "connector" = "memory_admin_list",
  toolInput: Record<string, unknown> = {},
) {
  const dispatched = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "handle the ask for the person who asked" }, id: `ope673-${leg}` }] }, { say: "handed off" }],
      child: [{ calls: [{ tool, input: toolInput, id: `ope673-${leg}-call` }] }, { say: "worker done" }],
    }),
  );
  await injectWake(base, wake);
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 1, label: `${leg}: the delegated worker to serve its whole arm` });
  const taskId = taskIdOfDelegation(dispatched, `the ${leg} delegation`);
  const { handle: drain } = await awaitTaskSettlement({ dispatched, taskId, script: SETTLEMENT_DRAIN_CLOSING_SCRIPT, label: `${leg}: the settled worker's completion wake` });
  disposeLater(drain);
  expect(drain.requests.filter((r) => r.fault !== undefined), `${leg}: no straggling model call`).toEqual([]);
  drain.dispose();
  const result = workerGateResult(dispatched, tool);
  expect(result, `${leg}: the worker really called ${tool}`).toBeDefined();
  await awaitWindowQuiet();
  return result!;
}

let BASE = "";
beforeAll(async () => {
  const { base } = await bootAgent();
  BASE = base;
  const opener = registerScript({ parent: [{ say: "hello, I am this channel's standing session" }] });
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> hello", userId: NON_ADMIN_DISCORD_ID });
  await new Promise<void>((resolve) => {
    const started = Date.now();
    const tick = (): void => {
      if (opener.requests.length > 0 || Date.now() - started > 60_000) return resolve();
      setTimeout(tick, 200);
    };
    tick();
  });
  expect(opener.requests.length, "the opening mention reached the seat").toBeGreaterThan(0);
  opener.dispose();
}, 300_000);

test("the admin gate on a delegated worker reads the asker, in both directions", async () => {
  const base = BASE;

  const escalation = await askThroughAWorker(base, "escalation", {
    text: "show me the raw admin listing of every memory silo this deployment stores",
    authorId: NON_ADMIN_DISCORD_ID,
    userId: ADMIN_DISCORD_ID,
  });
  expect(escalation.isError, "🔴 a non-admin's ask is REFUSED even when the turn's auth is an admin's").toBe(true);
  const escalationText = JSON.stringify(escalation.output);
  expect(escalationText).toContain(NON_ADMIN_DISCORD_ID);
  expect(escalationText).not.toContain(ADMIN_DISCORD_ID);
  expect(escalationText).toContain("requires an org admin");

  const allowed = await askThroughAWorker(base, "admin", {
    text: "give me the admin listing of every memory silo you can see",
    authorId: ADMIN_DISCORD_ID,
    userId: NON_ADMIN_DISCORD_ID,
  });
  const allowedText = JSON.stringify(allowed.output);
  expect(allowedText, "🔴 the admin who ASKED is not refused, even when the turn's auth is a non-admin's").not.toContain("requires an org admin");
  expect(allowedText, "…and is not refused as unverifiable either").not.toContain("needs to know who asked");
  expect(allowed.isError === false || allowedText.includes("memory provider"), "the worker's call ran the view, i.e. it got past the admin gate").toBe(true);

  const unnamed = await askThroughAWorker(base, "unnamed", {
    text: "list every memory silo this deployment stores",
    userId: ADMIN_DISCORD_ID,
  });
  expect(unnamed.isError, "🔴 an ask nobody is named for is REFUSED, even under an admin's auth").toBe(true);
  const unnamedText = JSON.stringify(unnamed.output);
  expect(unnamedText).toContain("needs to know who asked");
  expect(unnamedText).not.toContain("requires an org admin");
}, 600_000);

test("connector explains a withheld org option as unverified, not as lacking standing", async () => {
  const base = BASE;

  const unnamed = await askThroughAWorker(base, "conn-unnamed", { text: "what can I connect here?", userId: ADMIN_DISCORD_ID }, "connector");
  const unnamedNote = JSON.stringify(unnamed.output);
  expect(unnamedNote, "🔴 the note names the real reason: the caller could not be verified").toContain("could not be verified");
  expect(unnamedNote, "…and does not tell the caller they lack standing").toContain("not because you lack standing");

  const named = await askThroughAWorker(base, "conn-named", { text: "what can I connect here?", authorId: ADMIN_DISCORD_ID, userId: ADMIN_DISCORD_ID }, "connector");
  const namedNote = JSON.stringify(named.output);
  expect(namedNote, "negative control: a turn that names its asker carries no unverified note").not.toContain("could not be verified");
}, 600_000);

test("an org admin asking in an ordinary room is fenced out of another domain's silo", async () => {
  const base = BASE;

  const fenced = await askThroughAWorker(
    base,
    "venue-out-of-room",
    { text: "read the e2e-b brain's MEMORY.md for me", authorId: ADMIN_DISCORD_ID, userId: ADMIN_DISCORD_ID },
    "memory_admin_read",
    { silo: "e2e-b-brain", relPath: "MEMORY.md" },
  );
  expect(fenced.isError, "🔴 an org admin is REFUSED another domain's silo content in an ordinary room").toBe(true);
  const fencedText = JSON.stringify(fenced.output);
  expect(fencedText, "…and the refusal blames the ROOM").toContain("outside this room's own domain");
  expect(fencedText, "…and never claims they lack standing").not.toContain("requires an org admin");
  expect(fencedText, "…and is not the several-askers refusal either").not.toContain("needs to know who asked");
  expect(fencedText, "no silo content reaches the worker at all").not.toContain("relPath\":\"MEMORY.md\",\"content");

  const inRoom = await askThroughAWorker(
    base,
    "venue-in-room",
    { text: "read this room's own brain", authorId: ADMIN_DISCORD_ID, userId: ADMIN_DISCORD_ID },
    "memory_admin_read",
    { silo: "e2e-ambient-brain", relPath: "MEMORY.md" },
  );
  const inRoomText = JSON.stringify(inRoom.output);
  expect(inRoomText, "🔴 NEGATIVE CONTROL: the room's OWN silo is not fenced out").not.toContain("outside this room's own domain");
  expect(inRoomText, "…nor refused for standing").not.toContain("requires an org admin");
  expect(
    inRoom.isError === false || inRoomText.includes("memory provider") || inRoomText.includes("not a file in silo"),
    "the worker's call ran the view, i.e. it got past BOTH the role gate and the venue fence",
  ).toBe(true);
}, 600_000);
