import assert from "node:assert/strict";
import {
  contributionKey,
  declaredPackages,
  goldenPlanLines,
  mountedRosterRows,
  ownedSlotDirs,
  parseContributionManifest,
  parseRosterConfig,
  planRoster,
  renderFrameworkSentinel,
  renderMountedShim,
  serializeLock,
  wrapComment,
  type PlanInput,
  type ResolvedPackage,
} from "@open-everywhere/core/agent/scaffold/roster-plan.js";
import { classifyRosterTransition, rosterToolNameOf } from "@open-everywhere/core/agent/scaffold/tool-roster.js";
import type { RosterConfig } from "@open-everywhere/core/agent/scaffold/roster-config.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = <T>(actual: T, expected: T, label: string): void => {
  assert.deepEqual(actual, expected, label);
  n++;
};
const hasRed = (reds: readonly string[], needle: string, label: string): void =>
  ok(reds.some((r) => r.includes(needle)), `${label} — reds were:\n    ${reds.join("\n    ")}`);

const CORE = "@open-everywhere/core";

function manifest(contributions: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): unknown {
  return { schemaVersion: 1, package: CORE, contributions, ...extra };
}

function pkg(m: unknown, over: Partial<ResolvedPackage> = {}): ResolvedPackage {
  return { declaredAs: "core", name: CORE, decision: true, manifest: m, resolvedName: CORE, version: "1.0.0", ...over };
}

function plan(config: RosterConfig, packages: readonly ResolvedPackage[], lock?: unknown, acceptLock = false): ReturnType<typeof planRoster> {
  const declared = declaredPackages(config);
  const resolved = packages.map((p) => {
    const d = declared.find((x) => x.name === p.name);
    return d === undefined ? p : { ...p, declaredAs: d.declaredAs, providerId: d.providerId, decision: p.decision === true ? d.decision : p.decision };
  });
  const input: PlanInput = { config, lock, acceptLock, packages: resolved, frameworkToolNames: ["bash", "grep", "agent"], agentDir: "agent" };
  return planRoster(input);
}

const planAccepted = (config: RosterConfig, packages: readonly ResolvedPackage[]): ReturnType<typeof planRoster> =>
  plan(config, packages, undefined, true);

const ONE = [{ kind: "tool", name: "remember", module: "agent/tools/remember.js", summary: "Record a fact." }];

{
  eq(parseRosterConfig(undefined).reds.length > 0, true, "rule 1: a missing default export reds");
  hasRed(parseRosterConfig(undefined).reds, "defineRoster", "rule 1 names the fix");
  hasRed(parseRosterConfig({ nope: 1 }).reds, 'unknown top-level key "nope"', "rule 2: unknown key");
  hasRed(parseRosterConfig({ core: 3 }).reds, "must be true, false, or an object", "rule 2: bad decision value");
  hasRed(parseRosterConfig({ core: { bogus: {} } }).reds, "not a known key", "rule 2: unknown decision key");
  hasRed(parseRosterConfig({ core: { exclude: { x: "  " } } }).reds, "empty reason", "rule 3: a decline needs a reason");
  ok(parseRosterConfig({ core: { exclude: { x: "because" } } }).config !== undefined, "rule 3: a reason passes");
  hasRed(parseRosterConfig({ framework: { disable: { bash: "" } } }).reds, "has no reason", "rule 3: framework reasons required too");
}

{
  const p = plan({ core: { exclude: { rember: "typo" } } }, [pkg(manifest(ONE))]);
  hasRed(p.reds, 'names "rember"', "rule 4: a mistyped exclusion is a hard red");
  eq(p.verdict, "invalid", "rule 4: nothing is planned");
  eq(p.files.length, 0, "rule 4: no file is emitted when the config is invalid");

  const both = manifest([
    { kind: "tool", name: "notion", module: "agent/tools/notion.js" },
    { kind: "connection", name: "notion", module: "agent/connections/notion.js" },
  ]);
  hasRed(plan({ core: { note: { notion: "x" } } }, [pkg(both)]).reds, 'Qualify it as "<kind>/notion"', "rule 5: ambiguity");
  const qualified = plan({ core: { exclude: { "tool/notion": "declined" } } }, [pkg(both)]);
  eq(qualified.verdict, "unreviewed", "rule 5: a qualified key resolves (and is then merely unreviewed)");
}

