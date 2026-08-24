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
  evaluateJqFilter,
  filterDocument,
  declareProviderSelection,
  defineBundle,
  defineBinding,
  defineDomain,
  resolveDomainForChannel,
  scopeIdOf,
  type Domain,
  type EffectiveAccess,
  type NormalizedEvent,
  type Partition,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  notionEventNormalizer,
  notionEventScopeGrant,
  notionEventClass,
  notionEventDeliveryId,
  notionScopePath,
  liftNotionEvent,
  NOTION_EVENT_SOURCE,
  NOTION_STRUCTURAL_PREFIXES,
  NOTION_CONVERSATIONAL_PREFIXES,
  NOTION_GRANT_STEPS,
  notionTriggerScopeVerdict,
} from "../agent/channels/notion-event-normalizer.js";
import { NOTION_WEBHOOK_SOURCE } from "../agent/channels/notion-webhook-verifier.js";
import { handleNotionDelivery } from "../agent/channels/notion-webhook.js";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const WS = "ws-1111";
const TEAMSPACE = "space-2222";
const DB = "db-3333";
const PAGE = "page-4444";
const BLOCK = "block-5555";
const OTHER_PAGE = "page-9999";

const PAGE_DOMAINS: Record<string, readonly string[]> = {
  [PAGE]: ["payments"],
  [DB]: ["security"],
  [TEAMSPACE]: ["security"],
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
    if (workspaceKey !== `notion/${WS}`) return [];
    const roster = PAGE_DOMAINS[surface];
    if (roster) return roster;
    const claimed = resolveDomainForChannel(`${workspaceKey}/${surface}`, CLAIM_REGISTRY).domain;
    return claimed ? [claimed.name] : [];
  },
});

function accessIn(...domains: string[]): EffectiveAccess {
  return {
    repoCapabilities: {}, resourceCapabilities: {},
    mode: "channel",
    scopeKey: "notion/test",
    tenantKey: "notion/test",
    surfaceKey: "notion/test/page",
    domains,
    connections: [],
    reachableHosts: [],
    repos: [],
   
    awsRoles: [], approvers: [],
    plugins: [],
    skills: [],
    subagents: [],
    connectors: [],
    connectorContentOrigin: {},
    connectorCredentials: {},
    instructionStack: [], preApprovalRules: [],
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

function structural(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt-abc",
    timestamp: "2026-07-27T10:00:00.000Z",
    workspace_id: WS,
    workspace_name: "Acme </untrusted> HQ",
    type: "page.properties_updated",
    authors: [{ id: "user-1", type: "person" }],
    entity: { id: PAGE, type: "page" },
    data: { parent: { id: DB, type: "database" }, updated_properties: ["title"] },
    ...overrides,
  });
}

function normalize(body: string): NormalizedEvent | null {
  return notionEventNormalizer.normalize({ source: NOTION_EVENT_SOURCE, headers: {}, body, receivedAt: "2026-07-27T10:00:01.000Z" });
}

{
  ok(NOTION_EVENT_SOURCE === "notion", "the event source key is the vendor's own name");
  ok(
    NOTION_EVENT_SOURCE === NOTION_WEBHOOK_SOURCE,
    "the normalizer, the scope grant and the WEBHOOK VERIFIER all register under ONE key — a delivery that verifies as notion normalizes as notion",
  );
  ok(notionEventNormalizer.provider === "notion" && notionEventScopeGrant.provider === "notion", "both entries are PROVIDER-owned, so a de-selected bundle contributes neither");

  ok(
    notionEventNormalizer.scopeKinds.length === 5 &&
      ["tenant", "group", "container", "entity", "sub"].every((k) => (notionEventNormalizer.scopeKinds as readonly string[]).includes(k)),
    "all FIVE ScopeKinds are declared — each is reachable somewhere in the vocabulary",
  );
  ok(
    !notionEventNormalizer.scopeKeys.includes("workspace"),
    "`workspace` is NOT a scopeKey — otherwise `workspace in [ws]` would satisfy mandatory narrowing while subscribing to the entire workspace",
  );
  ok(
    notionEventNormalizer.matchKeys.includes("workspace"),
    "…but `workspace` IS filterable — the rule it must not satisfy is narrowing, not matching",
  );
  ok(!notionEventNormalizer.matchKeys.includes("author"), "`author` is deliberately NOT filterable — `authors` is an array and `notIn` would fail OPEN on a multi-author event");
  ok(notionEventNormalizer.resolvesActor === true, "Notion's `authors[]` genuinely identifies who caused the event");
  ok(
    notionEventNormalizer.deliveryIdHeader === undefined,
    "no deliveryIdHeader — Notion publishes no delivery-id header; the id is in the BODY",
  );
  ok(notionEventDeliveryId(structural()) === "evt-abc", "notionEventDeliveryId reads the body's top-level `id` — what arms admitTrigger's durable dedupe");
  ok(notionEventDeliveryId('{"id":""}') === undefined && notionEventDeliveryId("not json") === undefined, "a blank id and an unparseable body are both 'no id', never a synthesised one");
}

