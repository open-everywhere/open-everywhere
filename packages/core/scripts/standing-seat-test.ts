
import assert from "node:assert/strict";
import {
  defineDomain,
  windowedSupervisorEnabled,
  standingSeatDomainFor,
  windowedDomainFor,
  windowModeFor,
  ambientSupervisorEnabled,
  admissionNameFor,
  assertDomainsValid,
  assertUnifiedDomainTrust,
  type Domain,
} from "../agent/memory/domain.js";
import { supervisorGrainFor, grainUsesUnifiedWindow, unifiedDomainSessionKey } from "../agent/channels/unified-supervisor.js";
import { admissionFunction, admissionFunctionNames, isAdmissionFunctionName, admitContextLines, DEFAULT_ADMISSION, SEAT_ADMISSION_FUNCTIONS } from "../agent/channels/seat-admission.js";
import { contextLinesNotInEnvelope, type ContextLine } from "../agent/channels/context-render.js";
import type { WakeMessageInput } from "../agent/channels/wake-envelope.js";
import { fetchedBackscroll, seatCatchUpSinceMs, type NormalizedMessage } from "../agent/channels/backscroll-window.js";
import { auditAmbientSkip, resetAmbientSkipSightings } from "../agent/channels/ambient-skip.js";
import { registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
const throws = (fn: () => unknown, needle: string, label: string): void => {
  assert.throws(fn, (err: unknown) => String(err instanceof Error ? err.message : err).includes(needle), label);
  n++;
};

const armed = <T>(fn: () => T): T => {
  registerSettings({ window: { topology: true } });
  try {
    return fn();
  } finally {
    resetSettingsForTest();
  }
};

const ORG = defineDomain({ name: "org", match: "org" });
const TEAM = defineDomain({ name: "payments", reach: ["slack/T1/C-pay"], ambientSupervisor: true });
const ADDRESSED_ONLY = defineDomain({ name: "engaged", reach: ["slack/T1/C-engaged"] });

console.log("1 — a seat in every channel:");
{
  const domains: Domain[] = [ORG, TEAM, ADDRESSED_ONLY];
  armed(() => {
    ok(windowedSupervisorEnabled("slack/T1/C-pay", domains), "an explicit ambient domain seats its channel (unchanged)");
    ok(windowedSupervisorEnabled("slack/T1/C-engaged", domains), "an ADDRESSED-ONLY domain seats its channel too — the flag no longer decides whether a seat exists");
    ok(windowedSupervisorEnabled("slack/T1/C-undeclared", domains), "an UNDECLARED channel seats on the org default");
    ok(!ambientSupervisorEnabled("slack/T1/C-engaged", domains), "…and the addressed-only domain still refuses AMBIENT wakes, which is the flag's whole remaining job");
    ok(!ambientSupervisorEnabled("slack/T1/C-undeclared", domains), "…as does the undeclared channel, inheriting the org default (off)");
  });
  armed(() => {
    ok(!windowedSupervisorEnabled("slack/T1/C-undeclared", [TEAM]), "no org pseudo-domain ⇒ an undeclared channel has NO seat (nothing to inherit — fail closed)");
    eq(standingSeatDomainFor("slack/T1/C-undeclared", [TEAM]), undefined, "…and the seat-domain resolver says so directly");
  });
  ok(!windowedSupervisorEnabled("slack/T1/C-pay", domains), "capability OFF ⇒ no seat anywhere, byte-identical to a pre-feature build");
  eq(windowedDomainFor("slack/T1/C-pay", domains), undefined, "…and the domain resolver agrees with its own gate");
}

console.log("2 — a pseudo-domain seat is its own room's:");
{
  const domains: Domain[] = [ORG, TEAM];
  armed(() => {
    const a = supervisorGrainFor("slack/T1/C-undeclared", domains);
    const b = supervisorGrainFor("slack/T1/C-other", domains);
    ok(grainUsesUnifiedWindow(a) && grainUsesUnifiedWindow(b), "both undeclared channels seat through a window");
    eq(a.windowId, "slack/T1/C-undeclared", "the window id IS the channel's own surface key (solo)");
    ok(a.registryKey !== b.registryKey, "two undeclared channels get DIFFERENT registry rows — no shared context, which is what the footgun rule protected");
    eq(a.singleWindow, undefined, "no cross-surface bit on a pseudo-domain seat");
    eq(windowModeFor("slack/T1/C-undeclared", domains), "solo", "the topology resolves solo, and a pseudo-domain cannot declare otherwise");
    eq(a.registryKey, unifiedDomainSessionKey("slack/T1/C-undeclared"), "the registry key is the window key for that one channel");
  });
  throws(
    () => assertUnifiedDomainTrust([defineDomain({ name: "org", match: "org", mode: "unified", ambientSupervisor: true })]),
    "must not set mode",
    "a pseudo-domain STILL cannot elect a cross-surface window — the refusal that keeps universal seats narrow",
  );
  assertUnifiedDomainTrust([defineDomain({ name: "grouped", reach: ["slack/T1/C1", "slack/T1/C2"], mode: "unified" })]);
  n++;
  console.log("   ✓ a domain may declare a window WITHOUT ambientSupervisor (topology ⊥ chattiness)");
}

console.log("3 — admission by name:");
{
  const domains: Domain[] = [defineDomain({ name: "org", match: "org", admission: "members-only" }), defineDomain({ name: "bots", reach: ["slack/T1/C-bots"], admission: "wide-with-bots" }), TEAM];
  eq(admissionNameFor("slack/T1/C-bots", domains), "wide-with-bots", "an explicit domain's declaration wins for its channels");
  eq(admissionNameFor("slack/T1/C-pay", domains), DEFAULT_ADMISSION, "a domain that declares none takes the default — NOT the org's (the deployer's-word single hop)");
  eq(admissionNameFor("slack/T1/C-undeclared", domains), "members-only", "an undeclared channel inherits the org default");
  eq(admissionNameFor("slack/T1/C-undeclared", [TEAM]), DEFAULT_ADMISSION, "…and falls back to wide when there is no org declaration at all");
  ok(isAdmissionFunctionName("wide") && !isAdmissionFunctionName("widish"), "the registry is the vocabulary");
  throws(
    () => assertDomainsValid([defineDomain({ name: "typo", reach: ["slack/T1/C9"], admission: "wide-ish" })]),
    "not a registered admission function",
    "an unknown policy NAME is refused at config load — a typo must never silently resolve the wider default",
  );

  const human = { sender: "human" as const, trust: "peer" as const, type: "channel" as const };
  const guest = { sender: "human" as const, trust: "unauth" as const, type: "channel" as const };
  const bot = { sender: "bot" as const, trust: "relay" as const, type: "channel" as const };
  const self = { sender: "self" as const, trust: "relay" as const, type: "channel" as const };
  const wide = admissionFunction("wide");
  ok(wide(human) && wide(guest) && wide(self), "wide admits every person and the seat's own posts");
  ok(!wide(bot), "…and refuses a foreign bot");
  const withBots = admissionFunction("wide-with-bots");
  ok(withBots(bot) && withBots(human), "wide-with-bots admits an attributable bot at the relay tier");
  ok(!withBots({ ...bot, trust: "peer" }), "…and ONLY at that tier — the trust tier is the floor the ruling names");
  const members = admissionFunction("members-only");
  ok(members(human) && !members(guest) && !members(bot), "members-only admits vouched people alone");
  ok(members(self), "…and the deployment's own machine authors, which are not a trust question");
  const fallback = admissionFunction("no-such-policy");
  ok(!fallback(bot) && fallback(guest), "an unregistered name resolves WIDE at runtime — not wide-with-bots (it would admit the bot), not members-only (it would refuse the guest)");
  ok(admissionFunctionNames().includes(DEFAULT_ADMISSION), "the default is itself a registered name");
  eq(SEAT_ADMISSION_FUNCTIONS.size, admissionFunctionNames().length, "the registry and its name list are one thing");
}

console.log("4 — the since-last-wake catch-up:");
{
  const now = Date.parse("2026-09-12T12:00:00.000Z");
  eq(seatCatchUpSinceMs("2026-09-11T11:30:00.000Z", now, 24), Date.parse("2026-09-11T11:30:00.000Z"), "the seat's own last wake is the bound");
  eq(seatCatchUpSinceMs("2026-04-04T23:30:00.000Z", now, 24), now - 24 * 3600_000, "a seat quiet for weeks is FLOORED — it reads the recent tail, not a month");
  eq(seatCatchUpSinceMs(null, now, 24), now - 24 * 3600_000, "no recorded wake ⇒ the bootstrap window, which is what a first wake always read");
  eq(seatCatchUpSinceMs("not-a-date", now, 24), now - 24 * 3600_000, "an unparseable stamp degrades the same way rather than reading nothing");

  const msg = (id: string, sender: NormalizedMessage["sender"], text: string): NormalizedMessage => ({ id, ms: Number(id), sender, type: "channel", text });
  const window: NormalizedMessage[] = [msg("1", "human", "first"), msg("2", "bot", "noise from a bot"), msg("3", "human", "second")];
  const trustFor = (m: NormalizedMessage) => (m.sender === "human" ? ("peer" as const) : ("relay" as const));
  const widened = fetchedBackscroll(window, 10_000, trustFor, admissionFunction("wide"));
  eq(widened.map((m) => m.id), ["1", "3"], "the wide policy keeps the people and drops the foreign bot");
  const withBots = fetchedBackscroll(window, 10_000, trustFor, admissionFunction("wide-with-bots"));
  eq(withBots.map((m) => m.id), ["1", "2", "3"], "…and the bot-admitting policy keeps all three, in room order");
  eq(fetchedBackscroll(window, 10_000, trustFor).map((m) => m.id), ["1", "2", "3"], "no policy passed ⇒ nothing is filtered (the pre-feature shape)");

  const oneMessageCap = 160;
  const capped = fetchedBackscroll([msg("1", "human", "the person's message"), msg("2", "bot", "the bot's message")], oneMessageCap, trustFor, admissionFunction("wide"));
  eq(capped.map((m) => m.id), ["1"], "the cap keeps the PERSON's message — the refused bot never competed for the budget");
  eq(capped[0]?.trust, "peer", "the tier the policy judged is the tier that renders — resolved once");
}

console.log("5 — the ambient_skipped fix text:");
{
  resetAmbientSkipSightings();
  const logged: string[] = [];
  const reason = await auditAmbientSkip({
    platform: "slack",
    workspace: "T1",
    surfaceKey: "slack/T1/C-engaged",
    log: (m: string) => logged.push(m),
    domains: [ADDRESSED_ONLY],
  });
  eq(reason, "domain-refused", "an addressed-only domain records the domain-refused reason (unchanged)");
  const line = logged[0] ?? "";
  ok(line.includes("ADDRESSED-ONLY by declaration"), "the row names the DECLARATION — the absence is the fixture, not a gap");
  ok(!line.includes("set ambientSupervisor: true on it"), "🔴 it no longer prescribes the change the ruling refused on such a domain");
  ok(line.includes("MAY opt in"), "the setting is named as an opt-in a domain OWNER may choose");
  ok(line.includes("decision, not a gap"), "…and the reader is told which of the two they are looking at");
}

console.log("6 — admitContextLines (the hydrated context slot):");
{
  const cl = (senderType: ContextLine["senderType"], senderId: string | undefined, trust: ContextLine["trust"], text: string): ContextLine => ({
    senderType,
    senderId,
    ts: text,
    text,
    ...(trust !== undefined ? { trust } : {}),
  });
  const room: readonly ContextLine[] = [
    cl("user", "U_MEMBER", "peer", "a colleague"),
    cl("user", "U_ADMIN", "principal", "an admin"),
    cl("user", "U_GUEST", "unauth", "a guest"),
    cl("agent", undefined, undefined, "the agent's own prior post"),
    cl("bot", "B1", undefined, "a foreign bot"),
    cl("unknown", undefined, undefined, "an unattributable author"),
  ];

  const membersOnly = admitContextLines(room, admissionFunction("members-only"), "channel");
  eq(
    membersOnly.map((l) => l.text),
    ["a colleague", "an admin", "the agent's own prior post"],
    "🔴 members-only admits the VOUCHED people and the deployment's own post, in room order",
  );
  ok(!membersOnly.some((l) => l.text === "a guest"), "🔴 …and refuses the non-member's line — the OPE-1742 leak, closed at the seam");
  ok(
    !membersOnly.some((l) => l.text === "an unattributable author"),
    "🔴 …and refuses an UNATTRIBUTABLE author: `unknown` maps to a human at `unauth`, never to a harness `system` line",
  );

  const wide = admitContextLines(room, admissionFunction("wide"), "channel");
  eq(
    wide.map((l) => l.text),
    ["a colleague", "an admin", "a guest", "the agent's own prior post", "an unattributable author"],
    "negative control: `wide` admits every person at any tier, the agent's own post included",
  );
  ok(!wide.some((l) => l.text === "a foreign bot"), "🔴 `wide` refuses the FOREIGN BOT on this slot too — the shipped-default half of the gap");
  ok(
    admitContextLines(room, admissionFunction("wide-with-bots"), "channel").some((l) => l.text === "a foreign bot"),
    "🔴 negative control: `wide-with-bots` admits the UNGRADED foreign bot — a machine author floors at `relay`, not `unauth`",
  );

  const ungraded: readonly ContextLine[] = [cl("user", "U_MEMBER", undefined, "ungraded, but a real member")];
  eq(admitContextLines(ungraded, admissionFunction("members-only"), "channel").length, 0, "🔴 an UNGRADED line floors at `unauth`, so members-only refuses it");
  eq(admitContextLines(ungraded, admissionFunction("wide"), "channel").length, 1, "…while `wide`, which does not read the tier, still admits it");
  eq(admitContextLines([], admissionFunction("members-only"), "thread").length, 0, "an empty slice admits nothing and throws nothing");
}

console.log("7 — contextLinesNotInEnvelope (catch-up ∩ hydration):");
{
  const line = (ts: string, text: string): ContextLine => ({ senderType: "user", senderId: "U1", ts, text });
  const sibling = (id: string, body: string): WakeMessageInput => ({ from: "human", author: "U1", id, sentAt: "2026-09-12T10:00:00.000Z", trust: "peer", body });
  const hydration: readonly ContextLine[] = [line("10", "older than the catch-up"), line("20", "inside both"), line("30", "also inside both")];
  const envelope: readonly WakeMessageInput[] = [sibling("20", "inside both"), sibling("30", "also inside both")];

  eq(
    contextLinesNotInEnvelope(hydration, envelope).map((l) => l.ts),
    ["10"],
    "🔴 the hydration keeps ONLY the message the envelope never read — each ts renders once",
  );
  eq(
    contextLinesNotInEnvelope(hydration, [sibling("99", "a different message")]).map((l) => l.ts),
    ["10", "20", "30"],
    "negative control: an envelope with NO overlap drops nothing",
  );
  eq(contextLinesNotInEnvelope(hydration, []).map((l) => l.ts), ["10", "20", "30"], "an empty envelope drops nothing (a first wake with no read)");
  eq(contextLinesNotInEnvelope([], envelope).length, 0, "an empty hydration stays empty");
  eq(
    contextLinesNotInEnvelope(hydration, envelope)[0]?.text,
    "older than the catch-up",
    "the kept line is returned whole — the filter never rewrites a line it keeps",
  );

  const refutedLine: ContextLine = { senderType: "user", senderId: "U_GUEST", ts: "20", text: "a refuted guest's words", trust: "unauth", refuted: true };
  const plainLine: ContextLine = { senderType: "user", senderId: "U_GUEST", ts: "20", text: "a refuted guest's words", trust: "unauth" };
  eq(
    contextLinesNotInEnvelope([refutedLine], envelope).map((l) => l.ts),
    ["20"],
    "🔴 a REFUTED author's line survives the de-duplication even though the envelope carries that exact message",
  );
  eq(
    contextLinesNotInEnvelope([plainLine], envelope).length,
    0,
    "negative control: the same line WITHOUT `refuted` is de-duplicated — the exemption is the flag deciding, not the filter giving up",
  );
  eq(
    contextLinesNotInEnvelope([refutedLine, line("30", "also inside both"), line("10", "older than the catch-up")], envelope).map((l) => l.ts),
    ["20", "10"],
    "🔴 the exemption is per line: the refuted line and the older line stay, the overlapping member line goes",
  );
}

console.log(`\nstanding-seat: ${n} assertions passed`);
