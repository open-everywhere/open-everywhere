import {
  registerConfig,
  registerEventNormalizer,
  registerEventScopeGrant,
  eventNormalizer,
  eventScopeGrant,
  resetEventNormalizersForTest,
  resetEventScopeGrantsForTest,
  checkEventReadGrant,
  validateSubscription,
  declareProviderSelection,
  defineBundle,
  defineBinding,
  defineDomain,
  resolveDomainForChannel,
  registeredWebhookVerifiers,
  type Domain,
  type EffectiveAccess,
  type EventScopeGrant,
  type NormalizedEvent,
  type Partition,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  linearEventNormalizer,
  linearEventScopeGrant,
  linearEventClass,
  linearScopePath,
  linearTeamId,
  liftLinearEvent,
  LINEAR_EVENT_SOURCE,
  LINEAR_DELIVERY_ID_HEADER,
  LINEAR_WORK_TYPES,
  LINEAR_CONVERSATIONAL_TYPES,
  LINEAR_AGENT_SESSION_TYPE,
  type LinearEventEnvelope,
} from "../agent/channels/linear-event-normalizer.js";
import { extractLinearCommentSignal } from "../agent/channels/linear-supervisor.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const ORG = "org-1111";
const TEAM = "team-2222";
const OTHER_TEAM = "team-3333";
const UNLISTED_TEAM = "team-9999";
const PROJECT = "proj-4444";
const ISSUE = "issue-5555";

const TEAM_DOMAINS: Record<string, readonly string[]> = {
  [TEAM]: ["payments"],
  [OTHER_TEAM]: ["security"],
};

let CLAIM_REGISTRY: readonly Domain[] = [];

registerConfig({
  loadBundles: () => [defineBundle({ name: "org-default" })],
  loadBindings: () => [defineBinding({ bundle: "org-default", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => CLAIM_REGISTRY,
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) => {
    if (workspaceKey !== `linear/${ORG}`) return [];
    const roster = TEAM_DOMAINS[surface];
    if (roster) return roster;
    const claimed = resolveDomainForChannel(`${workspaceKey}/${surface}`, CLAIM_REGISTRY).domain;
    return claimed ? [claimed.name] : [];
  },
});

function accessIn(...domains: string[]): EffectiveAccess {
  return {
    mode: "channel",
    scopeKey: "linear/test",
    tenantKey: "linear/test",
    surfaceKey: "linear/test/team",
    domains,
    connections: [],
    reachableHosts: [],
    repos: [],
    awsRoles: [], approvers: [],
    plugins: [],
    skills: [],
    subagents: [],
    connectors: [],
    connectorTrust: {},
    connectorCredentials: {},
    instructionStack: [],
    warnings: [],
  };
}

const PARTITION: Partition = {
  org: "acme",
  platform: "slack",
  workspace: "T1",
  surface: "C1",
  workspaceKey: "slack/T1",
  surfaceKey: "slack/T1/C1",
  key: "slack/T1/C1",
};

function issueBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "create",
    type: "Issue",
    createdAt: "2026-07-29T10:00:00.000Z",
    organizationId: ORG,
    url: "https://linear.app/acme/issue/ENG-42",
    actor: { id: "user-1", name: "Alice" },
    data: {
      id: ISSUE,
      identifier: "ENG-42",
      title: "Ship </untrusted> the thing",
      teamId: TEAM,
      projectId: PROJECT,
    },
    ...overrides,
  });
}

function normalize(body: string): NormalizedEvent | null {
  return linearEventNormalizer.normalize({ source: LINEAR_EVENT_SOURCE, headers: {}, body, receivedAt: "2026-07-29T10:00:01.000Z" });
}

registerEventNormalizer(linearEventNormalizer);
registerEventScopeGrant(linearEventScopeGrant);

