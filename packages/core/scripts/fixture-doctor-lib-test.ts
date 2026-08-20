import {
  FIXTURE_FAMILIES,
  classifyAll,
  classifyFixture,
  fixtureDoctorResult,
  renderFixtureReport,
  type FixtureFamily,
  type FixtureFinding,
} from "./e2e/fixture-doctor-lib.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const SINGLE: FixtureFamily = {
  id: "slackPrivate",
  label: "test single-var family",
  required: [{ name: "T_ONE" }],
  scenarios: "test",
  probe: "presence-only",
  presenceOnlyReason: "test fixture",
};

const PAIR: FixtureFamily = {
  id: "slackChannelB",
  label: "test two-var family",
  required: [{ name: "T_A" }, { name: "T_B" }],
  scenarios: "test",
  probe: "presence-only",
  presenceOnlyReason: "test fixture",
};

{
  const c = classifyFixture({}, SINGLE);
  ok(c.classification === "absent", "no vars set → absent");
  ok(c.present.length === 0 && c.missing.length === 1, "absent: nothing present, one missing");
}
{
  const c = classifyFixture({ T_ONE: "  " }, SINGLE);
  ok(c.classification === "absent", "whitespace-only var counts as absent, not set");
}
{
  const c = classifyFixture({ T_ONE: "x" }, SINGLE);
  ok(c.classification === "set", "the one required var present → set");
  ok(c.missing.length === 0, "set: nothing missing");
}
{
  const c = classifyFixture({ T_A: "x" }, PAIR);
  ok(c.classification === "partial", "one of two required vars present → partial, not absent");
  ok(c.present.length === 1 && c.missing[0] === "T_B", "partial names exactly the missing var");
}
{
  const c = classifyFixture({ T_A: "x", T_B: "y" }, PAIR);
  ok(c.classification === "set", "both required vars present → set");
}
{
  const c = classifyFixture({}, PAIR);
  ok(c.classification === "absent", "neither of two vars present → absent, not partial");
}

const WITH_OPTIONAL: FixtureFamily = {
  id: "github",
  label: "test family with an optional var",
  required: [{ name: "T_REQ" }],
  optional: ["T_OPT_A", "T_OPT_B"],
  scenarios: "test",
  probe: "presence-only",
  presenceOnlyReason: "test fixture",
};

{
  const c = classifyFixture({ T_REQ: "x" }, WITH_OPTIONAL);
  ok(c.classification === "set", "an unset optional var never blocks 'set'");
  ok(c.optionalPresent.length === 0 && c.optionalMissing.length === 2, "both optional vars report as missing when absent");
}
{
  const c = classifyFixture({ T_REQ: "x", T_OPT_A: "y" }, WITH_OPTIONAL);
  ok(c.classification === "set", "a SET optional var still doesn't change the classification");
  ok(c.optionalPresent[0] === "T_OPT_A" && c.optionalMissing[0] === "T_OPT_B", "optional presence is split correctly");
}

const FLAG_GATED: FixtureFamily = {
  id: "connectorWrite",
  label: "test flag-gated family",
  required: [{ name: "T_CHAN" }, { name: "T_FLAG", mustEqual: "1" }],
  scenarios: "test",
  probe: "presence-only",
  presenceOnlyReason: "test fixture",
};

{
  const c = classifyFixture({ T_CHAN: "C1", T_FLAG: "1" }, FLAG_GATED);
  ok(c.classification === "set", "mustEqual: exact match arms the family");
}
{
  const c = classifyFixture({ T_CHAN: "C1", T_FLAG: "0" }, FLAG_GATED);
  ok(c.classification === "partial", "mustEqual: a WRONG value (not the literal) counts as missing, not present");
  ok(c.missing[0] === "T_FLAG", "the flag itself is named missing, not the channel");
}
{
  const c = classifyFixture({ T_FLAG: "1" }, FLAG_GATED);
  ok(c.classification === "partial", "mustEqual satisfied alone, channel missing → still partial");
}

function finding(overrides: Partial<FixtureFinding["classified"]> & { probe?: FixtureFinding["probe"]; notProbed?: string }): FixtureFinding {
  const classified = {
    family: SINGLE,
    classification: "absent" as const,
    present: [],
    missing: ["T_ONE"],
    optionalPresent: [],
    optionalMissing: [],
    ...overrides,
  };
  return { classified, probe: overrides.probe, notProbed: overrides.notProbed };
}

{
  const r = fixtureDoctorResult([finding({ classification: "absent" })]);
  ok(r.ok === true, "an absent-only fixture set is green (a deliberate, honest gap)");
}
{
  const r = fixtureDoctorResult([finding({ classification: "partial", present: ["T_ONE"], missing: [] })]);
  ok(r.ok === false, "a partially-configured fixture is a RED — DEMONSTRATED: flip to false and watch this go false too");
}
{
  const r = fixtureDoctorResult([finding({ classification: "set", present: ["T_ONE"], missing: [], probe: { ok: true, detail: "fine" } })]);
  ok(r.ok === true, "a set fixture with a PASSING probe is green");
}
{
  const r = fixtureDoctorResult([finding({ classification: "set", present: ["T_ONE"], missing: [], probe: { ok: false, detail: "revoked" } })]);
  ok(r.ok === false, "a set fixture with a FAILING probe is the canonical RED — fixture rot");
}
{
  const f = finding({ classification: "set", present: ["T_ONE"], missing: [], notProbed: "presence-only" });
  ok(f.probe === undefined, "negative control: a not-probed finding carries NO probe outcome");
  const r = fixtureDoctorResult([f]);
  ok(r.ok === true, "a set-but-not-probed fixture does not fail the run (unproven, not broken)");
}
{
  const r = fixtureDoctorResult([
    finding({ classification: "absent" }),
    finding({ classification: "set", present: ["T_ONE"], missing: [], probe: { ok: false, detail: "gone" } }),
  ]);
  ok(r.ok === false, "one red among many greens still fails the whole run");
}

