import assert from "node:assert/strict";
import {
  RESOURCE_CAPABILITIES,
  RESOURCE_CAPABILITY_NAMES,
  DEFAULT_RESOURCE_CAPABILITIES,
  isResourceCapability,
  resourceCapabilityProblems,
  unionResourceCapabilities,
} from "../agent/access/resource-capabilities.js";
import {
  RESOURCE_CONNECTORS,
  parseResourceAddress,
  resourceAddress,
  resourceGrantCapabilities,
  resourceGrantProblems,
  resourceTypesFor,
  type ResourceGrant,
} from "../agent/access/resource-grant.js";
import { assertBundlesValid, type Bundle } from "../agent/access/bundle.js";
import { resolveAccess } from "../agent/access/resolver.js";
import {
  ChatWriteGrantError,
  CONTAINER_RESOURCE_TYPE,
  chatWriteTargetsFrom,
  resolveChatWriteTargetFrom,
} from "../agent/access/chat-write-grant.js";
import { TOOL_CONSEQUENCE } from "../agent/access/consequence.js";
import { surfaceKeySegment } from "../agent/identity/binding.js";
import type { Domain } from "../agent/memory/domain.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const throws = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

const HOME = "slack/T1/C_HOME";
const ELSEWHERE_ID = "C_ELSEWHERE";
const OTHER_ID = "C_OTHER";
const D_HOME_ID = "900000000000000001";
const D_HOME = `discord/G1/${D_HOME_ID}`;
const D_ELSEWHERE_ID = "900000000000000002";
const D_OTHER_ID = "900000000000000003";
const T_RAW_ELSEWHERE = "19:engTeamsConversation@thread.tacv2";
const T_ELSEWHERE_ID = surfaceKeySegment(T_RAW_ELSEWHERE);
const T_RAW_HOME = "19:engTeamsHome@thread.tacv2;messageid=17";
const T_HOME = `teams/TENANT1/${surfaceKeySegment(T_RAW_HOME)}`;
const T_OTHER_ID = surfaceKeySegment("19:financeTeamsConversation@thread.tacv2");
const DOMAINS: readonly Domain[] = [
  { name: "eng", reach: [HOME, `slack/T1/${ELSEWHERE_ID}`, D_HOME, `discord/G1/${D_ELSEWHERE_ID}`, T_HOME, `teams/TENANT1/${T_ELSEWHERE_ID}`] },
  { name: "finance", reach: [`slack/T1/${OTHER_ID}`, `discord/G1/${D_OTHER_ID}`, `teams/TENANT1/${T_OTHER_ID}`] },
];
const ELSEWHERE = resourceAddress("slack", CONTAINER_RESOURCE_TYPE, ELSEWHERE_ID);
const OTHER = resourceAddress("slack", CONTAINER_RESOURCE_TYPE, OTHER_ID);
const D_ELSEWHERE = resourceAddress("discord", CONTAINER_RESOURCE_TYPE, D_ELSEWHERE_ID);
const D_OTHER = resourceAddress("discord", CONTAINER_RESOURCE_TYPE, D_OTHER_ID);
const T_ELSEWHERE = resourceAddress("teams", CONTAINER_RESOURCE_TYPE, T_ELSEWHERE_ID);
const T_OTHER = resourceAddress("teams", CONTAINER_RESOURCE_TYPE, T_OTHER_ID);