{
  ok(LINEAR_EVENT_SOURCE === "linear", "the event source key is the vendor's own name");
  ok(
    linearEventNormalizer.source === LINEAR_EVENT_SOURCE && linearEventScopeGrant.source === LINEAR_EVENT_SOURCE,
    "the normalizer and the scope grant register under ONE key — a delivery that normalizes as linear is authorized as linear",
  );
  ok(
    linearEventNormalizer.provider === "linear" && linearEventScopeGrant.provider === "linear",
    "both entries are PROVIDER-owned, so a de-selected bundle contributes neither",
  );

  ok(
    linearEventNormalizer.scopeKinds.length === 4 &&
      ["tenant", "group", "container", "entity"].every((k) => (linearEventNormalizer.scopeKinds as readonly string[]).includes(k)),
    "FOUR ScopeKinds are declared — tenant/group/container/entity",
  );
  ok(
    !(linearEventNormalizer.scopeKinds as readonly string[]).includes("sub"),
    "`sub` is NOT declared: the only sub-issue entity Linear webhooks carry is the Comment, and the Comment family is the ambient supervisor's — an `under: [{sub}]` selector could never match",
  );

  ok(
    !linearEventNormalizer.scopeKeys.includes("organization"),
    "`organization` is NOT a scopeKey — otherwise `organization in [org]` would satisfy mandatory narrowing while subscribing to the entire workspace",
  );
  ok(
    linearEventNormalizer.matchKeys.includes("organization"),
    "…but `organization` IS filterable — the rule it must not satisfy is narrowing, not matching",
  );
  ok(
    linearEventNormalizer.scopeKeys.every((k) => linearEventNormalizer.matchKeys.includes(k)),
    "every scopeKey is a matchKey — scopeKeys is documented as a SUBSET, and a scope key nobody may name would be unusable",
  );
  ok(
    !linearEventNormalizer.matchKeys.includes("title") && !linearEventNormalizer.matchKeys.includes("url"),
    "`title` and `url` are carried for RENDERING but are not filterable — title is attacker-authored prose, url is per-entity",
  );

  ok(linearEventNormalizer.deliveryIdHeader === LINEAR_DELIVERY_ID_HEADER, "the delivery-id header is DECLARED, so the shared ingress can arm replay dedupe without hardcoding a vendor header");
  ok(LINEAR_DELIVERY_ID_HEADER === LINEAR_DELIVERY_ID_HEADER.toLowerCase(), "…and it is lowercased, per TriggerDelivery.headers");
  ok(linearEventNormalizer.scopeHookConstant !== true, "scope is PAYLOAD-derived and correctly declares so — Linear signs the delivery and is authoritative about which org/team/project/issue it came from");
}

