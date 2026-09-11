
import {
  SEAT_PROMPT_SLOTS,
  composeSeatPrompt,
  editReplyParagraph,
  postingIsAnActionParagraph,
  renderDeliverySection,
  renderHandle,
  renderSeatPersona,
  renderSurface,
  renderSurfaceGuide,
  standDownAckSentence,
  renderUnifiedSurfaceGuides,
  renderUnifiedSurfaces,
  surfaceDisplayName,
  SURFACE_GUIDES,
  type SeatPromptParts,
  type SeatPromptSlot,
} from "../agent/instructions/seat-prompt.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { registerCapabilityManifest } from "../agent/identity/capabilities.js";
import { renderScopeMarkdown, renderSupervisorPersona } from "../agent/instructions/access.js";
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
    "noiseDoctrine",
  ];
  ok(JSON.stringify([...SEAT_PROMPT_SLOTS]) === JSON.stringify(EXPECTED_ORDER), "🔴 SEAT_PROMPT_SLOTS is exactly the pinned order — a reorder must be deliberate");

  const named = Object.fromEntries(SEAT_PROMPT_SLOTS.map((s) => [s, s])) as SeatPromptParts;
  ok(composeSeatPrompt(named) === EXPECTED_ORDER.join("\n\n"), "🔴 composeSeatPrompt joins the filled slots in that order, separated by one blank line");

  const withHole: SeatPromptParts = { ...named, replyStyle: "" };
  const expected = SEAT_PROMPT_SLOTS.filter((s) => s !== "replyStyle").join("\n\n");
  ok(composeSeatPrompt(withHole) === expected, "an empty slot drops out and leaves no extra blank line");
  ok(!composeSeatPrompt(withHole).includes("\n\n\n"), "negative control: dropping a slot never produces a double blank line");

  for (const missing of ["persona", "readingAWake", "memoryIndex"] as SeatPromptSlot[]) {
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
  const wakeAck = standDownAckSentence("wake-addressed");
  const replyOnlyAck = standDownAckSentence("reply-only");
  const dualAck = standDownAckSentence("dual-mode");
  const closingAck = standDownAckSentence("closing-text");

  ok(/`reply`/.test(wakeAck) && /wake-id/.test(wakeAck), "the wake-addressed sentence names `reply` AND the wake-id its reply needs");
  ok(/`reply`/.test(replyOnlyAck) && !/wake-id/.test(replyOnlyAck), "the reply-only sentence names `reply` and asks for NO address");
  ok(/final text/.test(dualAck), "the dual-mode sentence names the turn's final text — the route that seat actually has");
  ok(dualAck === closingAck, "closing-text reads the same sentence: on both arms the closing text is what posts");

  ok(!/`reply`/.test(dualAck), "🔴 negative control: the dual-mode sentence does not ALSO offer `reply`");
  ok(!/as your final text/.test(wakeAck), "🔴 negative control: the wake-addressed sentence does not offer the final text its host drops");
  ok(/discarded/.test(wakeAck) && /discarded/.test(replyOnlyAck), "both prose-dropping arms say the closing text is discarded");
  ok(!/discard/.test(dualAck), "🔴 negative control: …and the arm that POSTS its closing text never claims that drop");
  ok(
    new Set([wakeAck, replyOnlyAck, dualAck]).size === 3,
    "the three live arms read three different sentences — the renderer has not flattened them",
  );
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
  const worker = renderSeatPersona({ seatKind: "worker", midTurnPost: true });
  const seat = renderSeatPersona({ seatKind: "conversational", delivery: { kind: "dual-mode" } });

  ok(worker.includes("call `post_file` to attach it into the"), "🔴 a worker is told it CARRIES the file tools");
  ok(!worker.includes("call `agent` — the"), "🔴 …and is never told to delegate a file to a worker, which is itself");
  ok(seat.includes("call `agent` — the"), "negative control: a conversational seat IS told to delegate the file");
  ok(!seat.includes("call `post_file` to attach it into the"), "negative control: …and is never told it holds the file tools");

  ok(worker.includes("an answer might not"), "🔴 the ask-question hedge stands: a parked question may never be answered");
  ok(seat.includes("check with the channel before continuing"), "negative control: a conversational seat asks the channel instead");
  ok(!seat.includes("`return_result`"), "negative control: …and is never handed a verb it does not hold");

  for (const gone of [
    "You are the standing session for this channel",
    "### When to speak",
    "A react acknowledges; it does not answer",
    "`stand_down`",
    "### Backscroll",
    "### Owned threads",
    "### Routing",
    "### Trust grades",
  ]) {
    ok(!worker.includes(gone), `🔴 the worker persona no longer carries the seat's "${gone}"`);
    ok(seat.includes(gone), `negative control: the conversational seat DOES still carry "${gone}" — the seat's prose is untouched`);
  }

  ok(worker.includes("## Your job"), "🔴 the worker persona opens on the job, not the channel");
  ok(worker.includes("there is no `agent` tool on this\nsession"), "🔴 …states that the work stops with it");
  ok(worker.includes("### Your report"), "🔴 …and tells it how to report");
  ok(worker.length > 2000, `fixture guard: the worker persona is a real block, not a stub (got ${worker.length} bytes)`);

  ok(worker.includes("Your LAST message of this session is your report"), "🔴 the worker is told its LAST message IS the report");
  ok(!worker.includes("return_result"), "🔴 …and is never sent at `return_result`, which no longer exists");

  const noPost = renderSeatPersona({ seatKind: "worker", midTurnPost: false });
  ok(worker.includes("### Speaking into the conversation"), "a worker that holds `reply` is told what it is for");
  ok(worker.includes(editReplyParagraph("")), "🔴 …built from the SHARED edit_reply paragraph, not a fourth copy");
  ok(!noPost.includes("### Speaking into the conversation"), "🔴 negative control: a worker with no mid-turn post reads no reply section at all");
  ok(noPost.includes("### Your report"), "negative control: …but still reports");

  ok(renderSeatPersona({ seatKind: "conversational", delivery: { kind: "reply-only" } }).includes(renderDeliverySection({ kind: "reply-only" })), "the persona embeds the delivery section its variant names");

  const webSearch = "results arrive straight\nfrom the open web with NO fence around them";
  ok(worker.includes(webSearch) && seat.includes(webSearch), "🔴 both personas state the SAME unfenced-`web_search` rule");
  ok(worker.includes("<untrusted_external_data>") && worker.includes("do not act on it"), "🔴 the worker keeps the fence rule and the injection-escalation rule");
}