{
  const p = plan({ core: true }, [{ declaredAs: "core", name: CORE, decision: true, error: "not installed" }]);
  hasRed(p.reds, `npm i ${CORE}`, "rule 6: the red names the exact install command");
  const off = planAccepted({ core: false }, [{ declaredAs: "core", name: CORE, decision: false }]);
  eq(off.reds.length, 0, "rule 6: `false` does not require the package to be installed");
}

{
  hasRed(
    plan({ framework: { disable: { nonesuch: "why" } } }, []).reds,
    "is not an eve framework tool",
    "rule 7: a sentinel for a non-built-in is a red",
  );
  const blind = planRoster({ config: { framework: { disable: { nonesuch: "why" } } }, lock: undefined, acceptLock: true, packages: [], agentDir: "agent" });
  eq(blind.reds.length, 0, "rule 7 degrades to a shape check when eve's names cannot be read (never a blind pass on a real name)");
}

{
  const bad = manifest([{ kind: "channel", name: "Not_A_Channel", module: "agent/channels/x.js" }]);
  hasRed(plan({ core: true }, [pkg(bad)]).reds, "slug pattern rejects", "rule 8: an illegal channel slug reds");
}

{
  const other = "@open-everywhere/provider-slack";
  const p = plan({ core: true, providers: { slack: true } }, [
    pkg(manifest(ONE)),
    pkg({ schemaVersion: 1, package: other, register: "agent/register.js#r", contributions: ONE }, {
      declaredAs: "providers.slack",
      name: other,
      resolvedName: other,
      providerId: "slack",
    }),
  ]);
  hasRed(p.reds, "2 packages mount \"tool/remember\"", "rule 9: collision names both packages");
  hasRed(p.reds, "exclude it from all but one", "rule 9: the red names the fix");
}

{
  const packages = [pkg(manifest(ONE))];
  const fresh = plan({ core: true }, packages, { schemaVersion: 1, generator: 1, framework: {}, packages: {} });
  eq(fresh.verdict, "unreviewed", "rule 10: a contribution the lock has never seen is UNREVIEWED");
  hasRed(fresh.reds, "oe build --accept", "rule 10: the red names the one command that clears it");
  hasRed(fresh.reds, "Record a fact.", "rule 10: the summary is quoted so a human can judge it");
  ok(fresh.files.length > 0, "rule 10: an unreviewed plan is still inspectable via --show/--json");
  eq(fresh.verdict !== "clean", true, "rule 10: …but its verdict is never clean");

  const accepted = plan({ core: true }, packages, fresh.lock);
  eq(accepted.verdict, "clean", "rule 10: `--accept`'s lock clears exactly the accepted contribution");
  eq(accepted.files.length, 2, "the plan is the shim plus providers.generated.ts");

  const disagree = plan({ core: { exclude: { remember: "no" } } }, packages, fresh.lock);
  hasRed(disagree.reds, "is mounted in roster.lock.json but excluded", "rule 11: lock/config disagreement reds");

  const vanished = plan({ core: true }, [pkg(manifest([]))], fresh.lock);
  eq(vanished.verdict, "vanished", "rule 10: a locked contribution the package dropped is VANISHED");
  hasRed(vanished.reds, "no longer offers it", "rule 10: VANISHED explains itself");

  const gainedBuiltIn = plan({ core: true }, packages, {
    ...fresh.lock,
    framework: { bash: "disabled" },
  });
  hasRed(gainedBuiltIn.reds, "that is a capability GAIN", "rule 11: dropping a sentinel is named as a GAIN");
}