{
  ok(linearEventClass(JSON.parse(issueBody()) as LinearEventEnvelope) === "work", "an Issue delivery is WORK — the routing plane's");
  ok(normalize(issueBody()) !== null, "…and it really does produce a routable event");

  for (const action of ["create", "update", "remove"]) {
    const body = JSON.stringify({ action, type: "Comment", organizationId: ORG, data: { id: "c1", issue: { teamId: TEAM } } });
    ok(linearEventClass(JSON.parse(body) as LinearEventEnvelope) === "conversational", `a Comment ${action} delivery is CONVERSATION`);
    ok(normalize(body) === null, `…and normalizes to null, so no routine can ever fire on it (${action})`);
  }
  ok(
    extractLinearCommentSignal({ kind: "data", type: "Comment", action: "create", organizationId: ORG, raw: { data: { id: "c1" } } }) !== null,
    "the ambient supervisor still takes the Comment create it always took — this partition removed nothing from it",
  );
  ok(
    extractLinearCommentSignal({ kind: "data", type: "Issue", action: "create", organizationId: ORG, raw: { data: { id: ISSUE } } }) === null,
    "…and the supervisor never sees an Issue delivery, so a structural event cannot double-drive it",
  );

  const sessionByType = JSON.stringify({ action: "created", type: LINEAR_AGENT_SESSION_TYPE, organizationId: ORG, data: { id: "sess-1" } });
  ok(linearEventClass(JSON.parse(sessionByType) as LinearEventEnvelope) === "agent-session", "an AgentSessionEvent delivery is the MENTION leg's");
  ok(normalize(sessionByType) === null, "…and normalizes to null — the mention leg is NOT reduced to an adapter over the event plane");
  const sessionByObject = JSON.stringify({ action: "prompted", type: "Issue", organizationId: ORG, agentSession: { id: "s1", issueId: ISSUE }, data: { id: ISSUE, teamId: TEAM } });
  ok(linearEventClass(JSON.parse(sessionByObject) as LinearEventEnvelope) === "agent-session", "the agentSession OBJECT alone is enough to classify — the arm does not depend on being right about the type string");
  ok(normalize(sessionByObject) === null, "…so a session-shaped payload wearing an Issue type still fires nothing");

  for (const type of ["Project", "Cycle", "IssueLabel", "Document", "Reaction"]) {
    const body = JSON.stringify({ action: "create", type, organizationId: ORG, data: { id: "x", teamId: TEAM } });
    ok(linearEventClass(JSON.parse(body) as LinearEventEnvelope) === "unrecognised", `\`${type}\` is not on the reviewed allowlist`);
    ok(normalize(body) === null, `…and normalizes to null (${type})`);
  }
  ok(LINEAR_WORK_TYPES.length === 1 && LINEAR_WORK_TYPES[0] === "Issue", "the allowlist is exactly Issue — every other model's team-proving is unverified, and this tree does not enumerate schema values without evidence");
  ok(LINEAR_CONVERSATIONAL_TYPES.includes("Comment"), "Comment is named explicitly rather than left to the unrecognised bucket, so the omission reads as deliberate");
  ok(
    LINEAR_WORK_TYPES.every((t) => !LINEAR_CONVERSATIONAL_TYPES.includes(t)) && !LINEAR_WORK_TYPES.includes(LINEAR_AGENT_SESSION_TYPE),
    "the three vocabularies are DISJOINT — no type can be claimed by two consumers",
  );

  ok(normalize("not json") === null, "an unparseable body is not routable");
  ok(normalize("[]") === null, "a non-object body is not routable");
  ok(normalize(JSON.stringify({ organizationId: ORG })) === null, "a delivery with no type at all is unrecognised, not routed");
}

{
  const ev = normalize(issueBody())!;
  ok(
    ev.scope.map((s) => s.kind).join(">") === "tenant>group>container>entity",
    "a project-assigned issue proves FOUR kinds at once — outermost-first",
  );
  ok(ev.scope.map((s) => s.id).join(">") === `${ORG}>${TEAM}>${PROJECT}>${ISSUE}`, "…with the vendor's own ids at each step");
  ok(
    ev.scope.some((s) => s.kind === "group") && ev.scope.some((s) => s.kind === "container"),
    "Linear does NOT have Notion's mutual-exclusivity property — group and container coexist on one delivery",
  );
  ok(!ev.scope.some((s) => s.kind === "sub"), "…and `sub` is never proved, on any delivery");

  const noProject = normalize(issueBody({ data: { id: ISSUE, teamId: TEAM } }))!;
  ok(noProject.scope.map((s) => s.kind).join(">") === "tenant>group>entity", "an issue with no project proves three kinds — a shorter path is coarser, never wrongly narrower");

  ok(linearTeamId({ data: { teamId: TEAM } }) === TEAM, "team probe: data.teamId");
  ok(linearTeamId({ data: { team: { id: TEAM } } }) === TEAM, "team probe: data.team.id");
  ok(linearTeamId({ data: { issue: { teamId: TEAM } } }) === TEAM, "team probe: data.issue.teamId");
  ok(linearTeamId({ data: { issue: { team: { id: TEAM } } } }) === TEAM, "team probe: data.issue.team.id");
  ok(linearTeamId({ data: { id: ISSUE } }) === undefined, "…and a payload proving no team returns undefined rather than guessing");
  ok(linearTeamId({ data: { teamId: "" } }) === undefined, "…as does a blank one");

  const teamless = normalize(issueBody({ data: { id: ISSUE } }))!;
  ok(teamless !== null && !teamless.scope.some((s) => s.kind === "group"), "a teamless Issue delivery still normalizes — the refusal belongs to the grant, where it is audited");

  ok(linearScopePath({}).length === 0, "an empty envelope proves an EMPTY path — which core's own `no-scope` arm then refuses");
}

