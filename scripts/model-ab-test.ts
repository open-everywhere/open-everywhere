import assert from "node:assert/strict";
import { deploymentOrg, registerIdentityMapper } from "@open-everywhere/core/agent/identity/binding.js";
import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { resolvePartition, domainKeyOf } from "@open-everywhere/core/agent/memory/partition.js";

import { pinSuiteStore } from "../packages/core/scripts/_suite-store.js";
pinSuiteStore("model-ab");

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "org", match: "org", admins: ["slack/U_ADMIN"] })],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const {
  abBucket,
  abBucketKey,
  abThreadKey,
  applyModelAb,
  armForBucket,
  assertModelAbTestValid,
  decideModelAb,
  modelAbTestArmed,
  noteModelAbArm,
  resolveModelArm,
  registerModelAbTest,
  registeredModelAbTest,
  resetModelAbTest,
  _resetModelAbArmRowsForTest,
  MODEL_AB_ARM_ACTION,
  MODEL_AB_RATING_ACTION,
  MODEL_ARM_DETAIL_KEY,
  MODEL_AB_BUCKET_DETAIL_KEY,
} = await import("@open-everywhere/core/agent/model/ab-test.js");
const { resolveRoute } = await import("@open-everywhere/core/agent/model/routing.js");
const { formatWindowToken } = await import("@open-everywhere/core/agent/channels/window-key.js");
const { recordModelCall } = await import("@open-everywhere/core/agent/hooks/spend.js");
const { usageForSession } = await import("@open-everywhere/core/agent/spend/usage-events.js");
const { lastArmedTurn, parseRateTokens, runRate, RATE_HELP_LINE } = await import("@open-everywhere/core/agent/commands/rate.js");
const { parseOeCommandTokens, renderHelp } = await import("@open-everywhere/core/agent/commands/core.js");
const { defaultScopeKey } = await import("@open-everywhere/core/agent/tools/set_spend_limit.js");
const { parseDiscordOeCommandOptions, buildOeDiscordCommandDefinition } = await import(
  "@open-everywhere/provider-discord/agent/commands/discord-commands.js"
);
const { unpricedModelIds, registerModelPricing } = await import("@open-everywhere/core/agent/spend/pricing.js");
const { tallyModelAb } = await import("./model-ab-report-lib.js");
const { MODEL_AB_TEST, abTestCollidesWithChampion } = await import("../agent/model/ab-test.js");
const { PRIMARY_MODEL } = await import("../agent/model/models.js");
const { loadModelPricing } = await import("../agent/spend/model-pricing.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const CHAMPION = "vendor/champion-1";
const CHALLENGER = "vendor/challenger-1";
const ALWAYS = { challenger: CHALLENGER, percent: 100 } as const;
const NEVER = { challenger: CHALLENGER, percent: 0 } as const;

{
  const key = abBucketKey("slack/T1/C_ROOM", "C_ROOM:1700000000.0001");
  ok(key === "slack/T1/C_ROOM::C_ROOM:1700000000.0001", "bucket key is `<surfaceKey>::<threadKey>`");
  ok(abBucketKey("slack/T1/C_ROOM", undefined) === "slack/T1/C_ROOM::", "a thread-less context buckets on the surface key alone");

  ok(abThreadKey({ channel: { continuationToken: "slack:C_ROOM:1700000000.0001" } } as never) === "slack:C_ROOM:1700000000.0001", "an ordinary thread token is used as eve reports it");
  const winTok = formatWindowToken({ domain: "payments", windowId: "payments", generation: 3 });
  ok(abThreadKey({ channel: { continuationToken: `unified:${winTok}` } } as never) === winTok, "a structured window token loses eve's channel namespace");
  ok(abThreadKey({} as never) === undefined, "a ctx with no channel yields no thread key");
  {
    const a = abBucketKey("slack/T1/C_ROOM", abThreadKey({ channel: { continuationToken: "slack:C_ROOM:1.0" } } as never));
    const b = abBucketKey("slack/T1/C_ROOM", abThreadKey({ channel: { continuationToken: "slack:C_ROOM:2.0" } } as never));
    ok(a !== b, "two threads in one channel derive two different bucket keys through the real ctx path");
    ok(a === "slack/T1/C_ROOM::slack:C_ROOM:1.0", "…and the derived key is the surface key plus the thread's own token");
    ok(armForBucket(a, { challenger: CHALLENGER, percent: 50 }) !== undefined, "…and it feeds armForBucket unchanged");
  }

  const first = abBucket(key);
  for (let i = 0; i < 50; i++) ok(abBucket(key) === first, "the bucket is stable for one conversation");
  ok(Number.isInteger(first) && first >= 0 && first <= 99, "the bucket is an integer in 0-99");

  const test = { challenger: CHALLENGER, percent: 50 } as const;
  const arm = armForBucket(key, test);
  for (let i = 0; i < 50; i++) ok(armForBucket(key, test) === arm, "one thread stays on one arm");

  const arms = new Set<string>();
  for (let i = 0; i < 200; i++) arms.add(armForBucket(abBucketKey("slack/T1/C_ROOM", `C_ROOM:${i}.0001`), test));
  ok(arms.size === 2, "at 50%, threads in one room split across both arms");

  let sawChallenger = false;
  for (let i = 0; i < 1000; i++) {
    if (armForBucket(abBucketKey("slack/T1/C_ROOM", `t${i}`), NEVER) === "challenger") sawChallenger = true;
  }
  ok(!sawChallenger, "percent 0 never resolves the challenger arm");
  ok(armForBucket(key, undefined) === "champion", "an undeclared experiment resolves the champion arm");

  let sawChallengerAtFull = 0;
  for (let i = 0; i < 1000; i++) {
    if (armForBucket(abBucketKey("slack/T1/C_ROOM", `t${i}`), ALWAYS) === "challenger") sawChallengerAtFull++;
  }
  ok(sawChallengerAtFull === 1000, "percent 100 resolves the challenger arm for every conversation (negative control)");

  resetModelAbTest();
  ok(registeredModelAbTest() === undefined, "unregistered resolves to no experiment");
  ok(!modelAbTestArmed(registeredModelAbTest()), "…which is unarmed, i.e. the champion");
  registerModelAbTest(ALWAYS);
  ok(registeredModelAbTest() === ALWAYS, "a registered experiment reads back (control)");
  resetModelAbTest();
  ok(registeredModelAbTest() === undefined, "the reset seam clears it again");

  ok(!modelAbTestArmed(undefined) && !modelAbTestArmed(NEVER), "an absent or 0% test is unarmed");
  ok(!modelAbTestArmed({ challenger: "  ", percent: 10 }), "a blank challenger id leaves the test unarmed");
  ok(modelAbTestArmed(ALWAYS), "a challenger plus a positive percent is armed");

  for (const bad of [-1, 101, 5.5, Number.NaN]) {
    assert.throws(() => assertModelAbTestValid({ challenger: CHALLENGER, percent: bad }), `percent ${bad} is refused`);
    n++;
  }
  assert.throws(() => assertModelAbTestValid({ challenger: "", percent: 10 }), "an armed test with no challenger is refused");
  n++;
  assertModelAbTestValid({ challenger: "", percent: 0 });
  n++;
}

{
  const deps = {
    domains: () => [],
    roles: () => [],
    backend: { model: (id: string) => ({ id }) as never, applyOptions: (_r: unknown, o: never) => o },
  };
  const bucketKey = abBucketKey("slack/T1/C_ROOM", "C_ROOM:1.0");

  const always = await resolveRoute("primary", "slack/T1/C_ROOM", undefined, CHAMPION, deps as never, undefined, { test: ALWAYS, bucketKey });
  ok(always.id === CHALLENGER, "at 100% the primary route resolves the challenger id");

  const never = await resolveRoute("primary", "slack/T1/C_ROOM", undefined, CHAMPION, deps as never, undefined, { test: NEVER, bucketKey });
  ok(never.id === undefined || never.id === CHAMPION, "at 0% the primary route is left on the champion");

  const noAb = await resolveRoute("primary", "slack/T1/C_ROOM", undefined, CHAMPION, deps as never);
  ok(noAb.id === undefined || noAb.id === CHAMPION, "with no ab argument the route is untouched");

  const pinnedDeps = {
    ...deps,
    domains: () => [defineDomain({ name: "pinned", reach: ["slack/T1/C_ROOM"], models: { primary: { id: "vendor/pinned-1" } } })],
  };
  const pinned = await resolveRoute("primary", "slack/T1/C_ROOM", undefined, CHAMPION, pinnedDeps as never, undefined, { test: ALWAYS, bucketKey });
  ok(pinned.id === "vendor/pinned-1", "a concrete route pin is never overridden by the challenger");

  const tierDeps = {
    ...deps,
    domains: () => [defineDomain({ name: "tiered", reach: ["slack/T1/C_ROOM"], models: { primary: { tier: "low" } } })],
    modelPolicy: () => ({ allow: [{ id: CHAMPION, tier: "high" as const }, { id: "vendor/cheap-1", tier: "low" as const }, { id: CHALLENGER, tier: "high" as const }] }),
  };
  const tiered = await resolveRoute("primary", "slack/T1/C_ROOM", undefined, CHAMPION, tierDeps as never, undefined, { test: ALWAYS, bucketKey });
  ok(tiered.id === "vendor/cheap-1", "a tier-routed domain resolves its tier's model, not the challenger");

  const clampedDeps = { ...deps, modelPolicy: () => ({ allow: [{ id: CHAMPION, tier: "high" as const }] }) };
  const clamped = await resolveRoute("primary", "slack/T1/C_ROOM", undefined, CHAMPION, clampedDeps as never, undefined, { test: ALWAYS, bucketKey });
  ok(clamped.id === CHAMPION, "a challenger outside the org allow-list is substituted back to the champion");

  const wanted = decideModelAb({}, CHAMPION, { test: ALWAYS, bucketKey })!;
  ok(wanted.arm === "challenger" && wanted.requestedId === CHALLENGER, "the decision asked for the challenger");
  ok(resolveModelArm(wanted, CHALLENGER) === "challenger", "an honoured challenger records the challenger arm");
  ok(resolveModelArm(wanted, CHAMPION) === "champion", "a substituted-away challenger records the CHAMPION arm");
  ok(resolveModelArm({ arm: "champion", bucketKey }, CHAMPION) === "champion", "a champion decision records the champion arm");

  ok(decideModelAb({}, CHAMPION, { test: NEVER, bucketKey }) === undefined, "an unarmed test yields no decision at all");
  ok(decideModelAb({ id: "vendor/other-1" }, CHAMPION, { test: ALWAYS, bucketKey }) === undefined, "a pinned route yields no decision at all");
  ok(decideModelAb({ tier: "low" }, CHAMPION, { test: ALWAYS, bucketKey }) === undefined, "a tier-routed route yields no decision at all");
  ok(decideModelAb({ id: CHAMPION }, CHAMPION, { test: ALWAYS, bucketKey }) !== undefined, "a route pinned to the champion IS in the experiment (control)");
  ok(applyModelAb({ reasoning: "low" }, undefined).id === undefined, "no decision leaves the route's id alone");
  ok(applyModelAb({ tier: "low" }, wanted).tier === undefined, "a challenger drops an inherited tier");
}

registerIdentityMapper("slack", () => ({
  workspace: "T1",
  surface: "C_THREAD",
  domainSurface: "C_PARENT",
  mode: "channel",
  visibility: "public",
  trust: "internal",
}));

{
  const ctx = {
    session: { id: "S1", auth: { current: { id: "slack/U_HUMAN", attributes: { platform: "slack", workspace: "T1", surface: "C_ROOM", channelKind: "channel" } } } },
    channel: { kind: "slack", continuationToken: "C_ROOM:1.0" },
  };
  const written: Record<string, unknown>[] = [];
  const capture = async (entry: Record<string, unknown>): Promise<void> => void written.push(entry);

  _resetModelAbArmRowsForTest();
  const stamp = { arm: "challenger" as const, bucketKey: "slack/T1/C_ROOM::C_ROOM:1.0", modelId: CHALLENGER };
  noteModelAbArm(ctx as never, stamp, { data: { turnId: "turn_1" } }, { appendAudit: capture as never });
  ok(written.length === 1, "an armed turn writes one model.ab_arm row");
  const row = written[0]!;
  const detail = row["detail"] as Record<string, unknown>;
  ok(row["action"] === MODEL_AB_ARM_ACTION, "the row's action is model.ab_arm");
  ok(row["surface"] === "slack/T1/C_PARENT", "the row files under the DOMAIN grain — the parent channel");
  ok(row["surface"] !== resolvePartition(ctx as never).surfaceKey, "…and NOT under the thread grain, which /oe rate never looks up");
  ok(domainKeyOf(resolvePartition(ctx as never)) === "slack/T1/C_PARENT", "the fixture really does split the two grains (control)");
  ok(row["org"] === resolvePartition(ctx as never).org, "the row files under this context's org");
  ok(detail["arm"] === "challenger" && detail["modelId"] === CHALLENGER, "the row carries the stamped arm and model");
  ok(detail["bucketKey"] === stamp.bucketKey, "the row carries the bucket, so a reader can recompute the assignment");
  ok(detail["turnId"] === "turn_1" && detail["sessionId"] === "S1", "the row carries the join keys");

  for (let i = 0; i < 5; i++) noteModelAbArm(ctx as never, stamp, { data: { turnId: "turn_1" } }, { appendAudit: capture as never });
  ok(written.length === 1, "further steps of the same turn write no second row");
  noteModelAbArm(ctx as never, stamp, { data: { turnId: "turn_2" } }, { appendAudit: capture as never });
  ok(written.length === 2, "the next turn writes its own row");

  noteModelAbArm(ctx as never, null, { data: { turnId: "turn_3" } }, { appendAudit: capture as never });
  ok(written.length === 2, "no stamp means no row at all");
  noteModelAbArm(ctx as never, stamp, undefined, { appendAudit: capture as never });
  ok(written.length === 2, "a step with no resolvable turn id writes no row");
}

{
  registerModelPricing(loadModelPricing());
  const org = deploymentOrg();
  const sessionId = `ab-test-${Date.now()}`;
  const ctx = {
    session: { id: sessionId, auth: { current: { id: "slack/U_HUMAN", attributes: { platform: "slack", workspace: "T1", surface: "C_ROOM", channelKind: "channel" } } } },
    channel: { kind: "slack", continuationToken: "C_ROOM:1.0" },
  };
  await recordModelCall(ctx as never, {
    usage: { inputTokens: 100, outputTokens: 10 },
    model: CHALLENGER,
    arm: { arm: "challenger", bucketKey: "slack/T1/C_ROOM::C_ROOM:1.0", modelId: CHALLENGER },
    what: "a turn step",
  });
  await recordModelCall(ctx as never, { usage: { inputTokens: 100, outputTokens: 10 }, model: CHAMPION, what: "a turn step" });

  const rows = await usageForSession(org, sessionId);
  ok(rows.length === 2, "both model calls landed a usage row");
  const armed = rows.filter((r) => r.detail?.[MODEL_ARM_DETAIL_KEY] !== undefined);
  ok(armed.length === 1, "exactly the armed call carries the arm key — an unarmed call's row is unchanged");
  ok(armed[0]!.detail?.[MODEL_ARM_DETAIL_KEY] === "challenger", "the arm key names the arm that ran");
  ok(armed[0]!.detail?.[MODEL_AB_BUCKET_DETAIL_KEY] === "slack/T1/C_ROOM::C_ROOM:1.0", "the row carries the bucket alongside the arm");
  ok(armed[0]!.model === CHALLENGER, "the row's model column still names the model, independently of the arm");
}

{
  ok(parseOeCommandTokens(["rate", "4"]).kind === "rate", '"/oe rate 4" parses as a rate command');
  ok((parseOeCommandTokens(["rate", "4"]) as { score: number }).score === 4, "the score is carried through");
  for (const bad of [[], ["0"], ["6"], ["3.5"], ["good"], ["-2"]]) {
    ok(parseRateTokens(bad).kind === "error", `"/oe rate ${bad.join(" ")}" is refused`);
  }
  ok(parseRateTokens(["1"]).kind === "rate" && parseRateTokens(["5"]).kind === "rate", "both ends of the scale are accepted");
  ok(renderHelp().includes("/oe rate"), "the help lists /oe rate");
  ok(RATE_HELP_LINE.includes("1-5"), "the help line states the scale");
  ok(parseDiscordOeCommandOptions([{ name: "rate", options: [{ name: "score", value: 4 }] }]).kind === "rate", "Discord's option tree parses rate");
  ok(parseDiscordOeCommandOptions([{ name: "rate", options: [{ name: "score", value: 9 }] }]).kind === "error", "Discord refuses an out-of-range score");
  const def = buildOeDiscordCommandDefinition() as { options: { name: string }[] };
  ok(def.options.some((o) => o.name === "rate"), "the Discord registration JSON offers /oe rate");

  const binding = {
    org: deploymentOrg(),
    platform: "slack",
    workspace: "T1",
    surface: "C_ROOM",
    principalId: "slack/U_HUMAN",
    mode: "channel" as const,
    visibility: "public" as const,
    trust: "internal" as const,
    target: { channelId: "C_ROOM" },
  };
  ok(
    defaultScopeKey({ ...binding, surface: "C_THREAD", domainSurface: "C_PARENT" } as never, "surface") === "slack/T1/C_PARENT",
    "the rate lookup keys on the parent channel for a thread-grain surface",
  );

  const armRow = {
    ts: "2026-09-09T10:00:00.000Z",
    org: binding.org,
    platform: "slack",
    workspace: "T1",
    surface: "slack/T1/C_ROOM",
    action: MODEL_AB_ARM_ACTION,
    detail: { arm: "challenger", bucketKey: "slack/T1/C_ROOM::C_ROOM:1.0", modelId: CHALLENGER, turnId: "turn_9", sessionId: "S9" },
  };

  let asked: Record<string, unknown> | undefined;
  const found = await lastArmedTurn(binding.org, "slack/T1/C_ROOM", {
    readAudit: (async (f: Record<string, unknown>) => {
      asked = f;
      return [armRow];
    }) as never,
  });
  ok(asked?.["action"] === MODEL_AB_ARM_ACTION && asked?.["surface"] === "slack/T1/C_ROOM" && asked?.["limit"] === 1, "the lookup is narrowed to this surface's newest arm row");
  ok(found?.arm === "challenger" && found?.turnId === "turn_9" && found?.sessionId === "S9", "the lookup returns the row's arm and join keys");

  for (const bad of [{ ...armRow, detail: { arm: "sideways", turnId: "t", bucketKey: "b", modelId: "m" } }, { ...armRow, detail: { arm: "champion" } }, { ...armRow, detail: undefined }]) {
    ok((await lastArmedTurn(binding.org, "slack/T1/C_ROOM", { readAudit: (async () => [bad]) as never })) === undefined, "a malformed arm row yields no rated turn");
  }
  ok((await lastArmedTurn(binding.org, "slack/T1/C_ROOM", { readAudit: (async () => []) as never })) === undefined, "no arm row yields no rated turn");
  ok(
    (await lastArmedTurn(binding.org, "slack/T1/C_ROOM", {
      readAudit: (async () => {
        throw new Error("store down");
      }) as never,
    })) === undefined,
    "an unreadable audit store yields no rated turn rather than throwing",
  );

  const rated: Record<string, unknown>[] = [];
  const reply = await runRate(binding as never, 4, {
    readAudit: (async () => [armRow]) as never,
    appendAudit: (async (e: Record<string, unknown>) => void rated.push(e)) as never,
  });
  ok(rated.length === 1, "one rating writes one audit row");
  const rd = rated[0]!["detail"] as Record<string, unknown>;
  ok(rated[0]!["action"] === MODEL_AB_RATING_ACTION, "the rating row's action is model.ab_rating");
  ok(rated[0]!["principalId"] === "slack/U_HUMAN", "the rating names who gave it");
  ok(rd["score"] === 4, "the rating carries the score");
  ok(rd["arm"] === "challenger" && rd["modelId"] === CHALLENGER, "the rating carries the arm and model of the turn it rates");
  ok(rd["turnId"] === "turn_9" && rd["sessionId"] === "S9", "the rating is keyed to the turn it rates");
  ok(rd["ratedAt"] === armRow.ts, "the rating records when the turn it rates happened");
  ok(!reply.includes("challenger") && !reply.includes(CHALLENGER), "the reply does not tell the rater which arm they marked");

  const none: unknown[] = [];
  const quiet = await runRate(binding as never, 4, { readAudit: (async () => []) as never, appendAudit: (async (e: unknown) => void none.push(e)) as never });
  ok(none.length === 0 && quiet.toLowerCase().includes("nothing to rate"), "an unarmed room records nothing and says so");
}

{
  ok(unpricedModelIds([MODEL_AB_TEST.challenger]).length === 0, "this deployment's declared challenger has a committed rate");
  ok(unpricedModelIds(["vendor/no-such-model-0"]).length === 1, "an unknown model id IS reported unpriced (negative control)");
  ok(MODEL_AB_TEST.percent === 0, "the shipped experiment is OFF — arming it is a deliberate, reviewed diff");

  ok(abTestCollidesWithChampion({ challenger: "vendor/x", percent: 10 }, "vendor/x"), "an ARMED test whose challenger is the champion collides");
  ok(!abTestCollidesWithChampion({ challenger: "vendor/x", percent: 0 }, "vendor/x"), "…but an OFF test with the same two ids does not — it routes nothing");
  ok(!abTestCollidesWithChampion({ challenger: "vendor/x", percent: 10 }, "vendor/y"), "…and two different ids never collide (control)");
  ok(!abTestCollidesWithChampion(MODEL_AB_TEST, PRIMARY_MODEL), "this deployment's own declaration does not collide");
}

{
  const NO_PRICING = { note: "test — no assumed model" };
  const armRow = (sessionId: string, turnId: string, arm: string) => ({
    ts: "2026-09-09T10:00:00.000Z",
    org: "o",
    platform: "slack",
    workspace: "T1",
    action: MODEL_AB_ARM_ACTION,
    detail: { arm, bucketKey: "b", modelId: "m", sessionId, turnId },
  });
  const rating = (turnId: string, principalId: string, arm: string, score: number) => ({
    ts: "2026-09-09T10:01:00.000Z",
    org: "o",
    platform: "slack",
    workspace: "T1",
    principalId,
    action: MODEL_AB_RATING_ACTION,
    detail: { arm, score, turnId, bucketKey: "b", modelId: "m" },
  });
  const call = (arm: string | undefined, inTok: number) => ({
    ts: "2026-09-09T10:00:30.000Z",
    org: "o",
    surfaceKey: "slack/T1/C",
    sessionId: "S1",
    inputTokens: inTok,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(arm ? { detail: { [MODEL_ARM_DETAIL_KEY]: arm } } : {}),
  });

  const dupTurns = tallyModelAb(
    { armRows: [armRow("S1", "t1", "challenger"), armRow("S1", "t1", "challenger"), armRow("S1", "t2", "champion")] as never, ratingRows: [], usageBySession: new Map() },
    NO_PRICING as never,
  );
  ok(dupTurns.tallies.challenger.turns === 1, "a turn with two arm rows counts once");
  ok(dupTurns.tallies.champion.turns === 1, "a second turn still counts (control)");
  ok(dupTurns.sessionArm.get("S1") === "challenger", "the session's usage is fetched once, under its first-seen arm");

  const marks = tallyModelAb(
    {
      armRows: [],
      ratingRows: [
        rating("t1", "slack/U_A", "challenger", 5),
        rating("t1", "slack/U_A", "challenger", 1),
        rating("t1", "slack/U_A", "challenger", 1),
        rating("t1", "slack/U_B", "challenger", 3),
        rating("t2", "slack/U_A", "champion", 2),
      ] as never,
      usageBySession: new Map(),
    },
    NO_PRICING as never,
  );
  ok(marks.tallies.challenger.ratings === 2, "one person rating one turn three times counts once");
  ok(marks.tallies.challenger.ratingSum === 8, "the NEWEST-first row wins — the 5, not the later 1s");
  ok(marks.tallies.champion.ratings === 1, "the same person on another turn still counts (control)");

  const money = tallyModelAb(
    { armRows: [armRow("S1", "t1", "challenger")] as never, ratingRows: [], usageBySession: new Map([["S1", [call("challenger", 10), call("champion", 20), call(undefined, 40)]]]) as never },
    NO_PRICING as never,
  );
  ok(money.tallies.challenger.calls === 1 && money.tallies.challenger.inputTokens === 10, "a challenger-stamped call counts to the challenger");
  ok(money.tallies.champion.calls === 1 && money.tallies.champion.inputTokens === 20, "a champion-stamped call in the SAME session counts to the champion, not to the session's arm");
  ok(money.tallies.challenger.calls + money.tallies.champion.calls === 2, "an unstamped call is not counted at all");
  ok(money.tallies.challenger.unpricedCalls === 1, "a call with no assumable rate is reported unpriced, never given another model's rate");

  const junk = tallyModelAb(
    { armRows: [armRow("S1", "t1", "sideways"), { ...armRow("S1", "t9", "champion"), detail: { arm: "champion" } }] as never, ratingRows: [rating("t1", "u", "champion", Number.NaN)] as never, usageBySession: new Map() },
    NO_PRICING as never,
  );
  ok(junk.tallies.champion.turns === 0 && junk.tallies.challenger.turns === 0, "an unknown arm and a turn-id-less row are both skipped");
  ok(junk.tallies.champion.ratings === 0, "a non-finite score is skipped");
}

console.log(`✓ model-ab: ${n} assertion(s)`);
