import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-window-tool-gate-")), "ops.sqlite3");
delete process.env.OE_ORG;

import { windowGrainOf, type WindowGrain, type BindableContext } from "../agent/identity/binding.js";
import { formatWindowToken, taskWindowId } from "../agent/channels/window-key.js";
import { auditWindowToolGate } from "../agent/audit/window-tool-gate.js";
import { readAudit } from "../agent/audit/audit.js";
import { OE_GRAIN_ATTR, rootDmGrainAttrs } from "../agent/channels/unified-window.js";
import { buildSlackAuth } from "../agent/channels/slack-identity.js";
import { buildDiscordAuth } from "../agent/channels/discord-identity.js";
import { buildTeamsAuth } from "../agent/channels/teams-identity.js";
import { buildTelegramAuth } from "../agent/channels/telegram-identity.js";
import { withheldFromGrain, WINDOW_GATED_TOOLS } from "../agent/access/window-gate-manifest.js";

let n = 0;
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const ctxFor = (token: string | undefined, grain?: string): BindableContext => ({
  channel: token === undefined ? { kind: "unified" } : { kind: "unified", continuationToken: token },
  session: { auth: { current: { attributes: grain ? { oe_grain: grain } : {} } } },
});

const LEGACY = formatWindowToken({ domain: "payments", windowId: "payments", generation: 3 });
const EXPLICIT = formatWindowToken({ domain: "payments", windowId: "slack/T1/C_PAY", generation: 3 });
const TASK = formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "1720000000.001"), generation: 3 });
const PER_CONTAINER = "slack/T1/C_PAY:oe-sup:g3";
const NATIVE = "cse_abc123def";

console.log("1. windowGrainOf backstop (token classification, no stamp):");
eq(windowGrainOf(ctxFor(LEGACY)), "standing", "legacy/degenerate window token ⇒ standing");
eq(windowGrainOf(ctxFor(EXPLICIT)), "standing", "explicit solo-window token ⇒ standing");
eq(windowGrainOf(ctxFor(TASK)), "task", "task (t/…) window token ⇒ task");
eq(windowGrainOf(ctxFor(PER_CONTAINER)), "standing", "per-container ambient (`<chan>:oe-sup:g`, not a window token) ⇒ standing");
eq(windowGrainOf(ctxFor(NATIVE)), "native", "native `cse_…` mention token (no supervisor suffix) ⇒ native");
eq(windowGrainOf(ctxFor(`unified:${LEGACY}`)), "standing", "a `unified:`-prefixed window token ⇒ standing after the strip");
eq(windowGrainOf(ctxFor(`unified:${TASK}`)), "task", "a `unified:`-prefixed TASK token ⇒ task after the strip");
eq(windowGrainOf(ctxFor(undefined)), "native", "a blank/unreadable token ⇒ native (full hands, the pre-gate default)");
eq(windowGrainOf(ctxFor("garbage")), "native", "an unrecognised token ⇒ native");

console.log("2. windowGrainOf primary (oe_grain stamp) precedence:");
eq(windowGrainOf(ctxFor(LEGACY, "standing")), "standing", "stamp standing + standing token ⇒ standing");
eq(windowGrainOf(ctxFor(TASK, "task")), "task", "stamp task + task token ⇒ task");
eq(windowGrainOf(ctxFor(undefined, "standing")), "standing", "stamp standing + BLANK token ⇒ standing (primary honoured; token degradation covered)");
eq(windowGrainOf(ctxFor(undefined, "task")), "task", "stamp task + BLANK token ⇒ task (primary honoured — the stamp is why a blank token is safe)");
eq(windowGrainOf(ctxFor(NATIVE, "native")), "native", "stamp native + native token ⇒ native");

console.log("3. windowGrainOf spoof-resistance (fail-closed to narrow):");
eq(windowGrainOf(ctxFor(PER_CONTAINER, "task")), "standing", "stamp task on a STANDING (per-container) token ⇒ standing (the spoof/bug case, fail-closed)");
eq(windowGrainOf(ctxFor(LEGACY, "task")), "standing", "stamp task on a STANDING window token ⇒ standing (fail-closed)");
eq(windowGrainOf(ctxFor(LEGACY, "native")), "standing", "stamp native on a STANDING window token ⇒ standing (a full claim loses to a standing token)");
eq(windowGrainOf(ctxFor(PER_CONTAINER, "garbage")), "standing", "an unrecognised stamp value ⇒ falls through to the token backstop (standing here)");
eq(windowGrainOf(ctxFor(NATIVE, "garbage")), "native", "an unrecognised stamp value ⇒ token backstop (native here) — never task");
ok(windowGrainOf(ctxFor(PER_CONTAINER)) !== "task" && windowGrainOf(ctxFor(NATIVE)) !== "task", "a non-task token never yields task grain without a host task-stamp on a task token");

