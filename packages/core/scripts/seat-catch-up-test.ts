
import assert from "node:assert/strict";
import {
  registerSeatCatchUp,
  seatCatchUp,
  seatCatchUpFetchFor,
  seatAdmissionFor,
  catchUpUnavailableReason,
  _resetSeatCatchUp,
  SEAT_CATCH_UP_ACTION,
  seatCatchUpScopeFromChannelKey,
  seatCatchUpBounds,
  seatCatchUpPrecisionFor,
  DEFAULT_TIMESTAMP_PRECISION_MS,
} from "../agent/channels/seat-catch-up.js";
import type { AuditInput } from "../agent/audit/audit.js";
import type { NormalizedMessage } from "../agent/channels/backscroll-window.js";
import { renderWakeEnvelope, type WakeMessageInput } from "../agent/channels/wake-envelope.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const quiet = async (): Promise<void> => {};

const T = Date.parse("2026-09-12T12:00:00.000Z");
const msg = (over: Partial<NormalizedMessage> & { id: string; ms: number }): NormalizedMessage => ({
  authorId: "U1",
  sender: "human",
  type: "channel",
  text: "hello",
  ...over,
});

{
  _resetSeatCatchUp("nosuch");
  const res = await seatCatchUp("nosuch", { container: "C", sinceMs: T }, { audit: quiet });
  ok(res.messages.length === 0, "an unregistered platform reads nothing");
  ok(res.unavailable === catchUpUnavailableReason("nosuch"), "an unregistered platform reports the UNAVAILABLE reason verbatim");
  ok(res.unavailable!.includes("nosuch"), "the reason names the platform");
  ok(
    /does not mean the room was quiet/u.test(res.unavailable!),
    "the reason states the bound a seat would otherwise get wrong (an empty context is not a quiet room)",
  );
}

{
  const seen: Array<{ container: string; sinceMs: number }> = [];
  registerSeatCatchUp("fixture", async (req) => {
    seen.push({ container: req.container, sinceMs: req.sinceMs });
    return [
      msg({ id: "too-old", ms: T - 60_000, text: "before the seat last looked" }),
      msg({ id: "inside", ms: T + 1_000, text: "said while the seat was away" }),
      msg({ id: "trigger", ms: T + 5_000, text: "the message that woke it" }),
      msg({ id: "too-new", ms: T + 9_000, text: "after the trigger" }),
    ];
  });
  const res = await seatCatchUp("fixture", { container: "C1", sinceMs: T, untilMs: T + 5_000, excludeId: "trigger" }, { audit: quiet });
  ok(seen.length === 1 && seen[0].container === "C1" && seen[0].sinceMs === T, "the request reaches the registered fetch unchanged");
  ok(res.unavailable === undefined, "a registered fetch never reports unavailable");
  ok(res.messages.length === 1, "the window keeps exactly the one message inside the bounds");
  ok(res.messages[0].id === "inside", "the surviving message is the one said between the seat's own wakes");
  ok(res.messages[0].body === "said while the seat was away", "the body rides through to the wake message");
  ok(res.messages[0].trigger === undefined, "a catch-up message is never a trigger");
}

{
  registerSeatCatchUp("fixture", async () => [
    msg({ id: "bot", ms: T + 1_000, sender: "bot", authorId: "B1", text: "machine chatter" }),
    msg({ id: "person", ms: T + 2_000, text: "a person's message" }),
  ]);
  const wide = await seatCatchUp("fixture", { container: "C", sinceMs: T }, { audit: quiet, admit: (c) => c.sender !== "bot" });
  ok(wide.messages.length === 1 && wide.messages[0].id === "person", "a refused author never enters the seat's context");
  const withBots = await seatCatchUp("fixture", { container: "C", sinceMs: T }, { audit: quiet, admit: () => true });
  ok(withBots.messages.length === 2, "negative control: a policy that admits bots keeps the bot message");

  registerSeatCatchUp("fixture", async () => [
    msg({ id: "loud-bot", ms: T + 1_000, sender: "bot", authorId: "B1", text: "x".repeat(8_000) }),
    msg({ id: "quiet-person", ms: T + 2_000, text: "the one message that matters" }),
  ]);
  const capped = await seatCatchUp("fixture", { container: "C", sinceMs: T }, { audit: quiet, admit: (c) => c.sender !== "bot", capTokens: 400 });
  ok(capped.messages.length === 1 && capped.messages[0].id === "quiet-person", "ADMISSION RUNS BEFORE THE CAP — a refused author's bytes never evict an admitted message");
  const cappedWithBot = await seatCatchUp("fixture", { container: "C", sinceMs: T }, { audit: quiet, admit: () => true, capTokens: 400 });
  ok(cappedWithBot.messages.length === 1, "negative control: the cap was genuinely binding on this window");
}

