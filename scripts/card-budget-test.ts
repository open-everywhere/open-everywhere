import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { PendingActionRow } from "@open-everywhere/core/agent/approvals/types.js";

const dir = join(tmpdir(), `open-everywhere-card-budget-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
registerConfig({ loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {}, loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [] } as never);
await import("@open-everywhere/core/agent/approvals/flow.js");
await import("@open-everywhere/core/agent/approvals/session-checkpoint.js");
const { registeredActionKinds, actionKind } = await import("@open-everywhere/core/agent/approvals/actions.js");
const { withTaintDisclosure } = await import("@open-everywhere/core/agent/approvals/taint-disclosure.js");
const { pendingCardLayout, decidedCardLine, APPROVAL_CARD_METADATA_TYPE, APPROVAL_CARD_BLOCK_PREFIX, CARD_METADATA_DETAIL_MAX } = await import("@open-everywhere/core/agent/approvals/card-layout.js");
const { CONSEQUENCE_MAX } = await import("@open-everywhere/core/agent/approvals/plain-summary.js");
const { QUOTE_MAX } = await import("@open-everywhere/core/agent/approvals/plain-text.js");
const { PLAIN_SUMMARY_MAX } = await import("@open-everywhere/core/agent/approvals/plain-text.js");
const { pendingCardBlocks, decidedCardBlocks, judgeLiftNoticeBlocks, judgeLiftNoticeText, groupedCardBlocks } = await import("@open-everywhere/core/agent/approvals/card.js");
const { rawIdLeaks } = await import("@open-everywhere/core/agent/channels/friendly-ids.js");
const { pendingDiscordCard, decidedDiscordCard, judgeLiftNoticeDiscordCard } = await import("@open-everywhere/provider-discord/agent/approvals/discord-card.js");
const { pendingTeamsCard, decidedTeamsCard, judgeLiftNoticeTeamsCard } = await import("@open-everywhere/provider-teams/agent/approvals/teams-card.js");
const { APPROVAL_KIND_FIXTURES } = await import("../packages/core/scripts/approval-kind-fixtures.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const MAX_PENDING_LINES = 4;
const MAX_PENDING_CHARS = 420;
const MAX_DECIDED_CHARS = 240;

const KINDS = registeredActionKinds();
const KIND_LABEL = new RegExp(`(?<![\\w.])(?:${KINDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w.])`, "u");
const MODEL_ID = /\b(?:gpt-\d[\w.-]*|claude-[\w.-]+|gemini-[\w.-]+|llama-?\d[\w.-]*|mistral-[\w.-]+|(?:anthropic|openai|google|xai|meta)\/[\w.-]+)/iu;
const INTERNAL_WORDS = /\b(?:Approval requested|vercel-sandbox|sandbox backend|spend ledger|ledger|AI Gateway|utility model|bot-PR|config-as-code|ActionKind|frozen args)\b/iu;
const SNOWFLAKE = /(?<![\w<@#])\d{17,20}(?![\w>])/u;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const SHORT_INTERNAL_ID = /\b[a-z]{1,3}-[0-9a-f]{8}\b/u;
const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;

function leaks(text: string): string[] {
  const out: string[] = [];
  const kind = KIND_LABEL.exec(text);
  if (kind) out.push(`kind label "${kind[0]}"`);
  const model = MODEL_ID.exec(text);
  if (model) out.push(`model id "${model[0]}"`);
  const word = INTERNAL_WORDS.exec(text);
  if (word) out.push(`internal word "${word[0]}"`);
  for (const id of rawIdLeaks(text)) out.push(`raw platform id "${id}"`);
  const flake = SNOWFLAKE.exec(text);
  if (flake) out.push(`raw snowflake "${flake[0]}"`);
  const uuid = UUID.exec(text);
  if (uuid) out.push(`internal row id "${uuid[0]}"`);
  const short = SHORT_INTERNAL_ID.exec(text);
  if (short) out.push(`internal id "${short[0]}"`);
  const iso = ISO_INSTANT.exec(text);
  if (iso) out.push(`ISO instant "${iso[0]}"`);
  return out;
}

{
  const bad: readonly [string, string][] = [
    ["Approval requested: meeting.join", "kind label"],
    ["Transcription runs on openai/whisper-1", "model id"],
    ["uses gpt-5.6-luna for the recap", "model id"],
    ["Runs on vercel-sandbox; its hours go to the spend ledger.", "internal word"],
    ["Post a message into slack C0EXAMPLE2", "raw platform id"],
    ["Join voice channel 123456789012345678", "raw snowflake"],
    ["quote action 00000000-0000-4000-8000-000000000085", "internal row id"],
    ["Let routine r-1a2b3c4d use it", "internal id"],
    ["expires 2026-03-16T07:01:00.000Z", "ISO instant"],
  ];
  for (const [text, shape] of bad) ok(leaks(text).some((l) => l.startsWith(shape)), `🔴 the detector catches a ${shape} in "${text}" (got ${JSON.stringify(leaks(text))})`);
  for (const clean of ["Post a message in <#C0EXAMPLE1>.", "Asked by <@U0EXAMPLE1> · expires 13 October, 14:00 UTC", "Set the monthly spend limit for #general to $100.00/mo."]) {
    ok(leaks(clean).length === 0, `a clean line passes the detector: "${clean}" (got ${JSON.stringify(leaks(clean))})`);
  }
}

interface Block {
  readonly type: string;
  readonly block_id?: string;
  readonly text?: { readonly text?: string };
  readonly elements?: readonly { readonly text?: string | { readonly text?: string } }[];
}
function slackLines(blocks: readonly unknown[]): { lines: string[]; buttons: string[] } {
  const lines: string[] = [];
  const buttons: string[] = [];
  for (const raw of blocks) {
    const b = raw as Block;
    if ((b.type === "header" || b.type === "section") && b.text?.text) lines.push(b.text.text);
    if (b.type === "context") lines.push((b.elements ?? []).map((e) => (typeof e.text === "string" ? e.text : "")).join(" "));
    if (b.type === "actions") for (const e of b.elements ?? []) buttons.push(typeof e.text === "object" ? (e.text.text ?? "") : String(e.text ?? ""));
  }
  return { lines, buttons };
}
function teamsLines(card: { body: readonly unknown[]; actions?: readonly unknown[] }): { lines: string[]; buttons: string[] } {
  return {
    lines: card.body.map((e) => String((e as { text?: string }).text ?? "")),
    buttons: (card.actions ?? []).map((a) => String((a as { title?: string }).title ?? "")),
  };
}
function discordLines(msg: { content: string; components: readonly unknown[] }): { lines: string[]; buttons: string[] } {
  const buttons = msg.components.flatMap((row) => ((row as { components?: { label?: string }[] }).components ?? []).map((c) => c.label ?? ""));
  return { lines: msg.content.split("\n"), buttons };
}

function row(kind: string, args: unknown, over: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    id: "00000000-0000-4000-8000-000000000085",
    org: "acme",
    kind,
    argsJson: JSON.stringify(args),
    scopeKey: "slack/T0EXAMPLE1/C0EXAMPLE1",
    domain: null,
    requestedBy: "U0EXAMPLE1",
    channelId: "C0EXAMPLE1",
    threadTs: null,
    messageTs: "1760453700.000200",
    postedTo: "slack/T0EXAMPLE1/C0EXAMPLE1",
    status: "pending",
    createdAt: "2026-03-15T07:01:00.000Z",
    expiresAt: "2026-03-16T07:01:00.000Z",
    decidedBy: null,
    decidedAt: null,
    ...over,
  };
}

function charBudget(kind: string): number {
  return actionKind(kind)?.consequenceQuotes === true ? MAX_PENDING_CHARS - CONSEQUENCE_MAX + QUOTE_MAX : MAX_PENDING_CHARS;
}

function checkVisible(label: string, lines: readonly string[], buttons: readonly string[], kind: string): void {
  for (const line of [...lines, ...buttons]) ok(leaks(line).length === 0, `${label}: no banned shape in "${line}" (got ${JSON.stringify(leaks(line))})`);
  ok(lines.length <= MAX_PENDING_LINES, `${label}: at most ${MAX_PENDING_LINES} visible lines (got ${lines.length}: ${JSON.stringify(lines)})`);
  const chars = lines.join("\n").length;
  ok(chars <= charBudget(kind), `${label}: at most ${charBudget(kind)} visible characters (got ${chars}: ${JSON.stringify(lines)})`);
}

{
  ok(KINDS.length >= 30, `the registry is populated (got ${KINDS.length}) — an empty registry would pass every loop vacuously`);
  const fixtureKinds = new Set(APPROVAL_KIND_FIXTURES.map((f) => f.kind));
  for (const kind of KINDS) ok(fixtureKinds.has(kind), `kind "${kind}" has a card fixture in approval-kind-fixtures.ts`);
}
for (const { kind, args } of APPROVAL_KIND_FIXTURES) {
  for (const tainted of [false, true]) {
    const frozen = { ...args, tainted };
    const r = row(kind, frozen);
    const detail = withTaintDisclosure(actionKind(kind)!.summarize(frozen as never), frozen, { live: false });
    const layout = pendingCardLayout(r, detail);
    const tag = `${kind}${tainted ? " (tainted)" : ""}`;
    ok(layout.headline.length <= PLAIN_SUMMARY_MAX, `${tag}: the headline fits ${PLAIN_SUMMARY_MAX} characters`);
    const cap = actionKind(kind)!.consequenceQuotes === true ? QUOTE_MAX : CONSEQUENCE_MAX;
    ok(layout.consequence === undefined || (layout.consequence.length <= cap && !layout.consequence.includes("\n")), `${tag}: the consequence is one line of at most ${cap} characters`);
    ok(tainted === (layout.warning !== undefined), `${tag}: the warning line shows exactly when the proposal was tainted`);

    const slack = pendingCardBlocks(r, detail);
    const s = slackLines(slack.blocks);
    checkVisible(`${tag} Slack`, s.lines, s.buttons, kind);
    for (const line of slack.text.split("\n")) ok(leaks(line).length === 0, `${tag} Slack notification text: no banned shape in "${line}"`);
    ok(slack.text.split("\n").length <= MAX_PENDING_LINES, `${tag} Slack notification text: at most ${MAX_PENDING_LINES} lines`);
    const payload = slack.metadata?.event_payload as { kind?: string; detail?: string[] } | undefined;
    ok(slack.metadata?.event_type === APPROVAL_CARD_METADATA_TYPE && payload?.kind === kind, `${tag} Slack: the message metadata carries the kind`);
    ok(JSON.stringify(payload?.detail) === JSON.stringify(detail), `${tag} Slack: the message metadata carries the full detail`);
    ok((slack.blocks[0] as Block).block_id === `${APPROVAL_CARD_BLOCK_PREFIX}${kind}:${r.id}`, `${tag} Slack: the first block id carries the kind`);

    const d = discordLines(pendingDiscordCard(r, detail));
    checkVisible(`${tag} Discord`, d.lines, d.buttons, kind);
    const t = teamsLines(pendingTeamsCard(r, detail));
    checkVisible(`${tag} Teams`, t.lines, t.buttons, kind);
  }
}

for (const { kind, args } of APPROVAL_KIND_FIXTURES) {
  for (const [status, outcome] of [
    ["approved", "done"],
    ["rejected", "rejected"],
    ["expired", "expired"],
  ] as const) {
    const r = row(kind, args, { status, decidedBy: status === "expired" ? null : "U0EXAMPLE3" });
    const tag = `${kind} ${status}`;
    const slack = decidedCardBlocks(r, ["detail"], outcome);
    const s = slackLines(slack.blocks);
    ok(s.lines.length === 1 && s.buttons.length === 0 && !slack.text.includes("\n"), `${tag} Slack: one line, no buttons (got ${JSON.stringify(s.lines)})`);
    const d = decidedDiscordCard(r, ["detail"], outcome);
    ok(!d.content.includes("\n") && d.components.length === 0, `${tag} Discord: one line, no buttons (got ${JSON.stringify(d.content)})`);
    const t = teamsLines(decidedTeamsCard(r, ["detail"], outcome));
    ok(t.lines.length === 1 && t.buttons.length === 0, `${tag} Teams: one line, no buttons`);
    for (const line of [...s.lines, d.content, ...t.lines]) {
      ok(line.length <= MAX_DECIDED_CHARS, `${tag}: the decided line fits ${MAX_DECIDED_CHARS} characters (got ${line.length}: "${line}")`);
      ok(leaks(line).length === 0, `${tag}: no banned shape in the decided line "${line}" (got ${JSON.stringify(leaks(line))})`);
    }
    ok(s.lines[0] === decidedCardLine(r, outcome, "<@U0EXAMPLE3>") && d.content === s.lines[0], `${tag}: Slack and Discord say the same line`);
  }
}

{
  const f = APPROVAL_KIND_FIXTURES.find((x) => x.kind === "spend.set")!;
  const r = row(f.kind, f.args, { status: "approved", decidedBy: "chain:judge" });
  const slack = slackLines(judgeLiftNoticeBlocks(r, ["detail"], "spend limit set for #general").blocks);
  const discord = discordLines(judgeLiftNoticeDiscordCard(r, ["detail"], "spend limit set for #general"));
  const teams = teamsLines(judgeLiftNoticeTeamsCard(r, ["detail"], "spend limit set for #general"));
  const text = judgeLiftNoticeText(r, ["detail"], "spend limit set for #general").split("\n");
  for (const [label, v] of [
    ["Slack", slack],
    ["Discord", discord],
    ["Teams", teams],
    ["text-only", { lines: text, buttons: [] }],
  ] as const) {
    ok(v.lines.length <= (label === "text-only" ? 4 : 3), `judge-lift ${label}: at most three lines, four with the text-only overrule line (got ${JSON.stringify(v.lines)})`);
    for (const line of [...v.lines, ...v.buttons]) ok(leaks(line).length === 0, `judge-lift ${label}: no banned shape in "${line}" (got ${JSON.stringify(leaks(line))})`);
  }

  const rc = APPROVAL_KIND_FIXTURES.find((x) => x.kind === "routine.create")!;
  const rcNotice = judgeLiftNoticeText(row(rc.kind, { ...rc.args, prompt: `${"long instruction ".repeat(60)}END` }, { status: "approved", decidedBy: "chain:judge" }), ["detail"], "routine started").split("\n");
  ok(rcNotice[0]!.startsWith("Ran without asking: started a routine in ") && !rcNotice[0]!.includes("without anyone asking"), `a judge-lifted routine's notice opens with the short done line (got ${JSON.stringify(rcNotice[0])})`);
  ok(rcNotice[1]!.length <= 120 && !rcNotice[1]!.includes("END"), `the notice's reminder of what ran is one short line (got ${rcNotice[1]!.length} characters)`);
  ok(rcNotice.join("\n").length <= 400, `the whole notice stays short (got ${rcNotice.join("\n").length} characters)`);

  const items = APPROVAL_KIND_FIXTURES.slice(0, 5).map((x, i) => ({ row: row(x.kind, x.args, { id: `3f2a1b4c-1111-2222-3333-44445555666${i}` }), summaryLines: ["detail"] }));
  const grouped = groupedCardBlocks(items);
  const g = slackLines(grouped.blocks);
  for (const line of [...g.lines, ...g.buttons]) ok(leaks(line).length === 0, `grouped card: no banned shape in "${line}" (got ${JSON.stringify(leaks(line))})`);
  ok(grouped.blocks.length <= 50, `a full grouped card fits Slack's 50-block limit (got ${grouped.blocks.length})`);
  const huge = pendingCardBlocks(row("chat.post", APPROVAL_KIND_FIXTURES.find((x) => x.kind === "chat.post")!.args), ["head", "x".repeat(9000)]);
  const hugeDetail = (huge.metadata?.event_payload as { detail: string[] }).detail;
  ok(hugeDetail.join("").length <= CARD_METADATA_DETAIL_MAX + 80 && hugeDetail.at(-1)!.startsWith("(detail cut"), `the card metadata caps the detail at ${CARD_METADATA_DETAIL_MAX} characters, with a marker`);
  const gp = grouped.metadata?.event_payload as { items?: { kind: string }[] } | undefined;
  ok(gp?.items?.length === 5 && gp.items.every((it, i) => it.kind === items[i]!.row.kind), "grouped card: the metadata carries each item's kind");
}