console.log("3b. root-DM ingress stamp (the D-DM security fix — stamp ⇒ standing ⇒ narrowed):");

const DM_NATIVE_TOKEN = "cse_dm_native_0001";
const ctxWithAuth = (attributes: Record<string, string>, token: string | undefined): BindableContext => ({
  channel: token === undefined ? { kind: "slack" } : { kind: "slack", continuationToken: token },
  session: { auth: { current: { attributes } } },
});

eq(rootDmGrainAttrs(true), { [OE_GRAIN_ATTR]: "standing" }, "rootDmGrainAttrs(true) ⇒ { oe_grain: standing }");
eq(rootDmGrainAttrs(false), {}, "rootDmGrainAttrs(false) ⇒ {} (a non-DM ingress stamps nothing — no over-narrowing)");

const slackDm = buildSlackAuth({ userId: "U1", teamId: "T1", channelId: "D0001", channelType: "im", dmPartnerTrust: "internal" });
const slackChan = buildSlackAuth({ userId: "U1", teamId: "T1", channelId: "C0001", channelType: "channel", isPrivate: false });
const slackMpim = buildSlackAuth({ userId: "U1", teamId: "T1", channelId: "G0001", channelType: "mpim" });
const discordDm = buildDiscordAuth({ userId: "U1", channelId: "D1", channelType: "1" });
const discordChan = buildDiscordAuth({ userId: "U1", guildId: "G1", channelId: "C1", channelType: "0" });
const discordGroupDm = buildDiscordAuth({ userId: "U1", channelId: "GD1", channelType: "3" });
const teamsDm = buildTeamsAuth({ userId: "U1", conversationId: "conv1", tenantId: "ten1", scope: "personal" });
const teamsChan = buildTeamsAuth({ userId: "U1", conversationId: "conv1", tenantId: "ten1", scope: "channel", channelId: "ch1", teamId: "team1" });
const teamsGroup = buildTeamsAuth({ userId: "U1", conversationId: "conv1", tenantId: "ten1", scope: "groupChat" });
const tgDm = buildTelegramAuth({ userId: "U1", chatId: "12345", chatType: "private" });
const tgGroup = buildTelegramAuth({ userId: "U1", chatId: "-100999", chatType: "supergroup" });

eq(slackDm.attributes[OE_GRAIN_ATTR], "standing", "buildSlackAuth(im) stamps oe_grain=standing");
eq(slackDm.attributes.channel_id, "D0001", "buildSlackAuth(im) still captures the raw DM channel id (identity/memory unchanged)");
ok(!(OE_GRAIN_ATTR in slackChan.attributes), "buildSlackAuth(channel) does NOT stamp a grain (native/full preserved)");
ok(!(OE_GRAIN_ATTR in slackMpim.attributes), "buildSlackAuth(mpim/group-DM) does NOT stamp (D-DM is 1:1 only — no over-narrowing)");
eq(discordDm.attributes[OE_GRAIN_ATTR], "standing", "buildDiscordAuth(DM type 1) stamps oe_grain=standing");
ok(!(OE_GRAIN_ATTR in discordChan.attributes), "buildDiscordAuth(guild channel) does NOT stamp");
ok(!(OE_GRAIN_ATTR in discordGroupDm.attributes), "buildDiscordAuth(group DM type 3 ⇒ mpim) does NOT stamp");
eq(teamsDm.attributes[OE_GRAIN_ATTR], "standing", "buildTeamsAuth(personal) stamps oe_grain=standing");
ok(!(OE_GRAIN_ATTR in teamsChan.attributes), "buildTeamsAuth(channel) does NOT stamp");
ok(!(OE_GRAIN_ATTR in teamsGroup.attributes), "buildTeamsAuth(groupChat ⇒ mpim) does NOT stamp");
eq(tgDm.attributes[OE_GRAIN_ATTR], "standing", "buildTelegramAuth(private) stamps oe_grain=standing");
ok(!(OE_GRAIN_ATTR in tgGroup.attributes), "buildTelegramAuth(supergroup) does NOT stamp");

