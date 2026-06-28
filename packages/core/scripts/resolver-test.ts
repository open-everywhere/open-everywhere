import { resolveAccess, type ResolveRequest } from "../agent/access/resolver.js";
import type { Binding, Bundle } from "../agent/access/bundle.js";
import type { PluginRegistry } from "../agent/plugins/types.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
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
    { bundle: "pay", scope: { level: "channel", workspace: "T1", channel: "C1" } },
  ];
  const a = resolveAccess(chan("T1", "C1"), bundles, bindings);
  ok(a.repos.length === 2 && a.repos.includes("acme/shared") && a.repos.includes("acme/payments"), "repos union across org + channel");
  const b = resolveAccess(chan("T1", "C2"), bundles, bindings);
  ok(b.repos.length === 1 && b.repos[0] === "acme/shared", "new channel inherits only the broad baseline (default-deny on channel grants)");
}

{
  const bundles: Bundle[] = [{ name: "basket", repos: ["acme/web"] }];
  const bindings: Binding[] = [
    { bundle: "basket", scope: { level: "channel", workspace: "T1", channel: "C1" } },
    { bundle: "basket", scope: { level: "channel", workspace: "T1", channel: "C2" } },
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
    { bundle: "w", scope: { level: "workspace", workspace: "T1" } },
    { bundle: "d", scope: { level: "domain", workspace: "T1", domain: "pay" } },
    { bundle: "c", scope: { level: "channel", workspace: "T1", channel: "C1" } },
  ];
  const a = resolveAccess(chan("T1", "C1", ["pay"]), bundles, bindings);
  ok(a.connections.length === 1 && a.connections[0].secretRef === "CHAN", "channel beats domain/workspace/org for same connection id");
  const noChan = resolveAccess(chan("T1", "C9", ["pay"]), bundles, bindings);
  ok(noChan.connections[0].secretRef === "DOMAIN", "domain beats workspace/org when no channel binding");
  const noDomain = resolveAccess(chan("T1", "C9"), bundles, bindings);
  ok(noDomain.connections[0].secretRef === "WS", "workspace beats org when surface is in no domain");
}

{
  const bundles: Bundle[] = [
    { name: "org", domains: ["raw.githubusercontent.com"] },
    { name: "ch", connections: [{ id: "linear", credentialType: "bearer", secretRef: "LINEAR", allowedWebsites: ["api.linear.app"] }] },
  ];
  const bindings: Binding[] = [
    { bundle: "org", scope: { level: "org" } },
    { bundle: "ch", scope: { level: "channel", workspace: "T1", channel: "C1" } },
  ];
  const a = resolveAccess(chan("T1", "C1"), bundles, bindings);
  ok(a.reachableHosts.find((h) => h.host === "api.linear.app")?.viaConnection === "linear", "credentialed host carries its connection id");
  ok(a.reachableHosts.find((h) => h.host === "raw.githubusercontent.com")?.viaConnection === null, "credential-less domain reachable with no connection");
}

{
  const bundles: Bundle[] = [{ name: "pay-tools", repos: ["acme/payments"] }];
  const bindings: Binding[] = [{ bundle: "pay-tools", scope: { level: "domain", workspace: "T1", domain: "payments" } }];
  ok(resolveAccess(chan("T1", "C1", ["payments"]), bundles, bindings).repos[0] === "acme/payments", "domain-scoped bundle applies to a member surface");
  ok(resolveAccess(chan("T1", "C1", ["other"]), bundles, bindings).repos.length === 0, "domain-scoped bundle does NOT apply to a non-member surface");
  ok(resolveAccess(chan("T1", "C1"), bundles, bindings).repos.length === 0, "no domains on the request -> domain bundle doesn't apply");
  ok(resolveAccess(chan("T2", "C1", ["payments"]), bundles, bindings).repos.length === 0, "domain is workspace-scoped: same domain name in another workspace doesn't match");
}

