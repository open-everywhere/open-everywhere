import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `oe-person-text-sweep-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
delete process.env.DATABASE_URL;

const { personTextFaults, commandFailureText, PersonFacingError, TURN_FAILED_TEXT, COMMAND_FAILED_TEXT, friendlyWhen } = await import("../agent/channels/person-text.js");
const core = await import("../agent/commands/core.js");
const { parseRateTokens, runRate, rateHelpLine } = await import("../agent/commands/rate.js");
const { parseOptOutTokens, optOutHelpLine } = await import("../agent/commands/optout.js");
const { parseWatchTokens, watchHelpLine } = await import("../agent/commands/watch.js");
const { disableNoticeText, boundNoticeText } = await import("../agent/routines/disable-notice.js");
const { fireWithheldNoticeText } = await import("../agent/routines/fire-disclosure.js");
const { withRunRefusalBlock } = await import("../agent/routines/report.js");
const { buildConnectCard, renderNonSlackConnect, connectorWords } = await import("../agent/connections/connector-card.js");
const { grantApproveFailureText } = await import("../agent/access/credential-grant-click.js");
const { memoryLineForReader, renderProvenanceWording, restoreProvenanceCarriers } = await import("../agent/memory/provenance-mark.js");
const { introMessage } = await import("../agent/onboarding/onboarding.js");
const { renderPinned, statusItemLine, upsertStatusItem, statusSeed } = await import("../agent/status/status.js");

let n = 0;
function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  n++;
}
function clean(text: string, what: string): void {
  assert.deepEqual(personTextFaults(text), [], `${what} reads cleanly (got ${JSON.stringify(text)})`);
  n++;
}

const MEMBER = "U0EXOWNER1";
const ROUTINE_ID = "r-1a2b3c4d";

{
  const before: readonly [string, string][] = [
    ["raw id", `🛑 Routine \`${ROUTINE_ID}\` has DISABLED itself after 3 consecutive failures and will not run again.`],
    ["raw id", "Card posted in this channel — proposing $25.00/month (pending `7b1e9f0c2d3a4b5c`, expires 2026-10-13T09:00:00Z)."],
    ["debug", "⚠️ I hit an error while handling that and couldn't finish. Please try again — and if it keeps failing, check the deployment logs."],
    ["debug", "*/oe* — zero-inference control-plane commands (pure logic, code-rendered, no model turn)"],
    ["debug", "couldn't open a Slack DM with the requester — missing_scope (check SLACK_BOT_TOKEN and the im:write bot scope)"],
    ["plumbing", "This channel's audience floor resolved to \"guest\" — so org-internal content can't be delivered here."],
    ["plumbing", "- 2026-10-01: The API is down [external-provenance: added on a turn that ingested web]"],
    ["plumbing", "Done — the approver chain auto-approved it (judge), so no card was posted."],
    ["raw id", `Sent by the agent on behalf of ${MEMBER}, from slack/T0EXAMPLE.`],
  ];
  for (const [kind, text] of before) {
    const faults = personTextFaults(text);
    ok(faults.some((f) => f.startsWith(kind)), `🔴 the detector flags the OLD wording as ${kind}: ${JSON.stringify(text)} (got ${JSON.stringify(faults)})`);
  }
  clean(`Ask <@${MEMBER}> in <#C0123ABCD>, or open https://example.com/r/9f2c3b4a5d6e7f80`, "a mention and a URL");
  ok(friendlyWhen("2026-10-14T09:00:00.000Z") === "14 October, 09:00 UTC", "an instant reads as a date in words");
  ok(friendlyWhen("not a date") === "soon", "an unparseable instant never echoes the raw string");
}

{
  clean(TURN_FAILED_TEXT, "the failed-turn line");
  clean(COMMAND_FAILED_TEXT, "the failed-command line");
  ok(commandFailureText(new Error("connect ECONNREFUSED 10.0.0.1:5432")) === COMMAND_FAILED_TEXT, "🔴 a raw error never reaches the room — it renders the generic line");
  ok(commandFailureText(new PersonFacingError("Try this in a channel.")) === "Try this in a channel.", "a PersonFacingError renders as written");
  const { readFileSync } = await import("node:fs");
  const slackSrc = readFileSync(new URL("../../providers/slack/agent/channels/slack.ts", import.meta.url), "utf8");
  const discordSrc = readFileSync(new URL("../../providers/discord/agent/channels/discord-gateway.ts", import.meta.url), "utf8");
  ok(!/postWakeText\([^)]*data\.message/.test(slackSrc), "🔴 Slack never posts the raw error message into the thread");
  ok(slackSrc.includes("`:octagonal_sign: ${TURN_FAILED_TEXT}`"), "Slack posts the shared failed-turn line");
  ok(!discordSrc.includes("deployment logs"), "🔴 Discord never sends a person to the deployment logs");
  ok(discordSrc.includes("`⚠️ ${TURN_FAILED_TEXT}`"), "Discord posts the shared failed-turn line");
}