for (const [label, auth] of [["slack", slackDm], ["discord", discordDm], ["teams", teamsDm], ["telegram", tgDm]] as const) {
  eq(windowGrainOf(ctxWithAuth(auth.attributes, DM_NATIVE_TOKEN)), "standing", `${label} DM (stamped) on a native token ⇒ windowGrainOf standing (the stamp narrows, not the token)`);
}
eq(windowGrainOf(ctxWithAuth(slackChan.attributes, DM_NATIVE_TOKEN)), "native", "an UNstamped native-token seat stays native/FULL (F8 over-narrowing guard intact)");
eq(windowGrainOf(ctxWithAuth(slackMpim.attributes, DM_NATIVE_TOKEN)), "native", "an mpim seat (no stamp) stays native/FULL — not over-narrowed");

const dmWithheld = new Set(withheldFromGrain("standing"));
ok(!dmWithheld.has("spawn_task"), "a standing (DM) seat KEEPS spawn_task — WINDOW_GATED_TOOLS[spawn_task] includes standing");
ok(WINDOW_GATED_TOOLS.spawn_task.includes("standing"), "spawn_task is mounted on the standing grain (manifest)");
const WIDE_HANDS_12 = ["bash", "glob", "grep", "read_file", "write_file", "web_fetch", "checkout_repo", "open_pull_request", "post_file", "browser_qa", "create_skill", "delete_skill"];
for (const wide of WIDE_HANDS_12) {
  ok(dmWithheld.has(wide), `a standing (DM) seat DROPS ${wide} (withheld from grain standing)`);
}
ok(dmWithheld.has("complete_task"), "complete_task (task-only) is also absent from a standing DM seat");
eq(dmWithheld.size, WIDE_HANDS_12.length + 1, "a standing (DM) seat withholds exactly the 12 wide-hands tools + complete_task");

console.log("4. auditWindowToolGate (turn.tool_gated row):");
await auditWindowToolGate({ org: "default", domain: "payments", grain: "standing", withheld: [], wakeId: "w-empty", sessionId: "s-empty" });
{
  const rows = await readAudit({ action: "turn.tool_gated" });
  eq(rows.length, 0, "empty withheld ⇒ NO turn.tool_gated row (Stage B fires for nothing in prod)");
}
const WITHHELD = ["checkout_repo", "bash", "open_pull_request"] as const;
await auditWindowToolGate({ org: "default", domain: "payments", grain: "standing", withheld: [...WITHHELD], wakeId: "w-1", sessionId: "s-1" });
{
  const rows = await readAudit({ action: "turn.tool_gated" });
  eq(rows.length, 1, "populated withheld ⇒ exactly one turn.tool_gated row");
  const row = rows[0];
  eq(row.action, "turn.tool_gated", "action is turn.tool_gated");
  eq(row.platform, "unified", "platform label is unified");
  eq(row.workspace, "payments", "workspace label is the domain");
  const detail = row.detail as Record<string, unknown>;
  eq(detail.grain, "standing", "detail.grain records the seat's grain");
  eq(detail.withheld, [...WITHHELD], "detail.withheld lists the tool NAMES");
  eq(detail.withheldCount, WITHHELD.length, "detail.withheldCount is the count");
  eq(detail.wakeId, "w-1", "detail carries the wakeId");
  eq(detail.sessionId, "s-1", "detail carries the sessionId");
  const allowedKeys = ["grain", "withheld", "withheldCount", "wakeId", "sessionId"].sort();
  eq(Object.keys(detail).sort(), allowedKeys, "detail carries names+counts+ids ONLY — no message/content/input field (taint rule)");
}

await auditWindowToolGate({ org: "default", domain: "acme", grain: "task" as WindowGrain, withheld: ["bash"], wakeId: "w-2", sessionId: "s-2" });
{
  const rows = await readAudit({ action: "turn.tool_gated", workspace: "acme" });
  eq(rows.length, 1, "a second workspace's row is isolated by the workspace filter");
  eq((rows[0].detail as Record<string, unknown>).grain, "task", "the row records whatever grain it was given");
}

console.log(`\nwindow-tool-gate: ${n} assertions passed.`);