{
  const r = fixtureDoctorResult([finding({ classification: "partial", present: ["T_ONE"], missing: [] })]);
  const lines = renderFixtureReport(r).join("\n");
  ok(lines.includes("PARTIALLY CONFIGURED"), "report names the partial section when one exists");
  ok(lines.includes("✗ e2e:fixtures: fixture rot found."), "report's closing verdict is red when ok is false");
}
{
  const r = fixtureDoctorResult([finding({ classification: "absent" })]);
  const lines = renderFixtureReport(r).join("\n");
  ok(lines.includes("NOT CONFIGURED"), "report names the absent section");
  ok(lines.includes("gates: test"), "an absence line names the scenarios it gates");
  ok(lines.includes("✓ e2e:fixtures:"), "report's closing verdict is green when ok is true");
}

{
  const ids = FIXTURE_FAMILIES.map((f) => f.id);
  ok(new Set(ids).size === ids.length, "every family id in the real table is unique — no duplicate Capability entry");
}
{
  for (const f of FIXTURE_FAMILIES) {
    if (f.probe === "slack-channel" || f.probe === "slack-dm-channel")
      ok(typeof f.channelVar === "string" && f.channelVar.length > 0, `${f.probe} family "${f.id}" declares channelVar`);
    if (f.probe === "slack-channel-pair") ok(Array.isArray(f.channelVars) && f.channelVars.length === 2, `slack-channel-pair family "${f.id}" declares two channelVars`);
    if (f.probe === "notion-page-pair") ok(Array.isArray(f.pageVars) && f.pageVars.length === 2, `notion-page-pair family "${f.id}" declares two pageVars`);
    if (f.probe === "linear-label") ok(typeof f.labelVar === "string" && f.labelVar.length > 0, `linear-label family "${f.id}" declares labelVar`);
    if (f.probe === "presence-only") ok(typeof f.presenceOnlyReason === "string" && f.presenceOnlyReason.length > 0, `presence-only family "${f.id}" states why`);
    ok(f.required.length > 0, `family "${f.id}" declares at least one required var`);
    ok(f.scenarios.length > 0, `family "${f.id}" names what it gates`);
  }
}
{
  const classified = classifyAll({}, FIXTURE_FAMILIES);
  ok(classified.length === FIXTURE_FAMILIES.length, "classifyAll returns one entry per declared family");
  ok(classified.every((c) => c.classification === "absent"), "an empty env classifies every real family as absent");
  const findings: FixtureFinding[] = classified.map((c) => ({ classified: c }));
  const result = fixtureDoctorResult(findings);
  ok(result.ok === true, "an empty env (fresh checkout, no .env.e2e) is a green fixture doctor run");
}

{
  const soakSlack = FIXTURE_FAMILIES.find((f) => f.id === "soakSlack")!;
  const soakNotion = FIXTURE_FAMILIES.find((f) => f.id === "soakNotion")!;
  const soakLinear = FIXTURE_FAMILIES.find((f) => f.id === "soakLinear")!;
  ok(soakSlack !== undefined && soakNotion !== undefined && soakLinear !== undefined, "the three OPE-845 soak families are declared in FIXTURE_FAMILIES");

  const fullEnv = {
    E2E_SLACK_SOAK_CHANNEL_DEV: "C1",
    E2E_SLACK_SOAK_CHANNEL_OPS: "C2",
    E2E_NOTION_SOAK_PAGE_1: "P1",
    E2E_NOTION_SOAK_PAGE_2: "P2",
    E2E_SOAK_LINEAR_LABEL_ID: "L1",
    E2E_LINEAR_SOAK_DRIVER_KEY: "lin_key",
    E2E_SOAK_LINEAR_TEAM_ID: "team-soak",
  };
  const fullClassified = classifyAll(fullEnv, [soakSlack, soakNotion, soakLinear]);
  ok(fullClassified.every((c) => c.classification === "set"), "all three vars present on each soak family → classification set");

  const halfEnv = { E2E_SLACK_SOAK_CHANNEL_DEV: "C1", E2E_NOTION_SOAK_PAGE_1: "P1" };
  const halfClassified = classifyAll(halfEnv, [soakSlack, soakNotion, soakLinear]);
  const soakSlackHalf = halfClassified.find((c) => c.family.id === "soakSlack")!;
  const soakNotionHalf = halfClassified.find((c) => c.family.id === "soakNotion")!;
  const soakLinearHalf = halfClassified.find((c) => c.family.id === "soakLinear")!;
  ok(soakSlackHalf.classification === "partial", "one of two Slack channel vars set → partial, not set or absent");
  ok(soakNotionHalf.classification === "partial", "one of two Notion page vars set → partial");
  ok(soakLinearHalf.classification === "absent", "no linear label var at all → absent (an honest gap, not a broken half)");

  const halfFindings: FixtureFinding[] = halfClassified.map((c) => ({ classified: c }));
  const halfResult = fixtureDoctorResult(halfFindings);
  ok(halfResult.ok === false, "a half-provisioned soak Slack/Notion pair flips the doctor RED — this is the assertion that goes false if the partial branch is ever dropped");
}

console.log(`✓ fixture-doctor-lib: ${passed} assertions passed`);