{
  registerSeatCatchUp("fixture", async () => {
    throw new Error("vendor down");
  });
  const res = await seatCatchUp("fixture", { container: "C", sinceMs: T }, { audit: quiet });
  ok(res.messages.length === 0, "a throwing fetch reads nothing");
  ok(res.unavailable === undefined, "a transient failure is NOT reported as a structural absence");
}

{
  registerSeatCatchUp("fixture", async () => []);
  const res = await seatCatchUp("fixture", { container: "C", sinceMs: T }, { audit: quiet });
  ok(res.messages.length === 0 && res.unavailable === undefined, "a genuinely quiet room reads empty with no note");
  ok(seatCatchUpFetchFor("fixture") !== undefined, "the registry reports the registered fetch");
  _resetSeatCatchUp("fixture");
  ok(seatCatchUpFetchFor("fixture") === undefined, "the reset drops it again");
}

{
  const rows: AuditInput[] = [];
  const audit = async (e: AuditInput) => {
    rows.push(e);
  };
  const KEY = "fixture/WS-1/room-1";
  const detail = (i: number) => rows[i]!.detail!;

  rows.length = 0;
  _resetSeatCatchUp("fixture");
  await seatCatchUp("fixture", { container: "C1", sinceMs: T, channelKey: KEY }, { audit });
  ok(rows.length === 1 && rows[0]!.action === SEAT_CATCH_UP_ACTION, "OPE-1831: an unregistered platform still writes exactly ONE row — the outcome an empty list hid best");
  ok(detail(0)["outcome"] === "unavailable" && detail(0)["reason"] === "no-registered-fetch", "🔴 OPE-1831: …and it reads `unavailable`, with the reason, not `empty`");
  ok(rows[0]!.platform === "fixture" && rows[0]!.workspace === "WS-1" && rows[0]!.surface === "room-1", "OPE-1831: the row is filed under the seat's own platform, workspace and surface, split from the domain-grain key");
  ok(detail(0)["container"] === "C1" && detail(0)["since"] === new Date(T).toISOString(), "OPE-1831: the row names the container it was asked to read and the window's lower bound");

  rows.length = 0;
  registerSeatCatchUp("fixture", async () => {
    throw new Error("read: vendor GET failed (HTTP 404) for https://api.example/x — {\"error\":\"NotFound\"}");
  });
  const failed = await seatCatchUp("fixture", { container: "C1", sinceMs: T, channelKey: KEY }, { audit });
  ok(failed.messages.length === 0 && failed.unavailable === undefined, "OPE-1831: a throwing fetch is still fail-soft to empty and still not unavailable");
  ok(rows.length === 1 && detail(0)["outcome"] === "failed" && detail(0)["reason"] === "fetch-threw", "🔴 OPE-1831: a fetch that THROWS writes a `failed` row — the assertion the ticket names, and the one that separates a broken read from a quiet room");
  ok(detail(0)["httpStatus"] === 404 && detail(0)["errorName"] === "Error", "OPE-1831: the row carries the error CLASS and the HTTP status the thrown message named");
  ok(!JSON.stringify(rows[0]).includes("NotFound"), "🔴 OPE-1831: NEGATIVE CONTROL — the vendor's response body never reaches the row, only the three status digits");

  rows.length = 0;
  registerSeatCatchUp("fixture", async () => [
    msg({ id: "a", ms: T + 1_000, text: "said while away" }),
    msg({ id: "too-old", ms: T - 90_000, text: "before the seat last looked" }),
  ]);
  const read = await seatCatchUp("fixture", { container: "C1", threadRoot: "TH", sinceMs: T, channelKey: KEY }, { audit });
  ok(read.messages.length === 1, "OPE-1831 PRECONDITION: the drive really did keep one of the two messages");
  ok(rows.length === 1 && detail(0)["outcome"] === "read", "OPE-1831: a read that reaches the seat records `read`");
  ok(detail(0)["raw"] === 2 && detail(0)["kept"] === 1, "🔴 OPE-1831: raw 2 / kept 1 — the row separates what the SURFACE returned from what this core kept, which is the whole diagnosis on a red ship");
  ok(detail(0)["threadRoot"] === "TH" && detail(0)["reason"] === undefined, "OPE-1831: the row names the conversation, and carries NO reason when the outcome is `read`");
  ok(!JSON.stringify(rows[0]).includes("said while away"), "🔴 OPE-1831: NEGATIVE CONTROL — no message body reaches the row");

  rows.length = 0;
  registerSeatCatchUp("fixture", async () => []);
  await seatCatchUp("fixture", { container: "C1", sinceMs: T, channelKey: KEY }, { audit });
  ok(rows.length === 1 && detail(0)["outcome"] === "empty" && detail(0)["reason"] === "fetch-returned-none" && detail(0)["raw"] === 0, "OPE-1831: the SURFACE returning nothing records `empty` with raw 0 — the genuinely quiet room");

  rows.length = 0;
  registerSeatCatchUp("fixture", async () => [msg({ id: "old", ms: T - 90_000 })]);
  await seatCatchUp("fixture", { container: "C1", sinceMs: T, channelKey: KEY }, { audit });
  ok(rows.length === 1 && detail(0)["reason"] === "bounds-dropped-all" && detail(0)["raw"] === 1 && detail(0)["kept"] === 0, "🔴 OPE-1831: raw 1 / kept 0 with `bounds-dropped-all` — the surface DID answer and OUR window dropped it, which reads nothing like the row above");

  rows.length = 0;
  registerSeatCatchUp("fixture", async () => [msg({ id: "b", ms: T + 1_000, sender: "bot", authorId: "B1" })]);
  await seatCatchUp("fixture", { container: "C1", sinceMs: T, channelKey: KEY }, { audit, admit: () => false });
  ok(rows.length === 1 && detail(0)["reason"] === "admission-dropped-all" && detail(0)["raw"] === 1, "🔴 OPE-1831: …and a window the DOMAIN'S ADMISSION POLICY emptied is a third reason again — the one a surface owner would otherwise read as a broken fetch");

  registerSeatCatchUp("fixture", async () => [msg({ id: "a", ms: T + 1_000 })]);
  const survived = await seatCatchUp("fixture", { container: "C1", sinceMs: T, channelKey: KEY }, {
    audit: async () => {
      throw new Error("store down");
    },
  });
  ok(survived.messages.length === 1, "🔴 OPE-1831: a THROWING audit writer still returns the seat's messages — the row must never be able to break the read it records");

  ok(seatCatchUpScopeFromChannelKey("fixture", KEY)?.workspace === "WS-1", "OPE-1831: the domain-grain key splits into the row's workspace and surface");
  ok(seatCatchUpScopeFromChannelKey("fixture", "slack/W/C") === undefined, "🔴 OPE-1831: ANOTHER platform's key yields NO scope — a row never borrows a foreign surface, it says `unknown`");
  ok(seatCatchUpScopeFromChannelKey("fixture", undefined) === undefined && seatCatchUpScopeFromChannelKey("fixture", "fixture/W") === undefined, "OPE-1831: an absent or half key yields no scope either");
  rows.length = 0;
  registerSeatCatchUp("fixture", async () => []);
  await seatCatchUp("fixture", { container: "C1", sinceMs: T }, { audit });
  ok(rows[0]!.workspace === "unknown" && rows[0]!.surface === undefined, "🔴 OPE-1831: a call with NO channel key files the row under `unknown` — a stated gap, never a filled-in blank");

  _resetSeatCatchUp("fixture");
}

