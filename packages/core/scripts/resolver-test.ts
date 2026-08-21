import { resolveAccess, type ResolveRequest } from "../agent/access/resolver.js";
import { assertBindingsValid, assertBundlesValid, type Binding, type Bundle } from "../agent/access/bundle.js";
import type { ConnectorCredentials } from "../agent/access/connector-credentials.js";
import type { PluginRegistry } from "../agent/plugins/types.js";

const CATALOGUES: readonly ConnectorCredentials[] = ["notion", "linear-mcp", "helpdesk", "my-gmail", "a", "b", "c", "d"].map(
  (connector) => ({
    connector,
    allows: ["api-key" as const],
    credentials: [{ id: "k", type: "api-key" as const, secretRef: `SECRET_${connector}`, broker: "env" }],
  }),
);

function resolveAccessT(
  req: ResolveRequest,
  bundles: readonly Bundle[],
  bindings: readonly Binding[],
  registry: PluginRegistry = {},
  catalogues: readonly ConnectorCredentials[] = CATALOGUES,
) {
  return resolveAccess(req, bundles, bindings, registry, catalogues);
}

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function throwsWith(fn: () => void, fragment: string, label: string): void {
  try {
    fn();
  } catch (err) {
    ok(String(err).includes(fragment), label);
    return;
  }
  ok(false, label);
}

const chan = (workspace: string, channel: string, domains?: string[]): ResolveRequest => ({
  mode: "channel",
  platform: "slack",
  workspace,
  channel,
  domains,
});

{
  const bundles: Bundle[] = [
    { name: "org", repos: ["acme/shared"] },
    { name: "pay", repos: ["acme/payments"] },
  ];
  const bindings: Binding[] = [
    { bundle: "org", scope: { level: "org" } },
    { bundle: "pay", scope: { level: "surface", surface: "slack/T1/C1" } },
  ];
  const a = resolveAccessT(chan("T1", "C1"), bundles, bindings);
  ok(a.repos.length === 2 && a.repos.includes("acme/shared") && a.repos.includes("acme/payments"), "repos union across org + surface");
  const b = resolveAccessT(chan("T1", "C2"), bundles, bindings);
  ok(b.repos.length === 1 && b.repos[0] === "acme/shared", "new channel inherits only the broad baseline (default-deny on channel grants)");
}

{
  const bundles: Bundle[] = [{ name: "basket", repos: ["acme/web"] }];
  const bindings: Binding[] = [
    { bundle: "basket", scope: { level: "surface", surface: "slack/T1/C1" } },
    { bundle: "basket", scope: { level: "surface", surface: "slack/T1/C2" } },
  ];
  ok(resolveAccessT(chan("T1", "C1"), bundles, bindings).repos[0] === "acme/web", "one bundle bound to C1");
  ok(resolveAccessT(chan("T1", "C2"), bundles, bindings).repos[0] === "acme/web", "same bundle reused on C2 (define once, bind many)");
  ok(resolveAccessT(chan("T1", "C3"), bundles, bindings).repos.length === 0, "unbound channel gets nothing");
}

{
  const conn = (secretRef: string) => ({ id: "gh", credentialType: "bearer" as const, secretRef, allowedWebsites: ["api.github.com"] });
  const bundles: Bundle[] = [
    { name: "o", connections: [conn("ORG")] },
    { name: "w", connections: [conn("WS")] },
    { name: "d", connections: [conn("DOMAIN")] },
    { name: "c", connections: [conn("CHAN")] },
  ];
  const bindings: Binding[] = [
    { bundle: "o", scope: { level: "org" } },
    { bundle: "w", scope: { level: "tenant", tenant: "slack/T1" } },
    { bundle: "d", scope: { level: "domain", domain: "pay" } },
    { bundle: "c", scope: { level: "surface", surface: "slack/T1/C1" } },
  ];
  const a = resolveAccessT(chan("T1", "C1", ["pay"]), bundles, bindings);
  ok(a.connections.length === 1 && a.connections[0].secretRef === "CHAN", "surface beats domain/tenant/org for same connection id");
  const noChan = resolveAccessT(chan("T1", "C9", ["pay"]), bundles, bindings);
  ok(noChan.connections[0].secretRef === "DOMAIN", "domain beats tenant/org when no surface binding");
  const noDomain = resolveAccessT(chan("T1", "C9"), bundles, bindings);
  ok(noDomain.connections[0].secretRef === "WS", "tenant beats org when surface is in no domain");
}

{
  const bundles: Bundle[] = [
    { name: "org", domains: ["raw.githubusercontent.com"] },
    { name: "ch", connections: [{ id: "linear", credentialType: "bearer", secretRef: "LINEAR", allowedWebsites: ["api.linear.app"] }] },
  ];
  const bindings: Binding[] = [
    { bundle: "org", scope: { level: "org" } },
    { bundle: "ch", scope: { level: "surface", surface: "slack/T1/C1" } },
  ];
  const a = resolveAccessT(chan("T1", "C1"), bundles, bindings);
  ok(a.reachableHosts.find((h) => h.host === "api.linear.app")?.viaConnection === "linear", "credentialed host carries its connection id");
  ok(a.reachableHosts.find((h) => h.host === "raw.githubusercontent.com")?.viaConnection === null, "credential-less domain reachable with no connection");
}

{
  const bundles: Bundle[] = [{ name: "pay-tools", repos: ["acme/payments"] }];
  const bindings: Binding[] = [{ bundle: "pay-tools", scope: { level: "domain", domain: "payments" } }];
  ok(resolveAccessT(chan("T1", "C1", ["payments"]), bundles, bindings).repos[0] === "acme/payments", "domain-scoped bundle applies to a member surface");
  ok(resolveAccessT(chan("T1", "C1", ["other"]), bundles, bindings).repos.length === 0, "domain-scoped bundle does NOT apply to a non-member surface");
  ok(resolveAccessT(chan("T1", "C1"), bundles, bindings).repos.length === 0, "no domains on the request -> domain bundle doesn't apply");
  ok(
    resolveAccessT(chan("T2", "C1", ["payments"]), bundles, bindings).repos[0] === "acme/payments",
    "a domain grant follows its domain across tenants — membership, not workspace, is the test",
  );
}