{
  ok(RESOURCE_CAPABILITY_NAMES.length > 0, "the resource capability vocabulary is non-empty");
  for (const name of RESOURCE_CAPABILITY_NAMES) {
    ok(
      typeof RESOURCE_CAPABILITIES[name]?.summary === "string" && RESOURCE_CAPABILITIES[name].summary.length > 0,
      `capability "${name}" carries an operator-facing summary`,
    );
  }
  ok(isResourceCapability("post"), "`post` is implemented");
  ok(!isResourceCapability("chat:write"), "a raw vendor permission string is NOT a capability");
  ok(!isResourceCapability("posts"), "a near-miss typo is NOT a capability");
  ok(DEFAULT_RESOURCE_CAPABILITIES.includes("post"), "an unadorned row defaults to `post`");
  for (const name of DEFAULT_RESOURCE_CAPABILITIES) {
    ok(isResourceCapability(name), `the default capability "${name}" is in the closed set`);
  }
  ok(
    JSON.stringify(unionResourceCapabilities(["post"], ["post"])) === JSON.stringify(["post"]),
    "the capability union dedupes",
  );

  ok(resourceCapabilityProblems("row", undefined).length === 0, "an absent `capabilities` is valid (it means the default)");
  ok(resourceCapabilityProblems("row", ["post"]).length === 0, "the default spelled out explicitly is valid");
  const empty = resourceCapabilityProblems("row", []);
  ok(empty.length === 1 && empty[0]!.includes("grants nothing"), "`capabilities: []` refuses, naming what it would grant");
  const raw = resourceCapabilityProblems("row", ["chat:write"]);
  ok(raw.length === 1, "an unknown capability refuses");
  ok(
    raw[0]!.includes("never raw vendor permission strings"),
    "the unknown-capability error says a capability is a NAME we implement, never a vendor permission string",
  );
  ok(raw[0]!.includes('"post"'), "the unknown-capability error lists the implemented vocabulary");
  ok(resourceCapabilityProblems("row", ["post", "post"]).length === 1, "a duplicate capability refuses");
}

{
  const parsed = parseResourceAddress("slack:channel/C0123ABC");
  ok(parsed?.connector === "slack" && parsed.type === "channel" && parsed.id === "C0123ABC", "a well-formed address parses into three facts");
  ok(resourceAddress("slack", "channel", "C0123ABC") === "slack:channel/C0123ABC", "the composer round-trips the parser");
  for (const bad of [
    "C0123ABC",
    "slack:channel",
    "slack:/C1",
    ":channel/C1",
    "slack:channel/",
    "slack:channel/C1/extra",
    "slack:chan:nel/C1",
    "slack:channel/*",
    "slack:channel/C 1",
  ]) {
    ok(parseResourceAddress(bad) === undefined, `malformed address ${JSON.stringify(bad)} refuses to parse`);
  }
  ok(parseResourceAddress("slack:channel/C*") === undefined, "a glob id is unnameable — tier P4 has no spelling");
  ok(RESOURCE_CONNECTORS.includes("slack"), "slack is an implemented connector");
  ok(resourceTypesFor("slack").includes(CONTAINER_RESOURCE_TYPE), "slack implements the container resource type");
  ok(RESOURCE_CONNECTORS.includes("discord"), "discord is an implemented connector");
  ok(resourceTypesFor("discord").includes(CONTAINER_RESOURCE_TYPE), "discord implements the container resource type");
  const parsedDiscord = parseResourceAddress(D_ELSEWHERE);
  ok(
    parsedDiscord?.connector === "discord" && parsedDiscord.type === "channel" && parsedDiscord.id === D_ELSEWHERE_ID,
    "a discord container address parses into three facts, snowflake id intact",
  );

  ok(RESOURCE_CONNECTORS.includes("teams"), "teams is an implemented connector");
  ok(resourceTypesFor("teams").includes(CONTAINER_RESOURCE_TYPE), "teams implements the container resource type");
  ok(parseResourceAddress("teams:channel/19:x@thread.tacv2") === undefined, "a RAW teams conversation address does not parse — a second colon is still refused");
  ok(parseResourceAddress("teams:person/29:1abc") === undefined, "a RAW teams person address does not parse either — the grammar is unchanged");
  const parsedTeams = parseResourceAddress(T_ELSEWHERE);
  ok(
    parsedTeams?.connector === "teams" && parsedTeams.type === "channel" && parsedTeams.id === T_ELSEWHERE_ID,
    "the SPELLED teams container address parses into three facts",
  );
  ok(parsedTeams!.id !== T_RAW_ELSEWHERE, "…and its id is NOT the raw Bot Framework id — the two really are different strings");
  ok(surfaceKeySegment(T_ELSEWHERE_ID) === T_ELSEWHERE_ID, "the spelling is idempotent, so an address id and a roster id cannot drift apart");
}