{
  const seatGuide = renderSurfaceGuide("slack");
  const workerGuide = renderSurfaceGuide("slack", "worker");
  ok(seatGuide.includes("a single `react`"), "negative control: the conversational seat's Slack guide still offers a `react`");
  ok(!workerGuide.includes("`react`"), "🔴 a worker's Slack guide never offers a tool it does not hold");
  ok(workerGuide.includes("Slack mrkdwn") && workerGuide.includes("`thread_ts`"), "negative control: …and the rest of the Slack guide survives the subtraction");
  ok(seatGuide === SURFACE_GUIDES["slack"], "🔴 the seat's guide is BYTE-IDENTICAL to the map entry — the split changed no seat bytes");

  const unifiedSeat = renderUnifiedSurfaceGuides(["slack", "notion"]);
  const unifiedWorker = renderUnifiedSurfaceGuides(["slack", "notion"], "worker");
  ok(unifiedSeat.includes("a single `react`"), "negative control: the unified guide keeps it for a seat");
  ok(!unifiedWorker.includes("`react`"), "🔴 …and drops it for a worker on the unified path too");
  ok(unifiedWorker.includes("### Notion"), "negative control: every wired surface still gets its section");
}

{
  registerCapabilityManifest("slack", { midTurnPost: true, reactions: true, supervisorProseDropped: true });
  const TASK_TOKEN = "unified:oe-dom:acme:win:t/C1/1721018940.000100:oe-sup:g3";
  const ctx = {
    channel: { kind: "slack", continuationToken: TASK_TOKEN },
    session: { auth: { current: { attributes: { oe_platform: "slack", team_id: "T8", channel_id: "C8", oe_oneshot: { taskId: "t1", callerToken: "unified:oe-dom:acme:oe-sup:g3", callerOrigin: { kind: "slack" } } } } } },
  } as unknown as BindableContext;
  const addressed = renderSupervisorPersona(ctx, { messageToolOnly: true });
  const plain = renderSupervisorPersona(ctx);
  ok(!addressed.includes("### Speaking into the conversation"), "🔴 a wake-addressed worker reads no reply section — the address is undescribed and undriven");
  ok(addressed.includes("### Your report"), "…and still reads its report route in full, so it is not left mute");
  ok(plain.includes("### Speaking into the conversation"), "negative control: the SAME worker off that path does read it — the withholding is the arm, not a deletion");
}