{
  const bundles: Bundle[] = [{ name: "ws", repos: ["acme/ws"] }];
  const bindings: Binding[] = [{ bundle: "ws", scope: { level: "tenant", tenant: "slack/T1" } }];
  ok(resolveAccessT(chan("T1", "C1"), bundles, bindings).repos.length === 1, "tenant bundle applies inside its tenant");
  ok(resolveAccessT(chan("T2", "C1"), bundles, bindings).repos.length === 0, "tenant bundle does NOT leak to another tenant");
}

{
  const bundles: Bundle[] = [
    { name: "org", repos: ["acme/shared"], connections: [{ id: "gh", credentialType: "bearer", secretRef: "ORG", allowedWebsites: ["api.github.com"] }] },
    { name: "ch", repos: ["acme/payments"] },
    { name: "personal", repos: ["acme/scratch"] },
  ];
  const bindings: Binding[] = [
    { bundle: "org", scope: { level: "org" } },
    { bundle: "ch", scope: { level: "surface", surface: "slack/T1/C1" } },
    { bundle: "personal", scope: { level: "principal", principal: "slack/T1/U1" } },
  ];
  const dm: ResolveRequest = { mode: "dm", platform: "slack", workspace: "T1", channel: "C1", principalId: "U1" };
  const a = resolveAccessT(dm, bundles, bindings);
  ok(a.repos.length === 1 && a.repos[0] === "acme/scratch", "DM resolves the caller's personal scope ONLY");
  ok(a.connections.length === 0, "DM does not inherit the org service credential");
  ok(a.scopeKey === "dm:U1", "DM scopeKey is the principal");
  const none: ResolveRequest = { mode: "dm", platform: "slack", workspace: "T1", channel: "C1", principalId: "U2" };
  ok(resolveAccess(none, bundles, bindings).repos.length === 0, "DM with no personal bundle = empty surface");
  const foreign: ResolveRequest = { mode: "dm", platform: "discord", workspace: "G1", channel: "D1", principalId: "U1" };
  ok(resolveAccess(foreign, bundles, bindings).repos.length === 0, "🔴 a DM from the same id on ANOTHER platform resolves NOTHING — the binding names slack/T1/U1, not the bare id");
}