{
  const QUOTED_FIELD: Readonly<Record<string, string>> = {
    "chat.post": "text",
    "chat.dm": "text",
    "a2a.delegate": "message",
    "op.connector": "inputPreview",
    "skill.create": "content",
    "routine.create": "prompt",
    "routine.edit": "prompt",
    "routine.policy.add": "rule",
    "routine.policy.remove": "ruleText",
    "routine.permission": "prompt",
    "ticket.create": "body",
    "pr.open": "body",
    "mcp-server.propose": "declaration.description",
  };
  const quoting = KINDS.filter((k) => actionKind(k)?.consequenceQuotes === true);
  ok(quoting.length >= 8, `the quoting kinds are registered (got ${quoting.length})`);
  for (const kind of quoting) ok(QUOTED_FIELD[kind] !== undefined, `quoting kind "${kind}" names its quoted field in this test`);
  const withField = (args: Record<string, unknown>, path: string, value: string): Record<string, unknown> => {
    const [head, sub] = path.split(".");
    return sub === undefined ? { ...args, [head!]: value } : { ...args, [head!]: { ...(args[head!] as Record<string, unknown>), [sub]: value } };
  };
  const HOSTILE = "<!channel> <@U0EXAMPLE9> <https://evil.example|Docs> [ok](https://evil.example) @everyone @@here";
  for (const kind of quoting) {
    const field = QUOTED_FIELD[kind]!;
    const base = APPROVAL_KIND_FIXTURES.find((f) => f.kind === kind)!.args;
    const longArgs = withField(base, field, `${"word ".repeat(1200)}END-OF-TEXT`);
    const longLayout = pendingCardLayout(row(kind, longArgs), ["detail"]);
    ok(longLayout.consequence !== undefined && longLayout.consequence.length <= QUOTE_MAX, `${kind}: a long quote fits QUOTE_MAX (got ${longLayout.consequence?.length})`);
    ok(/\(\d+ more characters not shown\)/u.test(longLayout.consequence ?? ""), `🔴 ${kind}: a cut quote says how much it does not show (got ${JSON.stringify(longLayout.consequence?.slice(-80))})`);
    ok(!(longLayout.consequence ?? "").includes("END-OF-TEXT"), `${kind}: the cut is real (negative control for the marker)`);
    const discordLong = pendingDiscordCard(row(kind, longArgs), ["detail"]).content;
    ok(discordLong.length <= 2000, `${kind}: the Discord card with a long quote fits Discord's 2,000-character content cap (got ${discordLong.length})`);
    const notice = judgeLiftNoticeDiscordCard(row(kind, longArgs, { status: "approved", decidedBy: "chain:judge" }), ["detail"], `routine started — ${"x".repeat(600)}`).content;
    ok(notice.length <= 2000, `${kind}: the Discord judge-lift notice with a long quote and a long outcome fits 2,000 characters (got ${notice.length})`);
    const hostileArgs = withField(base, field, HOSTILE);
    const r = row(kind, hostileArgs);
    const surfaces: [string, string[]][] = [
      ["Slack", slackLines(pendingCardBlocks(r, ["detail"]).blocks).lines],
      ["Discord", discordLines(pendingDiscordCard(r, ["detail"])).lines],
      ["Teams", teamsLines(pendingTeamsCard(r, ["detail"])).lines],
    ];
    for (const [surface, lines] of surfaces) {
      const consequence = lines.find((l) => l.includes("Docs"));
      ok(consequence !== undefined, `${kind} ${surface}: the hostile quote shows on the card`);
      ok(!/[<>[\]|]/u.test(consequence ?? "<"), `🔴 ${kind} ${surface}: the quote carries no link or mention markup (got ${JSON.stringify(consequence)})`);
      ok(!/@(?:everyone|here)\b/iu.test(consequence ?? "@here"), `🔴 ${kind} ${surface}: the quote carries no broadcast mention (got ${JSON.stringify(consequence)})`);
    }
  }
}