{
  const MINUTE = 60_000;
  const floorMinute = (ms: number): number => Math.floor(ms / MINUTE) * MINUTE;
  const LAST_WAKE = Date.parse("2026-04-19T23:45:40.250Z");
  const TRIGGER_STAMP = floorMinute(Date.parse("2026-04-19T23:47:31.400Z"));
  const at = (iso: string): number => floorMinute(Date.parse(iso));

  const seen: Array<{ sinceMs: number; untilMs: number | undefined }> = [];
  const window = [
    msg({ id: "way-old", ms: at("2026-04-19T23:43:12.000Z"), text: "the previous wake already read this" }),
    msg({ id: "same-minute-as-last-wake", ms: at("2026-04-19T23:45:58.000Z"), text: "said just after the seat looked away" }),
    msg({ id: "trigger-minute", ms: at("2026-04-19T23:47:10.000Z"), text: "the build token you are being asked about" }),
    msg({ id: "trig", ms: TRIGGER_STAMP, text: "which build token was posted while you were away?" }),
    msg({ id: "after", ms: at("2026-04-19T23:48:04.000Z"), text: "posted after the wake was dispatched" }),
  ];
  const req = { container: "PAGE-1", sinceMs: LAST_WAKE, untilMs: TRIGGER_STAMP, excludeId: "trig", channelKey: "coarse/WS-1/page-1" };
  const drive = async (declaredMs: number | undefined): Promise<{ ids: readonly string[]; rows: AuditInput[] }> => {
    const rows: AuditInput[] = [];
    seen.length = 0;
    _resetSeatCatchUp("coarse");
    registerSeatCatchUp(
      "coarse",
      async (r) => {
        seen.push({ sinceMs: r.sinceMs, untilMs: r.untilMs });
        return window.filter((m) => m.ms >= r.sinceMs);
      },
      declaredMs === undefined ? {} : { timestampPrecisionMs: declaredMs },
    );
    const res = await seatCatchUp("coarse", req, { audit: async (e) => void rows.push(e), admit: () => true });
    return { ids: res.messages.map((m) => m.id), rows };
  };

  const wide = await drive(MINUTE);
  ok(seen.length === 1 && seen[0].sinceMs === floorMinute(LAST_WAKE), "🔴 OPE-1847: the FETCH receives the lower bound already widened to the start of its own stamp unit — the surface and this core ask the same question");
  ok(seen[0].untilMs === TRIGGER_STAMP + MINUTE, "🔴 OPE-1847: …and the upper bound already widened to the END of the trigger's unit, so a message sharing the trigger's instant is inside the window the surface is asked for");
  ok(wide.ids.includes("trigger-minute"), "🔴 OPE-1847: a message stamped at the TRIGGER'S OWN instant is KEPT — the live-run defect, and the whole reason a seat on a coarse surface reads anything at all");
  ok(wide.ids.includes("same-minute-as-last-wake"), "🔴 OPE-1847: a message whose floored stamp lands before the seat's unfloored `lastWakeAt` is KEPT — the lower bound is widened too, not only the upper one");
  ok(!wide.ids.includes("trig"), "🔴 OPE-1847: the wake's OWN message leaves by ID — `excludeId` is the only thing that can remove it, because it shares its instant with the messages the seat is reading for");
  ok(!wide.ids.includes("after"), "OPE-1847: a message in the NEXT unit is still newer than the wake and is still dropped — the widening is exactly one unit, never an open upper bound");
  ok(!wide.ids.includes("way-old"), "OPE-1847: a message a whole unit before the last wake is still dropped — the widening is exactly one unit at the bottom too");
  ok(wide.rows.length === 1 && wide.rows[0]!.detail!["outcome"] === "read" && wide.rows[0]!.detail!["kept"] === 2, "OPE-1847: the row reads `read` with the two kept messages counted");
  ok(wide.rows[0]!.detail!["precisionMs"] === MINUTE && wide.rows[0]!.detail!["since"] === new Date(floorMinute(LAST_WAKE)).toISOString(), "🔴 OPE-1847: the row carries the unit it applied and the bound AS APPLIED — the next red ship reads both off the row instead of inferring them from a provider module");

  const narrow = await drive(undefined);
  ok(!narrow.ids.includes("same-minute-as-last-wake"), "🔴 OPE-1847 NEGATIVE CONTROL: with the declaration REMOVED, the message whose floored stamp falls inside the last wake's own unit is LOST — the lower bound is widened by the declaration and by nothing else");
  ok(narrow.ids.length === 1 && narrow.ids[0] === "trigger-minute", "OPE-1847 NEGATIVE CONTROL: the undeclared window keeps ONE of the two messages the declared one keeps");
  ok(narrow.rows[0]!.detail!["raw"] === 3 && narrow.rows[0]!.detail!["precisionMs"] === DEFAULT_TIMESTAMP_PRECISION_MS, "OPE-1847 NEGATIVE CONTROL: the raw count falls too — the un-widened bound reached the SURFACE, and the row names the default unit it fell back to");

  {
    const rows: AuditInput[] = [];
    _resetSeatCatchUp("coarse");
    registerSeatCatchUp("coarse", async (r) => window.filter((m) => m.ms >= r.sinceMs), { timestampPrecisionMs: MINUTE });
    await seatCatchUp("coarse", req, { audit: async (e) => void rows.push(e), admit: () => false });
    ok(rows[0]!.detail!["reason"] === "admission-dropped-all", "🔴 OPE-1847: a window the BOUNDS kept and the ADMISSION POLICY emptied reads `admission-dropped-all` — `bounds-dropped-all` never covers for the policy");
    ok(rows[0]!.detail!["raw"] === 4 && rows[0]!.detail!["kept"] === 0, "OPE-1847: …with the same raw count, so the two reasons are told apart by name and not by the numbers");
  }

  ok(seatCatchUpPrecisionFor("coarse") === MINUTE, "OPE-1847: the registry reports the unit the surface declared");
  _resetSeatCatchUp("coarse");
  ok(seatCatchUpPrecisionFor("coarse") === DEFAULT_TIMESTAMP_PRECISION_MS, "OPE-1847: a platform that is not on the road reports the default unit, never `undefined` — the arithmetic always has a number");
  registerSeatCatchUp("coarse", async () => [], { timestampPrecisionMs: 0.5 });
  ok(seatCatchUpPrecisionFor("coarse") === DEFAULT_TIMESTAMP_PRECISION_MS, "🔴 OPE-1847: a declaration that is not a whole number of milliseconds ≥ 1 falls back to the default rather than throwing — a bundle registration must never cost a deployment its surface");
  _resetSeatCatchUp("coarse");

  ok(seatCatchUpBounds(90_000, 150_000, MINUTE).sinceMs === 60_000, "OPE-1847: the lower bound floors to the start of its unit");
  ok(seatCatchUpBounds(90_000, 150_000, MINUTE).untilMs === 180_000, "OPE-1847: the upper bound rises to the end of the unit the trigger sits in");
  ok(seatCatchUpBounds(90_000, 150_000, 1).sinceMs === 90_000 && seatCatchUpBounds(90_000, 150_000, 1).untilMs === 150_001, "OPE-1847: at millisecond grain the widening is one millisecond — the trigger's own instant stays inside, and its id is what removes it");
  ok(seatCatchUpBounds(-90_000, undefined, MINUTE).sinceMs === -120_000, "🔴 OPE-1847: a PRE-EPOCH bound floors DOWNWARD — `Math.floor`, never `t - (t % unit)`, which keeps the sign of the dividend and would raise the bound toward a newer instant");
  ok(seatCatchUpBounds(90_000, undefined, MINUTE).untilMs === undefined, "OPE-1847: an absent upper bound stays absent — an unbounded window is not widened into a bounded one");
  ok(Number.isNaN(seatCatchUpBounds(Number.NaN, undefined, MINUTE).sinceMs), "OPE-1847: a non-finite bound passes through unchanged — widening it would invent a number, and the row says `unparsable` instead");
}

