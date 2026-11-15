import { assertBindingsValid, assertBundlesValid } from "../agent/access/bundle.js";
import type { Domain } from "../agent/memory/domain.js";
import type { MemorySilo } from "../agent/memory/silo.js";
import {
  agentBundleName,
  agentSiloName,
  applyAgentSpec,
  assertExposedAgentSpec,
  assertExposedAgentsCurated,
  emitAgentsModule,
  emptyAgentsFile,
  parseAgentsFile,
  parseAgentsModule,
  renormalizeAgentsModule,
  stringifyAgents,
  AgentsCodemodError,
  type AgentSpec,
  type AgentsFile,
} from "../agent/memory/agents-codemod.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function throwsWith(fn: () => unknown, fragment: string, label: string): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes(fragment), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

const newReadonlySpec: AgentSpec = {
  name: "handbook-bot",
  title: "Handbook Bot",
  channels: ["slack/T1/C_ASK"],
  memory: { kind: "new-readonly", provider: "notion", container: "root-page", skill: "notion" },
  connectors: [{ name: "notion", credential: "k" }, { name: "linear", credential: "k" }],
  instructions: "Answer from the handbook only; never write.",
  exposed: true,
};

const existingSiloSpec: AgentSpec = {
  name: "txn-helper",
  channels: ["slack/T1/C_TXN"],
  memory: { kind: "existing-silo", silo: "transactions-silo" },
  connectors: [{ name: "github", credential: "k" }],
};

{
  const r1 = applyAgentSpec(emptyAgentsFile(), newReadonlySpec);
  ok(r1.changed, "apply: empty file → changed");
  ok(r1.file.domains.length === 1, "apply: exactly one domain derived");
  ok(r1.file.silos.length === 1, "apply: exactly one silo derived (new-readonly)");
  ok(r1.file.bundles.length === 1, "apply: exactly one bundle derived");
  ok(r1.file.bindings.length === 1, "apply: exactly one binding derived");
  ok(r1.file.specs.length === 1, "apply: the frozen spec is recorded in the side-table");

  const d = r1.file.domains[0];
  ok(d.name === "handbook-bot" && d.title === "Handbook Bot", "apply: domain carries name + title");
  ok(JSON.stringify(d.reach) === JSON.stringify(["slack/T1/C_ASK"]), "apply: domain channels = the asking surface key(s)");
  ok(d.memory === "handbook-bot-silo" && d.memory === agentSiloName(newReadonlySpec), "apply: domain memory points at the derived silo name");
  ok(d.match === undefined && d.includeOrg === undefined, "apply: derived domain is a plain channels domain (no match/includeOrg)");

  const s = r1.file.silos[0];
  ok(s.name === "handbook-bot-silo" && s.provider === "notion" && s.container === "root-page", "apply: silo carries name/provider/container");
  ok(s.readOnly === true, "apply: a new-readonly silo is readOnly by construction");
  ok(s.skill === "notion", "apply: silo carries the skill");

  const b = r1.file.bundles[0];
  ok(b.name === "agent:handbook-bot" && b.name === agentBundleName(newReadonlySpec), "apply: bundle is agent:-namespaced");
  ok(JSON.stringify(b.connectors) === JSON.stringify([{ name: "linear", credential: "k" }, { name: "notion", credential: "k" }]), "apply: bundle connector grants (sorted canonical, each naming its credential) present");
  ok(b.instructions === "Answer from the handbook only; never write.", "apply: bundle carries instructions");
  ok(b.title === "Handbook Bot", "apply: bundle carries title");

  const bind = r1.file.bindings[0];
  ok(bind.bundle === "agent:handbook-bot", "apply: binding names the agent bundle");
  ok(bind.scope.level === "domain" && bind.scope.domain === "handbook-bot", "apply: binding is DOMAIN-scoped by bare domain name");

  const m1 = emitAgentsModule(applyAgentSpec(emptyAgentsFile(), newReadonlySpec).file);
  const m2 = emitAgentsModule(applyAgentSpec(emptyAgentsFile(), newReadonlySpec).file);
  ok(m1 === m2, "apply: deterministic bytes (same spec → byte-identical module)");

  const r2 = applyAgentSpec(r1.file, newReadonlySpec);
  ok(!r2.changed, "apply: re-apply is a no-op (changed: false)");
  ok(stringifyAgents(r2.file) === stringifyAgents(r1.file), "apply: re-apply leaves identical bytes");

  const r3 = applyAgentSpec(r1.file, existingSiloSpec);
  ok(r3.changed && r3.file.domains.length === 2, "apply: a second agent adds a second domain");
  ok(r3.file.silos.length === 1, "apply: an existing-silo agent derives NO new silo (still 1)");
  ok(r3.file.domains.find((x) => x.name === "txn-helper")?.memory === "transactions-silo", "apply: existing-silo agent's domain reuses the named silo");
  ok(r3.file.bundles.find((x) => x.name === "agent:txn-helper")?.instructions === undefined, "apply: a spec with no instructions emits a bundle without instructions");

  assertBundlesValid([...r3.file.bundles]);
  assertBindingsValid([...r3.file.bindings], [...r3.file.bundles]);
  ok(true, "apply: merged overlay bundles/bindings pass assertBundlesValid/assertBindingsValid");
}