{
  const base = APPROVAL_KIND_FIXTURES.find((f) => f.kind === "chat.post")!.args;
  const clean = { ...base, tainted: false, text: "FYI: this summary used external content from the vendor docs." };
  const detail = withTaintDisclosure(actionKind("chat.post")!.summarize(clean as never), clean, { live: false });
  ok(pendingCardLayout(row("chat.post", clean), detail).warning === undefined, "🔴 a phrase inside the quoted message does not raise the taint warning");
  const crossVenue = { ...base, platform: "slack", container: "C0EXAMPLE2", scopeKey: "discord/111111111111111111/222222222222222222" };
  const headline = pendingCardLayout(row("chat.post", crossVenue), ["detail"]).headline;
  ok(!headline.includes("<#") && headline.includes("a Slack conversation"), `🔴 a cross-platform post names its destination in words, not a raw mention (got "${headline}")`);
  const sameVenue = pendingCardLayout(row("chat.post", { ...base, platform: "slack", container: "C0EXAMPLE2", scopeKey: "slack/T0EXAMPLE1/C0EXAMPLE1" }), ["detail"]).headline;
  ok(sameVenue.includes("<#C0EXAMPLE2>"), "negative control: on its own platform the destination renders as a channel mention");
  const es = APPROVAL_KIND_FIXTURES.find((f) => f.kind === "email.sender")!.args;
  const esArgs = { ...es, why: "they send us external content we must triage" };
  const live = withTaintDisclosure(actionKind("email.sender")!.summarize(esArgs as never), esArgs, { live: false, kinds: [] });
  const liveTainted = withTaintDisclosure(actionKind("email.sender")!.summarize(esArgs as never), { ...esArgs, tainted: true }, { live: false });
  ok(pendingCardLayout(row("email.sender", esArgs), liveTainted).warning !== undefined, "🔴 a tainted proposal whose reason names external content still shows the warning");
  ok(pendingCardLayout(row("email.sender", esArgs), live).warning === undefined, "negative control: the same reason on a clean proposal raises no warning");
}