{
  const conn = (id: string, secretRef: string) => ({ id, credentialType: "bearer" as const, secretRef, allowedWebsites: ["api.example.com"], methods: ["GET" as const] });
  const bundles: Bundle[] = [
    { name: "human", repos: ["acme/human"], connections: [conn("shared", "HUMAN_KEY")], instructions: "team rule" },
    { name: "exact", repos: ["acme/exact"], connections: [conn("shared", "EXACT_KEY")], instructions: "my rule" },
  ];
  const lsBinding: Binding[] = [{ bundle: "human", scope: { level: "principal", principal: "linkSet:set-rowan" } }];
  const base = { mode: "dm" as const, platform: "slack", workspace: "T1", channel: "D1" };

  ok(resolveAccess({ ...base, principalId: "U1", principalLinkSets: ["set-rowan"] }, bundles, lsBinding).repos.includes("acme/human"), "a link-set principal binding grants in a member's DM (their confirmed set is on the request)");
  ok(resolveAccess({ ...base, principalId: "U1" }, bundles, lsBinding).repos.length === 0, "🔴 no principalLinkSets on the request → a link-set principal binding grants NOTHING (fail-closed: absent is not a wildcard)");
  ok(resolveAccess({ ...base, principalId: "U1", principalLinkSets: ["set-other"] }, bundles, lsBinding).repos.length === 0, "a different confirmed set does not match the referenced link-set");
  ok(resolveAccess({ ...base, principalLinkSets: ["set-rowan"] }, bundles, lsBinding).repos.length === 0, "principalLinkSets with no principalId grants nothing — the caller must be present");
  ok(resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C1", principalId: "U1", principalLinkSets: ["set-rowan"] }, bundles, lsBinding).repos.length === 0, "a link-set principal binding contributes NOTHING in a channel");

  const both: Binding[] = [
    { bundle: "human", scope: { level: "principal", principal: "linkSet:set-rowan" } },
    { bundle: "exact", scope: { level: "principal", principal: "slack/T1/U1" } },
  ];
  const tie = resolveAccess({ ...base, principalId: "U1", principalLinkSets: ["set-rowan"] }, bundles, both);
  ok(tie.connections.length === 1 && tie.connections[0]!.secretRef === "EXACT_KEY", "🔴 narrowest-wins: an EXACT principal binding beats a LINK-SET principal binding for the same connection id");
  ok(tie.repos.includes("acme/human") && tie.repos.includes("acme/exact"), "…while additive fields (repos) UNION across the exact and link-set principal bindings");
  ok(tie.instructionStack.length === 2 && tie.instructionStack[0]!.source === "principal:linkSet:set-rowan" && tie.instructionStack[1]!.source === "principal:slack/T1/U1", "instructions order link-set → exact (the exact/personal layer outranks)");

  const other = resolveAccess({ ...base, principalId: "U2", principalLinkSets: ["set-rowan"] }, bundles, both);
  ok(other.connections.length === 1 && other.connections[0]!.secretRef === "HUMAN_KEY", "a set member with no exact binding gets the shared link-set credential");
}

{
  const COLLIDING_ID = "300000000000000104";
  const bundles: Bundle[] = [
    { name: "discord-personal", repos: ["acme/discord-scratch"] },
    { name: "teams-personal", repos: ["acme/teams-scratch"] },
  ];
  const bindings: Binding[] = [
    { bundle: "discord-personal", scope: { level: "principal", principal: `discord/${COLLIDING_ID}` } },
    { bundle: "teams-personal", scope: { level: "principal", principal: `teams/${COLLIDING_ID}` } },
  ];
  const dmOn = (platform: string): ResolveRequest => ({ mode: "dm", platform, workspace: "W1", channel: "D1", principalId: COLLIDING_ID });
  const d = resolveAccess(dmOn("discord"), bundles, bindings);
  const t = resolveAccess(dmOn("teams"), bundles, bindings);
  ok(d.repos.length === 1 && d.repos[0] === "acme/discord-scratch", "identical digit ids: the discord DM resolves ONLY the discord principal's bundle");
  ok(t.repos.length === 1 && t.repos[0] === "acme/teams-scratch", "identical digit ids: the teams DM resolves ONLY the teams principal's bundle");
  ok(resolveAccess(dmOn("slack"), bundles, bindings).repos.length === 0, "…and a third platform with the same id resolves nothing at all");
}

{
  const bundles: Bundle[] = [
    { name: "c", instructions: "channel rule" },
    { name: "o", instructions: "org rule" },
    { name: "d", instructions: "domain rule" },
    { name: "w", instructions: "ws rule" },
  ];
  const bindings: Binding[] = [
    { bundle: "c", scope: { level: "surface", surface: "slack/T1/C1" } },
    { bundle: "o", scope: { level: "org" } },
    { bundle: "d", scope: { level: "domain", domain: "pay" } },
    { bundle: "w", scope: { level: "tenant", tenant: "slack/T1" } },
  ];
  const a = resolveAccessT(chan("T1", "C1", ["pay"]), bundles, bindings);
  ok(a.instructionStack.map((l) => l.text).join("|") === "org rule|ws rule|domain rule|channel rule", "instructions ordered org -> tenant -> domain -> surface regardless of declaration order");
}

{
  const bundles: Bundle[] = [{ name: "dup", connections: [
    { id: "a", credentialType: "bearer", secretRef: "A", allowedWebsites: ["api.example.com"] },
    { id: "b", credentialType: "bearer", secretRef: "B", allowedWebsites: ["api.example.com"] },
  ] }];
  const bindings: Binding[] = [{ bundle: "dup", scope: { level: "surface", surface: "slack/T1/C1" } }];
  ok(resolveAccessT(chan("T1", "C1"), bundles, bindings).warnings.some((w) => w.includes("claiming host")), "two connections claiming the same host in one scope warns");
}

{
  const a = resolveAccessT(chan("T1", "C1"), [], [{ bundle: "ghost", scope: { level: "org" } }]);
  ok(a.warnings.some((w) => w.includes('unknown bundle "ghost"')), "binding to an undefined bundle warns and is ignored");
}

{
  const bundles: Bundle[] = [{ name: "Build", repos: ["acme/a", "acme/b"] }];
  ok(resolveAccessT(chan("T1", "C1"), bundles, [{ bundle: "Build", scope: { level: "org" } }]).warnings.some((w) => w.startsWith("broad grant") && w.includes("repo")), "repos at org scope raise a broad-grant warning");
  ok(resolveAccessT(chan("T1", "C1"), bundles, [{ bundle: "Build", scope: { level: "tenant", tenant: "slack/T1" } }]).warnings.some((w) => w.startsWith("broad grant")), "repos at tenant scope raise a broad-grant warning");
  ok(!resolveAccessT(chan("T1", "C1", ["d"]), bundles, [{ bundle: "Build", scope: { level: "domain", domain: "d" } }]).warnings.some((w) => w.startsWith("broad grant")), "domain scope is an intended grouping -> NO broad-grant warning");
  ok(!resolveAccessT(chan("T1", "C1"), bundles, [{ bundle: "Build", scope: { level: "surface", surface: "slack/T1/C1" } }]).warnings.some((w) => w.startsWith("broad grant")), "surface scope -> NO broad-grant warning");
}

{
  const SOAK = "linear/org-soak/team-soak";
  const OTHER = "linear/org-soak/team-other";
  const bundles: Bundle[] = [
    { name: "work-a", workSurfaces: [SOAK] },
    { name: "work-b", workSurfaces: [OTHER] },
  ];
  const bindings: Binding[] = [
    { bundle: "work-a", scope: { level: "surface", surface: "slack/T1/C1" } },
    { bundle: "work-b", scope: { level: "surface", surface: "slack/T1/C1" } },
  ];
  const granted = resolveAccessT(chan("T1", "C1"), bundles, bindings);
  ok(granted.workSurfaces.length === 2 && granted.workSurfaces.includes(SOAK) && granted.workSurfaces.includes(OTHER), "work surfaces union across two bundles at one scope");
  const ungranted = resolveAccessT(chan("T1", "C2"), bundles, bindings);
  ok(ungranted.workSurfaces.length === 0, "an unbound channel resolves NO work surface (default-deny)");

  ok(
    resolveAccessT(chan("T1", "C1"), bundles, [{ bundle: "work-a", scope: { level: "org" } }]).warnings.some((w) => w.startsWith("broad grant") && w.includes("work surface")),
    "work surfaces at org scope raise a broad-grant warning",
  );
  ok(
    !resolveAccessT(chan("T1", "C1"), bundles, [{ bundle: "work-a", scope: { level: "surface", surface: "slack/T1/C1" } }]).warnings.some((w) => w.startsWith("broad grant")),
    "work surfaces at surface scope -> NO broad-grant warning",
  );

  ok(assertBundlesValid([{ name: "ok", workSurfaces: [SOAK, "linear/org-soak", "linear/org-soak/team-*"] }]) === undefined, "an exact key, a whole-tenant claim and a same-level glob all load");
  throwsWith(() => assertBundlesValid([{ name: "bad", workSurfaces: ["linear"] }]), "is not a well-formed surface key", "a one-segment entry is refused");
  throwsWith(() => assertBundlesValid([{ name: "bad", workSurfaces: ["linear/*/team-x"] }]), "is not a well-formed surface key", "a wildcard tenant is refused");
  throwsWith(() => assertBundlesValid([{ name: "bad", workSurfaces: ["slack/T1/C1"] }]), "reads no work-surface grant", "a platform with no consumer is refused (dead config reads as a live capability)");
  throwsWith(() => assertBundlesValid([{ name: "bad", workSurfaces: ["github/acme/web"] }]), "granted with `repos`", "GitHub is refused here and pointed at the grant that already exists");
  throwsWith(() => assertBundlesValid([{ name: "bad", workSurfaces: ["linear/org-soak/team:x"] }]), "person-GROUP rung", "a group rung is refused — a work grant addresses a surface");
  throwsWith(() => assertBundlesValid([{ name: "bad", workSurfaces: [SOAK, SOAK] }]), "more than once", "a duplicated entry is refused");
}

{
  const bundles: Bundle[] = [
    { name: "base", connectors: [{ name: "notion", credential: "k" }] },
    { name: "pay", connectors: [{ name: "linear-mcp", credential: "k" }, { name: "notion", credential: "k" }] },
  ];
  const bindings: Binding[] = [
    { bundle: "base", scope: { level: "org" } },
    { bundle: "pay", scope: { level: "surface", surface: "slack/T1/C1" } },
  ];
  const a = resolveAccessT(chan("T1", "C1"), bundles, bindings);
  ok(a.connectors.length === 2 && a.connectors.includes("notion") && a.connectors.includes("linear-mcp"), "connectors union across org + surface (deduped)");
  const b = resolveAccessT(chan("T1", "C2"), bundles, bindings);
  ok(b.connectors.length === 1 && b.connectors[0] === "notion", "sibling channel gets only the org baseline connector (default-deny on channel grants)");
  ok(resolveAccessT(chan("T1", "C3"), [{ name: "empty" }], [{ bundle: "empty", scope: { level: "org" } }]).connectors.length === 0, "no connectors granted -> empty array (fail-closed)");
}

{
  const bundles: Bundle[] = [
    { name: "good", connectors: [{ name: "notion", credential: "k", contentOrigin: "external" }] },
    { name: "ghost-cred", connectors: [{ name: "notion", credential: "not-configured", contentOrigin: "external" }] },
    { name: "ghost-connector", connectors: [{ name: "nowhere", credential: "k", contentOrigin: "external" }] },
    { name: "no-cred", connectors: ["notion"] },
  ];
  const at = (bundle: string) => [{ bundle, scope: { level: "surface" as const, surface: "slack/T1/C1" } }];

  const good = resolveAccessT(chan("T1", "C1"), bundles, at("good"));
  ok(good.connectors.includes("notion"), "one list: a grant naming a CONFIGURED credential mounts the connector");
  ok(good.connectorCredentials["notion"]?.credential === "k", "…and binds that credential for this surface, keyed by connector slug");
  ok(good.connectorCredentials["notion"]?.secretRef === "SECRET_notion", "…carrying the credential's own secretRef, not a fallback");
  ok(good.warnings.length === 0, "…with no warnings — this is the ordinary path");

  const ghostCred = resolveAccessT(chan("T1", "C1"), bundles, at("ghost-cred"));
  ok(!ghostCred.connectors.includes("notion"), "🔴 a grant naming an UNCONFIGURED credential grants NO connector — not the connector minus its identity");
  ok(ghostCred.connectorCredentials["notion"] === undefined, "…and binds nothing");
  ok(
    ghostCred.warnings.some((w) => w.includes("unknown credential") && w.includes("not-configured")),
    "…and warns, naming the credential it could not find",
  );

  const ghostConnector = resolveAccessT(chan("T1", "C1"), bundles, at("ghost-connector"));
  ok(ghostConnector.connectors.length === 0, "a grant for a connector with NO credential catalogue grants nothing");
  ok(
    ghostConnector.warnings.some((w) => w.includes("no credential catalogue")),
    "…and warns, naming the connector that has no catalogue",
  );

  ok(
    ghostCred.connectorContentOrigin["notion"] === undefined,
    "🔴 a grant that resolved NO credential contributes NO content-origin declaration either",
  );
  ok(good.connectorContentOrigin["notion"] === "external", "…NEGATIVE CONTROL: a grant that DID resolve still declares, so the rule is about failure and not about silence");
  {
    const withPlugin = resolveAccessT(
      chan("T1", "C1"),
      [{ name: "ghost-cred", connectors: [{ name: "notion", credential: "not-configured", contentOrigin: "internal" }] }, { name: "p", plugins: ["acme"] }],
      [
        { bundle: "ghost-cred", scope: { level: "surface", surface: "slack/T1/C1" } },
        { bundle: "p", scope: { level: "surface", surface: "slack/T1/C1" } },
      ],
      { acme: { connectors: ["notion"], skills: [], subagents: [] } } as PluginRegistry,
    );
    ok(withPlugin.connectors.includes("notion"), "…the plugin still mounts the connector (that vocabulary needs no credential)");
    ok(
      withPlugin.connectorContentOrigin["notion"] === undefined,
      "🔴 …and it stays UNDECLARED: a failed grant cannot vouch for a connector a plugin made reachable",
    );
  }

  const noCred = resolveAccessT(chan("T1", "C1"), bundles, at("no-cred"));
  ok(noCred.connectors.length === 0, "🔴 a BARE SLUG grant resolves to nothing — the resolver is pure and does not validate, so it must answer for config assertBundlesValid refuses");
  ok(noCred.warnings.some((w) => w.includes("names no credential")), "…and says why, rather than failing silently");
}

{
  const bundles: Bundle[] = [
    { name: "declared", connectors: [{ name: "notion", credential: "k", contentOrigin: "internal" }] },
    { name: "bare", connectors: [{ name: "linear-mcp", credential: "k" }] },
  ];
  const bindings: Binding[] = [
    { bundle: "declared", scope: { level: "domain", domain: "d" } },
    { bundle: "bare", scope: { level: "domain", domain: "d" } },
  ];
  const a = resolveAccessT(chan("T1", "C1", ["d"]), bundles, bindings);
  ok(a.connectors.includes("notion") && a.connectors.includes("linear-mcp"), "a grant that declares a contentOrigin mounts the same connector one that stays silent does — the declaration changes the taint verdict, never the capability");
  ok(a.connectorContentOrigin["notion"] === "internal", "the declared origin resolves onto EffectiveAccess.connectorContentOrigin, keyed by connection name");
  ok(!("linear-mcp" in a.connectorContentOrigin), "🔴 a BARE grant contributes NO key — silence is not a declaration, and an absent key is what keeps the table's verdict marked `assumed`");
  ok(a.connectorContentOrigin["nothing-like-this"] === undefined, "an ungranted connector is absent too (the map is sparse, never a default-filled table)");

  ok(Object.keys(a.connectorContentOrigin).length === 1, "one declaration produces exactly one key — a bundle's vouch cannot leak onto a sibling bundle's connector");

  const other = resolveAccessT(chan("T1", "C9"), bundles, [{ bundle: "bare", scope: { level: "org" } }]);
  ok(other.connectors.includes("linear-mcp") && Object.keys(other.connectorContentOrigin).length === 0, "a scope that resolves only the undeclaring bundle carries an EMPTY declaration map — declarations travel with the binding, not with the deployment");

  const viaPlugin = resolveAccessT(
    chan("T1", "C1", ["d"]),
    [{ name: "p", plugins: ["acme"] }],
    [{ bundle: "p", scope: { level: "domain", domain: "d" } }],
    { acme: { connectors: ["notion"], skills: [], subagents: [] } } as PluginRegistry,
  );
  ok(viaPlugin.connectors.includes("notion") && viaPlugin.connectorContentOrigin["notion"] === undefined, "a plugin-granted connector declares nothing — the plugin vocabulary has no contentOrigin field, and the resolver must not borrow a same-named raw grant's declaration");

  const perTool = resolveAccessT(
    chan("T1", "C1", ["d"]),
    [{ name: "desk", connectors: [{ name: "helpdesk", credential: "k", contentOrigin: { default: "internal", except: { search_tickets: "external" } } }] }],
    [{ bundle: "desk", scope: { level: "domain", domain: "d" } }],
  );
  ok(
    JSON.stringify(perTool.connectorContentOrigin["helpdesk"]) === JSON.stringify({ default: "internal", except: { search_tickets: "external" } }),
    "a `{ default, except }` declaration resolves onto EffectiveAccess VERBATIM — the per-tool answer is computed at the seam that knows the tool name, never guessed here",
  );
}

{
  const bundles: Bundle[] = [
    { name: "wide", connectors: [{ name: "notion", credential: "k", contentOrigin: "internal" }] },
    { name: "narrow", connectors: [{ name: "notion", credential: "k", contentOrigin: "external" }] },
  ];
  const a = resolveAccessT(chan("T1", "C1"), bundles, [
    { bundle: "wide", scope: { level: "org" } },
    { bundle: "narrow", scope: { level: "surface", surface: "slack/T1/C1" } },
  ]);
  ok(a.connectorContentOrigin["notion"] === "external", "🔴 internal + external for the SAME connection resolves to external — NOT narrowest-wins, because the two grants describe one global instance rather than choosing between interchangeable credentials");
  ok(a.warnings.some((w) => w.includes('connector "notion"') && w.includes("contradictory")), "…and it warns: a config that contradicts itself about who authors a connector's bytes is something an operator has to answer, not something to resolve silently");

  const flipped = resolveAccessT(chan("T1", "C1"), bundles, [
    { bundle: "narrow", scope: { level: "org" } },
    { bundle: "wide", scope: { level: "surface", surface: "slack/T1/C1" } },
  ]);
  ok(flipped.connectorContentOrigin["notion"] === "external", "the contradiction resolves the same way with the bindings swapped — specificity does not get a vote on content origin");

  const withBare: Bundle[] = [
    { name: "wide", connectors: [{ name: "notion", credential: "k" }] },
    { name: "narrow", connectors: [{ name: "notion", credential: "k", contentOrigin: "internal" }] },
  ];
  const mixed = resolveAccessT(chan("T1", "C1"), withBare, [
    { bundle: "wide", scope: { level: "org" } },
    { bundle: "narrow", scope: { level: "surface", surface: "slack/T1/C1" } },
  ]);
  ok(mixed.connectorContentOrigin["notion"] === "internal", "a grant that declares NO origin beside a declared one keeps the declaration — silence is the absence of a claim, so it cannot outrank one");
  ok(!mixed.warnings.some((w) => w.includes("contradictory")), "…and that is not warned about: nothing disagrees");

  const perToolClash: Bundle[] = [
    { name: "wide", connectors: [{ name: "helpdesk", credential: "k", contentOrigin: { default: "internal", except: { search_tickets: "external" } } }] },
    { name: "narrow", connectors: [{ name: "helpdesk", credential: "k", contentOrigin: { default: "internal", except: { search_tickets: "internal" } } }] },
  ];
  const clash = resolveAccessT(chan("T1", "C1"), perToolClash, [
    { bundle: "wide", scope: { level: "org" } },
    { bundle: "narrow", scope: { level: "surface", surface: "slack/T1/C1" } },
  ]);
  ok(clash.connectorContentOrigin["helpdesk"] === "external", "two per-tool declarations that disagree about ONE tool collapse to a flat `external` — a merge would be a third declaration nobody reviewed");
  ok(clash.warnings.some((w) => w.includes('connector "helpdesk"') && w.includes("contradictory")), "…and it warns, naming the connector");

  const sameClaim: Bundle[] = [
    { name: "wide", connectors: [{ name: "helpdesk", credential: "k", contentOrigin: { default: "internal", except: { b: "external", a: "external" } } }] },
    { name: "narrow", connectors: [{ name: "helpdesk", credential: "k", contentOrigin: { default: "internal", except: { a: "external", b: "external" } } }] },
  ];
  const agreed = resolveAccessT(chan("T1", "C1"), sameClaim, [
    { bundle: "wide", scope: { level: "org" } },
    { bundle: "narrow", scope: { level: "surface", surface: "slack/T1/C1" } },
  ]);
  ok(!agreed.warnings.some((w) => w.includes("contradictory")), "two specs that answer identically for every tool are ONE claim — key order in `except` is not a disagreement");
  ok(typeof agreed.connectorContentOrigin["helpdesk"] === "object", "…and the surviving declaration keeps its per-tool grain rather than being flattened");
}

{
  type AnyGrant = { name: string; credential: string; contentOrigin: "internal" };

  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: ["notion"] }]),
    "as a bare slug",
    "🔴 a BARE SLUG is rejected — a grant names the identity it reaches the connector as",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: [{ name: "notion", contentOrigin: "internal" } as unknown as AnyGrant] }]),
    "with no `credential`",
    "🔴 an object grant with NO credential is rejected — mandatory means mandatory, not defaulted",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: [{ name: "notion", credential: "  ", contentOrigin: "internal" }] }]),
    "with no `credential`",
    "…a blank credential is the same refusal — whitespace is not an identity",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "grants:slack/T1/C1", connectors: [{ name: "notion" } as unknown as AnyGrant] }]),
    "with no `credential`",
    "🔴 the MACHINE-WRITTEN carve-out covers contentOrigin ONLY — an overlay grant still names its credential (the requester chose it at propose time)",
  );

  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: [{ name: "notion", credential: "k" }] }]),
    "has no `contentOrigin`",
    "🔴 an object grant with a credential but NO contentOrigin is rejected — an undeclared connector marks every turn, and nothing told the operator why",
  );
  for (const fragment of ['contentOrigin: "internal"', '"external"', "except:"] as const) {
    throwsWith(
      () => assertBundlesValid([{ name: "b", connectors: [{ name: "notion", credential: "k" }] }]),
      fragment,
      `…and the error spells out an accepted shape (${fragment}) rather than pointing at a doc`,
    );
  }
  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: ["notion", "notion"] }]),
    'grants connector "notion" more than once',
    "…a grant that already failed the shape check is still duplicate-checked — all problems in one pass, not one per rerun",
  );

  assertBundlesValid([{ name: "grants:slack/T1/C1", connectors: [{ name: "notion", credential: "k" }] }]);
  assertBundlesValid([{ name: "agent:reporter", connectors: [{ name: "notion", credential: "k" }] }]);
  ok(true, "a `grants:`/`agent:` overlay bundle may omit contentOrigin — the codemods cannot write an operator assertion, so requiring one would make an approved request unloadable");
  throwsWith(
    () => assertBundlesValid([{ name: "grants:slack/T1/C1", connectors: [{ name: "notion", credential: "k", contentOrigin: "sideways" } as unknown as AnyGrant] }]),
    "declares unknown contentOrigin",
    "…but the exemption is ONLY the mandatory check — a hand-edited overlay that smuggles in a BAD declaration still fails loud",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "grantsy", connectors: [{ name: "notion", credential: "k" }] }]),
    "has no `contentOrigin`",
    "…and the exemption is the NAMESPACE, not a substring: `grantsy` is an ordinary bundle",
  );

  assertBundlesValid([{ name: "b", connectors: [{ name: "a", credential: "k", contentOrigin: "internal" }] }]);
  assertBundlesValid([{ name: "b", connectors: [{ name: "a", credential: "k", contentOrigin: "external" }] }]);
  assertBundlesValid([{ name: "b", connectors: [{ name: "a", credential: "k", contentOrigin: { default: "internal", except: { search: "external" } } }] }]);
  assertBundlesValid([{ name: "b", connectors: [{ name: "a", credential: "k", contentOrigin: { default: "external", except: { runbook: "internal" } } }] }]);
  ok(true, "every accepted shape — scalar internal/external and per-tool grain in both directions — passes validation");

  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: [{ name: "notion", credential: "k", contentOrigin: "trusted" } as unknown as AnyGrant] }]),
    "declares unknown contentOrigin",
    "an unknown `contentOrigin` value is a boot error, not a silently-undeclared grant",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: [{ name: "notion", credential: "k", contentOrigin: "public" } as unknown as AnyGrant] }]),
    "declares unknown contentOrigin",
    '🔴 the OLD vocabulary is rejected too — a config still saying `contentOrigin: "public"` must fail loud, not resolve to "declares nothing"',
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: [{ credential: "k", contentOrigin: "internal" } as unknown as AnyGrant] }]),
    "is not a { name, credential, contentOrigin } object",
    "a grant object with no name is rejected by shape",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: [{ name: "notion", credential: "k", contentOrigin: "internal" }, { name: "notion", credential: "k", contentOrigin: "external" }] }]),
    'grants connector "notion" more than once',
    "🔴 the duplicate check is by NAME — one bundle declaring a connector twice is ambiguous however each entry is spelled",
  );

  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: [{ name: "d", credential: "k", contentOrigin: { default: "sideways", except: { x: "external" } } } as unknown as AnyGrant] }]),
    "declares contentOrigin.default",
    "an unknown `default` is a boot error",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: [{ name: "d", credential: "k", contentOrigin: { default: "internal", except: { x: "publicish" } } } as unknown as AnyGrant] }]),
    'declares contentOrigin exception "x"',
    "an unknown per-tool override is a boot error — a typo must never silently fall back to `default`",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: [{ name: "d", credential: "k", contentOrigin: { default: "internal", except: {} } } as unknown as AnyGrant] }]),
    "an empty exception map",
    "`except: {}` is a scalar written the long way — rejected so a reader never hunts for an override that isn't there",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: [{ name: "d", credential: "k", contentOrigin: { default: "internal", except: ["x"] } } as unknown as AnyGrant] }]),
    "is not a { toolName: origin } map",
    "an array `except` is rejected by shape",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: [{ name: "helpdesk", credential: "k", contentOrigin: { default: "internal", except: { helpdesk__search: "external" } } }] }]),
    "are BARE tool names",
    "🔴 the QUALIFIED spelling is rejected: it would never match at the seam, so the tool would silently stay on `default` — a silent wrong answer about taint is the one thing this field exists to prevent",
  );

  assertBundlesValid([
    { name: "b", connectors: [{ name: "b", credential: "k", contentOrigin: "internal" }, { name: "c", credential: "k", contentOrigin: "external" }, { name: "d", credential: "k", contentOrigin: { default: "internal", except: { search: "external" } } }] },
  ]);
  ok(true, "a mixed scalar/per-tool list with distinct names is valid");
}