{
  const ev = normalize(issueBody())!;
  ok(ev.event === "Issue" && ev.action === "create", "the vendor's type and action are carried VERBATIM, in the two fields Linear itself splits them into");
  ok(ev.fields["team"] === TEAM && ev.fields["project"] === PROJECT && ev.fields["issue"] === ISSUE, "the scope ids are matchable");
  ok(ev.fields["identifier"] === "ENG-42" && ev.fields["title"]?.includes("Ship") === true, "…and the human handles are carried for rendering");
  ok(ev.occurredAt === "2026-07-29T10:00:00.000Z", "occurredAt is the SOURCE's time, not our receive time");
  ok(ev.actor?.id === "user-1" && ev.actor?.handle === "Alice", "the actor is carried (nothing reads it yet — OPE-192 — but the answer is honest)");
  ok(ev.pointer?.platform === "linear" && ev.pointer.id === ISSUE, "the pointer names the issue for the day a Linear read adapter exists");
  ok(ev.pointer?.gone !== true, "…and a create is not terminal");

  ok(!ev.summary.includes("</untrusted>") && !ev.summary.includes("Ship"), "the summary is built from ids + the vendor's type/action only — never the member-authored title");
  ok(ev.summary.includes(TEAM) && ev.summary.includes("ENG-42"), "…and it does name the team and the issue, so the fire preamble is diagnosable");

  const removed = normalize(issueBody({ action: "remove" }))!;
  ok(removed.pointer?.gone === true, "`remove` is Linear's delete verb, and it makes the pointer terminal so hydration is not required");
  const archived = normalize(issueBody({ action: "update", data: { id: ISSUE, teamId: TEAM, archivedAt: "2026-07-29T09:00:00.000Z" } }))!;
  ok(archived.pointer?.gone !== true, "an ARCHIVED issue is not `gone` — it is still fetchable, and claiming otherwise would suppress a re-fetch that works");

  let narrowRefusal = "";
  try {
    validateSubscription(LINEAR_EVENT_SOURCE, '(.fields.organization | IN("' + ORG + '"))');
  } catch (err) {
    narrowRefusal = String(err);
  }
  ok(
    narrowRefusal.includes("must narrow its scope") && narrowRefusal.includes("team"),
    "a filter naming only the ORGANIZATION is refused, and the refusal names `team` as a legal narrowing — subscribing to a whole Linear workspace has to be spelled out",
  );
  let narrowedByTeam = true;
  try {
    validateSubscription(LINEAR_EVENT_SOURCE, '(.fields.team | IN("' + TEAM + '"))');
  } catch {
    narrowedByTeam = false;
  }
  ok(narrowedByTeam, "…while a clause on `team` (a declared scope key) DOES narrow");
  let narrowedByScope = true;
  try {
    validateSubscription(LINEAR_EVENT_SOURCE, '.scope.group == "' + TEAM + '"');
  } catch {
    narrowedByScope = false;
  }
  ok(narrowedByScope, "…as does a `.scope.group` reference — the team is reachable from both halves of the language");
}