{
  const visible = (kind: string, args: Record<string, unknown>): string[] => {
    const r = row(kind, args);
    return [
      ...slackLines(pendingCardBlocks(r, ["detail"]).blocks).lines,
      ...discordLines(pendingDiscordCard(r, ["detail"])).lines,
      ...teamsLines(pendingTeamsCard(r, ["detail"])).lines,
    ];
  };
  const pr = APPROVAL_KIND_FIXTURES.find((f) => f.kind === "pr.open")!.args;
  const withWorkflows = visible("pr.open", { ...pr, capabilities: ["workflows"] });
  ok(withWorkflows.filter((l) => l.includes("the click also grants") && l.includes("workflows: write")).length === 3, "🔴 OPE-1822: a pr.open card names the extra token grade the click mints, on all three surfaces");
  ok(!visible("pr.open", { ...pr, capabilities: [] }).some((l) => l.includes("also grants")), "negative control: a repo with no declared capability shows no extra grade");
  ok(withWorkflows.some((l) => l.includes(" → ") && l.includes(String(pr["base"]))), "pr.open: the card names the branches and commit it publishes");
  ok(visible("pr.open", { ...pr, head: "fix_login_bug", base: "release_2" }).filter((l) => l.includes("fix_login_bug → release_2")).length === 3, "pr.open: an underscored branch name shows verbatim on all three surfaces");
  const cp = APPROVAL_KIND_FIXTURES.find((f) => f.kind === "session.checkpoint")!.args;
  ok(visible("session.checkpoint", { ...cp, durableSession: undefined }).some((l) => /lasts up to \d+ h/u.test(l)), "🔴 OPE-2161: a live session's checkpoint card names its clock");
  ok(visible("session.checkpoint", { ...cp, durableSession: true }).some((l) => l.includes("no timer")), "🔴 OPE-2161: a durable job's checkpoint card says the approval has no timer");
  const ar = APPROVAL_KIND_FIXTURES.find((f) => f.kind === "access.request")!.args;
  ok(visible("access.request", { ...ar, exposure: ["The engineering domain reaches 4 rooms, and it admits shared channels by a rule."] }).some((l) => l.startsWith("Reach: ")), "🔴 OPE-235: an access request's reach shows on the card");
}

