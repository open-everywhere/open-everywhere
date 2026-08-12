import { registerOperationalStore } from "../agent/operational/provider.js";
import { renderCancelNote } from "../agent/hooks/turn-anchor.js";
import { parseOeCommandTokens, parseSlackCommandText, renderHelp, runStop } from "../agent/commands/core.js";
import { resolveTurnAnchor, recordTurnAnchor, clearTurnAnchor, turnAnchorKey, turnChannelKey, TURN_ANCHOR_TTL_MS } from "../agent/channels/turn-registry.js";
import { cancelAnchoredTurn, type AttachSessionForCancel } from "../agent/channels/turn-cancel.js";
import type { SurfaceBinding } from "../agent/identity/binding.js";

process.env.OE_SQLITE_PATH = ":memory:";
const { sqliteOperationalStore, _resetOperationalDbForTest } = await import("../agent/operational/sqlite.js");
_resetOperationalDbForTest();
registerOperationalStore(sqliteOperationalStore);

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

ok(turnAnchorKey("slack", "C1", "111.222") === "slack:C1:111.222", "anchor key is platform:channel:message");
ok(turnAnchorKey("slack", "C1", undefined) === undefined, "a missing message id yields NO anchor key (a partial key would collide across channels)");
ok(turnChannelKey("slack", "C1") === "slack:C1", "channel key is platform:channel");
ok(turnChannelKey(undefined, "C1") === undefined, "a missing platform yields no channel key");

const NOW = "2026-08-12T10:00:00.000Z";
await recordTurnAnchor(
  "org-a",
  { windowKey: "w-1", anchorKey: "slack:C1:111.000", channelKey: "slack:C1", sessionId: "s-1", turnId: "t-1", surfaceKey: "slack/T1/C1" },
  NOW,
);
await recordTurnAnchor(
  "org-a",
  { windowKey: "w-2", anchorKey: "slack:C1:222.000", channelKey: "slack:C1", sessionId: "s-2", turnId: "t-2", surfaceKey: "slack/T1/C1" },
  "2026-08-12T10:05:00.000Z",
);

ok((await resolveTurnAnchor("org-a", { anchorKey: "slack:C1:111.000" }))?.turnId === "t-1", "an exact anchor key resolves its own turn");
ok((await resolveTurnAnchor("org-a", { windowKey: "w-2" }))?.turnId === "t-2", "a window key resolves its own turn");
ok((await resolveTurnAnchor("org-a", { channelKey: "slack:C1" }))?.turnId === "t-2", "a channel key resolves the NEWEST turn in the channel");
ok(
  (await resolveTurnAnchor("org-a", { anchorKey: "slack:C1:111.000", channelKey: "slack:C1" }))?.turnId === "t-1",
  "the sharp key WINS: an anchor key is never overridden by the channel's newest-turn guess",
);
ok(
  (await resolveTurnAnchor("org-a", { anchorKey: "slack:C1:999.000", windowKey: "w-2" }))?.turnId === "t-2",
  "an unknown anchor key falls through to the next arm it was GIVEN",
);
ok((await resolveTurnAnchor("org-a", { anchorKey: "slack:C1:999.000" })) === null, "…and only through the arms the caller supplied — an unknown key alone resolves nothing");
ok((await resolveTurnAnchor("org-a", {})) === null, "no keys ⇒ NOTHING — never a guess");

ok((await resolveTurnAnchor("org-b", { anchorKey: "slack:C1:111.000" })) === null, "another org's anchor key resolves NOTHING (org is the outermost partition)");
ok((await resolveTurnAnchor("org-b", { channelKey: "slack:C1" })) === null, "another org's channel key resolves NOTHING");

await clearTurnAnchor("org-a", "w-1");
ok((await resolveTurnAnchor("org-a", { anchorKey: "slack:C1:111.000" })) === null, "a cleared anchor stops resolving");
ok(TURN_ANCHOR_TTL_MS <= 60 * 60_000, "the anchor TTL is SHORT — a turn is minutes, and a stale anchor is a stop that cancels nothing");

await recordTurnAnchor(
  "org-b",
  { windowKey: "w-b", channelKey: "slack:C9", sessionId: "s-b", turnId: "t-b", surfaceKey: "slack/T1/C9" },
  "2026-08-12T10:00:00.000Z",
);
await recordTurnAnchor(
  "org-a",
  { windowKey: "w-3", channelKey: "slack:C1", sessionId: "s-3", turnId: "t-3", surfaceKey: "slack/T1/C1" },
  "2026-08-12T23:00:00.000Z",
);
ok((await resolveTurnAnchor("org-a", { windowKey: "w-2" })) === null, "the opportunistic prune reclaims this org's expired rows on write");
ok((await resolveTurnAnchor("org-b", { windowKey: "w-b" }))?.turnId === "t-b", "…and NEVER crosses the tenant boundary while doing it");

