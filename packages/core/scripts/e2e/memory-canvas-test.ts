import assert from "node:assert/strict";
import type { AuditWireEntry } from "./audit-read.js";
import { CANVAS_REFRESH_ACTION, CANVAS_WRITE_ACTION, canvasRefreshVerdict, canvasShowsFact, channelCanvasIdOf, channelCanvasIdsOf, classifyChannelTrust, createdCanvasId, readCanvasById, readChannelCanvas, type SlackRawCall } from "./memory-canvas.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n += 1;
};

const BOT = "U0BOT";
const FACT = "canvas-41234";
const row = (surface: string, outcome: string, ts: string, trigger = "memory-write"): AuditWireEntry => ({
  ts,
  org: "default",
  platform: "slack",
  workspace: "T0",
  surface,
  action: CANVAS_REFRESH_ACTION,
  detail: { domain: "e2e-unified", trigger, outcome },
});

{
  ok(canvasRefreshVerdict([], "C1").kind === "none", "no row names the channel ⇒ none");
  ok(canvasRefreshVerdict([row("C2", "created", "2026-10-14T00:00:01Z")], "C1").kind === "none", "a row for ANOTHER channel is not this channel's verdict");
  ok(canvasRefreshVerdict([row("C1", "created", "2026-10-14T00:00:01Z")], "C1").kind === "wrote", "created ⇒ wrote");
  ok(canvasRefreshVerdict([row("C1", "updated", "2026-10-14T00:00:01Z")], "C1").kind === "wrote", "updated ⇒ wrote");
  for (const o of ["skipped-external", "skipped-guest", "cleared-external", "cleared-guest"]) {
    ok(canvasRefreshVerdict([row("C1", o, "2026-10-14T00:00:01Z")], "C1").kind === "withheld", `${o} ⇒ withheld`);
  }
  for (const o of ["failed", "skipped-foreign", "clear-failed", "unchanged", "skipped-disabled", "cleared-disabled"]) {
    ok(canvasRefreshVerdict([row("C1", o, "2026-10-14T00:00:01Z")], "C1").kind === "other", `${o} ⇒ other, never wrote or withheld`);
  }
  ok(canvasRefreshVerdict([row("C1", "skipped-guest", "2026-10-14T00:00:01Z", "member-joined")], "C1").kind === "none", "a member-joined recheck row is ignored");
  const v = canvasRefreshVerdict([row("C1", "failed", "2026-10-14T00:00:01Z"), row("C1", "updated", "2026-10-14T00:00:09Z")], "C1");
  ok(v.kind === "wrote" && v.outcome === "updated", "the NEWEST memory-write row decides the verdict");
  const w = canvasRefreshVerdict([row("C1", "updated", "2026-10-14T00:00:09Z"), row("C1", "failed", "2026-10-14T00:00:01Z")], "C1");
  ok(w.kind === "wrote", "the order the rows arrive in does not change the verdict");
}

{
  ok(channelCanvasIdOf({ ok: true, channel: { properties: { canvas: { file_id: "F1" } } } }) === "F1", "reads the channel canvas id");
  ok(channelCanvasIdOf({ ok: true, channel: { properties: {} } }) === undefined, "no canvas property ⇒ undefined");
  ok(channelCanvasIdOf({ ok: true, channel: { properties: { canvas: { file_id: "" } } } }) === undefined, "an empty id is no canvas");
  const tabbed = { ok: true, channel: { properties: { tabs: [{ id: "Ct1", type: "files" }, { id: "Ct2", type: "canvas", data: { file_id: "F0CA0J8PLDC" } }] } } };
  ok(channelCanvasIdOf(tabbed) === "F0CA0J8PLDC", "🔴 a canvas named only as a channel tab is read (the OPE-2581 shape)");
  const both = { ok: true, channel: { properties: { canvas: { file_id: "F1" }, tabs: [{ type: "canvas", data: { file_id: "F1" } }, { type: "canvas", data: { file_id: "F2" } }] } } };
  ok(JSON.stringify(channelCanvasIdsOf(both)) === JSON.stringify(["F1", "F2"]), "every canvas id is read, the channel canvas first, with no id twice");
  ok(channelCanvasIdsOf({ ok: true, channel: { properties: { tabs: [{ type: "files", data: { file_id: "F9" } }, { type: "canvas", data: {} }, "junk"] } } }).length === 0, "a non-canvas tab, a tab with no id, and a malformed tab name no canvas");
}

