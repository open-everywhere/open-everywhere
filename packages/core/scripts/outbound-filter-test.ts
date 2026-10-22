import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-outbound-filter-")), "ops.sqlite3");
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
delete process.env.OE_PLATFORM;

import { generateText, jsonSchema, stepCountIs, tool, type LanguageModel, type ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { overrideSettingsForTest, registerSettings, sensitivePatternsProblem, defineSettings } from "../agent/settings/settings.js";
import { scanSensitive, luhnValid, cardBrandValid, ibanValid, nhsValid, abaValid, mrzCheckDigit, redactStrictest, SHIPPED_DETECTORS } from "../agent/access/sensitive-data.js";
import {
  decideOutbound,
  filterToolsetOutbound,
  outboundSinkOf,
  outboundTextOf,
  OUTBOUND_INTERNAL_TOOLS,
  OUTBOUND_WITHHELD_ACTION,
  OUTBOUND_HELD_ACTION,
  CLOSING_PROSE_SINK,
  type OutboundRefusal,
} from "../agent/access/outbound-filter.js";
import { projectToolSet } from "../agent/access/untrusted-projection.js";
import { finalMessageAction } from "../agent/channels/turn-delivery.js";
import { TOOL_CONSEQUENCE } from "../agent/access/consequence.js";
import { HARNESS_INTERNAL_TOOLS } from "../agent/access/job-posture.js";
import { recordRequesterAsk, recordRequesterMessage } from "../agent/access/requester-messages.js";
import { inboundAnswerOf } from "../agent/a2a/inbound/answer.js";
import { filterOutboundText, redactOutboundPreview, A2A_ANSWER_SINK } from "../agent/access/outbound-filter.js";
import { readAudit } from "../agent/audit/audit.js";
import { FakeEveContext, inEveContext } from "./_eve-context-stub.js";

_setDeploymentIdentityForTest({ org: "acme" });
registerSettings({});

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const types = (text: string): string[] => scanSensitive(text).map((f) => f.type);

const VISA = "4539 1488 0343 6467";
const VISA_PLAIN = "4539148803436467";
const MASTERCARD = "5425-2334-3010-9903";
const AMEX = "3782 822463 10005";
const PASSPORT = "533380006";
const MRZ_LINE_2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10";

{
  ok(luhnValid(VISA_PLAIN) && !luhnValid("4539148803436468"), "luhn: the check digit decides");
  ok(cardBrandValid(VISA_PLAIN) && !cardBrandValid("1729530000123456"), "brand: a Slack-timestamp-shaped number is no card brand");
  ok(ibanValid("GB82 WEST 1234 5698 7654 32") && !ibanValid("GB82 WEST 1234 5698 7654 33"), "iban: mod-97");
  ok(nhsValid("943 476 5919") && !nhsValid("943 476 5918"), "nhs: mod-11");
  ok(abaValid("011000015") && !abaValid("011000016"), "aba: the routing checksum");
  ok(mrzCheckDigit("L898902C3") === 6, "mrz: the ICAO 9303 specimen's document check digit");

  const positives: Array<[string, string]> = [
    [`my card is ${VISA}, expiry 04/29`, "card-luhn"],
    [`card ${VISA_PLAIN}`, "card-luhn"],
    [`use ${MASTERCARD} for it`, "card-luhn"],
    [`amex ${AMEX}.`, "card-luhn"],
    ["card 4539.1488.0343.6467", "card-luhn"],
    ["card 4539 1488-0343 6467", "card-luhn"],
    ["card 4 5 3 9 1 4 8 8 0 3 4 3 6 4 6 7", "card-luhn"],
    ["SSN 123-45-6789 on file", "us-ssn"],
    ["social security number: 123456789", "us-ssn-labelled"],
    ["NI number AB 12 34 56 C", "uk-nino"],
    [`Passport number: ${PASSPORT}`, "passport-labelled"],
    [`passport no. C01X00T47 issued 2019`, "passport-labelled"],
    [`P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\n${MRZ_LINE_2}`, "passport-mrz"],
    ["NHS number 943 476 5919", "nhs-number"],
    ["Authorization: Bearer abcd1234efgh5678ijkl", "secret-bearer"],
    ["key AKIAIOSFODNN7EXAMPLE", "secret-aws-key"],
    ["sk-proj-abcdefgh12345678", "secret-sk"],
    ["token xoxb-123456789012-abcdefgh", "secret-slack"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123", "secret-github"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIE", "secret-private-key"],
    ["IBAN GB82 WEST 1234 5698 7654 32", "iban"],
    ["sort code 12-34-56, account 12345678", "uk-sort-code"],
    ["routing number 011000015", "us-routing-number"],
    ["she was diagnosed with type 2 diabetes last year", "health-diagnosis"],
    ["MRN: 00123456", "health-record-number"],
  ];
  for (const [text, type] of positives) ok(types(text).includes(type), `detector finds ${type}`);

  const negatives = [
    "slack ts 1729830240.123456 and 1729530000123456",
    "discord snowflake 1180000000000000000",
    "order 4539148803436468 (Luhn fails)",
    "uuid 00000000-0000-4000-8000-000000000092",
    "commit 0123456789abcdef0123456789abcdef01234567",
    "call +44 20 7946 0958 or 555-123-4567",
    "deployed at 2026-01-24T10:00:51Z, build 20261021.2",
    "the passport number field is required",
    "we diagnosed with a race condition in the queue",
    "AWS account number 123456789012",
    "port 8080, pid 4111, 4111 1111 rows",
    "version 4.539.148.803.436.467",
    "the admin token is a bearer credential the operator must hold",
    'headers.set("www-authenticate", `Bearer resource_metadata="${metadata}"`)',
  ];
  for (const text of negatives) ok(types(text).length === 0, `no finding in a look-alike: "${text}" → [${types(text).join(", ")}]`);

  const redacted = redactStrictest(`card ${VISA} and passport ${PASSPORT}`);
  ok(!redacted.includes("4539") && !redacted.includes(PASSPORT), "redact: both spans are struck");
  ok(redacted.includes("[withheld: a card number]") && redacted.includes("[withheld: a government ID number]"), "redact: each marker names its category");
  ok(SHIPPED_DETECTORS.every((d) => d.pattern.flags.includes("g")), "every shipped detector is global");
}

{
  ok(decideOutbound("hello there", []).verdict === "pass", "decide: clean text passes");
  ok(decideOutbound(`card ${VISA}`, []).verdict === "withhold", "decide: a card number is withheld");
  ok(decideOutbound(`card ${VISA}`, [`please post my card ${VISA}`]).verdict === "withhold", "🔴 decide: strictest is withheld EVEN WHEN the member asked");
  const iban = "IBAN GB82 WEST 1234 5698 7654 32";
  ok(decideOutbound(iban, []).verdict === "hold", "decide: personal finance with no ask is held");
  ok(decideOutbound(iban, ["can you send the supplier our bank details?"]).verdict === "pass", "decide: a member who named the category passes it");
  ok(decideOutbound(iban, ["send GB82WEST12345698765432 to finance"]).verdict === "pass", "decide: a member who wrote the value passes it");
  ok(decideOutbound(iban, ["what's 2+2?"]).verdict === "hold", "decide: an unrelated ask does not pass it");
  ok(decideOutbound("diagnosed with asthma", ["post the medical summary"]).verdict === "pass", "decide: health named by the member passes");
  ok(decideOutbound("diagnosed with asthma", ["can you fix the race condition?"]).verdict === "hold", "🔴 decide: 'condition' in engineering text is no health ask");
  ok(decideOutbound(iban, ["check the AWS account for drift"]).verdict === "hold", "🔴 decide: 'account' alone is no finance ask");
  for (const phrase of ["post the health check results to #ops", "is the service health green?", "the diagnosis of the outage"]) {
    ok(decideOutbound("Dana is taking sertraline", [phrase]).verdict === "hold", `🔴 decide: "${phrase}" is no health ask`);
  }
  ok(decideOutbound(iban, ["what is our AWS account number?"]).verdict === "hold", "🔴 decide: 'AWS account number' is no finance ask");
  const nested = outboundTextOf({ channel: "C1", blocks: [{ text: { text: `pay with ${VISA}` } }], n: 3 });
  ok(nested.complete && nested.text.includes(VISA) && nested.text.includes("C1") && nested.text.includes("3"), "input text: nested strings and numbers are read");
  ok(!outboundTextOf({ a: "4539 1488", b: "0343 6467" }).text.match(/4539 1488 0343 6467/), "input text: two fields are not joined into one value");
  ok(decideOutbound(outboundTextOf({ [VISA_PLAIN]: true }), []).verdict === "withhold", "🔴 input text: an object KEY is scanned too");
  const table = { children: [{ table: { children: [{ table_row: { cells: [[{ text: { content: "ok" } }]] } }] } }] };
  ok(outboundTextOf(table).complete, "input text: a real nested connector input is read whole");
  let deep: unknown = `card ${VISA}`;
  for (let i = 0; i < 40; i++) deep = { d: deep };
  const deepVerdict = decideOutbound(outboundTextOf(deep), []);
  ok(deepVerdict.verdict === "withhold" && deepVerdict.findings[0]!.type === "input-too-large", "🔴 bounds: an input past the depth bound is withheld, never passed unread");
  const wide = Array.from({ length: 20_001 }, () => "x");
  ok(decideOutbound(outboundTextOf(wide), []).verdict === "withhold", "🔴 bounds: an input past the leaf bound is withheld");
  ok(decideOutbound(`${" ".repeat(4_200_000)}card ${VISA}`, []).verdict === "withhold", "🔴 bounds: a text past the scan bound is withheld, never scanned in part");
}

type Json = Record<string, unknown>;

async function driveToolCall(toolName: string, input: Json, opts: { asked?: string; envelope?: string; workChild?: boolean; project?: boolean } = {}): Promise<{ ran: boolean; error: string | undefined }> {
  let ran = false;
  const ctx = new FakeEveContext();
  ctx.set({ name: "open-everywhere.continuation-turn" }, { sessionId: "sess-1", turnId: "turn-1", unified: false });
  return inEveContext(ctx, async () => {
    if (opts.asked !== undefined) recordRequesterAsk("turn-1", { wakeId: "w1", authorId: "U1", body: opts.asked });
    if (opts.envelope !== undefined) recordRequesterMessage("turn-1", opts.envelope);
    if (opts.workChild === true) ctx.set({ name: "open-everywhere.work-tier" }, "child");
    const toolset: Record<string, unknown> = {
      [toolName]: tool({
        description: "probe",
        inputSchema: jsonSchema({ type: "object", properties: { text: { type: "string" }, channel: { type: "string" } }, required: ["text"] }) as never,
        execute: async () => {
          ran = true;
          return "posted";
        },
      }),
    };
    if (opts.project !== false) projectToolSet(toolset);
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step++;
        const content = step === 1 ? [{ type: "tool-call" as const, toolCallId: "c1", toolName, input: JSON.stringify(input) }] : [{ type: "text" as const, text: "done" }];
        return {
          content,
          finishReason: { unified: step === 1 ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
          usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
          warnings: [],
        };
      },
    } as never) as unknown as LanguageModel;
    const result = await generateText({ model, prompt: "go", tools: toolset as ToolSet, stopWhen: stepCountIs(2) });
    const errorPart = result.steps.flatMap((s) => s.content).find((p) => (p as { type: string }).type === "tool-error") as { error?: unknown } | undefined;
    const err = errorPart?.error;
    return { ran, error: err === undefined ? undefined : err instanceof Error ? err.message : String(err) };
  });
}