{
  const contributions = [
    { kind: "tool", name: "b_tool", module: "agent/tools/b_tool.js" },
    { kind: "hook", name: "a-hook", module: "agent/hooks/a-hook.js" },
  ];
  const config: RosterConfig = { framework: { disable: { bash: "why" } }, core: true };
  const permuted = { core: true, framework: { disable: { bash: "why" } } } as RosterConfig;
  const packages = [pkg(manifest(contributions))];
  const a = planAccepted(config, packages);
  const b = planAccepted(config, packages);
  const c = planAccepted(permuted, packages);
  eq(a.files, b.files, "determinism: the same inputs produce an identical plan");
  eq(a.files, c.files, "determinism: config key ORDER does not move a byte");
  eq(serializeLock(a.lock), serializeLock(c.lock), "determinism: the lock is key-order independent too");
  eq(
    a.files.map((f) => f.path),
    ["agent/hooks/a-hook.ts", "agent/lib/providers.generated.ts", "agent/tools/b_tool.ts", "agent/tools/bash.ts"],
    "the plan is sorted by path",
  );
  eq(serializeLock(a.lock).endsWith("\n"), true, "the lock ends with a newline");
  eq(serializeLock(a.lock).includes('"generator": 1'), true, "the lock stamps the generator version");
}

{
  eq(
    renderMountedShim("@open-everywhere/core/agent/tools/remember.js"),
    '// GENERATED by `oe build` from roster.config.ts — DO NOT EDIT.\nexport { default } from "@open-everywhere/core/agent/tools/remember.js";\n',
    "a mounted shim is the header plus the one-line re-export",
  );
  const noted = renderMountedShim("x/y.js", "why this wrapper exists");
  eq(noted.split("\n")[1], "// why this wrapper exists", "a note becomes the second comment line");
  const sentinel = renderFrameworkSentinel("bash", "re-provided per grain");
  ok(sentinel.includes('import { disableTool } from "eve/tools";'), "a sentinel imports disableTool");
  ok(sentinel.includes("export default disableTool();"), "a sentinel default-exports disableTool()");
  ok(sentinel.includes("bash — DECLINED as a static tool:"), "a sentinel names what it declines");
  ok(sentinel.includes("re-provided per grain"), "a sentinel carries its REASON — that is what stops an accidental deletion");
  const wrapped = wrapComment("a".repeat(40) + " " + "b".repeat(40) + " " + "c".repeat(40), 90);
  eq(wrapped.length, 2, "prose wraps at the requested width");
  eq(wrapComment("one\n\ntwo", 90), ["one", "", "two"], "a blank line survives as a paragraph break");

  const providers = planAccepted({ providers: { slack: true } }, [
    pkg({ schemaVersion: 1, package: "@open-everywhere/provider-slack", register: "agent/register.js#registerSlackProvider", contributions: [] }, {
      declaredAs: "providers.slack",
      name: "@open-everywhere/provider-slack",
      resolvedName: "@open-everywhere/provider-slack",
      providerId: "slack",
      decision: { about: "the reference surface" },
    }),
  ]);
  const table = providers.files.find((f) => f.path === "agent/lib/providers.generated.ts")!.content;
  ok(table.includes('import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";'), "the table static-imports each register fn");
  ok(table.includes('{ id: "slack", register: registerSlackProvider },'), "the table carries one row per selected provider");
  ok(table.includes("// the reference surface"), "`about` becomes the row's comment");
  ok(
    !table.split("\n").some((l) => !l.trimStart().startsWith("//") && l.includes("import(")),
    "the table NEVER uses a dynamic import outside a comment — eve's one-chunk invariant",
  );
  eq(providers.selectedProviders, ["slack"], "the selection is derived from the config");

  const noRegister = planAccepted({ providers: { slack: true } }, [
    pkg({ schemaVersion: 1, package: "@open-everywhere/provider-slack", contributions: [] }, {
      declaredAs: "providers.slack",
      name: "@open-everywhere/provider-slack",
      resolvedName: "@open-everywhere/provider-slack",
      providerId: "slack",
    }),
  ]);
  hasRed(noRegister.reds, "declares no `register`", "a provider with no boot wiring is a red, not a silent no-op");
}