{
  const row = (grant: ResourceGrant): Bundle => ({ name: "eng", resourceGrants: [grant] });

  ok(resourceGrantProblems("b", [{ connector: "slack", resources: [ELSEWHERE] }]).length === 0, "a bare row is valid");
  ok(
    resourceGrantProblems("b", [{ connector: "slack", resources: [ELSEWHERE], capabilities: ["post"] }]).length === 0,
    "a row naming the capability explicitly is valid",
  );
  ok(resourceGrantProblems("b", undefined).length === 0, "a bundle with no resourceGrants is valid — that is tier P0");
  assert.doesNotThrow(() => assertBundlesValid([row({ connector: "slack", resources: [ELSEWHERE] })]));
  n++;
  ok(
    JSON.stringify(resourceGrantCapabilities({ connector: "slack", resources: [ELSEWHERE] })) ===
      JSON.stringify(DEFAULT_RESOURCE_CAPABILITIES),
    "a row with no `capabilities` reads as the default",
  );

  const unknownConnector = throws(() =>
    assertBundlesValid([row({ connector: "irc", resources: ["irc:channel/x"] })]),
  );
  ok(unknownConnector !== "", "an unknown connector THROWS at config load — it does not load silently");
  ok(unknownConnector.includes('unknown connector "irc"'), "the unknown-connector error names the connector");
  ok(unknownConnector.includes('"slack"'), "the unknown-connector error lists what IS implemented");
  ok(unknownConnector.includes('"discord"'), "the unknown-connector error lists discord too — the list is the closed table, not a literal");

  ok(resourceGrantProblems("b", [{ connector: "discord", resources: [D_ELSEWHERE] }]).length === 0, "a bare discord container row is valid");
  assert.doesNotThrow(() => assertBundlesValid([row({ connector: "discord", resources: [D_ELSEWHERE] })]));
  n++;
  ok(
    JSON.stringify(resourceGrantCapabilities({ connector: "discord", resources: [D_ELSEWHERE] })) ===
      JSON.stringify(DEFAULT_RESOURCE_CAPABILITIES),
    "a bare discord row reads as the same container default a slack row does",
  );

  const ircRow = throws(() => assertBundlesValid([row({ connector: "irc", resources: ["irc:channel/CONV1"] })]));
  ok(ircRow.includes('unknown connector "irc"'), "an unimplemented connector's resource row refuses at config load");
  ok(ircRow.includes("never in config"), "the refusal says a connector is added in the diff that wires its transport");
  ok(throws(() => assertBundlesValid([row({ connector: "teams", resources: [T_ELSEWHERE] })])) === "", "a teams row at the spelled id loads");
  const rawTeamsRow = throws(() => assertBundlesValid([row({ connector: "teams", resources: [`teams:channel/${T_RAW_ELSEWHERE}`] })]));
  ok(rawTeamsRow.includes("malformed resource"), "a teams row at the RAW id refuses at load as malformed — never silently");

  const malformed = throws(() => assertBundlesValid([row({ connector: "slack", resources: ["C0123ABC"] })]));
  ok(malformed !== "", "a malformed address THROWS at config load");
  ok(malformed.includes("malformed resource"), "the malformed-address error says the address is malformed");
  ok(malformed.includes("<connector>:<type>/<id>"), "the malformed-address error states the address form");
  ok(malformed.includes("No wildcards"), "the malformed-address error states that a grant names containers one by one");

  const mismatch = throws(() => assertBundlesValid([row({ connector: "slack", resources: ["discord:channel/1"] })]));
  ok(mismatch.includes("but the row's `connector` is"), "an address on a different connector from its row refuses");

  const badType = throws(() => assertBundlesValid([row({ connector: "slack", resources: ["slack:dm/U1"] })]));
  ok(badType.includes("resource type"), "an unimplemented resource type refuses at config load");

  ok(throws(() => assertBundlesValid([row({ connector: "slack", resources: [] })])).includes("declares no `resources`"), "an empty resources list refuses");
  ok(
    throws(() => assertBundlesValid([row({ connector: "slack", resources: [ELSEWHERE], capabilities: [] })])).includes("grants nothing"),
    "an empty capabilities list refuses through the bundle validator too",
  );
  ok(
    throws(() =>
      assertBundlesValid([{ name: "eng", resourceGrants: [{ connector: "slack", resources: [ELSEWHERE, ELSEWHERE] }] }]),
    ).includes("more than once"),
    "a duplicate address in one bundle refuses",
  );
  ok(
    throws(() => assertBundlesValid([row({ connector: "slack", resources: [ELSEWHERE], capabilities: ["chat:write"] as never })])).includes(
      "never raw vendor permission strings",
    ),
    "a raw vendor permission string refuses through the bundle validator",
  );
}