{
  for (const s of NOTION_STRUCTURAL_PREFIXES) {
    ok(!NOTION_CONVERSATIONAL_PREFIXES.some((c) => s.startsWith(c) || c.startsWith(s)), `the families are disjoint: "${s}" does not overlap any conversational prefix`);
  }

  for (const type of ["comment.created", "comment.updated", "comment.deleted"]) {
    ok(notionEventClass(type) === "conversational", `${type} is classed as conversation`);
    ok(normalize(structural({ type, entity: { id: "c-1", type: "comment" } })) === null, `${type} normalizes to NULL — it never reaches the matcher`);
  }

  const seenDispatch: string[] = [];
  for (const type of [
    "page.created",
    "page.properties_updated",
    "page.content_updated",
    "page.moved",
    "page.deleted",
    "page.undeleted",
    "page.locked",
    "database.schema_updated",
    "data_source.content_updated",
  ]) {
    ok(notionEventClass(type) === "structural", `${type} is classed as work`);
    ok(normalize(structural({ type })) !== null, `${type} normalizes into a routable event`);

    const secret = "tok";
    const body = structural({ type });
    const sig = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
    const outcome = await handleNotionDelivery(body, sig, {
      signingKeys: [{ credentialId: "channel-key", secret }],
      allowUnverified: false,
      credentialFor: async () => ({ apiKey: "key" }),
      credentialForPage: () => undefined,
      domains: [],
      resolveBotUserId: async () => "bot",
      ambientEnabled: () => true,
      dispatch: async () => {
        seenDispatch.push(type);
      },
      attachSession: () => ({ cancel: async () => ({ status: "no_active_turn" }) }),
    });
    ok(outcome.action === "ignored" && outcome.detail === type, `${type} is IGNORED by the ambient supervisor — a structural delivery never double-drives it`);
    ok(outcome.verified === true, `${type} carrying a real signature is marked verified`);
  }
  ok(seenDispatch.length === 0, "no structural delivery reached the supervisor's dispatch at all");

  ok(notionEventClass("file_upload.complete") === "unrecognised", "an unmodelled family is unrecognised");
  ok(normalize(structural({ type: "file_upload.complete" })) === null, "an unrecognised family normalizes to null — the vocabulary is a reviewed allowlist");
  ok(normalize(structural({ type: undefined, event_type: "page.created" })) !== null, "the `event_type` spelling is tolerated, like the comment path's");
}

