// proves: SEAT-55, SEAT-59, SEAT-61

import assert from "node:assert/strict";
import {
  formatWindowToken,
  parseWindowToken,
  isWindowToken,
  windowKeyForDomain,
  taskWindowId,
  isTaskWindowId,
  isTaskWindowToken,
  threadSeatWindowId,
  isThreadSeatWindowId,
  isThreadSeatWindowToken,
  mintGenerationSalt,
  saltSupervisorGeneration,
  dmAnchorDomain,
  dmAnchorSurfaceForToken,
  dmAnchorWindowKey,
  dmWindowKey,
  isDmAnchorWindowToken,
  isDmAnchoredTaskToken,
  windowTokenPlatform,
  DM_ANCHOR_GENERATION,
  workWindowId,
  isWorkWindowToken,
  classifySessionId,
  HOOK_TOKEN_MAX_BYTES,
  HOOK_PREFIX_RESERVE_BYTES,
  LONGEST_EVE_HOOK_PREFIX,
  WINDOW_TOKEN_MAX_BYTES,
  type WindowKey,
} from "../agent/channels/window-key.js";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const degen = windowKeyForDomain("payments", 3);
eq(degen, { domain: "payments", windowId: "payments", generation: 3 }, "windowKeyForDomain defaults windowId to the domain");
eq(formatWindowToken(degen), "oe-dom:payments:oe-sup:g3", "degenerate key serialises to the DEGENERATE token shape (byte-identical to pre-window unifiedSupervisorToken)");

eq(parseWindowToken(formatWindowToken(degen)), degen, "degenerate key round-trips through format+parse");

const DEGENERATE = "oe-dom:payments:oe-sup:g7";
eq(parseWindowToken(DEGENERATE), { domain: "payments", windowId: "payments", generation: 7 }, "DEGENERATE token (no :win: segment) parses with windowId === domain — the id-equals-domain invariant");
eq(formatWindowToken(parseWindowToken(DEGENERATE)!), DEGENERATE, "degenerate token → key → token is byte-identical (no win segment introduced)");

const WEIRD = "oe-dom:team:sub:oe-sup:g12";
eq(parseWindowToken(WEIRD), { domain: "team:sub", windowId: "team:sub", generation: 12 }, "colon-bearing domain parses (greedy backtrack)");
eq(formatWindowToken(windowKeyForDomain("team:sub", 12)), WEIRD, "colon-bearing degenerate key serialises back to the same degenerate token");

const explicit: WindowKey = { domain: "payments", windowId: "chan-hr", generation: 5 };
eq(formatWindowToken(explicit), "oe-dom:payments:win:chan-hr:oe-sup:g5", "distinct windowId serialises to the explicit :win: form");
eq(parseWindowToken("oe-dom:payments:win:chan-hr:oe-sup:g5"), explicit, "explicit-window token parses domain + windowId + generation distinctly");
eq(parseWindowToken(formatWindowToken(explicit)), explicit, "explicit key round-trips");

const slashWin: WindowKey = { domain: "payments", windowId: "slack/T1/C_HR", generation: 9 };
eq(parseWindowToken(formatWindowToken(slashWin)), slashWin, "slash-bearing windowId (surface-key shape) round-trips");

assert.throws(() => formatWindowToken({ domain: "d", windowId: "a:b", generation: 1 }), /colon-free/, "formatWindowToken throws on a colon-bearing windowId in the explicit :win: form");
n++;
eq(formatWindowToken({ domain: "a:b", windowId: "a:b", generation: 1 }), "oe-dom:a:b:oe-sup:g1", "colon-bearing domain in the degenerate (windowId === domain) form is NOT guarded — still serialises");

const p = parseWindowToken("oe-dom:a:win:b:oe-sup:g1");
ok(p?.domain === "a" && p?.windowId === "b" && p?.generation === 1, "explicit form wins over the greedy degenerate match (domain=a, windowId=b, NOT domain=a:win:b)");

ok(formatWindowToken(degen).endsWith(":oe-sup:g3"), "degenerate token ends with the :oe-sup:g suffix");
ok(formatWindowToken(explicit).endsWith(":oe-sup:g5"), "explicit token ends with the :oe-sup:g suffix (win segment sits BEFORE it — invisible to suffix detectors)");

