
import {
  SEAT_PROMPT_SLOTS,
  composeSeatPrompt,
  editReplyParagraph,
  postingIsAnActionParagraph,
  renderDeliverySection,
  renderHandle,
  renderSeatPersona,
  renderSurface,
  renderUnifiedSurfaceGuides,
  renderUnifiedSurfaces,
  surfaceDisplayName,
  type SeatPromptParts,
  type SeatPromptSlot,
} from "../agent/instructions/seat-prompt.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { registerCapabilityManifest } from "../agent/identity/capabilities.js";
import { renderScopeMarkdown } from "../agent/instructions/access.js";
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { formatWindowToken } from "../agent/channels/window-key.js";
import type { BindableContext } from "../agent/identity/binding.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

{
  ok(new Set(SEAT_PROMPT_SLOTS).size === SEAT_PROMPT_SLOTS.length, "the slot list has no duplicate names");

  const EXPECTED_ORDER = [
    "identity",
    "handle",
    "surface",
    "surfaceGuide",
    "persona",
    "readingAWake",
    "replyStyle",
    "role",
    "access",
    "approvalPreview",
    "workerCapabilities",
    "recoveryRead",
    "memoryIndex",
    "channelScope",
    "noiseDoctrine",
  ];
  ok(JSON.stringify([...SEAT_PROMPT_SLOTS]) === JSON.stringify(EXPECTED_ORDER), "🔴 SEAT_PROMPT_SLOTS is exactly the pinned order — a reorder must be deliberate");

  const named = Object.fromEntries(SEAT_PROMPT_SLOTS.map((s) => [s, s])) as SeatPromptParts;
  ok(composeSeatPrompt(named) === EXPECTED_ORDER.join("\n\n"), "🔴 composeSeatPrompt joins the filled slots in that order, separated by one blank line");

  const withHole: SeatPromptParts = { ...named, replyStyle: "" };
  const expected = SEAT_PROMPT_SLOTS.filter((s) => s !== "replyStyle").join("\n\n");
  ok(composeSeatPrompt(withHole) === expected, "an empty slot drops out and leaves no extra blank line");
  ok(!composeSeatPrompt(withHole).includes("\n\n\n"), "negative control: dropping a slot never produces a double blank line");

  for (const missing of ["persona", "readingAWake", "channelScope"] as SeatPromptSlot[]) {
    const partial = { ...named } as Record<string, string>;
    delete partial[missing];
    let threw = "";
    try {
      composeSeatPrompt(partial as unknown as SeatPromptParts);
    } catch (err) {
      threw = String(err);
    }
    ok(threw.includes(missing), `🔴 composeSeatPrompt THROWS and names the slot when "${missing}" is not supplied`);
  }
  let brokeOnComplete = false;
  try {
    composeSeatPrompt(named);
  } catch {
    brokeOnComplete = true;
  }
  ok(brokeOnComplete === false, "negative control: a COMPLETE parts record composes without throwing");
}

{
  ok(surfaceDisplayName("notion") === "Notion", "the namer knows Notion");
  ok(surfaceDisplayName("github") === "GitHub", "🔴 the namer knows GitHub — the title-case fallback answered 'Github'");
  ok(surfaceDisplayName("teams") === "Microsoft Teams", "the namer keeps the product name, not the key");
  ok(surfaceDisplayName("zulip") === "Zulip", "an UNLISTED platform title-cases, so a newly wired surface still reads sensibly");
  ok(surfaceDisplayName(undefined) === "" && surfaceDisplayName("") === "", "an absent platform names nothing — every caller reads that as 'say nothing'");

  for (const p of ["notion", "github", "zulip"]) {
    const name = surfaceDisplayName(p);
    ok(renderSurface(p).includes(`**${name}**`), `the per-surface line names ${p} through the one namer`);
    ok(renderHandle(p, "Bot").includes(`on ${name} appears`), `the handle line names ${p} through the one namer`);
    ok(renderUnifiedSurfaceGuides([p]).includes(`### ${name}\n`), `the per-surface guide heading names ${p} through the one namer`);
  }
  ok(!renderUnifiedSurfaceGuides(["notion"]).includes("### notion\n"), "🔴 the guide heading is no longer the raw lowercase platform key");
  ok(renderHandle(undefined, "Bot").includes("on this surface appears"), "an unnamed platform falls back to 'this surface', never to an empty name");
  ok(renderHandle("slack", undefined) === "", "negative control: no handle resolved ⇒ no handle line at all");
}

