import { resolveAccess, type ResolveRequest } from "../agent/access/resolver.js";
import { assertBindingsValid, assertBundlesValid, type Binding, type Bundle } from "../agent/access/bundle.js";
import type { PluginRegistry } from "../agent/plugins/types.js";

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
  const a = resolveAccess(chan("T1", "C1"), bundles, bindings);
  ok(a.repos.length === 2 && a.repos.includes("acme/shared") && a.repos.includes("acme/payments"), "repos union across org + surface");
  const b = resolveAccess(chan("T1", "C2"), bundles, bindings);
  ok(b.repos.length === 1 && b.repos[0] === "acme/shared", "new channel inherits only the broad baseline (default-deny on channel grants)");
}

{
  const bundles: Bundle[] = [{ name: "basket", repos: ["acme/web"] }];
  const bindings: Binding[] = [
    { bundle: "basket", scope: { level: "surface", surface: "slack/T1/C1" } },
    { bundle: "basket", scope: { level: "surface", surface: "slack/T1/C2" } },
  ];
  ok(resolveAccess(chan("T1", "C1"), bundles, bindings).repos[0] === "acme/web", "one bundle bound to C1");
  ok(resolveAccess(chan("T1", "C2"), bundles, bindings).repos[0] === "acme/web", "same bundle reused on C2 (define once, bind many)");
  ok(resolveAccess(chan("T1", "C3"), bundles, bindings).repos.length === 0, "unbound channel gets nothing");
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
  const a = resolveAccess(chan("T1", "C1", ["pay"]), bundles, bindings);
  ok(a.connections.length === 1 && a.connections[0].secretRef === "CHAN", "surface beats domain/tenant/org for same connection id");
  const noChan = resolveAccess(chan("T1", "C9", ["pay"]), bundles, bindings);
  ok(noChan.connections[0].secretRef === "DOMAIN", "domain beats tenant/org when no surface binding");
  const noDomain = resolveAccess(chan("T1", "C9"), bundles, bindings);
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
  const a = resolveAccess(chan("T1", "C1"), bundles, bindings);
  ok(a.reachableHosts.find((h) => h.host === "api.linear.app")?.viaConnection === "linear", "credentialed host carries its connection id");
  ok(a.reachableHosts.find((h) => h.host === "raw.githubusercontent.com")?.viaConnection === null, "credential-less domain reachable with no connection");
}

{
  const bundles: Bundle[] = [{ name: "pay-tools", repos: ["acme/payments"] }];
  const bindings: Binding[] = [{ bundle: "pay-tools", scope: { level: "domain", domain: "payments" } }];
  ok(resolveAccess(chan("T1", "C1", ["payments"]), bundles, bindings).repos[0] === "acme/payments", "domain-scoped bundle applies to a member surface");
  ok(resolveAccess(chan("T1", "C1", ["other"]), bundles, bindings).repos.length === 0, "domain-scoped bundle does NOT apply to a non-member surface");
  ok(resolveAccess(chan("T1", "C1"), bundles, bindings).repos.length === 0, "no domains on the request -> domain bundle doesn't apply");
  ok(
    resolveAccess(chan("T2", "C1", ["payments"]), bundles, bindings).repos[0] === "acme/payments",
    "a domain grant follows its domain across tenants — membership, not workspace, is the test",
  );
}

{
  const bundles: Bundle[] = [{ name: "ws", repos: ["acme/ws"] }];
  const bindings: Binding[] = [{ bundle: "ws", scope: { level: "tenant", tenant: "slack/T1" } }];
  ok(resolveAccess(chan("T1", "C1"), bundles, bindings).repos.length === 1, "tenant bundle applies inside its tenant");
  ok(resolveAccess(chan("T2", "C1"), bundles, bindings).repos.length === 0, "tenant bundle does NOT leak to another tenant");
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
  const a = resolveAccess(dm, bundles, bindings);
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
  const a = resolveAccess(chan("T1", "C1", ["pay"]), bundles, bindings);
  ok(a.instructionStack.map((l) => l.text).join("|") === "org rule|ws rule|domain rule|channel rule", "instructions ordered org -> tenant -> domain -> surface regardless of declaration order");
}

{
  const bundles: Bundle[] = [{ name: "dup", connections: [
    { id: "a", credentialType: "bearer", secretRef: "A", allowedWebsites: ["api.example.com"] },
    { id: "b", credentialType: "bearer", secretRef: "B", allowedWebsites: ["api.example.com"] },
  ] }];
  const bindings: Binding[] = [{ bundle: "dup", scope: { level: "surface", surface: "slack/T1/C1" } }];
  ok(resolveAccess(chan("T1", "C1"), bundles, bindings).warnings.some((w) => w.includes("claiming host")), "two connections claiming the same host in one scope warns");
}

{
  const a = resolveAccess(chan("T1", "C1"), [], [{ bundle: "ghost", scope: { level: "org" } }]);
  ok(a.warnings.some((w) => w.includes('unknown bundle "ghost"')), "binding to an undefined bundle warns and is ignored");
}

