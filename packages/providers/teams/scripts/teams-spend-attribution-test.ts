import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const DIR = mkdtempSync(join(tmpdir(), "oe-teams-spend-"));
process.env.OE_SQLITE_PATH = join(DIR, "ops.sqlite3");

const { registerTeamsProvider } = await import("../agent/register.js");
registerTeamsProvider();

const { spendHook, usageForSession, spendTotals, stampModelCall } = await import(
  "@open-everywhere/core/agent/adapter-api.js"
);

const { createRequire } = await import("node:module");
const { dirname, join: pathJoin } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = await import(pathToFileURL(pathJoin(eveRoot, "dist/src/context/container.js")).href);

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(DIR, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

const MODEL = "anthropic/claude-sonnet-5";
const CHANNEL_ATTRS = {
  tenant_id: "TEN1",
  conversation_id: "19:conv1;messageid=1",
  channel_id: "19:chan1",
  team_id: "team-A",
  scope: "channel",
  membership_type: "standard",
  user_id: "AAD-1",
} as const;
const PERSONAL_ATTRS = { tenant_id: "TEN1", conversation_id: "19:dm1", scope: "personal", user_id: "AAD-1" } as const;

async function driveTurn(input: {
  channel: Record<string, unknown>;
  attributes: Record<string, unknown>;
  sessionId: string;
}): Promise<readonly Awaited<ReturnType<typeof usageForSession>>[number][]> {
  await contextStorage.run(new ContextContainer(), async () => {
    stampModelCall(MODEL);
    await spendHook.events!["step.completed"]!(
      { data: { usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 400, costUsd: 0.0021 } } } as never,
      {
        channel: input.channel,
        session: { id: input.sessionId, auth: { current: { attributes: input.attributes, principalId: "AAD-1", principalType: "teams-user" } } },
      } as never,
    );
  });
  return usageForSession("default", input.sessionId);
}

{
  const rows = await driveTurn({ channel: { kind: "teams" }, attributes: { ...CHANNEL_ATTRS }, sessionId: "teams-native" });
  ok(rows.length === 1, "a native Teams turn writes exactly ONE usage_events row");
  const r = rows[0]!;
  ok(r.surfaceKey === "teams/TEN1/19-chan1", `the row files under the Teams spend grain teams/<tenant>/<channel> (got ${r.surfaceKey})`);
  ok(r.principalId === "AAD-1", "the row carries the Teams principal, not an empty attribution");
  ok(r.kind === "channel", "a Teams channel turn tags kind 'channel'");
  ok(r.model === MODEL, "the row carries the routed model id from the per-call stamp");
  ok(r.inputTokens === 1200 && r.outputTokens === 300, "the row carries the turn's real token counts");
  ok(r.usdMicrosMeasured === 2100, `the row carries the gateway's measured cost in micros (got ${String(r.usdMicrosMeasured)})`);
  ok(r.costSource === "measured", "the row states WHICH cost answer it carries");
}

{
  const rows = await driveTurn({
    channel: { kind: "unified", continuationToken: "unified:oe-dom:eng:oe-sup:g1" },
    attributes: { ...CHANNEL_ATTRS, oe_platform: "teams" },
    sessionId: "teams-window",
  });
  ok(rows.length === 1, "a window-diverted Teams turn writes exactly ONE usage_events row");
  const r = rows[0]!;
  ok(r.surfaceKey === "teams/TEN1/19-chan1", `a diverted turn files under the SAME Teams spend grain as a native one (got ${r.surfaceKey})`);
  ok(r.principalId === "AAD-1", "a diverted turn keeps the Teams principal");
  ok(r.kind === "supervisor", "a standing-seat token tags kind 'supervisor', so seat turns stay separable from ordinary ones");
  ok(r.usdMicrosMeasured === 2100, "a diverted turn's measured cost lands too");
}

{
  const rows = await driveTurn({ channel: { kind: "teams" }, attributes: { ...PERSONAL_ATTRS }, sessionId: "teams-personal" });
  ok(rows.length === 1, "a personal Teams chat turn writes exactly ONE usage_events row");
  const r = rows[0]!;
  ok(r.surfaceKey === "teams/TEN1/19-dm1", `a personal chat files under the conversation grain (got ${r.surfaceKey})`);
  ok(r.kind === "dm", "a personal Teams chat tags kind 'dm'");
}

{
  const rows = await driveTurn({
    channel: { kind: "unified", continuationToken: "unified:oe-dom:eng:oe-sup:g1" },
    attributes: { ...CHANNEL_ATTRS },
    sessionId: "teams-unstamped",
  });
  ok(rows.length === 1, "an unstamped diverted turn still writes a row — spend is never dropped, only mis-filed");
  ok(rows[0]!.surfaceKey === "unified/dev/default", `without the oe_platform stamp the row files OUTSIDE the Teams workspace (got ${rows[0]!.surfaceKey})`);
}

{
  const totals = await spendTotals("default", { surfaceKey: "teams/TEN1/19-chan1" });
  ok(totals.calls === 2, `the cap ledger counted both Teams channel-door calls (got ${totals.calls})`);
  ok(totals.inputTokens === 2400 && totals.outputTokens === 600, "the cap ledger carries the summed Teams tokens");
  ok(totals.usdMicrosMeasured === 4200, `the cap ledger carries the summed measured cost (got ${totals.usdMicrosMeasured})`);
  const personal = await spendTotals("default", { surfaceKey: "teams/TEN1/19-dm1" });
  ok(personal.calls === 1, "a personal chat's spend caps under its own key, not the channel's");
}

{
  const noScope = await driveTurn({
    channel: { kind: "teams" },
    attributes: { tenant_id: "TEN1", conversation_id: "19:dm-nc", user_id: "AAD-1" },
    sessionId: "teams-no-scope",
  });
  ok(noScope.length === 1, "an activity with no conversationType still writes its usage row — spend is never dropped");
  ok(noScope[0]!.surfaceMode === undefined, "🔴 OPE-1867: the row is UNSTAMPED, so the report mask buckets it as (unclassified) rather than naming a conversation Teams never called a room");

  const personal = await driveTurn({
    channel: { kind: "teams" },
    attributes: { ...PERSONAL_ATTRS, conversation_id: "19:dm-nc2" },
    sessionId: "teams-personal-stamped",
  });
  ok(personal[0]!.surfaceMode === "dm", "🔴 OPE-1867 NEGATIVE CONTROL: a personal chat that DOES carry its scope is stamped 'dm' — the fix narrowed the stamp to resolved modes, it did not remove it");

  const channel = await driveTurn({ channel: { kind: "teams" }, attributes: { ...CHANNEL_ATTRS }, sessionId: "teams-channel-stamped" });
  ok(channel[0]!.surfaceMode === "channel", "🔴 OPE-1867 NEGATIVE CONTROL: a positively-identified team channel is stamped 'channel', so its spend is still reported by name");
}

await removeTempDir(DIR);
console.log(`✓ teams spend attribution: ${passed} assertions passed`);