{
  const bundles: Bundle[] = [
    { name: "svc", connectors: [{ name: "notion", credential: "k" }] },
    { name: "mine", connectors: [{ name: "my-gmail", credential: "k" }] },
  ];
  const bindings: Binding[] = [
    { bundle: "svc", scope: { level: "org" } },
    { bundle: "mine", scope: { level: "principal", principal: "slack/T1/U_me" } },
  ];
  const dm: ResolveRequest = { mode: "dm", platform: "slack", workspace: "T1", channel: "D1", principalId: "U_me" };
  const a = resolveAccessT(dm, bundles, bindings);
  ok(!a.connectors.includes("notion"), "DM does not inherit the service-scoped connector (two connector universes)");
  ok(a.connectors.includes("my-gmail"), "DM resolves the caller's own personal connector grant");
}

{
  const bundles: Bundle[] = [{ name: "Conn", connectors: [{ name: "notion", credential: "k" }] }];
  ok(resolveAccessT(chan("T1", "C1"), bundles, [{ bundle: "Conn", scope: { level: "org" } }]).warnings.some((w) => w.startsWith("broad grant") && w.includes("connector")), "connectors at org scope raise a broad-grant warning");
  ok(resolveAccessT(chan("T1", "C1"), bundles, [{ bundle: "Conn", scope: { level: "tenant", tenant: "slack/T1" } }]).warnings.some((w) => w.startsWith("broad grant") && w.includes("connector")), "connectors at tenant scope raise a broad-grant warning");
  ok(!resolveAccessT(chan("T1", "C1", ["d"]), bundles, [{ bundle: "Conn", scope: { level: "domain", domain: "d" } }]).warnings.some((w) => w.startsWith("broad grant")), "connectors at domain scope -> NO broad-grant warning");
  ok(!resolveAccessT(chan("T1", "C1"), bundles, [{ bundle: "Conn", scope: { level: "surface", surface: "slack/T1/C1" } }]).warnings.some((w) => w.startsWith("broad grant")), "connectors at surface scope -> NO broad-grant warning");
}

