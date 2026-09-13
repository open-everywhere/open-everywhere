import assert from "node:assert/strict";
import {
  registerSeatCatchUp,
  seatCatchUp,
  seatCatchUpFetchFor,
  seatAdmissionFor,
  catchUpUnavailableReason,
  _resetSeatCatchUp,
} from "../agent/channels/seat-catch-up.js";
import type { NormalizedMessage } from "../agent/channels/backscroll-window.js";
import { renderWakeEnvelope, type WakeMessageInput } from "../agent/channels/wake-envelope.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

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
  const res = await seatCatchUp("nosuch", { container: "C", sinceMs: T });
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
  const res = await seatCatchUp("fixture", { container: "C1", sinceMs: T, untilMs: T + 5_000, excludeId: "trigger" });
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
  const wide = await seatCatchUp("fixture", { container: "C", sinceMs: T }, { admit: (c) => c.sender !== "bot" });
  ok(wide.messages.length === 1 && wide.messages[0].id === "person", "a refused author never enters the seat's context");
  const withBots = await seatCatchUp("fixture", { container: "C", sinceMs: T }, { admit: () => true });
  ok(withBots.messages.length === 2, "negative control: a policy that admits bots keeps the bot message");

  registerSeatCatchUp("fixture", async () => [
    msg({ id: "loud-bot", ms: T + 1_000, sender: "bot", authorId: "B1", text: "x".repeat(8_000) }),
    msg({ id: "quiet-person", ms: T + 2_000, text: "the one message that matters" }),
  ]);
  const capped = await seatCatchUp("fixture", { container: "C", sinceMs: T }, { admit: (c) => c.sender !== "bot", capTokens: 400 });
  ok(capped.messages.length === 1 && capped.messages[0].id === "quiet-person", "ADMISSION RUNS BEFORE THE CAP — a refused author's bytes never evict an admitted message");
  const cappedWithBot = await seatCatchUp("fixture", { container: "C", sinceMs: T }, { admit: () => true, capTokens: 400 });
  ok(cappedWithBot.messages.length === 1, "negative control: the cap was genuinely binding on this window");
}

{
  registerSeatCatchUp("fixture", async () => {
    throw new Error("vendor down");
  });
  const res = await seatCatchUp("fixture", { container: "C", sinceMs: T });
  ok(res.messages.length === 0, "a throwing fetch reads nothing");
  ok(res.unavailable === undefined, "a transient failure is NOT reported as a structural absence");
}

{
  registerSeatCatchUp("fixture", async () => []);
  const res = await seatCatchUp("fixture", { container: "C", sinceMs: T });
  ok(res.messages.length === 0 && res.unavailable === undefined, "a genuinely quiet room reads empty with no note");
  ok(seatCatchUpFetchFor("fixture") !== undefined, "the registry reports the registered fetch");
  _resetSeatCatchUp("fixture");
  ok(seatCatchUpFetchFor("fixture") === undefined, "the reset drops it again");
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
