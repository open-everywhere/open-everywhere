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
  sessionGrantKeyFromToken,
  dmAnchorDomain,
  dmAnchorSurfaceForToken,
  dmAnchorWindowKey,
  dmWindowKey,
  isDmAnchorWindowToken,
  isDmAnchoredTaskToken,
  windowTokenPlatform,
  DM_ANCHOR_GENERATION,
  type WindowKey,
} from "../agent/channels/window-key.js";

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
eq(formatWindowToken(degen), "oe-dom:payments:oe-sup:g3", "degenerate key serialises to the LEGACY token shape (byte-identical to pre-window unifiedSupervisorToken)");

eq(parseWindowToken(formatWindowToken(degen)), degen, "degenerate key round-trips through format+parse");

const LEGACY = "oe-dom:payments:oe-sup:g7";
eq(parseWindowToken(LEGACY), { domain: "payments", windowId: "payments", generation: 7 }, "LEGACY token (no :win: segment) parses with windowId === domain — the backward-compat invariant");
eq(formatWindowToken(parseWindowToken(LEGACY)!), LEGACY, "legacy token → key → token is byte-identical (no win segment introduced)");

const WEIRD = "oe-dom:team:sub:oe-sup:g12";
eq(parseWindowToken(WEIRD), { domain: "team:sub", windowId: "team:sub", generation: 12 }, "colon-bearing domain parses (greedy backtrack)");
eq(formatWindowToken(windowKeyForDomain("team:sub", 12)), WEIRD, "colon-bearing degenerate key serialises back to the same legacy token");

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
ok(p?.domain === "a" && p?.windowId === "b" && p?.generation === 1, "explicit form wins over the greedy legacy match (domain=a, windowId=b, NOT domain=a:win:b)");

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

ok(isWindowToken(LEGACY), "isWindowToken true for a legacy token");
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
ok(!isTaskWindowToken(LEGACY), "isTaskWindowToken false for a legacy/degenerate standing token");
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
ok(!isThreadSeatWindowToken(LEGACY), "isThreadSeatWindowToken false for a legacy/degenerate standing token");
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

eq(
  sessionGrantKeyFromToken("oe-dom:e2e-unified:win:t/slack/C1/C1/abc123:oe-sup:g1784940129230-9f2c"),
  "oe-dom:e2e-unified:oe-sup:g1784940129230-9f2c",
  "task-grain window token collapses to the parent domain window token, rotation salt preserved verbatim",
);
eq(
  sessionGrantKeyFromToken("oe-dom:payments:oe-sup:g3"),
  "oe-dom:payments:oe-sup:g3",
  "bare unified window token keys as itself",
);
eq(
  sessionGrantKeyFromToken("oe-dom:e2e:win:slack/T0EXAMPLE/C0EXCHAN006:oe-sup:g7"),
  "oe-dom:e2e:win:slack/T0EXAMPLE/C0EXCHAN006:oe-sup:g7",
  "solo per-channel window token keys as itself (surfaceKey windowId is never t/-prefixed)",
);
eq(sessionGrantKeyFromToken("C123:oe-sup:g1"), "C123:oe-sup:g1", "non-window supervisor token keys as itself");
eq(sessionGrantKeyFromToken("1234.5678"), "1234.5678", "a thread-ts native token keys as itself");

{
  const DM_SURFACE = "slack/T1/D999";
  const dmKey = dmWindowKey(DM_SURFACE, 4);
  eq(dmKey, { domain: dmAnchorDomain(DM_SURFACE), windowId: dmAnchorDomain(DM_SURFACE), generation: 4 }, "dmWindowKey is DEGENERATE — windowId === domain === the oe-dm/ pseudo-domain");

  const dmToken = formatWindowToken(dmKey);
  eq(dmToken, "oe-dom:oe-dm/slack/T1/D999:oe-sup:g4", "a DM window serialises to the LEGACY/degenerate token shape — no :win: segment, no new grammar");
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
  ok(!isDmAnchorWindowToken(LEGACY), "isDmAnchorWindowToken FALSE for a regular channel/domain window token");
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
  eq(dmAnchorSurfaceForToken(LEGACY), undefined, "dmAnchorSurfaceForToken is undefined for a real config domain — the gates then fall through to the config arm");
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

console.log(`window-key-test: ${n} assertions passed`);