eq(parseWindowToken("C_PAY:oe-sup:g3"), undefined, "a per-container token (no oe-dom: prefix) is not a window token");
eq(parseWindowToken("C_PAY:1720000000.001"), undefined, "a thread token is not a window token");
eq(parseWindowToken("oe-dom:payments"), undefined, "a prefix without the :oe-sup:g suffix is not a window token");
eq(parseWindowToken("oe-dom:payments:oe-sup:gXX"), undefined, "a non-numeric generation is not a window token");
eq(parseWindowToken(""), undefined, "empty string is not a window token");
eq(parseWindowToken(undefined), undefined, "undefined fails soft");
eq(parseWindowToken(null), undefined, "null fails soft");
eq(parseWindowToken(42), undefined, "a non-string fails soft");

ok(isWindowToken(DEGENERATE), "isWindowToken true for a degenerate token");
ok(isWindowToken("oe-dom:payments:win:hr:oe-sup:g1"), "isWindowToken true for an explicit-window token");
ok(!isWindowToken("C_PAY:oe-sup:g3"), "isWindowToken false for a per-container token");
ok(!isWindowToken(undefined), "isWindowToken false for undefined");

const taskWin = taskWindowId("slack/T1/C_PAY", "1720000000.001");
eq(taskWin, "t/slack/T1/C_PAY/1720000000.001", "taskWindowId is t/<channelKey>/<threadTs> (slashes, colon-free)");

const taskKey: WindowKey = { domain: "payments", windowId: taskWin, generation: 4 };
const taskToken = formatWindowToken(taskKey);
eq(taskToken, "oe-dom:payments:win:t/slack/T1/C_PAY/1720000000.001:oe-sup:g4", "a task key serialises to an explicit :win: token whose windowId is the t/ composite");
eq(parseWindowToken(taskToken), taskKey, "a task token round-trips (the slash-bearing t/ windowId satisfies [^:]+)");
ok(parseWindowToken(taskToken)!.domain === "payments", "a task token still anchors its DOMAIN (memory/access unchanged)");
ok(formatWindowToken(taskKey).endsWith(":oe-sup:g4"), "a task token keeps the :oe-sup:g suffix (suffix detectors untouched)");

ok(isTaskWindowId(taskWin), "isTaskWindowId true for a t/ windowId");
ok(!isTaskWindowId("slack/T1/C_HR"), "isTaskWindowId false for a bare surface-key windowId (a solo window, NOT a task)");
ok(!isTaskWindowId("payments"), "isTaskWindowId false for a domain windowId (degenerate/standing)");
ok(isTaskWindowToken(taskToken), "isTaskWindowToken true for a task token");
ok(!isTaskWindowToken("oe-dom:payments:win:slack/T1/C_HR:oe-sup:g9"), "isTaskWindowToken false for a SOLO-window token (bare surface key windowId, not t/)");
ok(!isTaskWindowToken(DEGENERATE), "isTaskWindowToken false for a degenerate standing token");
ok(!isTaskWindowToken("C_PAY:oe-sup:g3"), "isTaskWindowToken false for a per-container (non-window) token");
ok(!isTaskWindowToken(undefined), "isTaskWindowToken fails soft on undefined");

assert.throws(() => taskWindowId("teams/T/19:meeting@thread.v2", "act1"), /colon-free/, "taskWindowId throws on a colon in channelKey");
n++;
assert.throws(() => taskWindowId("slack/T/C", "a:b"), /colon-free/, "taskWindowId throws on a colon in threadTs");
n++;
assert.throws(() => taskWindowId("", "t"), /non-empty/, "taskWindowId throws on an empty channelKey");
n++;
assert.throws(() => taskWindowId("c", ""), /non-empty/, "taskWindowId throws on an empty threadTs");
n++;

const seatWin = threadSeatWindowId("slack/T1/C_PAY", "1720000000.001");
eq(seatWin, "s/slack/T1/C_PAY/1720000000.001", "threadSeatWindowId is s/<channelKey>/<threadTs> (slashes, colon-free)");