const fake = (answers: Record<string, Record<string, unknown>>) => {
  const calls: { method: string; params: Record<string, string> }[] = [];
  const call: SlackRawCall = async (method, params) => {
    calls.push({ method, params });
    return answers[method] ?? { ok: false, error: "unknown_method" };
  };
  return { call, calls };
};
const info = (fileId?: string) => ({ ok: true, channel: { properties: fileId ? { canvas: { file_id: fileId } } : {} } });
{
  const s = fake({ "conversations.info": info("F1"), "files.info": { ok: true, file: { user: BOT } }, "canvases.sections.lookup": { ok: true, sections: [{ id: "temp:C:1" }] } });
  const r = await readChannelCanvas(s.call, "C1", FACT);
  ok(r.kind === "canvas" && r.canvasId === "F1" && r.creator === BOT && r.holdsText, "a bot canvas whose section holds the fact reads as such");
  ok(canvasShowsFact(r, BOT), "POSITIVE control: a bot canvas holding the fact SHOWS it");
  const lookup = s.calls.find((c) => c.method === "canvases.sections.lookup");
  ok(lookup !== undefined && JSON.parse(lookup.params["criteria"]!).contains_text === FACT && lookup.params["canvas_id"] === "F1", "the lookup asks for the exact fact in the exact canvas");
}
{
  const s = fake({ "conversations.info": info() });
  const r = await readChannelCanvas(s.call, "C1", FACT);
  ok(r.kind === "no-canvas" && !canvasShowsFact(r, BOT), "no channel canvas shows nothing");
  ok(s.calls.length === 1, "no canvas ⇒ no further calls");
}
{
  const s = fake({ "conversations.info": info("F1"), "files.info": { ok: true, file: { user: BOT } }, "canvases.sections.lookup": { ok: true, sections: [] } });
  const r = await readChannelCanvas(s.call, "C1", FACT);
  ok(r.kind === "canvas" && !r.holdsText && !canvasShowsFact(r, BOT), "a bot canvas WITHOUT the fact shows nothing");
}
{
  const s = fake({ "conversations.info": info("F1"), "files.info": { ok: true, file: { user: "U0PERSON" } }, "canvases.sections.lookup": { ok: true, sections: [{ id: "x" }] } });
  ok(!canvasShowsFact(await readChannelCanvas(s.call, "C1", FACT), BOT), "a person's canvas never counts as the bot's memory");
}
{
  const s = fake({ "conversations.info": info("F1"), "files.info": { ok: true, file: { user: BOT } }, "canvases.sections.lookup": { ok: false, error: "missing_scope", needed: "canvases:read" } });
  const r = await readChannelCanvas(s.call, "C1", FACT);
  ok(r.kind === "missing-scope" && r.scope === "canvases:read" && r.method === "canvases.sections.lookup", "a missing_scope answer names the scope Slack wanted");
  ok(!canvasShowsFact(r, BOT), "a missing scope is never read as a verdict that the canvas shows the fact");
}
{
  const s = fake({ "conversations.info": { ok: true, channel: { properties: { tabs: [{ type: "canvas", data: { file_id: "F0TAB" } }] } } }, "files.info": { ok: true, file: { user: BOT } }, "canvases.sections.lookup": { ok: true, sections: [{ id: "temp:C:1" }] } });
  const r = await readChannelCanvas(s.call, "C1", FACT, BOT);
  ok(r.kind === "canvas" && r.canvasId === "F0TAB" && canvasShowsFact(r, BOT), "🔴 a bot canvas named only as a tab, holding the fact, SHOWS it");
  const t = fake({ "conversations.info": { ok: true, channel: { properties: { tabs: [{ type: "canvas", data: { file_id: "F0TAB" } }] } } }, "files.info": { ok: true, file: { user: BOT } }, "canvases.sections.lookup": { ok: true, sections: [] } });
  ok(!canvasShowsFact(await readChannelCanvas(t.call, "C1", FACT, BOT), BOT), "NEGATIVE control: a tabbed bot canvas WITHOUT the fact shows nothing");
}
{
  const byFile: Record<string, Record<string, unknown>> = { F0PERSON: { ok: true, file: { user: "U0PERSON" } }, F0BOTS: { ok: true, file: { user: BOT } } };
  const call: SlackRawCall = async (method, params) => {
    if (method === "conversations.info") return { ok: true, channel: { properties: { tabs: [{ type: "canvas", data: { file_id: "F0PERSON" } }, { type: "canvas", data: { file_id: "F0BOTS" } }] } } };
    if (method === "files.info") return byFile[params["file"]!] ?? { ok: false, error: "file_not_found" };
    if (method === "canvases.sections.lookup") return { ok: true, sections: params["canvas_id"] === "F0BOTS" ? [{ id: "s" }] : [] };
    return { ok: false, error: "unknown_method" };
  };
  const r = await readChannelCanvas(call, "C1", FACT, BOT);
  ok(r.kind === "canvas" && r.canvasId === "F0BOTS" && canvasShowsFact(r, BOT), "🔴 the bot's canvas behind a person's tab is the read: a leak there is not missed");
  const both: SlackRawCall = async (method, params) => (method === "canvases.sections.lookup" ? { ok: true, sections: [{ id: "s" }] } : call(method, params));
  ok(canvasShowsFact(await readChannelCanvas(both, "C1", FACT, BOT), BOT), "a bot canvas holding the fact wins over a person's canvas that also holds it");
  const broken: SlackRawCall = async (method, params) => (method === "files.info" && params["file"] === "F0BOTS" ? { ok: false, error: "missing_scope", needed: "files:read" } : call(method, params));
  const b = await readChannelCanvas(broken, "C1", FACT, BOT);
  ok(b.kind === "missing-scope" && b.scope === "files:read", "a failed read of the second canvas is the verdict: no canvas is skipped");
}
{
  const s = fake({ "conversations.info": { ok: false, error: "channel_not_found" } });
  const r = await readChannelCanvas(s.call, "C1", FACT);
  ok(r.kind === "error" && r.error === "channel_not_found" && r.method === "conversations.info", "any other failure is an error that names the method");
}