{
  const seat = renderSeatPersona({ seatKind: "conversational", delivery: { kind: "dual-mode" } });
  const worker = renderSeatPersona({ seatKind: "worker", midTurnPost: true });

  ok(seat.includes("A react acknowledges; it does not answer"), "🔴 the seat is told a react is not an answer");
  ok(seat.includes("then still post ONE short reply before the turn ends"), "🔴 …and that an ADDRESSED message is owed one short reply");
  ok(
    seat.includes("Delegating the\nwork does not discharge that reply"),
    "🔴 …including on the exact shape OPE-906 measured — react, delegate, go quiet",
  );

  ok(
    seat.includes("A react alone\nis the whole answer only on a message that did NOT address you"),
    "🔴 negative control: a react alone is STILL the whole answer on an unaddressed message",
  );
  ok(seat.includes("`no_reply` is the most common correct ending to a wake"), "negative control: the silence bar itself is untouched");

  for (const retired of ["A react is a full response tier", "a single emoji is the whole answer"]) {
    ok(!seat.includes(retired), `🔴 the retired claim "${retired}" is deleted, not left standing beside the new rule`);
  }

  ok(seat.includes("your own turn has a budget"), "🔴 the seat reads an explicit per-turn budget");
  ok(
    seat.includes("a few reads to get your bearings, a react, ONE short reply"),
    "🔴 …enumerated: a few reads, a react, ONE short reply, a memory note, a delegation",
  );
  ok(seat.includes("A second reply is itself the signal that you are over budget"), "🔴 …with a second reply as the escalation threshold");
  ok(seat.includes("with a brief of\nwhat you already know in its instructions"), "🔴 …and the delegation carries a brief of what the seat already knows");

  for (const seatOnly of ["A react acknowledges", "your own turn has a budget", "ONE short reply"]) {
    ok(!worker.includes(seatOnly), `🔴 the worker persona never reads the seat's "${seatOnly}"`);
  }
}

{
  const seatGuide = renderSurfaceGuide("slack");
  ok(seatGuide.includes("to a message that did not address you"), "🔴 the Slack guide's react sentence names the UNADDRESSED case");
  ok(seatGuide.includes("one short `reply` still\nfollows") || seatGuide.includes("one short `reply` still follows"), "🔴 …and the addressed case's reply floor");
  ok(!renderSurfaceGuide("slack", "worker").includes("`react`"), "negative control: the worker subtraction still removes the WHOLE sentence");
}

{
  const discordGuide = SURFACE_GUIDES["discord"];
  ok(!discordGuide.includes("doesn't split for you"), "🔴 the Discord guide no longer claims `reply` doesn't split");
  ok(!discordGuide.includes("or the post fails"), "🔴 …and no longer claims an over-cap `reply` fails");
  ok(discordGuide.includes("`reply` splits an"), "🔴 …and states what is true: `reply` splits an over-cap message");
  ok(discordGuide.includes("several posts, sent in order"), "🔴 …into several posts, sent in order");
  ok(discordGuide.includes("an edit is a single PATCH, so it can't split"), "negative control: the edit_reply caveat survives, worded as a fact about edits, not a warning against the verb");
}