const seatKey: WindowKey = { domain: "payments", windowId: seatWin, generation: 4 };
const seatToken = formatWindowToken(seatKey);
eq(seatToken, "oe-dom:payments:win:s/slack/T1/C_PAY/1720000000.001:oe-sup:g4", "a thread-seat key serialises to an explicit :win: token whose windowId is the s/ composite");
eq(parseWindowToken(seatToken), seatKey, "a thread-seat token round-trips (the slash-bearing s/ windowId satisfies [^:]+)");
ok(parseWindowToken(seatToken)!.domain === "payments", "a thread-seat token still anchors its DOMAIN (memory/access unchanged)");

ok(isThreadSeatWindowId(seatWin), "isThreadSeatWindowId true for an s/ windowId");
ok(!isThreadSeatWindowId(taskWin), "isThreadSeatWindowId false for a t/ (task) windowId — the two prefixes are disjoint");
ok(!isTaskWindowId(seatWin), "isTaskWindowId false for an s/ (thread-seat) windowId — a thread seat never classifies task");
ok(isThreadSeatWindowToken(seatToken), "isThreadSeatWindowToken true for a thread-seat token");
ok(!isThreadSeatWindowToken(taskToken), "isThreadSeatWindowToken false for a task token (fail-closed: a task token is NOT a thread seat)");
ok(!isTaskWindowToken(seatToken), "isTaskWindowToken false for a thread-seat token (a lost stamp on an s/ token never re-widens to task)");
ok(!isThreadSeatWindowToken(DEGENERATE), "isThreadSeatWindowToken false for a degenerate standing token");
ok(!isThreadSeatWindowToken(undefined), "isThreadSeatWindowToken fails soft on undefined");

assert.throws(() => threadSeatWindowId("teams/T/19:meeting@thread.v2", "act1"), /colon-free/, "threadSeatWindowId throws on a colon in channelKey");
n++;
assert.throws(() => threadSeatWindowId("c", ""), /non-empty/, "threadSeatWindowId throws on an empty threadTs");
n++;

ok(/^[0-9a-f]{6}$/.test(mintGenerationSalt()), "mintGenerationSalt: 6 lowercase hex chars");
ok(mintGenerationSalt() !== mintGenerationSalt(), "mintGenerationSalt: two calls mint different salts");

{
  const saltedDegen = saltSupervisorGeneration(formatWindowToken(degen));
  ok(/^oe-dom:payments:oe-sup:g3-[0-9a-f]{6}$/.test(saltedDegen), `salted degenerate token shape: ${JSON.stringify(saltedDegen)}`);
  eq(parseWindowToken(saltedDegen), degen, "salted degenerate token parses back to the SAME key (salt invisible to the generation/domain/windowId consumer)");

  const saltedExplicit = saltSupervisorGeneration(formatWindowToken(explicit));
  ok(/^oe-dom:payments:win:chan-hr:oe-sup:g5-[0-9a-f]{6}$/.test(saltedExplicit), `salted explicit token shape: ${JSON.stringify(saltedExplicit)}`);
  eq(parseWindowToken(saltedExplicit), explicit, "salted explicit token parses back to the SAME key");

  const saltedTask = saltSupervisorGeneration(taskToken);
  eq(parseWindowToken(saltedTask), taskKey, "salted task token parses back to the SAME key (windowId's t/ prefix unaffected)");
  ok(isTaskWindowToken(saltedTask), "salted task token still classifies as a task window token");

  const saltedSeat = saltSupervisorGeneration(seatToken);
  eq(parseWindowToken(saltedSeat), seatKey, "salted thread-seat token parses back to the SAME key");
  ok(isThreadSeatWindowToken(saltedSeat), "salted thread-seat token still classifies as a thread-seat window token");

  ok(isWindowToken(saltedDegen), "isWindowToken true for a salted degenerate token");
  ok(isWindowToken(saltedExplicit), "isWindowToken true for a salted explicit token");

  const mintA = saltSupervisorGeneration(formatWindowToken(degen));
  const mintB = saltSupervisorGeneration(formatWindowToken(degen));
  ok(mintA !== mintB, "re-minting the SAME generation (simulated counter reset) never reproduces the same token");
  eq(parseWindowToken(mintA), degen, "mintA parses to generation 3");
  eq(parseWindowToken(mintB), degen, "mintB ALSO parses to generation 3 (same logical generation, different wire token)");
}