const TEAM = "T0HOME";
const member = (id: string, extra: Record<string, unknown> = {}) => ({ ok: true, user: { id, team_id: TEAM, ...extra } });
const slackFor = (channel: Record<string, unknown>, users: Record<string, Record<string, unknown>>, membersExtra: Record<string, unknown> = {}): SlackRawCall => async (method, params) => {
  if (method === "conversations.info") return { ok: true, channel };
  if (method === "conversations.members") return { ok: true, members: Object.keys(users), ...membersExtra };
  if (method === "users.info") return users[params["user"]!] ?? { ok: false, error: "user_not_found" };
  return { ok: false, error: "unknown_method" };
};
{
  const internal = await classifyChannelTrust(slackFor({ id: "C1" }, { U1: member("U1"), [BOT]: member(BOT, { is_bot: true }) }), "C1", TEAM);
  ok(internal.kind === "internal", "POSITIVE control: an unshared channel of full members (and the bot) is internal");
  for (const flag of ["is_ext_shared", "is_shared", "is_org_shared", "is_pending_ext_shared"]) {
    const t = await classifyChannelTrust(slackFor({ id: "C1", [flag]: true }, { U1: member("U1") }), "C1", TEAM);
    ok(t.kind === "untrusted" && t.why === flag, `${flag} ⇒ untrusted, whatever the deployment's row says`);
  }
  const guest = await classifyChannelTrust(slackFor({ id: "C1" }, { U1: member("U1"), U2: member("U2", { is_restricted: true }) }), "C1", TEAM);
  ok(guest.kind === "untrusted" && guest.why.includes("U2"), "a multi-channel guest member ⇒ untrusted");
  const single = await classifyChannelTrust(slackFor({ id: "C1" }, { U3: member("U3", { is_ultra_restricted: true }) }), "C1", TEAM);
  ok(single.kind === "untrusted", "a single-channel guest member ⇒ untrusted");
  const foreign = await classifyChannelTrust(slackFor({ id: "C1" }, { U4: { ok: true, user: { id: "U4", team_id: "T0OTHER" } } }), "C1", TEAM);
  ok(foreign.kind === "untrusted", "a member from another team ⇒ untrusted");
  const big = await classifyChannelTrust(slackFor({ id: "C1" }, { U1: member("U1") }, { response_metadata: { next_cursor: "x" } }), "C1", TEAM);
  ok(big.kind === "untrusted", "more members than one page lists ⇒ untrusted (the observer refuses it too)");
  const unreadable = await classifyChannelTrust(slackFor({ id: "C1" }, { U9: { ok: false, error: "missing_scope", needed: "users:read" } }), "C1", TEAM);
  ok(unreadable.kind === "missing-scope" && unreadable.scope === "users:read", "an unreadable member is a named missing scope, never internal");
  const lost: SlackRawCall = async () => ({ ok: false, error: "channel_not_found" });
  const err = await classifyChannelTrust(lost, "C1", TEAM);
  ok(err.kind === "error" && err.method === "conversations.info", "an unreadable channel is an error, never internal");
}
for (const [o, pass] of [["skipped-external", true], ["cleared-guest", true], ["updated", false], ["created", false], ["clear-failed", false]] as const) {
  ok((canvasRefreshVerdict([row("C9", o, "2026-10-14T00:00:01Z")], "C9").kind === "withheld") === pass, `an untrusted channel whose row says ${o} ${pass ? "passes" : "REDS"} the take-down gate`);
}