{
  const dbPage = normalize(
    structural({ type: "page.content_updated", data: { parent: { id: DB, type: "database" }, updated_blocks: [{ id: BLOCK, type: "paragraph" }] } }),
  );
  ok(dbPage !== null, "a database-parented page.content_updated normalizes");
  ok(dbPage!.scope.map((s) => s.kind).join(">") === "tenant>container>entity>sub", "…and proves tenant>container>entity>sub");
  ok(scopeIdOf(dbPage!.scope, "tenant") === WS && scopeIdOf(dbPage!.scope, "container") === DB, "tenant = workspace_id, container = data.parent.id");
  ok(scopeIdOf(dbPage!.scope, "entity") === PAGE && scopeIdOf(dbPage!.scope, "sub") === BLOCK, "entity = entity.id, sub = the ONE updated block");

  const spacePage = normalize(
    structural({ type: "page.content_updated", data: { parent: { id: TEAMSPACE, type: "space" }, updated_blocks: [{ id: BLOCK, type: "paragraph" }] } }),
  );
  ok(spacePage!.scope.map((s) => s.kind).join(">") === "tenant>group>entity>sub", "a teamspace-parented page proves tenant>group>entity>sub");
  ok(scopeIdOf(spacePage!.scope, "group") === TEAMSPACE, "`space` is Notion's word for a teamspace — the only thing `group` can mean");

  ok(scopeIdOf(spacePage!.scope, "container") === undefined, "a teamspace-parented delivery proves NO container — `data.parent` is one object");
  ok(scopeIdOf(dbPage!.scope, "group") === undefined, "…and a database-parented delivery proves NO group, for the same reason");
  ok(
    dbPage!.scope.length === 4 && spacePage!.scope.length === 4,
    "FOUR is the deepest path Notion can prove — the five-kind vocabulary was sized against the PRODUCT hierarchy, not the webhook envelope",
  );

  const twoBlocks = normalize(
    structural({ type: "page.content_updated", data: { parent: { id: DB, type: "database" }, updated_blocks: [{ id: BLOCK }, { id: "block-6666" }] } }),
  );
  ok(scopeIdOf(twoBlocks!.scope, "sub") === undefined, "two updated blocks prove no single `sub` — picking one would assert containment the delivery does not prove");

  const kinds = ["tenant", "group", "container", "entity", "sub"];
  for (const ev of [dbPage!, spacePage!, twoBlocks!]) {
    let last = -1;
    for (const s of ev.scope) {
      const rank = kinds.indexOf(s.kind);
      ok(rank > last, `scope path is strictly outermost-first (${s.kind})`);
      last = rank;
    }
  }

  ok(dbPage!.event === "page.content_updated" && dbPage!.action === "content_updated", "event is the VERBATIM vendor type; action is the verb");
  ok(dbPage!.fields["entity_type"] === "page" && dbPage!.fields["parent"] === DB && dbPage!.fields["entity"] === PAGE, "the scope-identifying fields are carried for filtering");
  ok(dbPage!.actor?.id === "user-1", "a SOLE author becomes the actor");
  const twoAuthors = normalize(structural({ authors: [{ id: "user-1" }, { id: "user-2" }] }));
  ok(twoAuthors!.actor === undefined, "TWO authors yield NO actor — a single slot must not name one of several");
  ok(dbPage!.occurredAt === "2026-07-27T10:00:00.000Z" && dbPage!.deliveryId === "evt-abc", "occurredAt is the vendor's timestamp; deliveryId is the body's id");
  ok(!dbPage!.summary.includes("</untrusted>"), "the summary reads NO member-authored prose — `workspace_name` is deliberately never rendered");
  const deleted = normalize(structural({ type: "page.deleted" }));
  ok(deleted!.pointer?.gone === true, "*.deleted is TERMINAL from the vendor's own signal");
  ok(normalize(structural({ type: "page.undeleted" }))!.pointer?.gone === undefined, "*.undeleted is a restore, NOT terminal");

  const noScope = liftNotionEvent({ type: "page.created" }, NOTION_EVENT_SOURCE);
  ok(noScope !== null && noScope.scope.length === 0, "an envelope with no workspace, parent or entity proves an EMPTY scope path");
  ok(notionScopePath({ workspace_id: "" }).length === 0, "a blank workspace id proves nothing (never an empty-id step)");
}