eq(parseWindowToken("oe-dom:payments:oe-sup:g3-"), undefined, "trailing bare dash, no hex → not a window token");
eq(parseWindowToken("oe-dom:payments:oe-sup:g3-ABCDEF"), undefined, "uppercase hex salt → not a window token (lowercase-only)");
eq(parseWindowToken("oe-dom:payments:oe-sup:g3-zz"), undefined, "non-hex salt chars → not a window token");

{
  const DM_SURFACE = "slack/T1/D999";
  const dmKey = dmWindowKey(DM_SURFACE, 4);
  eq(dmKey, { domain: dmAnchorDomain(DM_SURFACE), windowId: dmAnchorDomain(DM_SURFACE), generation: 4 }, "dmWindowKey is DEGENERATE — windowId === domain === the oe-dm/ pseudo-domain");

  const dmToken = formatWindowToken(dmKey);
  eq(dmToken, "oe-dom:oe-dm/slack/T1/D999:oe-sup:g4", "a DM window serialises to the DEGENERATE token shape — no :win: segment, no new grammar");
  eq(parseWindowToken(dmToken), dmKey, "a DM window token round-trips through format+parse");
  ok(dmToken.endsWith(":oe-sup:g4"), "a DM window token keeps the :oe-sup:g suffix (suffix detectors untouched)");
  ok(isWindowToken(dmToken), "isWindowToken true for a DM window token");

  ok(isDmAnchorWindowToken(dmToken), "isDmAnchorWindowToken true for a DM window token");
  ok(isDmAnchorWindowToken(`unified:${dmToken}`), "…including through eve's `unified:` send prefix");
  ok(isDmAnchorWindowToken(saltSupervisorGeneration(dmToken)), "…and for the salted (rotated) form");
  const dmWorker = formatWindowToken({ domain: dmAnchorDomain(DM_SURFACE), windowId: taskWindowId("slack/T1/D999", "D999", "n1"), generation: DM_ANCHOR_GENERATION });
  ok(!isDmAnchorWindowToken(dmWorker), "isDmAnchorWindowToken FALSE for a TASK window in a dm domain — a DM's worker is never mistaken for its seat");
  const dmThreadSeat = formatWindowToken({ domain: dmAnchorDomain(DM_SURFACE), windowId: threadSeatWindowId("slack/T1/D999", "1720000000.001"), generation: 2 });
  ok(!isDmAnchorWindowToken(dmThreadSeat), "isDmAnchorWindowToken FALSE for a THREAD-SEAT window in a dm domain (standing-grain only)");
  ok(!isDmAnchorWindowToken(DEGENERATE), "isDmAnchorWindowToken FALSE for a regular channel/domain window token");
  ok(!isDmAnchorWindowToken("oe-dom:payments:win:slack/T1/C_HR:oe-sup:g9"), "isDmAnchorWindowToken FALSE for a SOLO channel window token");
  ok(!isDmAnchorWindowToken("C_PAY:oe-sup:g3"), "isDmAnchorWindowToken FALSE for a per-container (non-window) token");
  ok(!isDmAnchorWindowToken("D999:oe-dm:g2"), "isDmAnchorWindowToken FALSE for an OPE-90 dm-seat token (a different grammar entirely)");
  ok(!isDmAnchorWindowToken(undefined), "isDmAnchorWindowToken fails soft on undefined");

  ok(isDmAnchoredTaskToken(dmWorker), "isDmAnchoredTaskToken still true for a DM-anchored worker (unchanged)");
  ok(!isDmAnchoredTaskToken(dmToken), "isDmAnchoredTaskToken FALSE for a DM SEAT window — the two predicates are disjoint");

  eq(dmAnchorSurfaceForToken(dmToken), DM_SURFACE, "dmAnchorSurfaceForToken recovers the surface key from a DM SEAT window token");
  eq(dmAnchorSurfaceForToken(dmWorker), DM_SURFACE, "…and from a DM-anchored WORKER token (grain-agnostic)");
  eq(dmAnchorSurfaceForToken(dmThreadSeat), DM_SURFACE, "…and from a DM-anchored thread-seat token");
  eq(dmAnchorSurfaceForToken(`unified:${dmToken}`), DM_SURFACE, "…through eve's `unified:` send prefix");
  eq(dmAnchorSurfaceForToken(DEGENERATE), undefined, "dmAnchorSurfaceForToken is undefined for a real config domain — the gates then fall through to the config arm");
  eq(dmAnchorSurfaceForToken("oe-dom:payments:win:t/slack/T1/C1/n:oe-sup:g3"), undefined, "…and for a NAMED-domain worker token");
  eq(dmAnchorSurfaceForToken("C_PAY:oe-sup:g3"), undefined, "…and for a per-container token");
  eq(dmAnchorSurfaceForToken(undefined), undefined, "…fail-soft on a non-string");

  eq(dmAnchorWindowKey(DM_SURFACE).domain, dmKey.domain, "the OPE-306 worker anchor and the OPE-351 seat window share ONE pseudo-domain (one memory/access/audit anchor)");
  ok(dmAnchorWindowKey(DM_SURFACE).generation === 0 && dmKey.generation > 0, "…but the anchor is pinned g0 while a seat window carries a rotation generation >= 1 — so they can never be the same token");
  eq(dmWindowKey(DM_SURFACE, 0), dmAnchorWindowKey(DM_SURFACE), "dmWindowKey at the g0 constant IS the anchor key — the two mints agree where they overlap");

  assert.throws(() => dmWindowKey("slack/T1/D:1", 1), /colon-free/, "dmWindowKey throws on a colon-bearing surface key");
  n++;
  assert.throws(() => dmWindowKey("", 1), /non-empty/, "dmWindowKey throws on an empty surface key");
  n++;
}