{
  const { placeWords } = await import("@open-everywhere/core/agent/channels/friendly-ids.js");
  ok(placeWords({ key: "google-chat/W1/AAAA" }) === "a Google Chat conversation", "a Google Chat place reads in words, never the slug");
  const f = APPROVAL_KIND_FIXTURES.find((x) => x.kind === "spend.set")!;
  const walked = row(f.kind, f.args, { scopeKey: "google-chat/W1/AAAA", requestedBy: "users/1234567890" });
  const slackFooter = slackLines(pendingCardBlocks(walked, ["detail"]).blocks).lines.find((l) => l.startsWith("Asked by "))!;
  const discordFooter = discordLines(pendingDiscordCard(walked, ["detail"])).lines.find((l) => l.includes("Asked by "))!;
  for (const [surface, footer] of [["Slack", slackFooter], ["Discord", discordFooter]] as const) {
    ok(!footer.includes("<@") && !footer.includes("users/") && footer.includes("Asked by someone"), `🔴 ${surface}: a requester from another platform reads "someone", never a raw id (got ${JSON.stringify(footer)})`);
  }
  const home = row(f.kind, f.args);
  ok(slackLines(pendingCardBlocks(home, ["detail"]).blocks).lines.some((l) => l.startsWith("Asked by <@U0EXAMPLE1>")), "negative control: a requester on the card's own platform is mentioned");
}