{
  const trigger: WakeMessageInput = {
    from: "human",
    author: "Ada",
    id: "1",
    sentAt: "2026-04-19T23:40:05.000Z",
    trust: "peer",
    body: "hi",
    trigger: true,
  };
  const base = { reason: "channel-activity" as const, currentTime: "2026-04-19T23:40:06.000Z", channel: { id: "C" }, messages: [trigger] };
  const without = renderWakeEnvelope(base);
  ok(!without.includes("<system-note>"), "no note is rendered when the surface can catch up");
  const withNote = renderWakeEnvelope({ ...base, catchUpUnavailable: catchUpUnavailableReason("teams") });
  ok(withNote.includes("<system-note>"), "the note renders as a trusted top-level child");
  ok(withNote.includes("teams:"), "the note names the surface");
  ok(withNote.indexOf("<system-note>") > withNote.indexOf("</channel>"), "the note sits OUTSIDE the channel block, where instructions live");
  const escaped = renderWakeEnvelope({ ...base, catchUpUnavailable: `x <b>&"` });
  ok(escaped.includes("x &lt;b&gt;&amp;&quot;"), "the note is XML-escaped — a surface label can never forge structure");
  ok(!escaped.includes("<b>"), "the raw markup never survives the escape");
}

{
  const { withE2eDriverAdmission, E2E_DRIVER_DOMAINS } = await import("../agent/channels/seat-catch-up.js");
  const { admissionFunction } = await import("../agent/channels/seat-admission.js");
  const { registerSettings, resetSettingsForTest, defineSettings } = await import("../agent/settings/settings.js");

  const DRIVER = "1300000001500000042";
  const OTHER_BOT = "1300000001500000099";
  const wide = admissionFunction("wide");
  const bot = (authorId?: string) => ({ sender: "bot" as const, trust: "relay" as const, type: "channel" as const, ...(authorId ? { authorId } : {}) });
  const person = { sender: "human" as const, trust: "peer" as const, type: "channel" as const, authorId: "U1" };

  ok(!wide(bot(DRIVER)), "🔴 the fixture domain's own `wide` policy REFUSES the driver — this is the drop that made the two catch-up legs undrivable");

  resetSettingsForTest();
  registerSettings(defineSettings({ wake: { e2eDrivers: [{ surface: "discord", principal: DRIVER }] } }));

  const admit = withE2eDriverAdmission(wide, "e2e-engaged", "discord");
  ok(admit(bot(DRIVER)), "🔴 the NAMED driver enters the seat's context on the fixture domain — the whole point: the pack can now prove the since-last-wake read on this surface");
  ok(!admit(bot(OTHER_BOT)), "🔴 a DIFFERENT bot on the SAME domain and surface is still REFUSED — the lever names identities, not 'bots in the fixture room'");
  ok(!admit(bot()), "an UNATTRIBUTABLE bot is refused — a message the surface could not pin to an author can never be the driver's");
  ok(admit(person), "a person still enters, exactly as `wide` admits them — the wrapper only ever widens");

  ok(!withE2eDriverAdmission(wide, "e2e-engaged", "notion")(bot(DRIVER)), "🔴 the same principal is refused on ANOTHER surface — the entry's `surface` is matched, not decoration");

  ok(!withE2eDriverAdmission(wide, "e2e-unified", "discord")(bot(DRIVER)), "🔴 the same driver is refused in a NON-fixture domain — the carve-out is scoped to the e2e fixtures, so a real room gains nothing");
  ok(!withE2eDriverAdmission(wide, undefined, "discord")(bot(DRIVER)), "…and refused in a room that resolves to no explicit domain at all");
  ok(E2E_DRIVER_DOMAINS.has("e2e-engaged"), "the carve-out's domain roster is the e2e fixture the engaged journeys drive");
  ok(!E2E_DRIVER_DOMAINS.has("org") && !E2E_DRIVER_DOMAINS.has("dm") && !E2E_DRIVER_DOMAINS.has("public"), "🔴 …and NO criteria pseudo-domain. `domainForChannel` resolves EXPLICIT domains alone, so `org`/`dm`/`public` here would each be a line that reads as a vouch and admits nobody");

  resetSettingsForTest();
  ok(withE2eDriverAdmission(wide, "e2e-engaged", "discord") === wide, "🔴 an unconfigured deployment gets the base policy ITSELF back — the shipped posture is byte-identical, not merely equivalent");

  const FIXTURE_ROOM = "discord/G1/C-engaged";
  const REAL_ROOM = "discord/G1/C-real";
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const DOMAINS = [
    defineDomain({ name: "e2e-engaged", reach: [FIXTURE_ROOM] }),
    defineDomain({ name: "e2e-unified", reach: [REAL_ROOM] }),
  ];
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => DOMAINS,
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
  registerSettings(defineSettings({ wake: { e2eDrivers: [{ surface: "discord", principal: DRIVER }] } }));
  ok(seatAdmissionFor(FIXTURE_ROOM)(bot(DRIVER)), "🔴 `seatAdmissionFor` REACHES the carve-out for a fixture room — the catch-up read is the caller, and this is the assertion that fails if the wrapper is never wired in");
  ok(!seatAdmissionFor(REAL_ROOM)(bot(DRIVER)), "🔴 …and does NOT reach it for a room in another domain — the negative control that keeps the line above from passing on a deployment-wide widening");
  resetSettingsForTest();
}

console.log(`seat-catch-up: ${n} assertions passed`);