{
  const SURFACE = "slack/T1/C_PAY";
  eq(windowTokenPlatform(`oe-dom:payments:win:${SURFACE}:oe-sup:g2`), "slack", "a SOLO window token names its one surface's platform");
  eq(windowTokenPlatform(`unified:oe-dom:payments:win:${SURFACE}:oe-sup:g2`), "slack", "…through eve's `unified:` send prefix");
  eq(windowTokenPlatform(`oe-dom:payments:win:teams/W1/CH1:oe-sup:g2`), "teams", "…and it reads the platform verbatim, never a hardcoded one");

  const task = `oe-dom:payments:win:${taskWindowId(SURFACE, "1700.5")}:oe-sup:g2`;
  const seat = `oe-dom:payments:win:${threadSeatWindowId(SURFACE, "1700.5")}:oe-sup:g2`;
  eq(windowTokenPlatform(task), "slack", "🔴 a TASK window token names the platform of the ONE thread it owns — NOT the grain marker `t`");
  eq(windowTokenPlatform(seat), "slack", "🔴 a THREAD-SEAT window token does the same — NOT the grain marker `s`");
  eq(windowTokenPlatform(`oe-dom:payments:win:${taskWindowId(SURFACE, "1700.5", "n7")}:oe-sup:g2`), "slack", "…a NONCE-bearing (one-shot) task windowId reads the same segment");
  eq(windowTokenPlatform(`oe-dom:payments:win:${taskWindowId("teams/W1/CH1", "1700.5")}:oe-sup:g2`), "teams", "…and a Teams-owned task window names teams");
  eq(windowTokenPlatform(`oe-dom:payments:win:${taskWindowId("slack/C123", "1700.5")}:oe-sup:g2`), "slack", "🔴 a TWO-segment channelKey (the real slack codec's threadRef shape) answers the same");
  eq(windowTokenPlatform(`oe-dom:payments:win:${threadSeatWindowId("github/example-owner/e2e-scratch", "42")}:oe-sup:g2`), "github", "…and a three-segment github channelKey names github");

  eq(windowTokenPlatform("oe-dom:payments:oe-sup:g3"), undefined, "🔴 NEGATIVE CONTROL: a DEGENERATE domain window names NO surface (its windowId is a config domain name) — undefined, never the domain name as a platform");
  eq(windowTokenPlatform("C_PAY:oe-sup:g3"), undefined, "NEGATIVE CONTROL: a per-container supervisor token is not a window token");
  eq(windowTokenPlatform("cse_abc123"), undefined, "NEGATIVE CONTROL: a native token names no surface");
  eq(windowTokenPlatform(undefined), undefined, "fail-soft on a non-string");
  eq(windowTokenPlatform(""), undefined, "fail-soft on a blank token");

  const dmSurface = "slack/T1/D_ALICE";
  eq(windowTokenPlatform(formatWindowToken(dmWindowKey(dmSurface, 4))), "slack", "a DM WINDOW token recovers its platform from the pseudo-domain's surface key");
  eq(
    windowTokenPlatform(`oe-dom:${dmAnchorDomain(dmSurface)}:win:${taskWindowId(dmSurface, "t1", "n1")}:oe-sup:g0`),
    "slack",
    "…and a DM-ANCHORED worker reads it off its own task windowId",
  );
}