{
  clean(core.renderHelp(), "/oe help");
  const status = core.renderStatus(
    { version: "1.2.3", deploymentSha: "abc1234", evePin: "0.44.0", primaryModel: "zai/glm-5.2", utilityModel: "deepseek/deepseek-v4-flash", contextWindowTokens: 200_000, compactionThresholdTokens: 100_000 } as never,
    "sqlite",
    "on",
  );
  clean(status, "/oe status");
  ok(status.split("\n")[0]!.endsWith("is running."), "/oe status answers \"are you working?\" on its first line");
  for (const text of ["budget raise", "budget raise abc", "budget bogus", "bogus", "optout maybe", "watch loud", "rate 9"]) {
    const cmd = core.parseSlackCommandText(text);
    ok(cmd.kind === "error", `"/oe ${text}" is an error`);
    if (cmd.kind === "error") clean(cmd.message, `the "/oe ${text}" error`);
  }
  const rateErr = parseRateTokens(["x"]);
  if ("message" in rateErr) clean(rateErr.message, "the rate parse error");
  for (const parsed of [parseOptOutTokens(["x"]), parseWatchTokens(["x"])]) if (parsed.kind === "error") clean(parsed.message, "an optout/watch parse error");
  clean(rateHelpLine(), "the rate help line");
  clean(optOutHelpLine(), "the optout help line");
  clean(watchHelpLine(), "the watch help line");
  const binding = { org: "default", platform: "slack", workspace: "T0EXAMPLE", surface: "C0123ABCD", principalId: MEMBER, mode: "channel", trust: "internal", target: { channelId: "C0123ABCD" } } as never;
  clean(await runRate(binding, 4, { readAudit: async () => [] }), "the nothing-to-rate answer");
  clean(await runRate(binding, 4, { readAudit: async () => [{ ts: "2026-10-13T09:00:00.000Z", detail: { arm: "champion", bucketKey: "b", modelId: "m", turnId: "t" } }] as never, appendAudit: async () => { throw new Error("SQLITE_BUSY"); } }), "the rating-failed answer");
  clean(await core.runStop(binding, undefined), "/oe stop with no stop door");
  clean(
    core.renderBudgetStatus({ surfaceKey: "slack/T0EXAMPLE/C0123ABCD", workspaceKey: "slack/T0EXAMPLE", surfaceTokens: 1234, workspaceTokens: 5678, surfaceUsd: 1.2, workspaceUsd: 3.4, caps: {} as never }),
    "/oe budget",
  );
  const guestBudget = await core.runOeCommand({ kind: "budget-status" }, { ...(binding as object), trust: "external", roomTrust: "internal" } as never);
  clean(guestBudget, "the /oe budget refusal for a guest");
  ok(!guestBudget.includes("$") && !/\d/.test(guestBudget), "the /oe budget refusal carries no figure");
  const noRoomTrust = await core.runOeCommand({ kind: "budget-status" }, { ...(binding as object), trust: "external" } as never);
  ok(noRoomTrust !== guestBudget && noRoomTrust.startsWith("*Spending this month*"), `with no roomTrust, /oe budget is not refused (got "${noRoomTrust.slice(0, 80)}")`);
}

{
  const routine = { id: ROUTINE_ID, prompt: "Post the release board every Monday.", report: { kind: "post" }, trigger: { kind: "cron", cron: "0 9 * * 1" }, sessionMode: "fresh" } as never;
  const once = { id: ROUTINE_ID, prompt: "Remind the team about the offsite.", report: { kind: "silent" }, trigger: { kind: "once", at: "2026-10-14T09:00:00.000Z" } } as never;
  clean(disableNoticeText(routine, "auto-disabled after 3 consecutive failures spanning over an hour", 3), "the self-disable notice");
  clean(disableNoticeText(once, "auto-disabled — its one scheduled fire failed", 1), "the one-shot self-disable notice");
  for (const dimension of ["fires", "deadline", "stalled"] as const) {
    clean(boundNoticeText(routine, { exhausted: true, dimension, reason: `it stopped (${ROUTINE_ID}, 2026-10-14T09:00:00.000Z)` }), `the ${dimension} stop notice`);
  }
  clean(fireWithheldNoticeText(ROUTINE_ID), "the withheld-fire notice");
  clean(
    withRunRefusalBlock("Here is the weekly summary.", [
      { permission: "open pull requests", card: "https://acme.slack.com/archives/C0123ABCD/p1700000000000100", cardPosted: true, cardCapped: false, cardKnown: true },
      { permission: "use Notion", card: null, cardPosted: true, cardCapped: false, cardKnown: true },
      { permission: "send email", card: null, cardPosted: false, cardCapped: true, cardKnown: true },
      { permission: "post to Linear", card: null, cardPosted: false, cardCapped: false, cardKnown: false },
      { permission: "read GitHub", card: null, cardPosted: false, cardCapped: false, cardKnown: true },
    ]),
    "the run-refusal block",
  );
}