{
  resetEventNormalizersForTest();
  ok(registerEventNormalizer(notionEventNormalizer) === true, "the normalizer registers THROUGH THE BARREL from the bundle — the first bundle-resident one in the tree");
  ok(eventNormalizer("notion") === notionEventNormalizer, "…and resolves back out of core's registry");

  ok(notionEventNormalizer.matchKeys.includes("entity_type"), "the normalizer still DECLARES the fields it emits — that is what the tool description and the probe document quote");

  let narrowRefusal = "";
  try {
    validateSubscription("notion", '(.fields.workspace | IN("' + WS + '"))');
  } catch (err) {
    narrowRefusal = String(err);
  }
  ok(
    narrowRefusal.includes("must narrow its scope") && narrowRefusal.includes("parent"),
    "a filter that names only the WORKSPACE is refused — subscribing to a whole Notion workspace has to be spelled out",
  );
  let ok2 = true;
  try {
    validateSubscription("notion", '(.fields.parent | IN("' + DB + '"))');
  } catch {
    ok2 = false;
  }
  ok(ok2, "…while a clause on `parent` (a declared scope key) DOES narrow");
  let ok3 = true;
  try {
    validateSubscription("notion", '.scope.sub == "' + BLOCK + '"');
  } catch {
    ok3 = false;
  }
  ok(ok3, "…as does a `.scope.<kind>` reference — including `sub`, the fifth level, which is live rather than decorative");

  const ev = normalize(structural({ type: "page.content_updated", data: { parent: { id: DB, type: "database" }, updated_blocks: [{ id: BLOCK }] } }))!;
  const match = async (expression: string): Promise<boolean> => {
    const outcome = await evaluateJqFilter(expression, filterDocument(ev));
    return "match" in outcome && outcome.match;
  };
  ok(await match('.scope.container == "' + DB + '"'), "an equality on the proved container matches");
  ok(!(await match('.scope.container == "db-other"')), "…and does not match another database");
  ok(await match('.scope.sub == "' + BLOCK + '"'), "the innermost step matches — the fifth kind is live, not decorative");
  ok(await match('(.fields.action | IN("content_updated"))'), "the split-out verb is filterable across families");
  ok(!(await match('(.fields.entity_type | IN("database"))')), "the family is filterable and discriminates");
  ok(await match('.scope.container == "' + DB + '" and ((.fields.action | IN("content_updated")) or (.fields.entity_type | IN("database")))'), "…and an OR across clauses is now one routine, not two");
}