{
  const evOnTeam = normalize(issueBody())!;
  ok(checkEventReadGrant(evOnTeam, [PARTITION], { resolve: () => accessIn("payments") }).ok === true, "a routine whose partition is in the team's domain is authorized");

  const cross = checkEventReadGrant(evOnTeam, [PARTITION], { resolve: () => accessIn("security") });
  ok(cross.ok === false && cross.reason === "refused", "a routine in domain `security` cannot subscribe to a team the deployer put in `payments`");

  const none = checkEventReadGrant(evOnTeam, [PARTITION], { resolve: () => accessIn() });
  ok(none.ok === false && none.reason === "refused", "a partition in NO domain is granted nothing");

  const unlisted = normalize(issueBody({ data: { id: ISSUE, teamId: UNLISTED_TEAM } }))!;
  ok(
    checkEventReadGrant(unlisted, [PARTITION], { resolve: () => accessIn("payments", "security", "ops") }).ok === false,
    "a Linear team in NO domain triggers nothing, in any domain",
  );

  const teamless = normalize(issueBody({ data: { id: ISSUE } }))!;
  const teamlessVerdict = checkEventReadGrant(teamless, [PARTITION], { resolve: () => accessIn("payments") });
  ok(teamlessVerdict.ok === false && teamlessVerdict.reason === "refused", "a delivery proving no TEAM is refused — the grant unit is the team, and it is absent");

  const tenantOnly = normalize(issueBody({ data: {} }))!;
  ok(tenantOnly.scope.length === 1 && tenantOnly.scope[0]!.kind === "tenant", "…the tenant-only delivery really does prove only a tenant");
  ok(
    checkEventReadGrant(tenantOnly, [PARTITION], { resolve: () => accessIn("payments") }).ok === false,
    "an organization-only delivery is refused — the delivery never said WHICH team it was about",
  );

  const empty: NormalizedEvent = { source: LINEAR_EVENT_SOURCE, event: "Issue", scope: [], fields: {}, summary: "x" };
  const noScope = checkEventReadGrant(empty, [PARTITION], { resolve: () => accessIn("payments") });
  ok(noScope.ok === false && noScope.reason === "no-scope", "an empty scope path is refused `no-scope` — a normalizer bug is never an authorization bypass");

  const two = checkEventReadGrant(evOnTeam, [PARTITION, { ...PARTITION, surface: "C2", surfaceKey: "slack/T1/C2", key: "slack/T1/C2" }], {
    resolve: (p) => (p.surface === "C1" ? accessIn("payments") : accessIn("ops")),
  });
  ok(two.ok === false && two.reason === "refused" && two.partition === "slack/T1/C2", "EVERY partition the fire touches must grant");

  ok(linearEventScopeGrant.grantsRead([], accessIn("payments")) === false, "an empty path answers false rather than throwing");
  ok(linearEventScopeGrant.grantsRead(evOnTeam.scope, accessIn()) === false, "a domain-less access answers false rather than throwing");
}

{
  const decorative: EventScopeGrant = { source: LINEAR_EVENT_SOURCE, provider: "linear", grantsRead: () => true };

  const corpus: ReadonlyArray<{ ev: NormalizedEvent; access: EffectiveAccess; label: string }> = [
    { ev: normalize(issueBody())!, access: accessIn("security"), label: "a team in ANOTHER domain" },
    { ev: normalize(issueBody({ data: { id: ISSUE, teamId: UNLISTED_TEAM } }))!, access: accessIn("payments"), label: "a team in NO domain" },
    { ev: normalize(issueBody({ data: { id: ISSUE } }))!, access: accessIn("payments"), label: "a delivery proving no team" },
    { ev: normalize(issueBody({ data: {} }))!, access: accessIn("payments"), label: "an organization-only delivery" },
    { ev: normalize(issueBody())!, access: accessIn(), label: "a partition in no domain at all" },
  ];

  let disagreements = 0;
  for (const c of corpus) {
    const honest = linearEventScopeGrant.grantsRead(c.ev.scope, c.access);
    const stub = decorative.grantsRead(c.ev.scope, c.access);
    ok(honest === false && stub === true, `the shipped grant REFUSES ${c.label}, where the decorative stub admits it`);
    if (honest !== stub) disagreements++;
  }
  ok(disagreements === corpus.length, "the shipped grant disagrees with `() => true` on EVERY refusal case — it is a boundary, not decoration");

  ok(
    linearEventScopeGrant.grantsRead(normalize(issueBody())!.scope, accessIn("payments")) === true,
    "…while still ADMITTING the in-domain case — a grant that refuses everything is decoration too",
  );
}