{
  const write = (channel: string, op: string, canvasId: string, ts: string): AuditWireEntry => ({
    ts,
    org: "default",
    platform: "slack",
    workspace: "T0",
    surface: channel,
    action: CANVAS_WRITE_ACTION,
    detail: { channel, op, canvasId, chars: 12 },
  });
  ok(createdCanvasId([], "C1") === undefined, "no canvas.write row ⇒ no canvas to read");
  ok(createdCanvasId([write("C2", "create", "F2", "2026-10-14T00:00:01Z")], "C1") === undefined, "a row for ANOTHER channel names no canvas here");
  ok(createdCanvasId([write("C1", "append", "F1", "2026-10-14T00:00:01Z")], "C1") === undefined, "an append row is not a create");
  ok(
    createdCanvasId([write("C1", "create", "F_OLD", "2026-10-14T00:00:01Z"), write("C1", "create", "F_NEW", "2026-10-14T00:00:09Z")], "C1") === "F_NEW",
    "the NEWEST create row names the canvas",
  );
  const byId = (user: string, sections: unknown[]): SlackRawCall => async (method) =>
    method === "files.info" ? { ok: true, file: { id: "F1", user } } : method === "canvases.sections.lookup" ? { ok: true, sections } : { ok: false, error: "unexpected" };
  const holds = await readCanvasById(byId(BOT, [{ id: "s1" }]), "F1", FACT);
  ok(canvasShowsFact(holds, BOT), "the bot's canvas with a section holding the fact shows it");
  const empty = await readCanvasById(byId(BOT, []), "F1", FACT);
  ok(!canvasShowsFact(empty, BOT), "negative control: no section holds the fact ⇒ not shown");
  const theirs = await readCanvasById(byId("U0PERSON", [{ id: "s1" }]), "F1", FACT);
  ok(!canvasShowsFact(theirs, BOT), "negative control: a canvas a person made is not the agent's write");
  const scope = await readCanvasById(async () => ({ ok: false, error: "missing_scope", needed: "files:read" }), "F1", FACT);
  ok(scope.kind === "missing-scope" && scope.scope === "files:read", "a missing driver scope is named, never read as a verdict");
}

console.log(`\n✓ memory-canvas: ${n} assertions passed\n`);