{
  const file = applyAgentSpec(emptyAgentsFile(), newReadonlySpec).file;
  const mod = emitAgentsModule(file);

  ok(mod.startsWith("// GENERATED + MACHINE-OWNED — DO NOT HAND-EDIT.\n"), "module: opens with the machine-owned banner");
  ok(mod.includes('\nimport type { AgentsFile } from "@open-everywhere/core/agent/memory/agents-codemod.js";\n'), "module: carries exactly one TYPE-ONLY import");
  ok(mod.includes("\nexport default {\n"), "module: the data is the default export");
  ok(mod.endsWith(" satisfies AgentsFile;\n"), "module: ends with the satisfies clause + newline");
  ok(mod.split("export default").length === 2, "module: exactly one `export default`");
  ok(!/\bfunction\b|\brequire\(|=>/u.test(mod.replace(/^\/\/.*$/gmu, "")), "module: no callable syntax outside the header");

  ok(emitAgentsModule(parseAgentsModule(mod)) === mod, "module: emit ∘ parseModule is a fixpoint");
  ok(parseAgentsModule(mod).domains.length === 1, "module: parseModule returns the data");

  throwsWith(
    () => parseAgentsModule(mod + "console.log(process.env.SLACK_BOT_TOKEN);\n"),
    "must contain exactly one",
    "module: a hand-added statement AFTER the data is REFUSED",
  );
  throwsWith(
    () => parseAgentsModule(mod.replace("\nexport default {", '\nglobalThis.x = 1;\nexport default {')),
    "does not start with the generated header",
    "module: a hand-added statement BEFORE the data is REFUSED",
  );
  throwsWith(
    () => parseAgentsModule(mod.replace('from "@open-everywhere/core/agent/memory/agents-codemod.js"', 'from "./elsewhere.js"')),
    "does not start with the generated header",
    "module: a re-pointed type import is REFUSED",
  );

  const reindented = mod.replace('  "domains"', '    "domains"');
  ok(reindented !== mod, "module: (fixture) the re-indent edit actually changed the bytes");
  throwsWith(() => parseAgentsModule(reindented), "not in canonical form", "module: a hand-re-indented body is REFUSED (round-trip check)");

  ok(renormalizeAgentsModule(reindented) === mod, "module: renormalize turns a hand-edited body back into the canonical bytes");
  ok(renormalizeAgentsModule(mod) === mod, "module: renormalize is idempotent on a canonical file");
  throwsWith(() => renormalizeAgentsModule(mod + "process.exit(0);\n"), "must contain exactly one", "module: renormalize REFUSES a code-bearing file rather than stripping the code");

  const empty = emitAgentsModule(emptyAgentsFile());
  ok(empty.includes('"domains": []') && empty.includes('"specs": []'), "module: the empty overlay emits empty arrays");
  ok(emitAgentsModule(parseAgentsModule(empty)) === empty, "module: the empty overlay round-trips");
  throwsWith(() => parseAgentsModule(""), "does not start with the generated header", "module: an empty FILE is refused (absence is not an empty overlay)");
}

{
  const good = parseAgentsFile(JSON.parse('{ "domains": [], "silos": [], "bundles": [], "bindings": [], "specs": [] }'));
  ok(good.domains.length === 0 && good.specs.length === 0, "parse: empty agents file parses");
  const withComment = parseAgentsFile({ $comment: "docs", domains: [], silos: [], bundles: [], bindings: [], specs: [] });
  ok(withComment.domains.length === 0, "parse: $comment is tolerated");

  throwsWith(() => parseAgentsFile({ domains: [], silos: [], bundles: [], bindings: [], specs: [], extra: 1 }), "unknown top-level key", "parse: unknown top-level key refuses");
  throwsWith(() => parseAgentsFile({ domains: [], silos: [], bundles: [], bindings: [] }), "needs a `specs` array", "parse: a missing array refuses");
  throwsWith(
    () => parseAgentsFile({ domains: [{ name: "x", reach: ["slack/T/C"], memory: "x-silo", bogus: 1 }], silos: [], bundles: [], bindings: [], specs: [] }),
    'has field "bogus"',
    "parse: an unknown domain field refuses",
  );
  throwsWith(
    () => parseAgentsFile({ domains: [], silos: [{ name: "s" }], bundles: [], bindings: [], specs: [] }),
    "needs a name and a provider",
    "parse: a malformed silo (no provider) refuses",
  );
  throwsWith(
    () => parseAgentsFile({ domains: [], silos: [], bundles: [{ name: "notagent", connectors: [] }], bindings: [], specs: [] }),
    '"agent:"-prefixed name',
    "parse: a non-namespaced bundle name refuses",
  );
  throwsWith(
    () => parseAgentsFile({ domains: [], silos: [], bundles: [], bindings: [{ bundle: "agent:x", scope: { level: "surface", surface: "slack/T/C" } }], specs: [] }),
    "must be domain-scoped",
    "parse: a non-domain overlay binding refuses (an agent binds to its domain)",
  );
  throwsWith(
    () => parseAgentsFile({ domains: [], silos: [], bundles: [], bindings: [{ bundle: "agent:x", scope: { level: "domain", domain: "slack/T/C" } }], specs: [] }),
    "must be domain-scoped with a bare domain name",
    "parse: a domain binding with a slash-bearing domain name refuses",
  );
}

{
  assertExposedAgentSpec(newReadonlySpec);
  ok(true, "assertExposedAgentSpec: an exposed new-readonly (curated) agent passes");

  assertExposedAgentSpec({ ...existingSiloSpec, exposed: false });
  ok(true, "assertExposedAgentSpec: a non-exposed agent is unconstrained");

  const roSilo: MemorySilo = { name: "handbook-cache", provider: "notion", readOnly: true };
  const rwSilo: MemorySilo = { name: "team-brain", provider: "postgres" };
  const resolve = (n: string): MemorySilo | undefined => [roSilo, rwSilo].find((s) => s.name === n);

  assertExposedAgentSpec({ name: "ro", channels: ["slack/T/C"], memory: { kind: "existing-silo", silo: "handbook-cache" }, exposed: true }, resolve);
  ok(true, "assertExposedAgentSpec: an exposed agent reading a READ-ONLY existing silo passes");

  throwsWith(
    () => assertExposedAgentSpec({ name: "rw", channels: ["slack/T/C"], memory: { kind: "existing-silo", silo: "team-brain" }, exposed: true }, resolve),
    "WRITABLE",
    "assertExposedAgentSpec: an exposed agent reading a WRITABLE existing silo is REFUSED",
  );
  throwsWith(
    () => assertExposedAgentSpec({ name: "missing", channels: ["slack/T/C"], memory: { kind: "existing-silo", silo: "nope" }, exposed: true }, resolve),
    "cannot be resolved",
    "assertExposedAgentSpec: an exposed agent reading an UNRESOLVABLE existing silo is REFUSED (fail-closed)",
  );

  {
    const specs: AgentSpec[] = [newReadonlySpec];
    const file = applyAgentSpec(emptyAgentsFile(), newReadonlySpec).file;
    assertExposedAgentsCurated(file.domains, file.silos, specs);
    ok(true, "assertExposedAgentsCurated: an exposed curated agent's merged config passes");
  }
  {
    const specs: AgentSpec[] = [{ name: "leaky", channels: ["slack/T/C"], memory: { kind: "existing-silo", silo: "handbook-cache" }, exposed: true }];
    const domains: Domain[] = [{ name: "leaky", reach: ["slack/T/C"], memory: "handbook-cache", includeOrg: "readonly" }];
    throwsWith(() => assertExposedAgentsCurated(domains, [roSilo], specs), "includeOrg", "assertExposedAgentsCurated: an exposed agent with includeOrg is REFUSED");
  }
  {
    const specs: AgentSpec[] = [{ name: "public", channels: [], memory: { kind: "existing-silo", silo: "handbook-cache" }, exposed: true }];
    const domains: Domain[] = [{ name: "public", match: "public", memory: "handbook-cache" }];
    throwsWith(() => assertExposedAgentsCurated(domains, [roSilo], specs), "criteria", "assertExposedAgentsCurated: an exposed agent on a match/pseudo-domain is REFUSED");
  }
  {
    const specs: AgentSpec[] = [{ name: "rw", channels: ["slack/T/C"], memory: { kind: "existing-silo", silo: "team-brain" }, exposed: true }];
    const domains: Domain[] = [{ name: "rw", reach: ["slack/T/C"], memory: "team-brain" }];
    throwsWith(() => assertExposedAgentsCurated(domains, [rwSilo], specs), "WRITABLE", "assertExposedAgentsCurated: an exposed agent reading a writable merged silo is REFUSED");
  }
  {
    const specs: AgentSpec[] = [{ name: "rw", channels: ["slack/T/C"], memory: { kind: "existing-silo", silo: "team-brain" } }];
    const domains: Domain[] = [{ name: "rw", reach: ["slack/T/C"], memory: "team-brain" }];
    assertExposedAgentsCurated(domains, [rwSilo], specs);
    ok(true, "assertExposedAgentsCurated: a NON-exposed writable agent is unconstrained");
  }
}

throwsWith(
  () => applyAgentSpec(emptyAgentsFile(), { ...newReadonlySpec, name: "a/b" }),
  'bare, non-empty domain name',
  "apply: refuses a slash-bearing agent name",
);
ok(new AgentsCodemodError("x") instanceof Error, "AgentsCodemodError is an Error (refusal type is catchable)");

{
  const file: AgentsFile = applyAgentSpec(applyAgentSpec(emptyAgentsFile(), existingSiloSpec).file, newReadonlySpec).file;
  const text = stringifyAgents(file);
  ok(text.endsWith("}\n"), "stringify: trailing newline");
  ok(text.indexOf('"agent:handbook-bot"') < text.indexOf('"agent:txn-helper"'), "stringify: bundles sorted by name");
  ok(stringifyAgents(parseAgentsFile(JSON.parse(text))) === text, "stringify: parse ∘ stringify is a fixpoint (round-trip stable)");
}

{
  const file: AgentsFile = {
    ...emptyAgentsFile(),
    bundles: [{ name: "agent:x", connectors: [{ name: "notion", credential: "k", contentOrigin: "internal" }] }],
  };
  const text = stringifyAgents(file);
  ok(!text.includes("contentOrigin"), "OPE-2723: stringify drops the deprecated contentOrigin — the codemod never writes it");
  ok(text.includes('"credential": "k"'), "OPE-2723: …and keeps the grant's name and credential");
}

console.log(`agents-codemod-test: ${passed} assertions passed`);