{
  const registry: PluginRegistry = {
    acme: { connectors: ["acme__api"], skills: ["acme__lint"], subagents: ["acme__worker"] },
    bare: { skills: ["bare__fmt"] },
  };
  const bundles: Bundle[] = [
    { name: "base", plugins: ["bare"], connectors: [{ name: "notion", credential: "k" }] },
    { name: "team", plugins: ["acme"] },
  ];
  const bindings: Binding[] = [
    { bundle: "base", scope: { level: "org" } },
    { bundle: "team", scope: { level: "surface", surface: "slack/T1/C1" } },
  ];
  const a = resolveAccessT(chan("T1", "C1"), bundles, bindings, registry);
  ok(
    a.plugins.length === 2 && a.plugins.includes("acme") && a.plugins.includes("bare"),
    "plugin grants union across scopes (names)",
  );
  ok(
    a.skills.includes("acme__lint") && a.skills.includes("bare__fmt"),
    "plugin skills expand + union across scopes",
  );
  ok(a.subagents.includes("acme__worker"), "plugin subagents expand");
  ok(
    a.connectors.includes("acme__api") && a.connectors.includes("notion"),
    "plugin connectors fold into the connector grant (alongside direct connectors)",
  );

  const b = resolveAccessT(chan("T1", "C2"), bundles, bindings, registry);
  ok(
    b.plugins.length === 1 && b.plugins[0] === "bare",
    "sibling channel gets only the org-baseline plugin",
  );
  ok(
    !b.skills.includes("acme__lint") && b.skills.includes("bare__fmt"),
    "sibling channel sees only the baseline plugin's skills (scoped, default-deny)",
  );
  ok(
    !b.connectors.includes("acme__api"),
    "sibling channel does not get the channel-scoped plugin's connector",
  );

  const u = resolveAccessT(
    chan("T1", "C1"),
    [{ name: "x", plugins: ["ghost"] }],
    [{ bundle: "x", scope: { level: "surface", surface: "slack/T1/C1" } }],
    registry,
  );
  ok(
    u.skills.length === 0 && u.warnings.some((w) => w.includes('unknown plugin "ghost"')),
    "unknown plugin contributes nothing and warns",
  );

  const e = resolveAccessT(
    chan("T1", "C1"),
    [{ name: "x", plugins: ["acme"] }],
    [{ bundle: "x", scope: { level: "surface", surface: "slack/T1/C1" } }],
  );
  ok(
    e.skills.length === 0 && e.warnings.some((w) => w.includes("unknown plugin")),
    "default empty registry: plugin grants expand to nothing (fail-closed)",
  );
}