{
  resetEventScopeGrantsForTest();
  const evOnPage = normalize(structural({ type: "page.properties_updated" }))!;

  const noAdapter = checkEventReadGrant(evOnPage, [PARTITION], { resolve: () => accessIn("payments") });
  ok(noAdapter.ok === false && noAdapter.reason === "no-grant-adapter", "with no grant registered, EVERY notion event is refused `no-grant-adapter`");

  ok(registerEventScopeGrant(notionEventScopeGrant) === true, "the scope grant registers THROUGH THE BARREL from the bundle");
  ok(eventScopeGrant("notion") === notionEventScopeGrant, "…and resolves back out of core's registry");

  const granted = checkEventReadGrant(evOnPage, [PARTITION], { resolve: () => accessIn("payments") });
  ok(granted.ok === true, "a routine in the page's own domain is GRANTED");

  const refused = checkEventReadGrant(evOnPage, [PARTITION], { resolve: () => accessIn("ops") });
  ok(refused.ok === false && refused.reason === "refused" && refused.partition === PARTITION.surfaceKey, "a routine in another domain is REFUSED (named), not no-grant-adapter");

  const security = checkEventReadGrant(evOnPage, [PARTITION], { resolve: () => accessIn("security") });
  ok(security.ok === false && security.reason === "refused", "the innermost CONFIGURED step decides — a parent-database grant does not reach a page the deployer put elsewhere");

  const evUnknownPage = normalize(structural({ type: "page.created", entity: { id: OTHER_PAGE, type: "page" } }))!;
  const viaContainer = checkEventReadGrant(evUnknownPage, [PARTITION], { resolve: () => accessIn("security") });
  ok(viaContainer.ok === true, "an unconfigured page falls through to its configured DATABASE — deployers configure containers, not every descendant");
  const viaContainerWrong = checkEventReadGrant(evUnknownPage, [PARTITION], { resolve: () => accessIn("payments") });
  ok(viaContainerWrong.ok === false && viaContainerWrong.reason === "refused", "…and that fall-through still refuses a domain the container does not belong to");

  const orphan = normalize(structural({ type: "page.created", entity: { id: OTHER_PAGE, type: "page" }, data: { parent: { id: "db-unknown", type: "database" } } }))!;
  ok(checkEventReadGrant(orphan, [PARTITION], { resolve: () => accessIn("payments", "security", "ops") }).ok === false, "a Notion surface in NO domain triggers nothing, in any domain");

  const tenantOnly = normalize(structural({ type: "page.created", entity: undefined, data: {} }))!;
  ok(tenantOnly.scope.length === 1 && tenantOnly.scope[0]!.kind === "tenant", "…the tenant-only delivery really does prove only a tenant");
  ok(checkEventReadGrant(tenantOnly, [PARTITION], { resolve: () => accessIn("payments") }).ok === false, "a workspace-only delivery is refused — the delivery never said WHICH surface it was about");

  CLAIM_REGISTRY = [defineDomain({ name: "eng", containers: [`notion/${WS}`] })];

  const claimedPage = normalize(structural({ type: "page.created", entity: { id: "page-never-listed", type: "page" }, data: { parent: { id: "db-never-listed", type: "database" } } }))!;
  ok(
    checkEventReadGrant(claimedPage, [PARTITION], { resolve: () => accessIn("eng") }).ok === true,
    "a claim-only domain ALREADY grants read on a page nobody enumerated — this is Stage 1 behaviour, with no `tenant` step admitted",
  );
  ok(
    checkEventReadGrant(claimedPage, [PARTITION], { resolve: () => accessIn("payments") }).ok === false,
    "…and the claim grants it to the CLAIMING domain only — a claim is not a global unlock",
  );
  const listedPage = normalize(structural({ type: "page.created", entity: { id: PAGE, type: "page" } }))!;
  ok(
    checkEventReadGrant(listedPage, [PARTITION], { resolve: () => accessIn("eng") }).ok === false &&
      checkEventReadGrant(listedPage, [PARTITION], { resolve: () => accessIn("payments") }).ok === true,
    "a page in another domain's `channels` stays with its roster owner even under a workspace claim (tier order, memory/domain.ts)",
  );
  ok(
    checkEventReadGrant(tenantOnly, [PARTITION], { resolve: () => accessIn("eng") }).ok === false,
    "a workspace-only delivery is STILL refused even for the domain that claims that very workspace — the claim confers reach, it does not make a subject-less delivery self-identifying",
  );
  CLAIM_REGISTRY = [];

  const empty: NormalizedEvent = { source: "notion", event: "page.created", scope: [], fields: {}, summary: "x" };
  const noScope = checkEventReadGrant(empty, [PARTITION], { resolve: () => accessIn("payments") });
  ok(noScope.ok === false && noScope.reason === "no-scope", "an empty scope path is refused `no-scope` — a normalizer bug is never an authorization bypass");

  const two = checkEventReadGrant(evOnPage, [PARTITION, { ...PARTITION, surface: "C2", surfaceKey: "slack/T1/C2", key: "slack/T1/C2" }], {
    resolve: (p) => (p.surface === "C1" ? accessIn("payments") : accessIn("ops")),
  });
  ok(two.ok === false && two.reason === "refused" && two.partition === "slack/T1/C2", "EVERY partition the fire touches must grant");

  ok(notionEventScopeGrant.grantsRead([], accessIn("payments")) === false, "an empty path answers false rather than throwing");
  ok(notionEventScopeGrant.grantsRead(evOnPage.scope, accessIn()) === false, "a partition in NO domain is granted nothing");
}

{
  const body = structural();
  const hatch = await handleNotionDelivery(body, null, {
    signingKeys: [{ credentialId: "channel-key", secret: undefined }],
    allowUnverified: true,
    credentialFor: async () => ({ apiKey: "key" }),
    credentialForPage: () => undefined,
    domains: [],
    resolveBotUserId: async () => "bot",
    ambientEnabled: () => true,
    dispatch: async () => {},
    attachSession: () => ({ cancel: async () => ({ status: "no_active_turn" }) }),
  });
  ok(hatch.action !== "rejected", "the OE_ALLOW_UNVERIFIED_NOTION_WEBHOOK hatch still ACCEPTS the delivery for the supervisor path");
  ok(hatch.verified === false, "🔴 …but it is NOT `verified`, so notion.ts never hands it to admitTrigger — a dev hatch cannot fire a routine");

  const rejected = await handleNotionDelivery(body, "sha256=deadbeef", {
    signingKeys: [{ credentialId: "channel-key", secret: "tok" }],
    allowUnverified: false,
    credentialFor: async () => ({ apiKey: "key" }),
    credentialForPage: () => undefined,
    domains: [],
    resolveBotUserId: async () => "bot",
    ambientEnabled: () => true,
    dispatch: async () => {},
    attachSession: () => ({ cancel: async () => ({ status: "no_active_turn" }) }),
  });
  ok(rejected.action === "rejected" && rejected.verified === false, "a bad signature is rejected and never verified");

  const handshake = await handleNotionDelivery(JSON.stringify({ verification_token: "secret_x" }), null, {
    signingKeys: [{ credentialId: "channel-key", secret: "tok" }],
    allowUnverified: false,
    credentialFor: async () => ({ apiKey: "key" }),
    credentialForPage: () => undefined,
    domains: [],
    resolveBotUserId: async () => "bot",
    ambientEnabled: () => true,
    dispatch: async () => {},
    attachSession: () => ({ cancel: async () => ({ status: "no_active_turn" }) }),
  });
  ok(handshake.action === "handshake" && handshake.verified === false, "the handshake arrives BEFORE any secret exists and is never verified");
}