{
  const bundles: Bundle[] = [{ name: "ws", repos: ["acme/ws"] }];
  const bindings: Binding[] = [{ bundle: "ws", scope: { level: "workspace", workspace: "T1" } }];
  ok(resolveAccess(chan("T1", "C1"), bundles, bindings).repos.length === 1, "workspace bundle applies inside its workspace");
  ok(resolveAccess(chan("T2", "C1"), bundles, bindings).repos.length === 0, "workspace bundle does NOT leak to another workspace");
}

{
  const bundles: Bundle[] = [
    { name: "org", repos: ["acme/shared"], connections: [{ id: "gh", credentialType: "bearer", secretRef: "ORG", allowedWebsites: ["api.github.com"] }] },
    { name: "ch", repos: ["acme/payments"] },
    { name: "personal", repos: ["acme/scratch"] },
  ];
  const bindings: Binding[] = [
    { bundle: "org", scope: { level: "org" } },
    { bundle: "ch", scope: { level: "channel", workspace: "T1", channel: "C1" } },
    { bundle: "personal", scope: { level: "workspace", workspace: "dm:U1" } },
  ];
  const dm: ResolveRequest = { mode: "dm", platform: "slack", workspace: "T1", channel: "C1", principalId: "U1" };
  const a = resolveAccess(dm, bundles, bindings);
  ok(a.repos.length === 1 && a.repos[0] === "acme/scratch", "DM resolves the caller's personal scope ONLY");
  ok(a.connections.length === 0, "DM does not inherit the org service credential");
  ok(a.scopeKey === "dm:U1", "DM scopeKey is the principal");
  const none: ResolveRequest = { mode: "dm", platform: "slack", workspace: "T1", channel: "C1", principalId: "U2" };
  ok(resolveAccess(none, bundles, bindings).repos.length === 0, "DM with no personal bundle = empty surface");
}

{
  const bundles: Bundle[] = [
    { name: "c", instructions: "channel rule" },
    { name: "o", instructions: "org rule" },
    { name: "d", instructions: "domain rule" },
    { name: "w", instructions: "ws rule" },
  ];
  const bindings: Binding[] = [
    { bundle: "c", scope: { level: "channel", workspace: "T1", channel: "C1" } },
    { bundle: "o", scope: { level: "org" } },
    { bundle: "d", scope: { level: "domain", workspace: "T1", domain: "pay" } },
    { bundle: "w", scope: { level: "workspace", workspace: "T1" } },
  ];
  const a = resolveAccess(chan("T1", "C1", ["pay"]), bundles, bindings);
  ok(a.instructionStack.map((l) => l.text).join("|") === "org rule|ws rule|domain rule|channel rule", "instructions ordered org -> workspace -> domain -> channel regardless of declaration order");
}

{
  const bundles: Bundle[] = [{ name: "dup", connections: [
    { id: "a", credentialType: "bearer", secretRef: "A", allowedWebsites: ["api.example.com"] },
    { id: "b", credentialType: "bearer", secretRef: "B", allowedWebsites: ["api.example.com"] },
  ] }];
  const bindings: Binding[] = [{ bundle: "dup", scope: { level: "channel", workspace: "T1", channel: "C1" } }];
  ok(resolveAccess(chan("T1", "C1"), bundles, bindings).warnings.some((w) => w.includes("claiming host")), "two connections claiming the same host in one scope warns");
}

{
  const a = resolveAccess(chan("T1", "C1"), [], [{ bundle: "ghost", scope: { level: "org" } }]);
  ok(a.warnings.some((w) => w.includes('unknown bundle "ghost"')), "binding to an undefined bundle warns and is ignored");
}