{
  const registry: PluginRegistry = { acme: { skills: ["acme__lint"] } };
  const bundles: Bundle[] = [{ name: "P", plugins: ["acme"] }];
  ok(
    resolveAccessT(chan("T1", "C1"), bundles, [{ bundle: "P", scope: { level: "org" } }], registry).warnings.some(
      (w) => w.startsWith("broad grant") && w.includes("plugin"),
    ),
    "plugins at org scope raise a broad-grant warning",
  );
  ok(
    !resolveAccess(
      chan("T1", "C1"),
      bundles,
      [{ bundle: "P", scope: { level: "surface", surface: "slack/T1/C1" } }],
      registry,
    ).warnings.some((w) => w.startsWith("broad grant")),
    "plugins at surface scope -> NO broad-grant warning",
  );
}

{
  const good: Bundle[] = [
    {
      name: "ok",
      repos: ["acme/web", "acme/api.v2"],
      connectors: [
        { name: "notion", credential: "k", contentOrigin: "external" },
        { name: "linear-mcp", credential: "k", contentOrigin: "external" },
      ],
      connections: [{ id: "gh", credentialType: "bearer", secretRef: "GH", allowedWebsites: ["api.github.com", "*.googleapis.com"] }],
      domains: ["raw.githubusercontent.com"],
    },
  ];
  assertBundlesValid(good);
  ok(true, "a well-formed bundle set validates (incl. org-subdomain wildcard)");

  throwsWith(
    () => assertBundlesValid([{ name: "dup" }, { name: "dup" }]),
    'bundle name "dup" is defined more than once',
    "duplicate bundle names throw",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", connections: [{ id: "gh", credentialType: "bearer", secretRef: "GH", allowedWebsites: [] }] }]),
    "empty allowedWebsites",
    "a connection with an empty allowedWebsites throws (credential sendable nowhere)",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", connections: [{ id: "gh", credentialType: "bearer", secretRef: "GH", allowedWebsites: ["*"] }] }]),
    'pattern "*" is overly broad',
    'a bare "*" allowedWebsites pattern throws',
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", domains: ["*.com"] }]),
    'pattern "*.com" is overly broad',
    'a single-label wildcard ("*.<tld>") egress domain throws',
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", connectors: ["notion", "notion"] }]),
    'grants connector "notion" more than once',
    "duplicate connector names within one bundle throw",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", repos: ["https://github.com/acme/web"] }]),
    "must be bare owner/name form",
    "a repo URL (not owner/name) throws",
  );
  throwsWith(() => assertBundlesValid([{ name: "b", repos: ["acme"] }]), "owner/name", "a bare owner with no repo name throws");
  throwsWith(() => assertBundlesValid([{ name: "b", repos: ["acme/web/tree"] }]), "owner/name", "an owner/name/extra path throws");
}