{
  const wake = renderDeliverySection({ kind: "wake-addressed", pinned: false });
  const wakePinned = renderDeliverySection({ kind: "wake-addressed", pinned: true });
  const replyOnly = renderDeliverySection({ kind: "reply-only" });
  const dual = renderDeliverySection({ kind: "dual-mode" });
  const closing = renderDeliverySection({ kind: "closing-text" });

  const bare = editReplyParagraph("");
  const addressed = editReplyParagraph(" and the same `wake-id`,");
  ok(replyOnly.includes(bare), "🔴 the reply-only arm is built from the shared edit_reply paragraph");
  ok(dual.includes(bare), "🔴 the dual-mode arm is built from the SAME shared edit_reply paragraph");
  ok(wake.includes(addressed) && wakePinned.includes(addressed), "🔴 both wake-addressed arms are built from it too, with the wake-id address");
  ok(!wake.includes(bare), "the wake-addressed arm takes the ADDRESSED form, not the bare one — its `edit_reply` needs the wake id");

  const tail = postingIsAnActionParagraph("X").slice("X".length);
  ok(replyOnly.includes(tail) && dual.includes(tail), "🔴 reply-only and dual-mode share ONE 'posting is an action' tail");

  ok(!closing.includes(bare) && !closing.includes(tail), "🔴 negative control: the closing-text arm shares NEITHER — it mounts no `reply` at all");
  ok(closing.includes("mounts no working `reply` tool"), "negative control: …and still says so, so the dead-but-structural arm is not silently gone");
  ok(wake.includes("This is a cross-surface session"), "negative control: the unpinned wake-addressed arm keeps its cross-surface claim");
  ok(!wakePinned.includes("This is a cross-surface session"), "negative control: the PINNED arm drops it (OPE-787)");
  ok(replyOnly.includes("It takes no address and there is nothing to name"), "negative control: the reply-only arm still states its `reply` carries no address");
  ok(!replyOnly.includes("wake-id"), "negative control: …and never asks that seat for a wake-id");
  ok(dual.includes("posts into the channel mid-turn"), "negative control: the dual-mode arm still states the mid-turn post");
  ok(!dual.includes("DISCARDED"), "negative control: …and never claims a drop that surface does not do");
}

{
  ok(renderUnifiedSurfaces(["notion"]) === renderSurface("notion"), "🔴 a ONE-surface window renders the byte-identical per-surface line, not a third wording");
  ok(!renderUnifiedSurfaces(["notion"]).includes("SEVERAL"), "🔴 …and never says SEVERAL of one surface");

  const many = renderUnifiedSurfaces(["slack", "notion", "linear"]);
  ok(many.includes("SEVERAL surfaces"), "negative control: a genuinely multi-surface window DOES say SEVERAL");
  ok(many.includes("Slack, Notion and Linear"), "negative control: …and lists every wired surface through the one namer");
  ok(renderUnifiedSurfaces([]) === "", "no known surface ⇒ no surface line");
}

