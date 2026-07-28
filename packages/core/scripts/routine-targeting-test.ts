import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function refuses(fn: () => unknown, needle: RegExp, label: string): Promise<void> {
  let msg: string | null = null;
  try {
    await fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  ok(msg !== null && needle.test(msg), `${label} (got: ${msg ?? "no throw"})`);
}

const dir = mkdtempSync(join(tmpdir(), "oe-routine-targeting-"));
process.env.OE_SQLITE_PATH = join(dir, "store.db");

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();

const routineDispatch = await import("../agent/schedules/routine-dispatch.js");
const routineMod = await import("../agent/routines/routine.js");
const domainMod = await import("../agent/memory/domain.js");
const cardVenue = await import("../agent/approvals/card-venue.js");
const eventAuthz = await import("../agent/routines/event-authz.js");
const store = await import("../agent/routines/store.js");
const dispatch = await import("../agent/schedules/dispatch.js");

const ORG = "default";

{
  ok(routineDispatch.canDispatchRoutinesOn("slack"), "predicate: slack can dispatch (core's one inline resolver)");
  ok(!routineDispatch.canDispatchRoutinesOn("linear"), "predicate: linear cannot — no registered resolver, and this is exactly the subscribe_pr bug's surface");
  ok(!routineDispatch.canDispatchRoutinesOn("github"), "predicate: github cannot (today) — the refusal is honest about what is wired, not about what is theoretically postable");
  ok(!routineDispatch.canDispatchRoutinesOn("notion"), "predicate: notion cannot");

  ok(!routineDispatch.canDispatchRoutinesOn("teams"), "predicate: teams is unregistered in THIS process before the bundle boots");
  routineDispatch.registerRoutineDispatch("teams", { resolveTarget: () => null });
  ok(routineDispatch.canDispatchRoutinesOn("teams"), "predicate: …and registering the bundle's resolver is what admits it — no second list to keep in sync");
  ok(
    routineDispatch.resolveRegisteredRoutineDispatch("teams") !== undefined,
    "predicate: the predicate and the dispatcher's own lookup resolve through the same map",
  );
}

{
  const t = routineDispatch.reportTargetForSurface("slack/T1/C_OPS");
  ok(t !== null && t["channelId"] === "C_OPS", "report-target: a slack surfaceKey's third segment IS the channel id, so { channelId } round-trips");
  ok(routineDispatch.reportTargetForSurface("slack/T1") === null, "report-target: a malformed (2-segment) key derives nothing rather than a plausible-looking wrong target");
  ok(routineDispatch.reportTargetForSurface("slack/T1/") === null, "report-target: an empty surface segment derives nothing");
  ok(routineDispatch.reportTargetForSurface("teams/W1/CONV1") === null, "report-target: a registered bundle with NO reportTargetFor answers null — a platform that can't express one says so");
}

{
  const base = {
    id: "r1",
    org: ORG,
    surfaceKey: "linear/W1/ISSUE1",
    trigger: { kind: "cron" as const, expr: "0 9 * * *" },
    prompt: "p",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active" as const,
    consecutiveFailures: 0,
  };
  const plain = { ...base, surfaceKey: "slack/T1/C_HOME", target: { channelId: "C_HOME" } };
  ok(routineMod.reportDestinationOf(plain) === plain, "report-model: a routine with NO report is returned by IDENTITY — the default path allocates nothing on the critical fire path");
  ok(routineMod.routineReportSurfaceKey(plain) === "slack/T1/C_HOME", "report-model: with no report, the report surface IS the owning surface");

  const silent = { ...plain, report: { kind: "silent" as const } };
  ok(routineMod.reportDestinationOf(silent) === silent, "report-model: a SILENT routine does NOT redirect — silence is a delivery gate, not a destination, and it still has to receive() into its own surface to run at all");

  const redirected = { ...base, target: {}, report: { kind: "surface" as const, surfaceKey: "slack/T1/C_OPS", target: { channelId: "C_OPS" } } };
  const dest = routineMod.reportDestinationOf(redirected);
  ok(dest.surfaceKey === "slack/T1/C_OPS" && (dest.target as Record<string, unknown>)["channelId"] === "C_OPS", "report-model: a redirected routine resolves the CONFIGURED destination");
  ok(redirected.surfaceKey === "linear/W1/ISSUE1", "report-model: …and the ORIGINAL row is untouched — ownership, spend and GC reach stay fused to surfaceKey");
  ok(routineMod.routineReportSurfaceKey(redirected) === "slack/T1/C_OPS", "report-model: routineReportSurfaceKey names the destination, which is what the dispatcher's slack-only guards must key on");

  ok(routineMod.describeTrigger(redirected.trigger, redirected.report).includes("slack/T1/C_OPS"), "report-model: describeTrigger NAMES the destination, so list_routines and the card can't render a redirected routine as if it posted here");
  ok(!routineMod.describeTrigger(plain.trigger).includes("posts into"), "report-model: an ordinary routine's description is byte-identical to before (no destination suffix)");

  const parts = eventAuthz.eventGrantPartitions(redirected as never);
  ok(parts.length === 2, "report-model: a redirected routine contributes TWO partitions to the event read-grant check");
  ok(parts.some((p) => p.surfaceKey === "linear/W1/ISSUE1") && parts.some((p) => p.surfaceKey === "slack/T1/C_OPS"), "report-model: …the owning one AND the destination's — an event may not be delivered into a room on a different domain's grant");
  ok(eventAuthz.eventGrantPartitions(silent as never).length === 1, "report-model: a silent routine still contributes only its own partition");
}

{
  const defineDomain = domainMod.defineDomain;
  const eng = defineDomain({ name: "eng", channels: ["teams/W1/CONV1", "slack/T1/C_OPS"] });
  const orphan = defineDomain({ name: "other", channels: ["slack/T1/C_X"] });
  const partitionFor = (surfaceKey: string) => {
    const [platform = "", workspace = "", ...rest] = surfaceKey.split("/");
    return { org: ORG, platform, workspace, surface: rest.join("/"), workspaceKey: `${platform}/${workspace}`, surfaceKey, key: surfaceKey };
  };
  const binding = (platform: string, workspace: string, channelId: string) =>
    ({ platform, workspace, mode: "channel", trust: "internal", target: { channelId } }) as never;

  const here = cardVenue.approvalVenueFor(binding("slack", "T1", "C_OPS"), partitionFor("slack/T1/C_OPS") as never, () => [eng]);
  ok("venue" in here && here.venue.sameRoom && here.venue.channelId === "C_OPS", "venue: a card-capable room hosts its own card — the common path is byte-identical to pre-OPE-148");

  const routed = cardVenue.approvalVenueFor(binding("teams", "W1", "CONV1"), partitionFor("teams/W1/CONV1") as never, () => [eng]);
  ok("venue" in routed && !routed.venue.sameRoom, "venue: a Teams channel can't host a card, so the card is ROUTED rather than the request refused — this is what makes Teams creatable at all");
  ok("venue" in routed && routed.venue.platform === "slack" && routed.venue.channelId === "C_OPS" && routed.venue.surfaceKey === "slack/T1/C_OPS", "venue: …into the card-capable channel in the SAME domain, whose third segment is its channel id");

  const noCard = cardVenue.approvalVenueFor(binding("teams", "W1", "CONV1"), partitionFor("teams/W1/CONV1") as never, () => [defineDomain({ name: "eng", channels: ["teams/W1/CONV1"] })]);
  ok("refusal" in noCard && noCard.refusal.reason === "no-card-channel" && noCard.refusal.domain === "eng", "venue: a domain with no card-capable channel REFUSES, naming the domain");
  ok(cardVenue.describeVenueRefusal((noCard as { refusal: never }).refusal, "teams").includes("eng"), "venue: the refusal text names the domain to edit — a blocked user gets an action, not a description of the blockage");

  const noDomain = cardVenue.approvalVenueFor(binding("teams", "W1", "CONV_X"), partitionFor("teams/W1/CONV_X") as never, () => [orphan]);
  ok("refusal" in noDomain && noDomain.refusal.reason === "no-domain", "venue: a channel in NO explicit domain gets no venue — a match/pseudo-domain is not a destination an operator chose");
  ok(cardVenue.describeVenueRefusal((noDomain as { refusal: never }).refusal, "teams").includes("domains.ts"), "venue: …and that refusal names the config file too");
}

{
  const defineDomain = domainMod.defineDomain;
  const good = defineDomain({ name: "eng", channels: ["linear/W1/ISSUE1", "slack/T1/C_OPS"], reportChannel: "slack/T1/C_OPS" });
  let threw: string | null = null;
  try {
    domainMod.assertReportChannels([good]);
  } catch (err) {
    threw = String(err);
  }
  ok(threw === null, "config-lint: a reportChannel that IS one of the domain's own channels passes");
  ok(domainMod.reportChannelFor("linear/W1/ISSUE1", [good]) === "slack/T1/C_OPS", "config-lint: …and resolves for every channel in that domain");
  ok(domainMod.reportChannelFor("slack/T9/C_ELSE", [good]) === undefined, "config-lint: a channel outside the domain gets NO redirect — it is deliberately not inherited or org-wide");

  await refuses(
    () => domainMod.assertReportChannels([defineDomain({ name: "eng", channels: ["linear/W1/ISSUE1"], reportChannel: "slack/T1/C_OTHER" })]),
    /not one of its own channels/,
    "config-lint: a redirect OUT of the domain is refused — that is the audience-expansion vector the config-not-creator decision exists to prevent",
  );
  await refuses(
    () => domainMod.assertReportChannels([defineDomain({ name: "org", match: "org", reportChannel: "slack/T1/C_OPS" })]),
    /not an explicit channels domain/,
    "config-lint: a match/pseudo-domain may not carry a reportChannel — nobody enumerated its membership",
  );
}

{
  const delivered: { channel: unknown; target: unknown; message: string; attributes: Record<string, string> }[] = [];
  const receive = ((channel: unknown, args: { message: string; target: unknown; auth: { attributes: Record<string, string> } }) => {
    delivered.push({ channel, target: args.target, message: args.message, attributes: args.auth.attributes });
    return Promise.resolve();
  }) as never;
  const pending: Promise<unknown>[] = [];
  const tick = (now: Date) => dispatch.dispatchTick({ now, receive, waitUntil: (p: Promise<unknown>) => void pending.push(p), appAuth: { attributes: {} } as never, confirmInternal: () => Promise.resolve(false) } as never);
  const settle = async () => {
    await Promise.allSettled(pending.splice(0));
  };
  const partitionFor = (surfaceKey: string) => {
    const [platform = "", workspace = "", ...rest] = surfaceKey.split("/");
    return { org: ORG, platform, workspace, surface: rest.join("/"), workspaceKey: `${platform}/${workspace}`, surfaceKey, key: surfaceKey } as never;
  };

  const teamsChannel = { kind: "teams-fake" };
  routineDispatch.registerRoutineDispatch("teams", {
    resolveTarget: (r) => {
      const conversationId = typeof r.target?.["conversationId"] === "string" ? (r.target["conversationId"] as string) : undefined;
      return conversationId ? { channel: teamsChannel as never, target: { conversationId }, mode: "channel", attributes: { conversation_id: conversationId } } : null;
    },
  });
  await store.addRoutine(partitionFor("teams/W1/CONV1"), {
    id: "r-teams",
    org: ORG,
    surfaceKey: "teams/W1/CONV1",
    target: { conversationId: "CONV1" },
    trigger: { kind: "cron", expr: "0 9 * * *" },
    prompt: "summarise the queue",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    nextRunAt: "2026-07-20T00:00:00.000Z",
    consecutiveFailures: 0,
  } as never);
  await tick(new Date("2026-07-20T01:00:00.000Z"));
  await settle();
  const teamsFire = delivered.filter((d) => d.channel === teamsChannel);
  ok(teamsFire.length === 1, "fires: a routine on a bundle-registered surface actually FIRES — the OPE-114 stage-4 resolver is reachable code now, not a gate that returns true");
  ok((teamsFire[0]!.target as Record<string, unknown>)["conversationId"] === "CONV1", "fires: …and the message REACHES that surface's own target");
  ok(teamsFire[0]!.message.includes("summarise the queue"), "fires: …carrying the routine's prompt");
  ok(teamsFire[0]!.attributes["open_everywhere_routine_surface"] === "teams/W1/CONV1", "fires: the routine marker names the OWNING surface, so outcome attribution and the strike counter land on the right row");

  const slackChannel = { kind: "slack-fake" };
  routineDispatch.registerRoutineDispatch("slack", {
    resolveTarget: (r) => {
      const channelId = typeof r.target?.["channelId"] === "string" ? (r.target["channelId"] as string) : undefined;
      return channelId ? { channel: slackChannel as never, target: { channelId }, mode: "channel", attributes: { team_id: r.surfaceKey.split("/")[1] ?? "", channel_id: channelId, channel_type: "channel" } } : null;
    },
  });
  await store.addRoutine(partitionFor("linear/W1/ISSUE1"), {
    id: "r-linear",
    org: ORG,
    surfaceKey: "linear/W1/ISSUE1",
    target: {},
    report: { kind: "surface", surfaceKey: "slack/T1/C_OPS", target: { channelId: "C_OPS" } },
    trigger: { kind: "cron", expr: "0 9 * * *" },
    prompt: "chase the migration",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    nextRunAt: "2026-07-20T00:00:00.000Z",
    consecutiveFailures: 0,
  } as never);
  await tick(new Date("2026-07-20T02:00:00.000Z"));
  await settle();
  const redirectFire = delivered.filter((d) => d.channel === slackChannel);
  ok(redirectFire.length === 1, "fires: a routine OWNED by an un-postable surface fires — before the report split it resolved null and dry-ran forever");
  ok((redirectFire[0]!.target as Record<string, unknown>)["channelId"] === "C_OPS", "fires: 🔴 …and its output REACHES THE CONFIGURED DESTINATION, not the owning surface");
  ok(redirectFire[0]!.message.includes("chase the migration"), "fires: …carrying the routine's prompt");
  ok(redirectFire[0]!.attributes["open_everywhere_routine_surface"] === "linear/W1/ISSUE1", "fires: the marker STILL names the owning surface — the destination moved, ownership did not");
  ok(redirectFire[0]!.attributes["channel_id"] === "C_OPS", "fires: the platform identity attributes describe the DESTINATION, because that is the room the turn runs in and posts to");

  const after = await store.getRoutine(ORG, "linear/W1/ISSUE1", "r-linear");
  ok(after?.nextRunAt !== "2026-07-20T00:00:00.000Z", "fires: the redirected routine's schedule ADVANCED — proof the dispatcher took the fire path, not the fail-closed dry-run path");
}

{
  const subscribeTool = (await import("../agent/tools/subscribe_pr.js")).default;
  const linearCtx = {
    channel: { kind: "linear" },
    session: { auth: { current: { attributes: { workspace_id: "W1", issue_id: "ISSUE1" }, principalId: "U1" } } },
  } as never;
  await refuses(
    () => subscribeTool.execute({ repo: "me/proj", number: 7 } as never, linearCtx),
    /no wired post-back/,
    "subscribe-pr: 🔴 subscribing from a surface that cannot post is REFUSED — it used to arm a chain that dry-ran forever and replied 'subscribed'",
  );
  ok(!routineDispatch.canDispatchRoutinesOn("linear"), "subscribe-pr: the refusal is canDispatchRoutinesOn's answer, not a private list");
}

{
  const createTool = (await import("../agent/tools/create_routine.js")).default;
  const slackCtx = (attrs: Record<string, string>) =>
    ({ channel: { kind: "slack" }, session: { auth: { current: { attributes: { team_id: "T1", ...attrs }, principalId: "U1", principalType: "slack-user" } } } }) as never;
  const cron = { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } as const;
  const once = { kind: "scheduled", at: new Date(Date.now() + 3_600_000).toISOString() } as const;

  await refuses(
    () => createTool.execute({ prompt: "p", trigger: cron } as never, slackCtx({ channel_id: "C_EXT", channel_type: "channel", is_ext_shared: "true", trust_checked: "true" })),
    /externally-shared or guest-bearing/,
    "external: a guest-bearing channel is refused at creation — the authoring half of the hole create_skill already closed",
  );

  const dmAttrs = { channel_id: "D_ME", channel_type: "im" };
  await refuses(
    () => createTool.execute({ prompt: "p", trigger: cron } as never, slackCtx(dmAttrs)),
    /standing schedule from a DM/,
    "dm: a RECURRING routine in a DM is refused — unwitnessed, unattended, standing, and approved by an audience of exactly the person who asked",
  );
  (await import("../agent/routines/event-model.js")).registerEventNormalizer({
    source: "fake",
    matchKeys: ["event"],
    scopeKeys: [],
    scopeKinds: ["container"],
    resolvesActor: false,
    normalize: () => null,
  } as never);
  await refuses(
    () => createTool.execute({ prompt: "p", trigger: { kind: "event", source: "fake", jq: '.scope.container == "me/proj"' } } as never, slackCtx(dmAttrs)),
    /standing schedule from a DM/,
    "dm: an EVENT subscription in a DM is refused too — no clock, but every bit as standing",
  );
  await refuses(
    () => createTool.execute({ prompt: "p", trigger: once, job: true } as never, slackCtx(dmAttrs)),
    /durable job from a DM/,
    "dm: a durable JOB in a DM is refused even on a one-shot trigger — a job runs until IT decides it is done, which is the opposite of 'fires once'",
  );
  let dmMsg = "";
  try {
    await createTool.execute({ prompt: "p", trigger: cron } as never, slackCtx(dmAttrs));
  } catch (err) {
    dmMsg = err instanceof Error ? err.message : String(err);
  }
  ok(dmMsg.includes("one-off reminder"), "dm: the refusal routes the user — 'ask in a channel, or ask for a one-off reminder here' — rather than just saying no");

  let onceMsg = "";
  try {
    await createTool.execute({ prompt: "check back on this", trigger: once } as never, slackCtx(dmAttrs));
  } catch (err) {
    onceMsg = err instanceof Error ? err.message : String(err);
  }
  ok(!/from a DM/.test(onceMsg), `dm: a ONE-SHOT in a DM is NOT refused — 'check back in an hour' is the most-wanted DM affordance and it survives (got: ${onceMsg || "no throw"})`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ routine targeting (OPE-148): ${passed} assertions passed (dispatch predicate + report model + card venue + config lint + REAL fires reaching their destination)`);