{
  const request = { mode: "channel", platform: "slack", workspace: "T1", channel: "C_HOME", domains: ["eng"] } as const;
  const bind = (bundle: string) => ({ bundle, scope: { level: "org" } as const });

  const none = resolveAccess({ ...request }, [{ name: "b1" }], [bind("b1")]);
  ok(Object.keys(none.resourceCapabilities).length === 0, "a deployment with no grant resolves an EMPTY resource map (tier P0)");

  const one = resolveAccess({ ...request }, [{ name: "b1", resourceGrants: [{ connector: "slack", resources: [ELSEWHERE] }] }], [bind("b1")]);
  ok(JSON.stringify(one.resourceCapabilities[ELSEWHERE]) === JSON.stringify(["post"]), "a bare grant resolves the default capability");

  const two = resolveAccess(
    { ...request },
    [
      { name: "b1", resourceGrants: [{ connector: "slack", resources: [ELSEWHERE] }] },
      { name: "b2", resourceGrants: [{ connector: "slack", resources: [ELSEWHERE], capabilities: ["post"] }] },
    ],
    [bind("b1"), bind("b2")],
  );
  ok(JSON.stringify(two.resourceCapabilities[ELSEWHERE]) === JSON.stringify(["post"]), "two bundles granting one address union, deduped");
  ok(Object.keys(two.resourceCapabilities).length === 1, "the union does not invent addresses");

  const unbound = resolveAccess({ ...request }, [{ name: "b1" }, { name: "b2", resourceGrants: [{ connector: "slack", resources: [ELSEWHERE] }] }], [bind("b1")]);
  ok(unbound.resourceCapabilities[ELSEWHERE] === undefined, "an UNBOUND bundle's grant does not reach this scope");
}