{
  for (const platform of ["slack", "discord", "teams"]) {
    const guide = SURFACE_GUIDES[platform];
    ok(!guide.includes("ending turn text"), `🔴 the ${platform} guide does not claim turn-final text posts`);
    ok(!guide.includes("also posts"), `🔴 …and carries no second delivery claim at all`);
  }

  const teamsGuideSection = renderUnifiedSurfaceGuides(["teams"]);
  const delivery = renderDeliverySection({ kind: "wake-addressed", pinned: false });
  const joined = `${teamsGuideSection}\n\n${delivery}`;
  ok(joined.includes("DISCARDED"), "🔴 the joined wake-addressed Teams prompt states the drop");
  ok(!joined.includes("also posts"), "🔴 …and carries no contradicting claim that turn-final text posts");
  ok(teamsGuideSection.includes("no reaction primitive wired"), "negative control: the rest of the Teams guide survives the deletion");
}

{
  const seatGuide = renderSurfaceGuide("discord");
  const workerGuide = renderSurfaceGuide("discord", "worker");
  ok(!seatGuide.includes("no `react` tool"), "🔴 the Discord seat guide no longer denies the `react` tool");
  ok(seatGuide.includes("a single `react`"), "🔴 …and states the same react-first-response guidance Slack gets");
  ok(seatGuide === SURFACE_GUIDES["discord"], "negative control: the seat's guide is byte-identical to the map entry");
  ok(!workerGuide.includes("`react`"), "negative control: a Discord worker still holds no `react`, so its guide still drops the sentence");
  ok(workerGuide.includes("Discord hard-caps a single message at 2000"), "negative control: the rest of the Discord guide survives the subtraction");

  const teamsGuide = SURFACE_GUIDES["teams"];
  ok(teamsGuide.includes("no `react` tool on this surface"), "negative control: Teams' denial stays — its manifest really has no react primitive");
}

{
  registerSlackFixtureMapper();
  registerCapabilityManifest("slack", { midTurnPost: true, reactions: true, supervisorProseDropped: true });
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "ope817", reach: ["slack/T8/C8", "notion/ws/pg"], mode: "unified", ambientSupervisor: true })],
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
    "## Busy threads: a react instead of a low-content reply": "noiseDoctrine",
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

{
  const wakeAddressed = renderSeatPersona({ seatKind: "conversational", delivery: { kind: "wake-addressed", pinned: false } });
  const replyOnly = renderSeatPersona({ seatKind: "conversational", delivery: { kind: "reply-only" } });
  const closingText = renderSeatPersona({ seatKind: "conversational", delivery: { kind: "closing-text" } });
  const seat = renderSeatPersona({ seatKind: "conversational", delivery: { kind: "dual-mode" } });
  const worker = renderSeatPersona({ seatKind: "worker", midTurnPost: true });

  ok(seat.includes("its report is OWED"), "🔴 §12: the seat is told the worker's report is OWED, not that relaying it is optional");
  ok(
    !seat.includes("if people are waiting on that outcome"),
    "🔴 §12: …and the CONDITIONAL that the five a live run scenarios read is gone. A permission where a duty belongs is what they acted on",
  );
  ok(seat.includes("on the turn the completion notice arrives"), "🔴 §12: the copy names WHEN the report is owed — the settlement turn, not some later one");
  ok(seat.includes("relaying it is your job, not echo"), "§12/CONTROL: the echo carve-out itself survives — this section sharpened it, it did not delete it");

  ok(!worker.includes("its report is OWED"), "🔴 §12: the worker persona carries none of it — a worker delegates nothing, so it is owed nothing");

  ok(wakeAddressed.includes("its report is OWED"), "🔴 §12: the `wake-addressed` arm reads the duty");
  ok(replyOnly.includes("its report is OWED"), "🔴 §12: the `reply-only` arm reads it too — every live container-supervisor seat is on this arm");
  ok(!closingText.includes("its report is OWED"), "🔴 §12: the `closing-text` arm mounts no working `reply`, so it reads no duty that names one");
  ok(!closingText.includes("`reply`,"), "🔴 §12: …and instructs no `reply` call at all, which is what `test:instructions` refuses on that arm");
  ok(closingText.includes("relaying it is your job, not echo"), "§12/CONTROL: the `closing-text` arm keeps the carve-out — only the `reply` route is withheld");

  const refusal = "`no_reply` is refused on the settlement turn";
  ok(wakeAddressed.includes(refusal), "🔴 §12: the unified arm states the host consequence, so the refusal in `no_reply` is a reminder rather than a surprise");
  ok(!replyOnly.includes(refusal), "🔴 §12: the `reply-only` arm is NOT threatened — its per-surface door records no promise, so nothing there can refuse");
  ok(!seat.includes(refusal), "🔴 §12: nor is `dual-mode`, for the same reason — every thread and DM seat reads the duty without a threat that cannot fire");
  ok(!closingText.includes(refusal), "🔴 §12: nor `closing-text`, which reads none of the paragraph at all");
}