{
  // The hook shapes come from the installed eve, not from a copy: its session-inbox address module
  // has no imports, so the test loads it by path and drives eve's own token builders.
  const eveSrc = join(dirname(createRequire(import.meta.url).resolve("eve/package.json")), "dist/src");
  const eveAddressPath = join(eveSrc, "execution/session-inbox/address.js");
  const eveAddress = readFileSync(eveAddressPath, "utf8");
  const { sessionInboxHookToken, sessionCommandHookToken } = (await import(pathToFileURL(eveAddressPath).href)) as {
    sessionInboxHookToken: (logical: string) => string;
    sessionCommandHookToken: (sessionId: string) => string;
  };
  ok(eveAddress.includes("`eve:inbox:v1:`"), "eve's session inbox hook prefix is `eve:inbox:v1:`");
  // Every `eve:inbox:` literal in eve's execution tree: the inbox hook prefix and the reserved-token check.
  // A new inbox hook anywhere in that tree (the 0.x hand-off hook was one) turns this red: re-measure the budget.
  const inboxLiterals = new Set<string>();
  const scan = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) scan(p);
      else if (ent.name.endsWith(".js")) for (const m of readFileSync(p, "utf8").matchAll(/`(eve:inbox:[^`$]*)/g)) inboxLiterals.add(m[1]);
    }
  };
  scan(join(eveSrc, "execution"));
  eq([...inboxLiterals].sort(), ["eve:inbox:", "eve:inbox:v1:"], "eve builds no `eve:inbox:` hook other than `eve:inbox:v1:` (re-measure the budget if one appears)");
  const routeArgs = readFileSync(join(eveSrc, "channel/route-args.js"), "utf8");
  ok(
    routeArgs.includes("channelName:a,continuationToken:i.continuationToken===void 0?void 0:`${a}:${i.continuationToken}`"),
    "eve namespaces a session's continuation token with its channel name (`unified:<token>`)",
  );
  const sessionEntry = readFileSync(join(eveSrc, "execution/session/entry.js"), "utf8");
  ok(
    sessionEntry.includes("bootInitialOwner(e,getWorkflowMetadata().workflowRunId,"),
    "eve's session id is the Workflow run id, so `eve:session:<sessionId>:inbox` never carries the window token",
  );

  const T = "oe-dom:payments:oe-sup:g2-abc123";
  eq(sessionInboxHookToken(`unified:${T}`), LONGEST_EVE_HOOK_PREFIX + T, "the budget prefix is eve's inbox hook over the `unified:` continuation token");
  ok(Buffer.byteLength(LONGEST_EVE_HOOK_PREFIX) <= HOOK_PREFIX_RESERVE_BYTES, "the budget reserves at least the longest hook prefix");
  const runId = `wrun_${"0".repeat(26)}`;
  for (const hook of [sessionCommandHookToken(runId), sessionInboxHookToken(sessionCommandHookToken(runId))]) {
    ok(Buffer.byteLength(hook) <= HOOK_TOKEN_MAX_BYTES, `the run-id session hook ${hook.slice(0, 13)}… fits the hook limit at a fixed length`);
  }
  eq(WINDOW_TOKEN_MAX_BYTES, 255 - 26 - 7, "the unsalted budget leaves room for the reserved prefix and a rotation salt");

  const hookBytes = (salted: string) => Buffer.byteLength(sessionInboxHookToken(`unified:${salted}`));
  const saltTail = saltSupervisorGeneration("").length;
  ok(hookBytes("x".repeat(WINDOW_TOKEN_MAX_BYTES + saltTail)) <= HOOK_TOKEN_MAX_BYTES, "a salted token at the full budget fits eve's inbox hook");
  const workKey = (domain: string, seatWindowId: string, generation: number): WindowKey => ({ domain, windowId: workWindowId(seatWindowId), generation });
  const teamsDm = `teams/1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8/a-1${"Xy9_Zq8-Wv7".repeat(8)}Ab_cd-EfG`;
  eq(teamsDm.length, 143, "the Teams DM surface key has the ship-257 length");

  const dmDomain = dmAnchorDomain(teamsDm);
  for (const generation of [1, 6, 1234]) {
    const w = formatWindowToken(workKey(dmDomain, dmDomain, generation));
    const salted = saltSupervisorGeneration(w);
    ok(hookBytes(salted) <= HOOK_TOKEN_MAX_BYTES, `a Teams DM W token at g${generation} fits the hook limit (${hookBytes(salted)} bytes)`);
    eq(parseWindowToken(w), workKey(dmDomain, dmDomain, generation), `the compact Teams DM W token parses to the FULL key at g${generation}`);
    eq(parseWindowToken(salted), workKey(dmDomain, dmDomain, generation), "…and so does its salted form");
    eq(formatWindowToken(parseWindowToken(w)!), w, "…and re-formats to the same bytes (one generation, one token)");
    ok(isWorkWindowToken(salted) && isWorkWindowToken(`unified:${salted}`), "…and still classifies as a work-session token, bare or namespaced");
    eq(classifySessionId(salted).kind, "work", "…in the codec too");
    ok(!isDmAnchorWindowToken(salted), "…and is never read as the DM seat");
    eq(dmAnchorSurfaceForToken(salted), teamsDm, "…and still names the DM surface it serves");
  }
  ok(formatWindowToken(workKey(dmDomain, dmDomain, 6)) !== formatWindowToken(dmWindowKey(teamsDm, 6)), "the compact W token never equals the DM seat's own token");

  const longForm = (k: WindowKey) => `oe-dom:${k.domain}:win:${k.windowId}:oe-sup:g${k.generation}`;
  const kept: Array<[string, WindowKey]> = [
    ["Slack DM", workKey(dmAnchorDomain("slack/T0123456789/D0123456789"), dmAnchorDomain("slack/T0123456789/D0123456789"), 6)],
    ["Discord DM", workKey(dmAnchorDomain("discord/@me/1234567890123456789"), dmAnchorDomain("discord/@me/1234567890123456789"), 6)],
    [
      "Notion DM",
      workKey(dmAnchorDomain("notion/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d"), dmAnchorDomain("notion/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d"), 6),
    ],
    ["channel domain", workKey("e2e-unified", "e2e-unified", 6)],
    ["solo Teams channel", workKey("eng", "teams/1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8/19-0123456789abcdef0123456789abcdef@thread.tacv2", 6)],
    ["Teams thread seat", workKey("eng", threadSeatWindowId("teams/19-0123456789abcdef0123456789abcdef@thread.tacv2", "1760800000000"), 6)],
  ];
  for (const [label, k] of kept) {
    const w = formatWindowToken(k);
    eq(w, longForm(k), `a ${label} W token keeps its long form byte for byte`);
    ok(hookBytes(saltSupervisorGeneration(w)) <= HOOK_TOKEN_MAX_BYTES, `a ${label} W token fits the hook limit`);
    eq(parseWindowToken(w), k, `a ${label} W token round-trips`);
  }

  const longTask = { domain: dmDomain, windowId: taskWindowId(teamsDm, "1760800000000"), generation: 0 };
  eq(formatWindowToken(longTask), longForm(longTask), "a long TASK window id is never compacted");
  eq(parseWindowToken("oe-dom:payments:win:w/=:oe-sup:g2-abc123"), { domain: "payments", windowId: "w/payments", generation: 2 }, "the compact wire id expands to `w/<domain>`");
}

console.log(`window-key-test: ${n} assertions passed`);