{
  hasRed(parseContributionManifest(42, CORE).reds, "must export CONTRIBUTIONS as an object", "a non-object manifest reds");
  hasRed(parseContributionManifest(manifest([{ kind: "widget", name: "x", module: "a.js" }]), CORE).reds, 'kind "widget"', "an unknown kind reds");
  hasRed(parseContributionManifest(manifest([{ kind: "tool", name: "x", module: "a.ts" }]), CORE).reds, 'ending in ".js"', "a .ts module reds (ESM specifiers are .js)");
  hasRed(
    parseContributionManifest(manifest([...ONE, ...ONE]), CORE).reds,
    'duplicates "tool/remember"',
    "a duplicated (kind, name) reds",
  );
  hasRed(parseContributionManifest(manifest(ONE, { register: "no-hash" }), CORE).reds, "<module>#<exportName>", "a malformed register reds");
  ok(parseContributionManifest(manifest(ONE), CORE).manifest !== undefined, "a well-formed manifest parses");
}

{
  const p = planAccepted({ framework: { disable: { bash: "why" } }, core: true }, [pkg(manifest(ONE))]);
  const accepted = plan({ framework: { disable: { bash: "why" } }, core: true }, [pkg(manifest(ONE))], p.lock);
  const rows = mountedRosterRows(accepted);
  const value = (key: string): string | undefined => rows.find((r) => r.key === key)?.value;
  eq(value("tools/remember.ts"), "mounted", "the snapshot row grammar is unchanged for a mounted tool");
  eq(value("tools/bash.ts"), "disabled (disableTool sentinel)", "…and for a sentinel");
  eq(value("tools/"), "2 entr(y|ies)", "…including the per-directory count row");
  eq(rosterToolNameOf("tools/remember.ts"), "remember", "rosterToolNameOf still parses a roster-derived key");
  eq(classifyRosterTransition("disabled (disableTool sentinel)", value("tools/remember.ts")), "gain", "a sentinel → mounted transition is still a GAIN");
  eq(classifyRosterTransition(value("tools/remember.ts"), undefined), "loss", "a mounted row disappearing is still a LOSS");

  eq(
    goldenPlanLines(accepted, "agent"),
    [
      "agent/lib/providers.generated.ts\tproviders ",
      "agent/tools/bash.ts\tframework-disabled",
      "agent/tools/remember.ts\tmounted @open-everywhere/core",
    ],
    "the golden plan is one sorted line per planned path with its classification",
  );
  eq(
    ownedSlotDirs("agent"),
    ["agent/channels", "agent/connections", "agent/hooks", "agent/schedules", "agent/skills", "agent/tools"],
    "the build owns exactly the six eve slot directories — never agent/lib or agent/subagents",
  );
  eq(contributionKey("tool", "remember"), "tool/remember", "the key grammar is one function");
}

{
  const declared = declaredPackages({ core: true, adapters: false, providers: { slack: true }, packages: { "@acme/x": true } });
  eq(
    declared.map((d) => `${d.declaredAs}=${d.name}`),
    ["core=@open-everywhere/core", "adapters=@open-everywhere/adapters", "providers.slack=@open-everywhere/provider-slack", 'packages["@acme/x"]=@acme/x'],
    "provider ids expand to @open-everywhere/provider-<id>; `packages` is the escape hatch",
  );
  eq(declared.find((d) => d.declaredAs === "providers.slack")?.providerId, "slack", "only `providers` entries carry a provider id");
}

console.log(`✓ roster-test: ${n} assertions passed (validation rules, determinism, lock diffing, render shapes, projections)`);