const auditRows = async (action: string) => (await readAudit({ org: "acme", action })).map((r) => r as unknown as { detail?: Json });

{
  const control = await driveToolCall("post_message", { channel: "C1", text: `card ${VISA}` }, { project: false });
  ok(control.ran === true, "control: without the projection the post runs");

  const posted = await driveToolCall("post_message", { channel: "C1", text: `card ${VISA} and passport ${PASSPORT}` });
  ok(posted.ran === false, "🔴 e2e: a card number and a passport number never reach the post's execute");
  ok(posted.error !== undefined && posted.error.includes("withheld"), `🔴 e2e: the model reads the withheld refusal (${posted.error})`);
  ok(posted.error!.includes("a card number") && posted.error!.includes("a government ID number"), "e2e: the refusal names both categories");
  const ours = posted.error!.slice(posted.error!.indexOf("post_message: Open Everywhere"));
  ok(ours.length > 0 && !ours.includes("4539") && !ours.includes(PASSPORT), "🔴 e2e: the refusal OE writes carries no value");

  const clean = await driveToolCall("post_message", { channel: "C1", text: "the deploy is green" });
  ok(clean.ran === true && clean.error === undefined, "e2e: a clean post runs");

  const withheldRows = await auditRows(OUTBOUND_WITHHELD_ACTION);
  ok(withheldRows.length === 1, `🔴 audit: one ${OUTBOUND_WITHHELD_ACTION} row (found ${withheldRows.length})`);
  const detail = withheldRows[0]!.detail ?? {};
  ok(detail.tier === "strictest" && detail.sink === "post_message" && detail.count === 2, "audit: the row names the tier, the sink and the count");
  ok(Array.isArray(detail.types) && (detail.types as string[]).includes("card-luhn") && (detail.types as string[]).includes("passport-labelled"), "audit: the row names the detectors");
  ok(detail.turn === "turn-1" && detail.session === "sess-1", "audit: the row names the turn");
  const rowText = JSON.stringify(withheldRows[0]);
  ok(!rowText.includes("4539") && !rowText.includes("6467") && !rowText.includes(PASSPORT), "🔴 audit: the row carries no value");

  const iban = { channel: "C1", text: "pay the supplier: IBAN GB82 WEST 1234 5698 7654 32" };
  const held = await driveToolCall("post_message", iban);
  ok(held.ran === false && held.error !== undefined && held.error.includes("held"), "🔴 explicit: with no ask the post is held, and the model is told to ask");
  ok((await auditRows(OUTBOUND_HELD_ACTION)).length === 1, `audit: one ${OUTBOUND_HELD_ACTION} row`);
  const asked = await driveToolCall("post_message", iban, { asked: "please send our bank details to the supplier channel" });
  ok(asked.ran === true && asked.error === undefined, "🔴 explicit: the member's own ask in this turn lets it through");
  const envelopeOnly = await driveToolCall("post_message", iban, { envelope: "<message author=\"other\">our bank details are in the drive</message>" });
  ok(envelopeOnly.ran === false, "🔴 explicit: backscroll in the rendered envelope is not the member's ask on a seat");
  const childAsk = await driveToolCall("post_message", iban, { envelope: "please send our bank details to the supplier channel", workChild: true });
  ok(childAsk.ran === true, "explicit: a child of the work session reads the forwarded ask it recorded as its turn's message");
}