{
  const granted = { [ELSEWHERE]: ["post"] as const };

  const targets = chatWriteTargetsFrom(HOME, granted, DOMAINS);
  ok(targets.length === 1, "a granted in-domain container is a target");
  ok(targets[0]!.platform === "slack" && targets[0]!.container === ELSEWHERE_ID, "the target parses to platform + container");
  ok(targets[0]!.address === ELSEWHERE, "the target carries the grant address verbatim — what the card and the audit row quote");
  const resolved = resolveChatWriteTargetFrom(HOME, granted, DOMAINS, ELSEWHERE);
  ok(resolved.container === ELSEWHERE_ID && resolved.address === ELSEWHERE, "the fence returns the resolved target for the caller to freeze");

  ok(chatWriteTargetsFrom(HOME, {}, DOMAINS).length === 0, "with NO grant there is no target — tier P0 is unchanged");
  let err: unknown;
  try {
    resolveChatWriteTargetFrom(HOME, {}, DOMAINS, ELSEWHERE);
  } catch (e) {
    err = e;
  }
  ok(err instanceof ChatWriteGrantError, "an ungranted target throws ChatWriteGrantError");
  ok((err as ChatWriteGrantError).boundary === "ungranted", "the ungranted refusal names the GRANT boundary");
  ok((err as ChatWriteGrantError).message.includes("not granted to this scope"), "the ungranted refusal says the scope holds no grant");
  ok((err as ChatWriteGrantError).message.includes("resourceGrants"), "the ungranted refusal names the remedy: a bundle row");

  const crossGranted = { [OTHER]: ["post"] as const };
  ok(chatWriteTargetsFrom(HOME, crossGranted, DOMAINS).length === 0, "a granted container in ANOTHER domain is not a target");
  let crossErr: unknown;
  try {
    resolveChatWriteTargetFrom(HOME, crossGranted, DOMAINS, OTHER);
  } catch (e) {
    crossErr = e;
  }
  ok(crossErr instanceof ChatWriteGrantError, "a cross-domain target throws even though it IS granted");
  ok((crossErr as ChatWriteGrantError).boundary === "cross-domain", "the cross-domain refusal names the DOMAIN boundary, not the grant");
  ok(
    (crossErr as ChatWriteGrantError).message.includes("not in this session's memory domain"),
    "the cross-domain refusal names the boundary that stopped it",
  );
  ok(
    (crossErr as ChatWriteGrantError).message.includes("`reach`"),
    "🔴 OPE-1790: the remedy names the domain's `reach` roster — the field the loader actually reads",
  );
  ok(
    !/\bchannels\b/.test((crossErr as ChatWriteGrantError).message),
    "🔴 OPE-1790: …and never `channels`, which `Domain` does not declare",
  );
  ok(
    (crossErr as ChatWriteGrantError).message !== (err as ChatWriteGrantError).message,
    "the two refusals are DIFFERENT messages — the remedies live in different files",
  );

  ok(chatWriteTargetsFrom(HOME, { [ELSEWHERE]: [] }, DOMAINS).length === 0, "an address granted with NO capability is not a target");

  ok(chatWriteTargetsFrom(HOME, { "irc:channel/CONV1": ["post"] }, DOMAINS).length === 0, "an unimplemented connector's address grants nothing");

  const teamsGranted = { [T_ELSEWHERE]: ["post" as const], [T_OTHER]: ["post" as const] };
  const teamsTargets = chatWriteTargetsFrom(T_HOME, teamsGranted, DOMAINS);
  ok(teamsTargets.length === 1, "a teams caller resolves exactly ONE granted in-domain container");
  ok(teamsTargets[0]?.address === T_ELSEWHERE && teamsTargets[0]?.container === T_ELSEWHERE_ID, "…the in-domain one, at the address spelling the transport restores from");
  ok(
    resolveChatWriteTargetFrom(T_HOME, teamsGranted, DOMAINS, T_ELSEWHERE).container === T_ELSEWHERE_ID,
    "…and the per-call fence admits it: the grant names it AND the caller's roster holds it",
  );
  ok(
    (throws(() => resolveChatWriteTargetFrom(T_HOME, teamsGranted, DOMAINS, T_OTHER)) as string).includes("not in this session's memory domain"),
    "…while a GRANTED teams container in another domain is still refused cross-domain — the negative control",
  );

  let shapeErr: unknown;
  try {
    resolveChatWriteTargetFrom(HOME, granted, DOMAINS, ELSEWHERE_ID);
  } catch (e) {
    shapeErr = e;
  }
  ok(shapeErr instanceof ChatWriteGrantError, "a bare container id (no address form) refuses");
  ok((shapeErr as ChatWriteGrantError).message.includes("is not a container address"), "the shape refusal states the address form");
  ok((shapeErr as ChatWriteGrantError).boundary === "malformed", "a malformed address is its OWN boundary, never `ungranted`");

  ok(chatWriteTargetsFrom("", granted, DOMAINS).length === 0, "an empty caller surface key yields no target");
  ok(
    throws(() => resolveChatWriteTargetFrom(undefined, granted, DOMAINS, ELSEWHERE)) !== "",
    "an unresolvable caller surface refuses the write",
  );

  const home = resourceAddress("slack", CONTAINER_RESOURCE_TYPE, "C_HOME");
  ok(chatWriteTargetsFrom(HOME, {}, DOMAINS).find((t) => t.address === home) === undefined, "the arrival container is not a P1 target without a grant");
  ok(chatWriteTargetsFrom(HOME, { [home]: ["post"] }, DOMAINS).some((t) => t.address === home), "a granted arrival container is a P1 target");
  const dHome = resourceAddress("discord", CONTAINER_RESOURCE_TYPE, D_HOME_ID);
  ok(chatWriteTargetsFrom(D_HOME, { [dHome]: ["post"] }, DOMAINS).some((t) => t.address === dHome), "a granted arrival discord container is a P1 target");
}