{
  ok(connectorWords("notion") === "Notion" && connectorWords("acme-crm") === "Acme-crm", "a connector reads by its display name");
  const options = [
    { credentialType: "user-oauth", principal: "user", credentialId: "c1", vercelConnector: "vc1", route: { kind: "url" } },
    { credentialType: "service-oauth", principal: "app", credentialId: "c2", dashboardUrl: "https://vercel.com/acme/connect", route: { kind: "url" } },
    { credentialType: "service-oauth", principal: "app", credentialId: "c3", vercelConnector: "vc3", route: { kind: "url" } },
    { credentialType: "service-oauth", principal: "app", credentialId: "c4", route: { kind: "url" } },
    { credentialType: "api-key", principal: "app", credentialId: "c5", route: { kind: "page" } },
    { credentialType: "api-key", principal: "app", credentialId: "c6", route: { kind: "text-degrade", reason: "I can't take a key safely here. Ask me in Slack, where I can open a private form, or ask your admin to add it." } },
  ] as never;
  const card = buildConnectCard("notion", options, "default");
  clean(card.text, "the connect card's fallback text");
  clean(JSON.stringify(card.blocks), "the connect card's blocks");
  const failingAuth = (async () => {
    throw new Error("connector vc1 not provisioned");
  }) as never;
  for (const mode of ["dm", "channel"] as const) {
    const { text } = await renderNonSlackConnect("notion", options, { mode, principalId: MEMBER, org: "default", platform: "discord", workspace: "G1" }, failingAuth, async () => undefined);
    clean(text, `the ${mode} connect message`);
  }
  for (const reason of ["consent_required", "catalogue_unreachable", "tool_absent", "frozen_args_unknown", "owner_unresolvable", "standing_unavailable", "mint_refused"] as const) {
    for (const prompted of [true, false]) clean(grantApproveFailureText(reason as never, prompted), `the grant-approve failure line (${reason})`);
  }
}

{
  const wording = renderProvenanceWording(["web", "notion", "chat-message", "github", "connector"]);
  const stored = `- 2026-10-01: ${wording.attribution} The API is down ${wording.mark}`;
  ok(personTextFaults(stored).length > 0, "🔴 NEGATIVE CONTROL: the STORED line carries the machine carriers");
  const shown = memoryLineForReader(stored);
  clean(shown, "a marked memory line as a person reads it");
  ok(shown.includes("(unconfirmed)") && shown.includes("(from the web, Notion, a chat and GitHub)"), `the carriers read as plain words (got ${JSON.stringify(shown)})`);
  ok(memoryLineForReader(`- x ${renderProvenanceWording([]).mark}`) === "- x (from an outside source)", "an unnamed source still says it came from outside");
  ok(memoryLineForReader("- plain line") === "- plain line", "an unmarked line is unchanged");
  ok(restoreProvenanceCarriers(shown, stored) === stored, "🔴 an unchanged Home edit of a marked line is byte-identical to the stored line");
  const reworded = restoreProvenanceCarriers(shown.replace("is down", "was down"), stored);
  ok(reworded === stored.replace("is down", "was down"), `a reworded edit keeps both carriers (got ${JSON.stringify(reworded)})`);
  const stripped = restoreProvenanceCarriers("- 2026-10-01: The API was down", stored);
  ok(stripped.endsWith(wording.mark), "a provenance suffix the person deleted comes back — an edit changes the wording, never where it came from");
  ok(restoreProvenanceCarriers("- plain line", "- plain line") === "- plain line", "an unmarked line edits as written");
  const twice = `A ${wording.mark} B ${wording.mark}`;
  ok(restoreProvenanceCarriers(memoryLineForReader(twice), twice) === twice, "two identical carriers each go back to their own place");
  const webMark = renderProvenanceWording(["web"]).mark;
  const suffixed = `The API is down ${webMark}`;
  ok(
    restoreProvenanceCarriers("The (from the web) docs say the API is down (from the web)", suffixed) === `The (from the web) docs say the API is down ${webMark}`,
    "a reader phrase the person typed earlier stays theirs — the suffix is found from the end",
  );
  ok(
    restoreProvenanceCarriers("The (from the web) docs say the API is down", suffixed) === `The (from the web) docs say the API is down ${webMark}`,
    "…and when the person deleted the suffix, their earlier phrase stays and the carrier comes back at the end",
  );
  const midLine = `- X is down ${webMark} — also Y`;
  ok(restoreProvenanceCarriers(memoryLineForReader(midLine), midLine) === midLine, "a mark with text after it round-trips byte-identical on an unchanged save");
}

{
  clean(introMessage(false), "the channel intro");
  clean(introMessage(true, "Ada"), "the channel intro with adopted instructions");
}

{
  const sessionId = "wrun_example79";
  const body = upsertStatusItem(statusSeed("slack/T0EXAMPLE/C0123ABCD"), sessionId, statusItemLine(sessionId, "working", "Drafting the launch note", "2026-10-13 09:30Z"));
  ok(body.includes(sessionId), "NEGATIVE CONTROL: STATUS.md keeps the session id — it is the bullet's key");
  clean(renderPinned(body), "the pinned status message");
  clean(renderPinned(undefined), "the idle pinned status message");
}

console.log(`✓ person-text-sweep: ${n} assertions passed (detector, errors, /oe commands, routine notices, connectors, memory marks, onboarding, spend and status)`);