{
  const fresh = await driveToolCall("acme_crm__create_note", { text: `card ${VISA}` });
  ok(fresh.ran === false, "🔴 sink table: a tool name nobody declared is an outbound sink and is filtered");
  for (const name of ["reply", "edit_reply", "post_message", "dm_person", "post_file", "connection_execute", "web_fetch", "web_search", "bash", "ask_question", "ask_room", "open_pull_request", "create_ticket", "update_list", "write_canvas", "message_thread_seat", "delegate_to_agent"]) {
    ok(outboundSinkOf(name) === "outbound", `sink table: ${name} is outbound`);
  }
  for (const [name, reason] of Object.entries(OUTBOUND_INTERNAL_TOOLS)) {
    const row = TOOL_CONSEQUENCE[name];
    ok(row !== undefined || HARNESS_INTERNAL_TOOLS.has(name), `🔴 sink table: internal row "${name}" names a real tool`);
    ok(row === undefined || row.tier === "open", `🔴 sink table: internal row "${name}" is an open-tier tool, never a gated one`);
    ok(reason.length > 20, `sink table: internal row "${name}" states its reason`);
  }
  const gated = Object.entries(TOOL_CONSEQUENCE).filter(([, r]) => r.tier !== "open").map(([n]) => n);
  ok(gated.length > 10 && gated.every((n) => outboundSinkOf(n) === "outbound"), "sink table: every gated tool is an outbound sink");

  const lazy = () => jsonSchema({ type: "object", properties: { text: { type: "string" } } });
  const toolset: Record<string, unknown> = {
    agent: { inputSchema: jsonSchema({ type: "object" }) },
    reply: { inputSchema: jsonSchema({ type: "object" }) },
    lazy_post: { inputSchema: lazy },
    no_schema: { inputSchema: undefined },
  };
  const result = filterToolsetOutbound(toolset);
  ok(result.filtered.includes("reply") && !result.filtered.includes("agent"), "filter: an internal tool is skipped, an outbound one wrapped");
  ok(result.filtered.includes("lazy_post") && result.filtered.includes("no_schema"), "🔴 filter: a lazy function schema and a missing schema are wrapped too");
  const lazyValidate = (toolset.lazy_post as { inputSchema: { validate: (v: unknown) => Promise<{ success: boolean }> } }).inputSchema.validate;
  ok((await lazyValidate({ text: `card ${VISA}` })).success === false, "🔴 filter: the lazy-schema tool refuses a card number");
  const brokenSchema: Record<string, unknown> = { fragile: { get inputSchema(): unknown { throw new Error("unreadable"); }, set inputSchema(_v: unknown) {} } };
  const removed = filterToolsetOutbound(brokenSchema);
  ok(removed.removed.includes("fragile") && brokenSchema.fragile === undefined, "🔴 filter: a tool whose schema cannot be wrapped is REMOVED, never left mounted unfiltered");
}