{
  const dGranted = { [D_ELSEWHERE]: ["post"] as const };

  const fromDiscord = chatWriteTargetsFrom(D_HOME, dGranted, DOMAINS);
  ok(fromDiscord.length === 1, "a granted in-domain discord container is a target for a discord caller");
  ok(fromDiscord[0]!.platform === "discord" && fromDiscord[0]!.container === D_ELSEWHERE_ID, "the discord target parses to platform + container");
  ok(fromDiscord[0]!.address === D_ELSEWHERE, "the discord target carries the grant address verbatim");

  const fromSlack = chatWriteTargetsFrom(HOME, dGranted, DOMAINS);
  ok(fromSlack.length === 1 && fromSlack[0]!.address === D_ELSEWHERE, "a SLACK caller may name a granted DISCORD container its own domain rosters");
  const resolvedCross = resolveChatWriteTargetFrom(HOME, dGranted, DOMAINS, D_ELSEWHERE);
  ok(resolvedCross.platform === "discord" && resolvedCross.container === D_ELSEWHERE_ID, "the fence resolves the cross-surface target for the caller to freeze");

  let dUngranted: unknown;
  try {
    resolveChatWriteTargetFrom(D_HOME, {}, DOMAINS, D_ELSEWHERE);
  } catch (e) {
    dUngranted = e;
  }
  ok(dUngranted instanceof ChatWriteGrantError, "an ungranted discord container throws ChatWriteGrantError");
  ok((dUngranted as ChatWriteGrantError).boundary === "ungranted", "the discord ungranted refusal names the GRANT boundary");
  ok((dUngranted as ChatWriteGrantError).platform === "discord", "the refusal names the DESTINATION's platform, which is what the audit row files under");
  ok((dUngranted as ChatWriteGrantError).message.includes("resourceGrants"), "the discord ungranted refusal names the remedy: a bundle row");

  const dCross = { [D_OTHER]: ["post"] as const };
  ok(chatWriteTargetsFrom(D_HOME, dCross, DOMAINS).length === 0, "a granted discord container in ANOTHER domain is not a target");
  let dCrossErr: unknown;
  try {
    resolveChatWriteTargetFrom(D_HOME, dCross, DOMAINS, D_OTHER);
  } catch (e) {
    dCrossErr = e;
  }
  ok((dCrossErr as ChatWriteGrantError).boundary === "cross-domain", "the discord cross-domain refusal names the DOMAIN boundary, not the grant");
  ok((dCrossErr as ChatWriteGrantError).message.includes("memory/config/domains/<domain>.ts"), "the discord cross-domain refusal names the DOMAIN remedy");

  const slackOnly: readonly Domain[] = [{ name: "solo", reach: [HOME] }];
  ok(chatWriteTargetsFrom(HOME, dGranted, slackOnly).length === 0, "a caller whose domain rosters NO discord container names no discord target");
  let soloErr: unknown;
  try {
    resolveChatWriteTargetFrom(HOME, dGranted, slackOnly, D_ELSEWHERE);
  } catch (e) {
    soloErr = e;
  }
  ok((soloErr as ChatWriteGrantError).boundary === "cross-domain", "…and it refuses as cross-domain, naming the roster rather than the grant");

  ok(chatWriteTargetsFrom(HOME, dGranted, DOMAINS).some((t) => t.platform === "slack") === false, "a discord grant admits no slack container");
}

{
  const row = TOOL_CONSEQUENCE["post_message"];
  ok(row !== undefined, "post_message carries a TOOL_CONSEQUENCE row");
  ok(row!.tier === "gate:member", "post_message is gate:member — a post beyond the asking room is consequential");
  ok(row!.via.kind === "action-kind" && row!.via.action === "chat.post", "post_message proposes the chat.post ActionKind");
  const { actionKind } = await import("../agent/approvals/actions.js");
  await import("../agent/approvals/chat-post.js");
  ok(actionKind("chat.post") !== undefined, "the chat.post ActionKind is registered");
  ok(actionKind("chat.post")!.policy === "member", "the chat.post kind's policy matches its tier");
}

{
  const { POST_MESSAGE_DESCRIPTION } = await import("../agent/tools/post_message.js");
  const { CONTRIBUTIONS } = await import("../agent/contributions.js");
  const summary = CONTRIBUTIONS.contributions.find((c) => c.kind === "tool" && c.name === "post_message")?.summary ?? "";
  const denies = /\bANOTHER container\b|not the one you are|other than the one|only targets another/iu;
  for (const [what, text] of [["description", POST_MESSAGE_DESCRIPTION], ["contribution summary", summary]] as const) {
    ok(text.length > 0, `🔴 post_message ${what} exists`);
    ok(!denies.test(text), `🔴 post_message ${what} does not forbid the granted arrival container`);
    ok(/\breply\b/u.test(text), `post_message ${what} still sends an answer to reply`);
  }
  ok(/current one too, when granted/u.test(summary), "🔴 the contribution summary says the current container is allowed when granted");
  ok(/channel you are in is allowed when it is granted/u.test(POST_MESSAGE_DESCRIPTION), "🔴 the description says the current channel is allowed when granted");
  ok(POST_MESSAGE_DESCRIPTION.includes("slack:") && POST_MESSAGE_DESCRIPTION.includes("discord:"), "the description shows an address on each surface");
  ok(POST_MESSAGE_DESCRIPTION.length <= 600, `the description stays brief (${POST_MESSAGE_DESCRIPTION.length} chars)`);
}

console.log(`chat-write-grant: ${n} assertions passed`);