{
  const bundles: Bundle[] = [{ name: "basket" }];
  const good: Binding[] = [
    { bundle: "basket", scope: { level: "org" } },
    { bundle: "basket", scope: { level: "tenant", tenant: "slack/T1" } },
    { bundle: "basket", scope: { level: "domain", domain: "payments" } },
    { bundle: "basket", scope: { level: "surface", surface: "slack/T1/C1" } },
    { bundle: "basket", scope: { level: "surface", surface: "teams/tid/19-x-thread.tacv2" } },
    { bundle: "basket", scope: { level: "principal", principal: "slack/T1/U1" } },
  ];
  assertBindingsValid(good, bundles);
  ok(true, "well-formed bindings at every level validate (org/tenant/domain/surface/principal)");

  throwsWith(
    () => assertBindingsValid([{ bundle: "ghost", scope: { level: "org" } }], bundles),
    'unknown bundle "ghost"',
    "a binding to an undefined bundle throws at config load",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "tenant" } }], bundles),
    "needs scope.tenant",
    "a tenant-level binding without tenant throws",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "domain" } }], bundles),
    "needs scope.domain",
    "a domain-level binding without domain throws",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "surface" } }], bundles),
    "needs scope.surface",
    "a surface-level binding without surface throws",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "principal" } }], bundles),
    "needs scope.principal",
    "a principal-level binding without principal throws",
  );

  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "tenant", tenant: "T1" } }], bundles),
    "PLATFORM-QUALIFIED tenant key",
    "a bare workspace id at tenant scope throws (it has no platform, so it can never match)",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "surface", surface: "C1" } }], bundles),
    "fully-qualified surface key",
    "a bare channel id at surface scope throws",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "surface", surface: "slack/T1" } }], bundles),
    "fully-qualified surface key",
    "a two-segment (tenant-shaped) key at surface scope throws",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "domain", domain: "slack/T1/payments" } }], bundles),
    'scope.domain "slack/T1/payments" contains "/"',
    "a qualified domain key throws — domains are cross-platform, so the name is bare",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "principal", principal: "dm:U1" } }], bundles),
    "the old `workspace: \"dm:<id>\"` sentinel",
    "the retired dm: sentinel throws with the migration instruction",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "principal", principal: "U1" } }], bundles),
    "qualified principal key",
    "a BARE principal id throws at config load (it names no namespace, so it can never match)",
  );
  assertBindingsValid([{ bundle: "basket", scope: { level: "principal", principal: "slack/T1/U1" } }], bundles);
  ok(true, "🔴 a THREE-segment slack principal key is now the valid spelling of a person (OPE-309)");
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "principal", principal: "slack/U1" } }], bundles),
    "qualified principal key",
    "🔴 a PRE-RUNG two-segment slack principal key throws — on a tenant-scoped platform a key without its workspace names nobody the composer can mint",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "principal", principal: "discord/G1/U1" } }], bundles),
    "qualified principal key",
    "…and a three-segment key on a VENDOR-GLOBAL platform still throws — the rung is per-platform, never optional",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "principal", principal: "Slack/U1" } }], bundles),
    "qualified principal key",
    "an upper-cased platform token throws — platform strings are normalized lowercase everywhere, so \"Slack/U1\" would never match a live request",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "domain", domain: "payments", tenant: "slack/T1" } }], bundles),
    "also sets scope.tenant",
    "a domain scope carrying a tenant qualifier throws (a domain is org-global)",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "org", surface: "slack/T1/C1" } }], bundles),
    "also sets scope.surface",
    "an org scope carrying an address field throws",
  );
}