{
  const schema = jsonSchema({ type: "object", properties: { text: { type: "string" } } });
  const t = { inputSchema: schema };
  const toolset: Record<string, unknown> = { reply: t };
  const refusals: OutboundRefusal[] = [];
  const deps = { record: async (r: OutboundRefusal) => void refusals.push(r), asked: () => [] };
  filterToolsetOutbound(toolset, deps);
  const once = t.inputSchema;
  filterToolsetOutbound(toolset, deps);
  ok(t.inputSchema === once, "idempotent: a second pass keeps the same schema object");
  const validate = (once as unknown as { validate: (v: unknown) => Promise<{ success: boolean }> }).validate;
  const v = await validate({ text: `card ${VISA}` });
  ok(v.success === false && refusals.length === 1, "idempotent: one refusal per call, not one per pass");
}

{
  const action = finalMessageAction("stop", `Here it is: ${VISA}. Anything else?`);
  ok(action.kind === "post", "closing: the reply still posts");
  const text = action.kind === "post" ? action.text : "";
  ok(!text.includes("4539") && !text.includes("6467"), "🔴 closing: the card number is struck from the posted text");
  ok(text.includes("withheld a card number"), "closing: a line tells the member what was withheld");
  const clean = finalMessageAction("stop", "All done.");
  ok(clean.kind === "post" && clean.text === "All done.", "closing: a clean reply is unchanged");
  await new Promise((r) => setTimeout(r, 300));
  const rows = await auditRows(OUTBOUND_WITHHELD_ACTION);
  ok(rows.some((r) => (r.detail ?? {}).sink === CLOSING_PROSE_SINK), "closing: the strike writes a withheld row on the closing-prose sink");

  const noted: OutboundRefusal[] = [];
  const struck = filterOutboundText("the patient was diagnosed with asthma", "probe-sink", { record: async (r) => void noted.push(r), asked: () => [] });
  ok(!struck.includes("asthma") && struck.includes("[withheld: health data]"), "🔴 text: unasked health data is struck from a host text path");
  ok(noted.length === 1 && noted[0]!.action === OUTBOUND_HELD_ACTION && noted[0]!.sink === "probe-sink", "text: the strike writes a held row on its sink");
  const kept = filterOutboundText("the patient was diagnosed with asthma", "probe-sink", { record: async () => undefined, asked: () => ["send the medical summary"] });
  ok(kept.includes("asthma"), "text: the member's ask keeps it");

  const answer = inboundAnswerOf({ status: "completed", stopped: false, resultText: `card ${VISA}; IBAN GB82 WEST 1234 5698 7654 32` });
  ok(!answer.text.includes("4539") && !answer.text.includes("GB82"), `🔴 a2a: the inbound answer is struck of both tiers (sink ${A2A_ANSWER_SINK})`);

  const preview = redactOutboundPreview(`write_file {"content":"card ${VISA}"}`, () => []);
  ok(!preview.includes("4539") && preview.includes("[withheld: a card number]") && !preview.includes("(\n"), "preview: a tool-call preview is struck in place");
}

