import { assertProvidersValid, type Provider } from "../agent/access/providers.js";
import {
  applyBindingOverride,
  applyOverridesToProviders,
  emptyCredentialBindingsFile,
  parseCredentialBindingsFile,
  parseCredentialBindingsText,
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
ok(parseCredentialBindingsText('{ "overrides": [] }').overrides.length === 0, "parse: from text");

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
ok(stringifyCredentialBindings(parseCredentialBindingsText(s1)) === s1, "stringify: parse∘stringify is a fixpoint");
ok(s1.indexOf('"linear"') < s1.indexOf('"notion"'), "stringify: overrides sorted by provider");
ok(/"provider"[\s\S]*"credential"[\s\S]*"broker"[\s\S]*"secretRef"/.test(s1), "stringify: canonical key order");

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
    { id: "user-oauth", type: "user-oauth", vercelConnector: "mcp.notion.com/notion-mcp" },
  ],
};
{
  const base = [notion];
  const merged = applyOverridesToProviders(base, [OV]);
  const cred = merged[0].credentials.find((c) => c.id === "team-key")!;
  ok(cred.broker === "db" && cred.secretRef === "db:notion:team-key", "overlay: team-key re-stamped env → db");
  ok(base[0].credentials.find((c) => c.id === "team-key")!.broker === "env", "overlay: base set is NOT mutated (pure)");
  ok(merged[0].credentials.find((c) => c.id === "user-oauth")!.vercelConnector === "mcp.notion.com/notion-mcp", "overlay: untouched credential unchanged");
  assertProvidersValid(merged);
  ok(true, "overlay: merged provider set passes assertProvidersValid");

  const stale = applyOverridesToProviders(base, [{ provider: "notion", credential: "ghost", broker: "db", secretRef: "db:notion:ghost" }]);
  ok(stale[0].credentials.length === 2 && !stale[0].credentials.some((c) => c.id === "ghost"), "overlay: stale override is inert");
  ok(applyOverridesToProviders(base, []) === base, "overlay: empty overrides returns the base set unchanged");
}

console.log(`✓ credential-bindings-codemod: ${passed} assertions passed`);