{
  const bundles: Bundle[] = [{ name: "Build", repos: ["acme/a", "acme/b"] }];
  ok(resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "Build", scope: { level: "org" } }]).warnings.some((w) => w.startsWith("broad grant") && w.includes("repo")), "repos at org scope raise a broad-grant warning");
  ok(resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "Build", scope: { level: "tenant", tenant: "slack/T1" } }]).warnings.some((w) => w.startsWith("broad grant")), "repos at tenant scope raise a broad-grant warning");
  ok(!resolveAccess(chan("T1", "C1", ["d"]), bundles, [{ bundle: "Build", scope: { level: "domain", domain: "d" } }]).warnings.some((w) => w.startsWith("broad grant")), "domain scope is an intended grouping -> NO broad-grant warning");
  ok(!resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "Build", scope: { level: "surface", surface: "slack/T1/C1" } }]).warnings.some((w) => w.startsWith("broad grant")), "surface scope -> NO broad-grant warning");
}

{
  const bundles: Bundle[] = [
    { name: "base", connectors: ["notion"] },
    { name: "pay", connectors: ["linear-mcp", "notion"] },
  ];
  const bindings: Binding[] = [
    { bundle: "base", scope: { level: "org" } },
    { bundle: "pay", scope: { level: "surface", surface: "slack/T1/C1" } },
  ];
  const a = resolveAccess(chan("T1", "C1"), bundles, bindings);
  ok(a.connectors.length === 2 && a.connectors.includes("notion") && a.connectors.includes("linear-mcp"), "connectors union across org + surface (deduped)");
  const b = resolveAccess(chan("T1", "C2"), bundles, bindings);
  ok(b.connectors.length === 1 && b.connectors[0] === "notion", "sibling channel gets only the org baseline connector (default-deny on channel grants)");
  ok(resolveAccess(chan("T1", "C3"), [{ name: "empty" }], [{ bundle: "empty", scope: { level: "org" } }]).connectors.length === 0, "no connectors granted -> empty array (fail-closed)");
}

{
  const bundles: Bundle[] = [
    { name: "svc", connectors: ["notion"] },
    { name: "mine", connectors: ["my-gmail"] },
  ];
  const bindings: Binding[] = [
    { bundle: "svc", scope: { level: "org" } },
    { bundle: "mine", scope: { level: "principal", principal: "slack/T1/U_me" } },
  ];
  const dm: ResolveRequest = { mode: "dm", platform: "slack", workspace: "T1", channel: "D1", principalId: "U_me" };
  const a = resolveAccess(dm, bundles, bindings);
  ok(!a.connectors.includes("notion"), "DM does not inherit the service-scoped connector (two connector universes)");
  ok(a.connectors.includes("my-gmail"), "DM resolves the caller's own personal connector grant");
}

{
  const bundles: Bundle[] = [{ name: "Conn", connectors: ["notion"] }];
  ok(resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "Conn", scope: { level: "org" } }]).warnings.some((w) => w.startsWith("broad grant") && w.includes("connector")), "connectors at org scope raise a broad-grant warning");
  ok(resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "Conn", scope: { level: "tenant", tenant: "slack/T1" } }]).warnings.some((w) => w.startsWith("broad grant") && w.includes("connector")), "connectors at tenant scope raise a broad-grant warning");
  ok(!resolveAccess(chan("T1", "C1", ["d"]), bundles, [{ bundle: "Conn", scope: { level: "domain", domain: "d" } }]).warnings.some((w) => w.startsWith("broad grant")), "connectors at domain scope -> NO broad-grant warning");
  ok(!resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "Conn", scope: { level: "surface", surface: "slack/T1/C1" } }]).warnings.some((w) => w.startsWith("broad grant")), "connectors at surface scope -> NO broad-grant warning");
}

{
  const registry: PluginRegistry = {
    acme: { connectors: ["acme__api"], skills: ["acme__lint"], subagents: ["acme__worker"] },
    bare: { skills: ["bare__fmt"] },
  };
  const bundles: Bundle[] = [
    { name: "base", plugins: ["bare"], connectors: ["notion"] },
    { name: "team", plugins: ["acme"] },
  ];
  const bindings: Binding[] = [
    { bundle: "base", scope: { level: "org" } },
    { bundle: "team", scope: { level: "surface", surface: "slack/T1/C1" } },
  ];
  const a = resolveAccess(chan("T1", "C1"), bundles, bindings, registry);
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

  const b = resolveAccess(chan("T1", "C2"), bundles, bindings, registry);
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

  const u = resolveAccess(
    chan("T1", "C1"),
    [{ name: "x", plugins: ["ghost"] }],
    [{ bundle: "x", scope: { level: "surface", surface: "slack/T1/C1" } }],
    registry,
  );
  ok(
    u.skills.length === 0 && u.warnings.some((w) => w.includes('unknown plugin "ghost"')),
    "unknown plugin contributes nothing and warns",
  );

  const e = resolveAccess(
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
    resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "P", scope: { level: "org" } }], registry).warnings.some(
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
      connectors: ["notion", "linear-mcp"],
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
  ok(resolveAccess(chan("T1", "C1"), bundles, tenantBinding).repos.length === 1, "tenant binding applies on its own platform");
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
  ok(resolveAccess(chan("T1", "C1"), bundles, personal).repos.length === 0, "a principal binding grants nothing in a channel");
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
    !resolveAccess(chan("T1", "C1"), bundles, personal).warnings.some((w) => w.startsWith("broad grant")),
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