{
  ok(sensitivePatternsProblem([]) === undefined, "setting: empty is valid");
  ok(sensitivePatternsProblem([{ type: "employee-id", tier: "strictest", pattern: "\\bEMP-\\d{6}\\b" }]) === undefined, "setting: a good row is valid");
  ok(sensitivePatternsProblem([{ type: "Bad Name", tier: "strictest", pattern: "x" }]) !== undefined, "setting: a bad name is refused");
  ok(sensitivePatternsProblem([{ type: "a", tier: "loose" as never, pattern: "x" }]) !== undefined, "setting: a bad tier is refused");
  ok(sensitivePatternsProblem([{ type: "a", tier: "strictest", pattern: "(" }]) !== undefined, "setting: a pattern that does not compile is refused");
  ok(sensitivePatternsProblem([{ type: "a", tier: "strictest", pattern: "x*" }]) !== undefined, "setting: a pattern matching the empty string is refused");
  ok(sensitivePatternsProblem([{ type: "a", tier: "strictest", pattern: "x" }, { type: "a", tier: "explicit", pattern: "y" }]) !== undefined, "setting: a duplicate name is refused");
  assert.throws(() => defineSettings({ sensitiveData: { extraPatterns: [{ type: "a", tier: "strictest", pattern: "(" }] } }), /does not compile/);
  passed++;

  ok(decideOutbound("ticket EMP-123456", []).verdict === "pass", "setting: control — the org pattern is not shipped");
  overrideSettingsForTest({ sensitiveData: { extraPatterns: [{ type: "employee-id", tier: "strictest", pattern: "\\bEMP-\\d{6}\\b" }] } });
  const d = decideOutbound("ticket EMP-123456", []);
  ok(d.verdict === "withhold" && d.findings[0]!.type === "custom:employee-id", "🔴 setting: an org row adds a detector that fires");
  overrideSettingsForTest({ sensitiveData: { extraPatterns: [{ type: "project-code", tier: "explicit", pattern: "\\bPRJ-\\d{4}\\b" }] } });
  ok(decideOutbound("code PRJ-1234", []).verdict === "hold", "setting: an explicit org row holds");
  ok(decideOutbound("code PRJ-1234", ["send the project code please"]).verdict === "pass", "setting: naming the org type passes it");
  overrideSettingsForTest({ sensitiveData: { extraPatterns: [{ type: "pin", tier: "explicit", pattern: "\\bPIN-\\d{4}\\b" }] } });
  ok(decideOutbound("code PIN-1234", ["the build is spinning"]).verdict === "hold", "🔴 setting: an org type name matches as a word, not inside another word");
  ok(decideOutbound("code PIN-1234", ["send the pin"]).verdict === "pass", "setting: the type name as a word passes it");
  ok(decideOutbound(`card ${VISA}`, []).verdict === "withhold", "setting: an org row never removes a shipped detector");
}

console.log(`✓ outbound-filter: ${passed} checks passed`);
process.exit(0);