{
  const bundles: Bundle[] = [{ name: "unified", repos: ["acme/web"] }];
  const bindings: Binding[] = [{ bundle: "unified", scope: { level: "domain", domain: "e2e-unified" } }];
  const slackSide: ResolveRequest = { mode: "channel", platform: "slack", workspace: "T1", channel: "C1", domains: ["e2e-unified"] };
  const discordSide: ResolveRequest = { mode: "channel", platform: "discord", workspace: "G9", channel: "CH9", domains: ["e2e-unified"] };
  ok(resolveAccess(slackSide, bundles, bindings).repos[0] === "acme/web", "ONE domain binding covers the domain's Slack member");
  ok(resolveAccess(discordSide, bundles, bindings).repos[0] === "acme/web", "…and its Discord member, with no second binding");
  ok(
    resolveAccess({ ...discordSide, domains: ["other"] }, bundles, bindings).repos.length === 0,
    "membership is still the only thing that matches — a non-member surface gets nothing",
  );

  const tenantBinding: Binding[] = [{ bundle: "unified", scope: { level: "tenant", tenant: "slack/T1" } }];
  ok(resolveAccessT(chan("T1", "C1"), bundles, tenantBinding).repos.length === 1, "tenant binding applies on its own platform");
  ok(
    resolveAccess({ mode: "channel", platform: "discord", workspace: "T1", channel: "C1" }, bundles, tenantBinding).repos.length === 0,
    "a same-looking id on another platform does NOT match (platform is part of the address)",
  );
  const surfaceBinding: Binding[] = [{ bundle: "unified", scope: { level: "surface", surface: "slack/T1/C1" } }];
  ok(
    resolveAccess({ mode: "channel", platform: "discord", workspace: "T1", channel: "C1" }, bundles, surfaceBinding).repos.length === 0,
    "same for a surface binding — the key carries its platform",
  );

  const personal: Binding[] = [{ bundle: "unified", scope: { level: "principal", principal: "slack/T1/U1" } }];
  ok(resolveAccessT(chan("T1", "C1"), bundles, personal).repos.length === 0, "a principal binding grants nothing in a channel");
  ok(
    resolveAccess({ mode: "dm", platform: "slack", workspace: "T1", channel: "D1", principalId: "U1" }, bundles, personal).repos.length === 1,
    "…and everything in its own principal's DM",
  );
  ok(
    !resolveAccess({ mode: "dm", platform: "slack", workspace: "T1", channel: "D1", principalId: "U1" }, bundles, [
      { bundle: "unified", scope: { level: "org" } },
    ]).repos.length,
    "an org binding still grants nothing in a DM (two connector universes, unchanged)",
  );
  ok(
    !resolveAccessT(chan("T1", "C1"), bundles, personal).warnings.some((w) => w.startsWith("broad grant")),
    "a principal scope is never 'broad' — with no dm:-prefix special case left to carry it",
  );

  const grouped: Binding[] = [{ bundle: "unified", scope: { level: "group", group: "payments" } }];
  ok(
    resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C1", principalId: "U1", groups: ["payments"] }, bundles, grouped).repos.length === 0,
    "a group binding grants nothing in a channel — a group grants PEOPLE, not rooms",
  );
  ok(
    resolveAccess({ mode: "dm", platform: "slack", workspace: "T1", channel: "D1", principalId: "U1", groups: ["payments"] }, bundles, grouped).repos.length === 1,
    "…and everything in a member's own DM",
  );
  ok(
    resolveAccess({ mode: "dm", platform: "slack", workspace: "T1", channel: "D1", principalId: "U1" }, bundles, grouped).repos.length === 0,
    "an absent `groups` list is member-of-nothing, never a wildcard",
  );
}

console.log(`✓ resolver: ${passed} assertions passed`);