{
  resetEventNormalizersForTest();
  resetEventScopeGrantsForTest();
  declareProviderSelection(["github"]);
  ok(registerEventNormalizer(notionEventNormalizer) === false, "a DE-SELECTED notion bundle registers no normalizer");
  ok(registerEventScopeGrant(notionEventScopeGrant) === false, "…and no scope grant either");
  ok(eventNormalizer("notion") === undefined, "so a notion event has no normalizer — routing fails closed");

  declareProviderSelection(["github", "notion"]);
  ok(registerEventNormalizer(notionEventNormalizer) === true, "…and a SELECTED notion bundle contributes both halves again");
  ok(registerEventScopeGrant(notionEventScopeGrant) === true, "…including the grant, so no source is ever left normalizer-with-no-grant");
}

{
  const PAY_CRED = "notion-payments";
  const SEC_CRED = "notion-security";
  const SEC_PAGE = "page-security-7777";
  const PAY_PAGE = "page-payments-6666";

  const FENCED: readonly Domain[] = [
    defineDomain({
      name: "payments",
      channels: [`notion/${WS}/${PAY_PAGE}`],
      credentials: [{ connector: "notion", credential: "channel-key", use: PAY_CRED, inboundSecret: "NOTION_WEBHOOK_SECRET_PAYMENTS" }],
    }),
    defineDomain({
      name: "security",
      channels: [`notion/${WS}/${SEC_PAGE}`],
      credentials: [{ connector: "notion", credential: "channel-key", use: SEC_CRED, inboundSecret: "NOTION_WEBHOOK_SECRET_SECURITY" }],
    }),
  ];

  const surfaces = (list: readonly Domain[]) => (p: { workspaceKey: string; surface: string }) => {
    const d = resolveDomainForChannel(`${p.workspaceKey}/${p.surface}`, list).domain;
    return d ? [d.name] : [];
  };

  const forged = (workspace: string, page: string) =>
    JSON.stringify({
      id: "evt-forged",
      timestamp: "2026-08-13T10:00:00.000Z",
      workspace_id: workspace,
      type: "page.properties_updated",
      entity: { id: page, type: "page" },
      data: {},
    });

  const attack = notionTriggerScopeVerdict(forged(WS, SEC_PAGE), PAY_CRED, FENCED, surfaces(FENCED));
  ok(attack.ok === false, "🔴 a body signed by payments' token, naming a SECURITY page, is refused by the trigger plane");
  ok(
    attack.ok === false && attack.reason.includes("security") && attack.reason.includes(SEC_CRED) && attack.reason.includes(PAY_CRED),
    "…and the refusal names the victim domain, the credential that serves it, and the credential that actually signed",
  );

  const honest = notionTriggerScopeVerdict(forged(WS, SEC_PAGE), SEC_CRED, FENCED, surfaces(FENCED));
  ok(honest.ok === true, "the SAME body signed by security's own token IS routed — the fence refuses the forgery, not the shape");
  const own = notionTriggerScopeVerdict(forged(WS, PAY_PAGE), PAY_CRED, FENCED, surfaces(FENCED));
  ok(own.ok === true, "…and payments' token still routes payments' own pages");

  const CLAIMED: readonly Domain[] = [
    defineDomain({
      name: "payments",
      channels: [`notion/${WS}/${PAY_PAGE}`],
      credentials: [{ connector: "notion", credential: "channel-key", use: PAY_CRED, inboundSecret: "NOTION_WEBHOOK_SECRET_PAYMENTS" }],
    }),
    defineDomain({
      name: "security",
      containers: ["notion/ws-security"],
      credentials: [{ connector: "notion", credential: "channel-key", use: SEC_CRED, inboundSecret: "NOTION_WEBHOOK_SECRET_SECURITY" }],
    }),
  ];
  const tenantForge = notionTriggerScopeVerdict(forged("ws-security", PAY_PAGE), PAY_CRED, CLAIMED, surfaces(CLAIMED));
  ok(
    tenantForge.ok === false,
    "🔴 naming a page payments CAN see, under a workspace SECURITY claims, is still refused — the workspace-claim route is closed",
  );
  ok(
    notionTriggerScopeVerdict(forged("ws-security", PAY_PAGE), SEC_CRED, CLAIMED, surfaces(CLAIMED)).ok === true,
    "…and the same claim still routes for the domain that made it",
  );

  const NESTED: readonly Domain[] = [
    defineDomain({
      name: "payments",
      channels: [`notion/${WS}/${PAY_PAGE}`],
      credentials: [{ connector: "notion", credential: "channel-key", use: PAY_CRED, inboundSecret: "NOTION_WEBHOOK_SECRET_PAYMENTS" }],
    }),
    defineDomain({
      name: "security",
      channels: [`notion/${WS}/${DB}`],
      credentials: [{ connector: "notion", credential: "channel-key", use: SEC_CRED, inboundSecret: "NOTION_WEBHOOK_SECRET_SECURITY" }],
    }),
  ];
  const nestedBody = JSON.stringify({
    id: "evt-nested",
    timestamp: "2026-08-13T10:00:00.000Z",
    workspace_id: WS,
    type: "page.properties_updated",
    entity: { id: PAY_PAGE, type: "page" },
    data: { parent: { id: DB, type: "database" } },
  });
  ok(
    (NOTION_GRANT_STEPS as readonly string[]).indexOf("entity") < (NOTION_GRANT_STEPS as readonly string[]).indexOf("container"),
    "the shared walk really does put `entity` inside `container` — 8d's premise, asserted rather than assumed",
  );
  ok(
    notionTriggerScopeVerdict(nestedBody, SEC_CRED, NESTED, surfaces(NESTED)).ok === false,
    "🔴 owning the parent DATABASE does not let security's token route an event about a payments PAGE — the fence checks the step the grant will use",
  );
  ok(notionTriggerScopeVerdict(nestedBody, PAY_CRED, NESTED, surfaces(NESTED)).ok === true, "…and the page's own domain still routes it");

  const SHARED: readonly Domain[] = [
    defineDomain({
      name: "eng",
      channels: [`notion/${WS}/${PAY_PAGE}`],
      credentials: [{ connector: "notion", credential: "channel-key", use: "notion-eng" }],
    }),
  ];
  const shared = notionTriggerScopeVerdict(forged(WS, PAY_PAGE), "channel-key", SHARED, surfaces(SHARED));
  ok(
    shared.ok === true && shared.detail.includes("shares this deployment's inbound secret"),
    "a domain that binds a credential but declares NO inbound secret is NOT fenced — and the verdict says which limit it hit",
  );

  ok(notionTriggerScopeVerdict(forged(WS, SEC_PAGE), undefined, FENCED, surfaces(FENCED)).ok === false, "no signer ⇒ refused (the dev hatch never routes)");
  ok(notionTriggerScopeVerdict("{not json", PAY_CRED, FENCED, surfaces(FENCED)).ok === false, "an unparseable body ⇒ refused");
  ok(
    notionTriggerScopeVerdict(forged(WS, "page-nobody-configured"), PAY_CRED, FENCED, surfaces(FENCED)).ok === false,
    "a path no domain owns ⇒ refused (the grant would refuse it anyway; refusing here makes it legible)",
  );
  ok(
    notionTriggerScopeVerdict(JSON.stringify({ id: "e", workspace_id: WS, type: "page.created" }), PAY_CRED, FENCED, surfaces(FENCED)).ok === false,
    "a delivery that identifies no surface at all ⇒ refused",
  );

  const unresolvable = notionTriggerScopeVerdict(forged(WS, PAY_PAGE), "channel-key", FENCED, () => ["a-domain-nobody-registered"]);
  ok(unresolvable.ok === false, "a surface that resolves to a domain this registry does not hold ⇒ refused, not defaulted to the org credential");
  ok(unresolvable.ok === false && unresolvable.reason.includes("does not hold"), "…and the refusal names the config seam rather than a credential mismatch");

  const nasty = `page-x\nAUG 13 [oe] event plane: 1 matched -> 1 fired`;
  const injected = notionTriggerScopeVerdict(forged("ws-security", nasty), PAY_CRED, CLAIMED, surfaces(CLAIMED));
  ok(injected.ok === false, "…a hostile id under a workspace claim is still refused");
  ok(injected.ok === false && !injected.reason.includes("\n"), "🔴 …and the refusal carries no raw newline — a scope id cannot forge a log line");
  ok(
    injected.ok === false && injected.reason.includes('"page-x?AUG'),
    "…the newline is struck and the whole id stays inside one quoted span, so the injected text can only read as data",
  );
  ok(
    notionTriggerScopeVerdict(forged("ws-security", "p".repeat(400)), PAY_CRED, CLAIMED, surfaces(CLAIMED)).ok === false &&
      !(notionTriggerScopeVerdict(forged("ws-security", "p".repeat(400)), PAY_CRED, CLAIMED, surfaces(CLAIMED)) as { reason: string }).reason.includes("p".repeat(70)),
    "…and a padded id is truncated, so it cannot push the rest of the line out of a size-capped log",
  );

  const commentBody = JSON.stringify({ id: "evt-c", workspace_id: WS, type: "comment.created", entity: { id: "cmt-1", type: "comment" } });
  const deferred = notionTriggerScopeVerdict(commentBody, PAY_CRED, FENCED, surfaces(FENCED));
  ok(deferred.ok === true && deferred.detail === "not a structural event", "a comment delivery is DEFERRED to the normalizer, not refused");

  const SECRET = "tok-payments";
  const body = structural();
  const sig = `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
  const ignored = await handleNotionDelivery(body, sig, {
    signingKeys: [{ credentialId: "channel-key", secret: "tok-default" }, { credentialId: PAY_CRED, secret: SECRET }],
    allowUnverified: false,
    credentialFor: async () => ({ apiKey: "key" }),
    credentialForPage: () => undefined,
    domains: [],
    resolveBotUserId: async () => "bot",
    ambientEnabled: () => true,
    dispatch: async () => {},
    attachSession: () => ({ cancel: async () => ({ status: "no_active_turn" }) }),
  });
  ok(ignored.action === "ignored" && ignored.verified === true, "a structural delivery is `ignored` by the comment path and still `verified`");
  ok(ignored.signerCredentialId === PAY_CRED, "🔴 …and it reports the integration whose secret VERIFIED it, which is the only fact the fence can stand on");
  ok(ignored.credentialId === undefined, "…while `credentialId` stays absent on this arm — the two fields are not the same fact");

  const hatched = await handleNotionDelivery(body, null, {
    signingKeys: [{ credentialId: "channel-key", secret: undefined }],
    allowUnverified: true,
    credentialFor: async () => ({ apiKey: "key" }),
    credentialForPage: () => undefined,
    domains: [],
    resolveBotUserId: async () => "bot",
    ambientEnabled: () => true,
    dispatch: async () => {},
    attachSession: () => ({ cancel: async () => ({ status: "no_active_turn" }) }),
  });
  ok(hatched.signerCredentialId === undefined, "the unverified dev hatch names NO signer — nothing verified, so nothing is claimed");

  const routeSource = await readFile(new URL("../agent/channels/notion.ts", import.meta.url), "utf8");
  const fenceAt = routeSource.indexOf("notionTriggerScopeVerdict(");
  const admitAt = routeSource.indexOf("admitTrigger(");
  ok(fenceAt > 0, "the route calls notionTriggerScopeVerdict");
  ok(admitAt > fenceAt, "…and it calls it BEFORE admitTrigger, not after");
  ok(routeSource.slice(fenceAt, admitAt).includes("if (!fence.ok)"), "…and admitTrigger sits behind the refusal branch");
}

console.log(`✓ notion event normalizer + scope grant: ${passed} assertions passed`);