{
  const worker = renderSeatPersona({ seatKind: "worker", delivery: { kind: "dual-mode" } });
  const seat = renderSeatPersona({ seatKind: "conversational", delivery: { kind: "dual-mode" } });

  ok(worker.includes("call `post_file` to attach it into the"), "🔴 a worker is told it CARRIES the file tools");
  ok(!worker.includes("call `agent` — the"), "🔴 …and is never told to delegate a file to a worker, which is itself");
  ok(seat.includes("call `agent` — the"), "negative control: a conversational seat IS told to delegate the file");
  ok(!seat.includes("call `post_file` to attach it into the"), "negative control: …and is never told it holds the file tools");

  ok(worker.includes("`return_result`"), "🔴 a worker's escalation route is its report");
  ok(worker.includes("an answer might not"), "🔴 …and the hedge stands: a parked question may never be answered on the roll-own path");
  ok(seat.includes("check with the channel before continuing"), "negative control: a conversational seat asks the channel instead");
  ok(!seat.includes("`return_result`"), "negative control: …and is never handed a verb it does not hold");

  ok(renderSeatPersona({ seatKind: "conversational", delivery: { kind: "reply-only" } }).includes(renderDeliverySection({ kind: "reply-only" })), "the persona embeds the delivery section its variant names");

  ok(worker.includes("You are the standing session for this channel"), "⚠️ TODAY: a worker still reads the conversational seat's channel-watch opener — the content fix is its own ticket");
  ok(worker.includes("`stand_down`") && worker.includes("### Backscroll"), "⚠️ TODAY: …and its stand-down and backscroll rules, neither of which a worker can act on");
}

{
  registerSlackFixtureMapper();
  registerCapabilityManifest("slack", { midTurnPost: true, reactions: true, supervisorProseDropped: true });
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "ope817", channels: ["slack/T8/C8", "notion/ws/pg"], mode: "unified", ambientSupervisor: true })],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });

  const perSurface: BindableContext = {
    channel: { kind: "slack", continuationToken: "C8:oe-sup:g1" },
    session: { auth: { current: { attributes: { team_id: "T8", channel_id: "C8", channel_type: "channel", is_private: "false", trust_checked: "true" }, principalId: "U1", principalType: "user" } } },
  } as BindableContext;
  const unified: BindableContext = {
    channel: { kind: "channel:unified", continuationToken: formatWindowToken({ domain: "ope817", windowId: "ope817", generation: 1 }) },
    session: { auth: { current: { attributes: { oe_platform: "slack" } } } },
  } as BindableContext;

  const OWNER: Readonly<Record<string, SeatPromptSlot>> = {
    "## Formatting & tools here": "surfaceGuide",
    "## Formatting & tools per surface": "surfaceGuide",
    "## This channel": "persona",
    "### Reading a wake": "readingAWake",
    "### How you write": "replyStyle",
    "## What stops for a human": "approvalPreview",
    "## What a worker can do that you cannot": "workerCapabilities",
    "## When somebody refers to something you cannot see": "recoveryRead",
    "## Channels you can read": "channelScope",
    "## Busy threads: react over reply": "noiseDoctrine",
  };
  const slotSequence = (md: string): SeatPromptSlot[] =>
    md
      .split("\n")
      .map((l) => OWNER[l.trim()])
      .filter((s): s is SeatPromptSlot => s !== undefined);

  for (const [label, ctx] of [
    ["per-surface", perSurface],
    ["unified", unified],
  ] as const) {
    const seq = slotSequence(await renderScopeMarkdown(ctx));
    ok(seq.length >= 4, `fixture guard: the ${label} path renders at least four owned headings (got ${seq.length})`);
    const indices = seq.map((s) => SEAT_PROMPT_SLOTS.indexOf(s));
    const sorted = [...indices].sort((x, y) => x - y);
    ok(JSON.stringify(indices) === JSON.stringify(sorted), `🔴 the ${label} scope path renders its blocks in SEAT_PROMPT_SLOTS order — one spine, two paths`);
  }

  const a = slotSequence(await renderScopeMarkdown(perSurface));
  const b = slotSequence(await renderScopeMarkdown(unified));
  const shared = a.filter((s) => b.includes(s));
  ok(shared.length >= 4, `fixture guard: the two paths share at least four owned blocks (got ${shared.length})`);
  ok(JSON.stringify(b.filter((s) => shared.includes(s))) === JSON.stringify(shared), "🔴 the shared blocks appear in the SAME relative order on both paths");
}

console.log(`✓ seat-prompt: ${passed} assertions passed`);