{
  CLAIM_REGISTRY = [defineDomain({ name: "eng", containers: [`linear/${ORG}`] })];

  const claimedTeam = normalize(issueBody({ data: { id: ISSUE, teamId: "team-never-listed" } }))!;
  ok(
    checkEventReadGrant(claimedTeam, [PARTITION], { resolve: () => accessIn("eng") }).ok === true,
    "a workspace-claiming domain is granted a team nobody enumerated — the two-segment prefix fallback, exactly as on the Notion side",
  );
  ok(
    checkEventReadGrant(claimedTeam, [PARTITION], { resolve: () => accessIn("payments") }).ok === false,
    "…and the claim grants it to the CLAIMING domain only — a claim is not a global unlock",
  );
  const listedTeam = normalize(issueBody())!;
  ok(
    checkEventReadGrant(listedTeam, [PARTITION], { resolve: () => accessIn("eng") }).ok === false &&
      checkEventReadGrant(listedTeam, [PARTITION], { resolve: () => accessIn("payments") }).ok === true,
    "a team in another domain's `channels` stays with its roster owner even under a workspace claim (tier order, memory/domain.ts)",
  );
  const tenantOnly = normalize(issueBody({ data: {} }))!;
  ok(
    checkEventReadGrant(tenantOnly, [PARTITION], { resolve: () => accessIn("eng") }).ok === false,
    "an organization-only delivery is STILL refused for the domain that claims that very workspace",
  );

  CLAIM_REGISTRY = [];
}

{
  resetEventNormalizersForTest();
  resetEventScopeGrantsForTest();
  declareProviderSelection(["linear"]);

  const evOnTeam = liftLinearEvent(JSON.parse(issueBody()) as LinearEventEnvelope, LINEAR_EVENT_SOURCE)!;
  const orphaned = checkEventReadGrant(evOnTeam, [PARTITION], { resolve: () => accessIn("payments") });
  ok(orphaned.ok === false && orphaned.reason === "no-grant-adapter", "with nothing registered the event fails closed `no-grant-adapter` — distinguishable from a refusal");

  ok(registerEventNormalizer(linearEventNormalizer) === true, "the normalizer registers through the BARREL under a selected provider");
  ok(registerEventScopeGrant(linearEventScopeGrant) === true, "…and so does the grant");
  ok(eventNormalizer(LINEAR_EVENT_SOURCE) === linearEventNormalizer, "the registry resolves the linear normalizer by its declared source");
  ok(eventScopeGrant(LINEAR_EVENT_SOURCE) === linearEventScopeGrant, "…and the linear grant under the same key");
  ok(checkEventReadGrant(evOnTeam, [PARTITION], { resolve: () => accessIn("payments") }).ok === true, "…and the event is authorized again once both are registered");

  resetEventNormalizersForTest();
  resetEventScopeGrantsForTest();
  declareProviderSelection(["notion"]);
  ok(registerEventNormalizer(linearEventNormalizer) === false, "a de-selected linear bundle registers no normalizer");
  ok(registerEventScopeGrant(linearEventScopeGrant) === false, "…and no grant");
  ok(eventNormalizer(LINEAR_EVENT_SOURCE) === undefined, "…so `source: \"linear\"` is unresolvable, which is the fail-closed direction");
  declareProviderSelection(["linear"]);
  registerEventNormalizer(linearEventNormalizer);
  registerEventScopeGrant(linearEventScopeGrant);
}

{
  ok(
    !registeredWebhookVerifiers().some((v) => v.source === LINEAR_EVENT_SOURCE),
    "there is no registered WebhookVerifier for linear — verification lives in eve's native route, so registering this normalizer does NOT make `linear` a source a runtime hook can name",
  );
}

console.log(`✓ linear event normalizer + scope grant: ${passed} assertions passed`);