{
  const bundles: Bundle[] = [{ name: "Build", repos: ["acme/a", "acme/b"] }];
  ok(resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "Build", scope: { level: "org" } }]).warnings.some((w) => w.startsWith("broad grant") && w.includes("repo")), "repos at org scope raise a broad-grant warning");
  ok(resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "Build", scope: { level: "workspace", workspace: "T1" } }]).warnings.some((w) => w.startsWith("broad grant")), "repos at workspace scope raise a broad-grant warning");
  ok(!resolveAccess(chan("T1", "C1", ["d"]), bundles, [{ bundle: "Build", scope: { level: "domain", workspace: "T1", domain: "d" } }]).warnings.some((w) => w.startsWith("broad grant")), "domain scope is an intended grouping -> NO broad-grant warning");
  ok(!resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "Build", scope: { level: "channel", workspace: "T1", channel: "C1" } }]).warnings.some((w) => w.startsWith("broad grant")), "channel scope -> NO broad-grant warning");
}

{
  const bundles: Bundle[] = [
    { name: "base", connectors: ["notion"] },
    { name: "pay", connectors: ["linear-mcp", "notion"] },
  ];
  const bindings: Binding[] = [
    { bundle: "base", scope: { level: "org" } },
    { bundle: "pay", scope: { level: "channel", workspace: "T1", channel: "C1" } },
  ];
  const a = resolveAccess(chan("T1", "C1"), bundles, bindings);
  ok(a.connectors.length === 2 && a.connectors.includes("notion") && a.connectors.includes("linear-mcp"), "connectors union across org + channel (deduped)");
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
    { bundle: "mine", scope: { level: "channel", workspace: "dm:U_me", channel: "U_me" } },
  ];
  const dm: ResolveRequest = { mode: "dm", platform: "slack", workspace: "T1", channel: "D1", principalId: "U_me" };
  const a = resolveAccess(dm, bundles, bindings);
  ok(!a.connectors.includes("notion"), "DM does not inherit the service-scoped connector (two connector universes)");
  ok(a.connectors.includes("my-gmail"), "DM resolves the caller's own personal connector grant");
}

{
  const bundles: Bundle[] = [{ name: "Conn", connectors: ["notion"] }];
  ok(resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "Conn", scope: { level: "org" } }]).warnings.some((w) => w.startsWith("broad grant") && w.includes("connector")), "connectors at org scope raise a broad-grant warning");
  ok(resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "Conn", scope: { level: "workspace", workspace: "T1" } }]).warnings.some((w) => w.startsWith("broad grant") && w.includes("connector")), "connectors at workspace scope raise a broad-grant warning");
  ok(!resolveAccess(chan("T1", "C1", ["d"]), bundles, [{ bundle: "Conn", scope: { level: "domain", workspace: "T1", domain: "d" } }]).warnings.some((w) => w.startsWith("broad grant")), "connectors at domain scope -> NO broad-grant warning");
  ok(!resolveAccess(chan("T1", "C1"), bundles, [{ bundle: "Conn", scope: { level: "channel", workspace: "T1", channel: "C1" } }]).warnings.some((w) => w.startsWith("broad grant")), "connectors at channel scope -> NO broad-grant warning");
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
    { bundle: "team", scope: { level: "channel", workspace: "T1", channel: "C1" } },
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
    [{ bundle: "x", scope: { level: "channel", workspace: "T1", channel: "C1" } }],
    registry,
  );
  ok(
    u.skills.length === 0 && u.warnings.some((w) => w.includes('unknown plugin "ghost"')),
    "unknown plugin contributes nothing and warns",
  );

  const e = resolveAccess(
    chan("T1", "C1"),
    [{ name: "x", plugins: ["acme"] }],
    [{ bundle: "x", scope: { level: "channel", workspace: "T1", channel: "C1" } }],
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
      [{ bundle: "P", scope: { level: "channel", workspace: "T1", channel: "C1" } }],
      registry,
    ).warnings.some((w) => w.startsWith("broad grant")),
    "plugins at channel scope -> NO broad-grant warning",
  );
}

console.log(`✓ resolver: ${passed} assertions passed`);