{
  const seat = renderSeatPersona({ seatKind: "conversational", delivery: { kind: "dual-mode" } });
  const worker = renderSeatPersona({ seatKind: "worker", midTurnPost: true });
  const arms = [
    renderSeatPersona({ seatKind: "conversational", delivery: { kind: "wake-addressed", pinned: false } }),
    renderSeatPersona({ seatKind: "conversational", delivery: { kind: "reply-only" } }),
    renderSeatPersona({ seatKind: "conversational", delivery: { kind: "closing-text" } }),
    seat,
    worker,
    renderSeatPersona({ seatKind: "worker", midTurnPost: false }),
  ];
  for (const [i, text] of arms.entries()) {
    ok(text.includes("Say what happened, not what you meant to do"), `🔴 §13: arm ${i} carries the honest-ack block — the defect is in the sentence, so no arm is exempt`);
  }
  ok(
    seat.includes("claims an execution YOU never made"),
    "🔴 §13: it says WHY a started-not-finished claim is false — nothing is running behind it (S-AWS-BOUNDARY)",
  );
  ok(
    seat.includes("Handing the work to a worker is the one case that differs") && seat.includes("its result comes back here"),
    "🔴 §13: a delegated hand-off is carved out — the seat is still told to say the work is running",
  );
  ok(
    seat.includes("does not discharge that reply: say in one line what you are doing"),
    "🔴 §13/CONTROL: …and the instruction it must not contradict is really in the same prompt, so this is a real conflict and not a hypothetical",
  );
  ok(
    seat.includes("never true either way is naming an outcome you\nhave not got"),
    "🔴 §13: the invariant that survives BOTH cases is stated last — the carve-out narrows the rule, it does not create an exemption",
  );
  ok(
    seat.includes("A fact is stored when the file edit happened") && seat.includes("A\nroutine exists when the tool returned its row"),
    "🔴 §13: …and it names the two measured effects by what actually lands — the file edit (J2) and the returned row (S23)",
  );
  ok(
    seat.includes("Say which permission is missing and who can grant it"),
    "🔴 §13: the refusal half tells the seat to pass on the BOUNDARY, which is what S-PR-BOUNDARY's reply replaced with a failed-task story",
  );
  ok(
    seat.includes('saying\n"the task failed" or "I could not verify it" instead reports a different, and wrong,\nreason'),
    "🔴 §13: …and it names the two wrong reasons verbatim, so the model can match its own draft against them",
  );
  for (const verb of ["`remember`", "`agent`", "`reply`", "`no_reply`"]) {
    ok(!seat.split("### Say what happened")[1]!.split("###")[0]!.includes(verb), `🔴 §13/CONTROL: the block names no ${verb} — a rule about a sentence must render on an arm that holds no tool at all`);
  }

  ok(!seat.includes("remember"), "🔴 §13: the standing persona names NO `remember` tool — the verb was deleted by OPE-389");
  ok(
    seat.includes("save it to this channel's memory the way the memory index says this") && seat.includes("Saving is a FILE"),
    "🔴 §13: …it points at the memory index for the route and says the save is a file EDIT",
  );
  ok(
    seat.includes("never say a fact is stored unless the edit happened"),
    "🔴 §13: …and forbids the save-claim without the edit, which is exactly what J2's grounding gate measures",
  );
}

console.log(`✓ seat-prompt: ${passed} assertions passed`);