{
  const { cronWords, routineWords, toolWords, triggerWords } = await import("@open-everywhere/core/agent/routines/schedule-words.js");
  const cases: readonly [string, string][] = [
    ["0 9 * * 1-5", "weekdays at 09:00 UTC"],
    ["30 7 * * *", "daily at 07:30 UTC"],
    ["0 18 * * 5", "every Friday at 18:00 UTC"],
    ["0 10 * * 0,6", "weekends at 10:00 UTC"],
    ["*/15 * * * *", "every 15 min"],
    ["0 * * * *", "every hour"],
    ["0 */6 * * *", "every 6 hours"],
    ["5 4 1 * *", "on a custom schedule"],
  ];
  for (const [expr, words] of cases) ok(cronWords(expr) === words, `cron "${expr}" reads "${words}" (got "${cronWords(expr)}")`);
  ok(routineWords('cron "0 9 * * 1-5" (UTC; posts every run)') === "the routine that runs weekdays at 09:00 UTC", "a frozen cron description names the routine by when it runs");
  ok(routineWords("daily digest") === "the routine “daily digest”", "any other description is quoted");
  ok(routineWords(undefined) === "the routine", "no description names the routine plainly");
  ok(toolWords("tool:notion__update_page") === "update page on notion", "a connector tool reads as words");
  ok(triggerWords({ kind: "once", at: "2026-03-16T07:01:00.000Z" }) === "once on 16 March, 07:01 UTC", "a one-shot reads as a short date");
  for (const w of [routineWords('cron "0 9 * * 1-5" (UTC; posts every run)'), toolWords("tool:notion__update_page")]) ok(leaks(w).length === 0 && !w.includes("*"), `no raw expression or id in "${w}"`);
}

console.log(`card-budget-test: ${n} assertions passed`);