function fakeAttach(status: string | undefined, calls: { sessionId?: string; turnId?: string }): AttachSessionForCancel {
  return (sessionId: string) => ({
    async cancel(options?: { turnId?: string }) {
      calls.sessionId = sessionId;
      calls.turnId = options?.turnId;
      return status === undefined ? undefined : { status };
    },
  });
}

{
  const calls: { sessionId?: string; turnId?: string } = {};
  const r = await cancelAnchoredTurn({
    org: "org-a",
    platform: "slack",
    workspace: "T1",
    via: "reaction",
    query: { windowKey: "w-3" },
    attachSession: fakeAttach("accepted", calls),
  });
  ok(r.outcome === "requested", "an accepted cancel reports `requested`");
  ok(calls.sessionId === "s-3", "…against the anchored SESSION id, not a continuation token");
  ok(calls.turnId === "t-3", "…and ALWAYS passes turnId, so a stale stop can never amputate a later turn");
  ok(!/\bstopped\b|undone/i.test(r.message), "the acknowledgement never claims work was `stopped` or `undone` — side effects are real and irreversible");
}

{
  const calls: { sessionId?: string; turnId?: string } = {};
  const r = await cancelAnchoredTurn({
    org: "org-a",
    platform: "slack",
    workspace: "T1",
    via: "command",
    query: { windowKey: "w-3" },
    attachSession: fakeAttach("no_active_turn", calls),
  });
  ok(r.outcome === "no_active_turn", "`no_active_turn` is reported as its own outcome — it is the parked signal, not an error");
  ok(/waiting on you/i.test(r.message), "…and reads to a human as 'I'm already waiting on you'");
}

{
  const r = await cancelAnchoredTurn({
    org: "org-a",
    platform: "slack",
    workspace: "T1",
    via: "reaction",
    query: { anchorKey: "slack:C1:nothing-here" },
    attachSession: fakeAttach("accepted", {}),
  });
  ok(r.outcome === "no_turn_found", "an unresolvable trigger cancels NOTHING rather than guessing");
}

{
  const throwing: AttachSessionForCancel = () => ({
    async cancel() {
      throw new Error("runtime unreachable");
    },
  });
  const r = await cancelAnchoredTurn({
    org: "org-a",
    platform: "slack",
    workspace: "T1",
    via: "reaction",
    query: { windowKey: "w-3" },
    attachSession: throwing,
  });
  ok(r.outcome === "error", "a throwing cancel door is an `error` outcome — never an exception out of an ingress route");
}

ok(renderCancelNote(0, []) === "Stood down — 0 steps in, nothing had run yet.", "a cancel before anything ran says so");
ok(renderCancelNote(1, []).includes("one step in"), "one step reads as prose, not '1 steps'");
{
  const note = renderCancelNote(6, ["read_thread", "reply", "create_ticket"]);
  ok(note.includes("6 steps in"), "the note says how far in the turn was");
  ok(note.includes("NOT undone"), "🔴 the note states plainly that what already ran was NOT undone");
  ok(note.includes("create_ticket"), "…and names the actions that actually executed");
}
{
  const note = renderCancelNote(9, ["a", "b", "c", "d", "e"]);
  ok(note.includes("and 2 earlier"), "a long turn summarises the tail rather than listing everything");
  ok(note.includes("`e`"), "…keeping the MOST RECENT actions, which are the ones a human is looking at");
}

ok(parseOeCommandTokens(["stop"]).kind === "stop", '"/oe stop" parses');
ok(parseSlackCommandText("  stop  ").kind === "stop", "…through Slack’s free-text field, whitespace and all");
ok(parseSlackCommandText("").kind === "help", "a bare /oe still lands on help");
ok(renderHelp().includes("/oe stop"), "…and help ADVERTISES stop — an affordance nobody can find is not an affordance");

{
  const binding = { platform: "slack", org: "org-a", workspace: "T1", target: { channelId: "C1" }, mode: "channel", trust: "internal" } as unknown as SurfaceBinding;
  const unwired = await runStop(binding, undefined);
  ok(/isn't wired/i.test(unwired), "an unwired surface tells the user plainly instead of failing silently");

  const calls: { sessionId?: string; turnId?: string } = {};
  const wired = await runStop(binding, fakeAttach("accepted", calls));
  ok(calls.sessionId === "s-3", '"/oe stop" resolves the channel’s in-flight turn — its ONLY available key');
  ok(wired.length > 0, "…and answers the invoker with a user-facing sentence");
}

console.log(`✓ turn-cancel: ${passed} assertions passed`);
