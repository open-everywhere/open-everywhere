import assert from "node:assert/strict";
import {
  formatWindowToken,
  parseWindowToken,
  isWindowToken,
  windowKeyForDomain,
  taskWindowId,
  isTaskWindowId,
  isTaskWindowToken,
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

console.log(`window-key-test: ${n} assertions passed`);
