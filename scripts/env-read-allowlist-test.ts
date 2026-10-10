import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DYNAMIC_ENV_READ_SITES,
  ENV_READ_ALLOWLIST,
  auditDynamicEnvReads,
  auditEnvReads,
  type AllowEntry,
  type EnvAllowlist,
} from "./env-read-allowlist.js";
import { collectExportedNameConstants, dynamicSiteKey, processEnvAliases, scanAliasDotReads, scanComputedEnvReads } from "./env-read-scan.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LINT = join(root, "scripts", "env-docs-lint.ts");
const TSX = join(root, "node_modules", "tsx", "dist", "cli.mjs");

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

const scratchRoots: string[] = [];

function fixture(names: readonly string[], root = "agent"): string {
  const dir = mkdtempSync(join(tmpdir(), "oe-env-allowlist-"));
  scratchRoots.push(dir);
  mkdirSync(join(dir, root), { recursive: true });
  const body = names.map((n, i) => `export const probe${i} = process.env.${n};`).join("\n");
  writeFileSync(join(dir, root, "probe.ts"), `${body}\n`);
  writeFileSync(join(dir, ".env.example"), `${names.map((n) => `${n}=`).join("\n")}\n`);
  return dir;
}

function sourceFixture(body: string, documented: readonly string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "oe-env-computed-"));
  scratchRoots.push(dir);
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "probe.ts"), `${body}\n`);
  writeFileSync(join(dir, ".env.example"), `${documented.map((n) => `${n}=`).join("\n")}\n`);
  return dir;
}

function lint(cwd: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [TSX, LINT], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function synthetic(entries: Record<string, AllowEntry>): EnvAllowlist {
  return new Map(Object.entries(entries));
}

function readsOf(...names: string[]): ReadonlyMap<string, readonly string[]> {
  return new Map(names.map((n) => [n, [`agent/fixture-${n.toLowerCase()}.ts`]]));
}

function main(): void {
  {
    const r = lint(fixture(["OE_SYNTHETIC_KNOB"]));
    ok(r.code !== 0, `a new unallowlisted env read fails the lint (exit ${r.code})`);
    ok(r.out.includes("ENV READ NOT ALLOWLISTED"), "…under the allowlist arm's own headline, not another arm's");
    ok(r.out.includes("process.env.OE_SYNTHETIC_KNOB"), "…naming the variable that caused it");
    ok(r.out.includes("agent/probe.ts"), "…and the file that reads it, so the author has somewhere to go");
    ok(r.out.includes("move it to settings/config"), "…and says where the value belongs instead");
  }

  {
    const r = lint(fixture(["OE_MODE"]));
    const unallowed = r.out.split("\n").filter((l) => l.includes("ENV READ NOT ALLOWLISTED"));
    ok(unallowed.length === 0, `an allowlisted read raises no unallowlisted red (got: ${unallowed.join(" | ")})`);
    ok(r.out.includes("STALE ALLOWLIST ENTRY"), "…while the shrink direction DOES fire for the entries this tree stopped reading");
    ok(r.out.includes("GITHUB_TOKEN"), "…naming one of them");
    ok(r.code !== 0, "…and a stale entry fails the lint, so the list can only shrink");
  }

  {
    const r = lint(fixture(["OE_SYNTHETIC_KNOB"], "scripts"));
    const named = r.out.split("\n").filter((l) => l.includes("ENV READ NOT ALLOWLISTED"));
    ok(named.length === 0, `a scripts/ env read is out of scope and raises no red (got: ${named.join(" | ")})`);
  }

  {
    const list = synthetic({ OE_GONE: { klass: "secret", why: "a token nothing reads any more." } });
    const reds = auditEnvReads(new Map(), list);
    ok(reds.length === 1 && reds[0].includes("STALE ALLOWLIST ENTRY"), "an entry with no matching read is a red");
    ok(reds[0].includes("OE_GONE") && reds[0].includes("secret"), "…naming the entry and its class");
    ok(auditEnvReads(readsOf("OE_GONE"), list).length === 0, "…and is silent while the read is still there");
  }

  {
    const untick = synthetic({ OE_KNOB: { klass: "pending-migration", why: "we will move it later." } });
    const reds = auditEnvReads(readsOf("OE_KNOB"), untick);
    ok(reds.length === 1 && reds[0].includes("UNTICKETED PENDING MIGRATION"), "a backlog entry naming no ticket is a red");

    const ticked = synthetic({ OE_KNOB: { klass: "pending-migration", why: "OPE-1153: a tuning number." } });
    ok(auditEnvReads(readsOf("OE_KNOB"), ticked).length === 0, "…and naming one clears it — the negative control");

    const permanent = synthetic({ OE_KNOB: { klass: "secret", why: "the bearer token this deployment signs with." } });
    ok(auditEnvReads(readsOf("OE_KNOB"), permanent).length === 0, "…and a permanent class needs no ticket");
  }

  {
    const bare = synthetic({ OE_KNOB: { klass: "secret", why: "" } });
    const reds = auditEnvReads(readsOf("OE_KNOB"), bare);
    ok(reds.length === 1 && reds[0].includes("UNREASONED ALLOWLIST ENTRY"), "an entry with no reason is a red");
    ok(reds[0].includes("OE_KNOB"), "…naming it");
    const label = synthetic({ OE_KNOB: { klass: "secret", why: "  ok  " } });
    ok(auditEnvReads(readsOf("OE_KNOB"), label)[0]?.includes("UNREASONED"), "…and a bare label does not count as one");
    const real = synthetic({ OE_KNOB: { klass: "secret", why: "the bearer token this deployment signs with." } });
    ok(auditEnvReads(readsOf("OE_KNOB"), real).length === 0, "…while a real reason clears it — the negative control");
  }

  {
    const list = synthetic({
      OE_A: { klass: "identity", why: "which org this is." },
      OE_B: { klass: "pending-migration", why: "OPE-1153: a cap." },
    });
    ok(auditEnvReads(readsOf("OE_A", "OE_B"), list).length === 0, "a matching inventory and allowlist produce no reds");
  }

  {
    const census = new Map<string, number>();
    for (const [, e] of ENV_READ_ALLOWLIST) census.set(e.klass, (census.get(e.klass) ?? 0) + 1);
    const expected: Record<string, number> = {
      "settings-lever": 0,
      secret: 33,
      connection: 36,
      identity: 19,
      platform: 17,
      "pending-migration": 3,
    };
    for (const [klass, n] of Object.entries(expected)) {
      ok(
        (census.get(klass) ?? 0) === n,
        `class ${klass} holds ${n} entries (found ${census.get(klass) ?? 0}) — if you meant to change this, say so here`,
      );
    }
    ok(ENV_READ_ALLOWLIST.size === 108, `the allowlist holds 108 names (found ${ENV_READ_ALLOWLIST.size})`);
  }

  {
    const unticketed = [...ENV_READ_ALLOWLIST].filter(([, e]) => e.klass === "pending-migration" && !/OPE-\d+/.test(e.why));
    ok(unticketed.length === 0, `every real backlog entry names a ticket (unticketed: ${unticketed.map(([n]) => n).join(", ")})`);
    const reasonless = [...ENV_READ_ALLOWLIST].filter(([, e]) => e.why.trim().length < 10);
    ok(reasonless.length === 0, `every real entry carries a reason (bare: ${reasonless.map(([n]) => n).join(", ")})`);
  }

  {
    const r = lint(fixture(["OE_MODE"]));
    ok(!r.out.includes("STALE REVERSE_SCAN_SELF"), "the self-exclusion list names files that exist");
  }

  {
    const src = [
      `const INJECT_TOKEN_ENV = "OE_CONTROL_INJECT_TOKENS";`,
      `export function entries(env: NodeJS.ProcessEnv = process.env): string | undefined {`,
      `  return env[INJECT_TOKEN_ENV];`,
      `}`,
    ].join("\n");
    const scan = scanComputedEnvReads("agent/auth.ts", src);
    ok(scan.resolved.length === 1, `one resolved read (found ${scan.resolved.length})`);
    ok(scan.resolved[0]?.name === "OE_CONTROL_INJECT_TOKENS", "…resolved to the name the constant holds");
    ok(scan.dynamic.length === 0, "…and nothing left unresolved");

    const bare = scanComputedEnvReads("agent/auth.ts", src.split("\n").slice(1).join("\n"));
    ok(bare.resolved.length === 0, "an unresolvable key resolves to no name");
    ok(bare.dynamic.length === 1 && bare.dynamic[0].expr === "INJECT_TOKEN_ENV", "…and is reported as a dynamic site instead");
    ok(bare.dynamic[0].line === 2, "…at the line it sits on, so the message points somewhere");
  }

  {
    const decl = `export const CREDENTIAL_KEY_ENV = "OE_CREDENTIAL_ENCRYPTION_KEY";`;
    const use = `if (process.env[CREDENTIAL_KEY_ENV]) register();`;
    const exported = collectExportedNameConstants([
      ["packages/core/agent/credentials/db-broker.ts", decl],
      ["packages/adapters/agent/register-defaults.ts", use],
    ]);
    const scan = scanComputedEnvReads("packages/adapters/agent/register-defaults.ts", use, exported);
    ok(scan.resolved[0]?.name === "OE_CREDENTIAL_ENCRYPTION_KEY", "an imported key constant resolves across modules");

    ok(scanComputedEnvReads("packages/adapters/agent/register-defaults.ts", use).dynamic.length === 1, "…and does not resolve without it");

    const clash = collectExportedNameConstants([
      ["a.ts", decl],
      ["b.ts", `export const CREDENTIAL_KEY_ENV = "OE_SOMETHING_ELSE";`],
    ]);
    ok(clash.get("CREDENTIAL_KEY_ENV") === null, "a name exported with two values is ambiguous");
    ok(scanComputedEnvReads("packages/adapters/agent/register-defaults.ts", use, clash).dynamic.length === 1, "…so the read stays dynamic");
  }

  {
    const built = [
      `interface Spawn {`,
      `  readonly env: NodeJS.ProcessEnv;`,
      `}`,
      `function childEnv(spawn: Spawn): string | undefined {`,
      `  const env: NodeJS.ProcessEnv = {};`,
      `  return env[K] ?? spawn.env[K];`,
      `}`,
    ].join("\n");
    const scan = scanComputedEnvReads("agent/cli.ts", built);
    ok(scan.resolved.length === 0 && scan.dynamic.length === 0, "a locally-built env object is not this process's env");

    const asParam = built.replace(`  const env: NodeJS.ProcessEnv = {};\n`, "").replace("(spawn: Spawn)", "(env: NodeJS.ProcessEnv, spawn: Spawn)");
    ok(scanComputedEnvReads("agent/cli.ts", asParam).dynamic.length === 1, "…while the same read off a ProcessEnv parameter is one");

    const defaulted = `export function f(deps: { env?: NodeJS.ProcessEnv } = {}) { const env = deps.env ?? process.env; return env[K]; }`;
    ok(scanComputedEnvReads("agent/r.ts", defaulted).dynamic.length === 1, "`X.env ?? process.env` is a ProcessEnv alias");
    const valueBinding = `export function g() { const key = process.env.OE_MODE ?? ""; return key[0]; }`;
    const vb = scanComputedEnvReads("agent/v.ts", valueBinding);
    ok(vb.dynamic.length === 0 && vb.resolved.length === 0, "…while `const key = process.env.X` binds a value, not the env");

    ok(scanComputedEnvReads("agent/o.ts", `const K = "OE_MODE";\nexport const v = process.env?.[K];`).resolved[0]?.name === "OE_MODE", "`process.env?.[K]` is the same read");
    ok(
      scanComputedEnvReads("agent/m.ts", `const K = "OE_MODE";\nexport const v = process.env[\n  K\n];`).resolved[0]?.name === "OE_MODE",
      "…and so is a key expression the formatter wrapped across lines",
    );

    const writes = `export function f(env: NodeJS.ProcessEnv = process.env) { env[K] = "x"; }`;
    ok(scanComputedEnvReads("agent/w.ts", writes).dynamic.length === 0, "an assignment target is not a read");
    ok(
      scanComputedEnvReads("agent/w.ts", writes.replace('env[K] = "x";', "return env[K];")).dynamic.length === 1,
      "…while reading the same key is",
    );
    const commented = [`// process.env[ref] is how the env broker resolves a ref.`, ` * env[SOME_CONST] too.`].join("\n");
    ok(scanComputedEnvReads("agent/c.ts", commented).dynamic.length === 0, "a read written inside a comment is not a read");
  }

  {
    const body = [`const K = "OE_SYNTHETIC_KNOB";`, `export const v = process.env[K];`].join("\n");
    const r = lint(sourceFixture(body, ["OE_SYNTHETIC_KNOB"]));
    ok(r.code !== 0, `a computed read of an unallowlisted name fails the lint (exit ${r.code})`);
    ok(r.out.includes("ENV READ NOT ALLOWLISTED"), "…under the allowlist arm, exactly as a literal read does");
    ok(r.out.includes("process.env.OE_SYNTHETIC_KNOB"), "…naming the variable the constant resolved to");
    ok(r.out.includes("agent/probe.ts"), "…and the file that reads it");
  }

  {
    const body = [`const K = "OE_MODE";`, `export const v = process.env[K];`].join("\n");
    const r = lint(sourceFixture(body, ["OE_MODE"]));
    const unallowed = r.out.split("\n").filter((l) => l.includes("ENV READ NOT ALLOWLISTED"));
    ok(unallowed.length === 0, `a computed read of an ALLOWLISTED name raises no red (got: ${unallowed.join(" | ")})`);
  }

  {
    const body = [`export function get(ref: string) { return process.env[ref]; }`].join("\n");
    const r = lint(sourceFixture(body));
    ok(r.code !== 0, `an unexcused dynamic env read fails the lint (exit ${r.code})`);
    ok(r.out.includes("DYNAMIC ENV READ NOT ALLOWLISTED"), "…under the dynamic-site arm's own headline");
    ok(r.out.includes("agent/probe.ts:1"), "…naming the file and line");
    ok(r.out.includes("DYNAMIC_ENV_READ_SITES"), "…and saying where an excuse would go");
  }

  {
    const site = { file: "agent/x.ts", line: 7, expr: "ref" };
    const key = dynamicSiteKey(site);
    ok(key === "agent/x.ts::ref", "the excuse key is <path>::<expression>, with no line number in it");

    const excused = new Map([[key, "an operator-authored credential ref."]]);
    ok(auditDynamicEnvReads([site], excused).length === 0, "an excused site is silent");
    const stale = auditDynamicEnvReads([], excused);
    ok(stale.length === 1 && stale[0].includes("STALE DYNAMIC SITE"), "an excuse for a site that is gone is a red");
    const sibling = auditDynamicEnvReads([site, { file: "agent/x.ts", line: 9, expr: "other" }], excused);
    ok(sibling.length === 1 && sibling[0].includes("agent/x.ts:9"), "a NEW key in an already-excused file is still a red");
    const bare = auditDynamicEnvReads([site], new Map([[key, "ok"]]));
    ok(bare.length === 1 && bare[0].includes("UNREASONED DYNAMIC SITE"), "an excuse with no reason is a red");
  }

  {
    ok(DYNAMIC_ENV_READ_SITES.size === 11, `11 dynamic sites are excused (found ${DYNAMIC_ENV_READ_SITES.size})`);
    const bare = [...DYNAMIC_ENV_READ_SITES].filter(([, why]) => why.trim().length < 10);
    ok(bare.length === 0, `every excused site carries a reason (bare: ${bare.map(([k]) => k).join(", ")})`);
  }

  {
    const aliasSrc = [
      "export function f(env: NodeJS.ProcessEnv = process.env) {",
      "  const a = env.OE_ALPHA;",
      "  const b = env?.OE_BETA;",
      "  return [a, b];",
      "}",
    ].join("\n");
    const found = scanAliasDotReads("f.ts", aliasSrc, processEnvAliases(aliasSrc)).map((r) => r.name).sort();
    ok(found.join(",") === "OE_ALPHA,OE_BETA", `a dot read off the alias resolves, optional chain included (got ${found.join(",")})`);

    const notAlias = ["export function g(cfg: Config) {", "  return cfg.OE_ALPHA;", "}"].join("\n");
    ok(scanAliasDotReads("g.ts", notAlias, processEnvAliases(notAlias)).length === 0, "a property off a non-alias identifier is not a read");

    const dotted = ["export function h(env: NodeJS.ProcessEnv = process.env, cfg: C) {", "  return cfg.env.OE_GAMMA;", "}"].join("\n");
    ok(scanAliasDotReads("h.ts", dotted, processEnvAliases(dotted)).length === 0, "a DOTTED base never qualifies, even when the last segment is the alias name");

    const write = ["export function w(env: NodeJS.ProcessEnv = process.env) {", '  env.OE_DELTA = "1";', "}"].join("\n");
    ok(scanAliasDotReads("w.ts", write, processEnvAliases(write)).length === 0, "an assignment target is not a read");
    const compound = ["export function c(env: NodeJS.ProcessEnv = process.env) {", '  env.OE_DELTA ??= "1";', "}"].join("\n");
    ok(scanAliasDotReads("c.ts", compound, processEnvAliases(compound))[0]?.name === "OE_DELTA", "a compound assignment IS a read — it consults the key first");

    const commented = ["export function k(env: NodeJS.ProcessEnv = process.env) {", "  // env.OE_EPSILON is deliberately not read here", "  return 1;", "}"].join("\n");
    ok(scanAliasDotReads("k.ts", commented, processEnvAliases(commented)).length === 0, "a comment line is never a read");

    const literal = ["export function l() {", "  return process.env.OE_ZETA;", "}"].join("\n");
    ok(scanAliasDotReads("l.ts", literal, new Set(["env"])).length === 0, "a literal process.env read is the literal arm's, never this one");

    const both = [
      'const K = "OE_ETA";',
      "export function m(env: NodeJS.ProcessEnv = process.env) {",
      "  return [env[K], env.OE_ETA];",
      "}",
    ].join("\n");
    const scan = scanComputedEnvReads("m.ts", both);
    ok(scan.resolved.filter((r) => r.name === "OE_ETA").length === 1, "one name read two ways in one file is inventoried once");
    ok(scan.dynamic.length === 0, "…and neither read becomes a dynamic site");

    const dotOnly = ["export function n(env: NodeJS.ProcessEnv = process.env) {", "  return env.OE_THETA;", "}"].join("\n");
    const folded = scanComputedEnvReads("n.ts", dotOnly);
    ok(folded.resolved.some((r) => r.name === "OE_THETA"), "scanComputedEnvReads FOLDS the dot arm in — the lint calls this, not scanAliasDotReads");
  }

  {
    const page = readFileSync(join(root, "docs", "inventory", "settings.md"), "utf8");
    const cell = (s: string): string => s.trim().replace(/`/g, "");
    const rowsOf = (prefix: string): { id: string; symbol: string; code: string }[] =>
      page
        .split("\n")
        .map((l) => l.split("|"))
        .filter((c) => c.length > 4 && new RegExp(`^${prefix}-\\d+$`, "u").test(c[1]!.trim()))
        .map((c) => ({ id: c[1]!.trim(), symbol: cell(c[2]!), code: cell(c[3]!) }));

    const envRows = rowsOf("ENV");
    const dynRows = rowsOf("DYN");

    ok(envRows.length > 100 && dynRows.length > 5, `the row parse reached both tables (${envRows.length} ENV, ${dynRows.length} DYN)`);

    ok(
      envRows.length === ENV_READ_ALLOWLIST.size,
      `the page holds one ENV row per allowlist entry (${envRows.length} rows, ${ENV_READ_ALLOWLIST.size} entries)`,
    );
    const orphanNames = envRows.filter((r) => !ENV_READ_ALLOWLIST.has(r.symbol));
    ok(orphanNames.length === 0, `every ENV row names a live allowlist entry (orphans: ${orphanNames.map((r) => `${r.id} ${r.symbol}`).join(", ")})`);
    const unrowedNames = [...ENV_READ_ALLOWLIST.keys()].filter((n) => !envRows.some((r) => r.symbol === n));
    ok(unrowedNames.length === 0, `every allowlist entry has a page row (unrowed: ${unrowedNames.join(", ")})`);

    const siteKeys = new Set([...DYNAMIC_ENV_READ_SITES.keys()].map((k) => k.replace(/`/g, "")));
    ok(
      dynRows.length === DYNAMIC_ENV_READ_SITES.size,
      `the page holds one DYN row per excused site (${dynRows.length} rows, ${DYNAMIC_ENV_READ_SITES.size} sites)`,
    );
    const orphanSites = dynRows.filter((r) => !siteKeys.has(dynamicSiteKey({ file: r.code, expr: r.symbol })));
    ok(orphanSites.length === 0, `every DYN row composes a live excuse key (orphans: ${orphanSites.map((r) => `${r.id} ${r.code}::${r.symbol}`).join(", ")})`);
    const unrowedSites = [...siteKeys].filter((k) => !dynRows.some((r) => dynamicSiteKey({ file: r.code, expr: r.symbol }) === k));
    ok(unrowedSites.length === 0, `every excused site has a page row (unrowed: ${unrowedSites.join(", ")})`);
  }

  {
    const r = lint(sourceFixture("export const v = process.env.OE_MODE;"));
    ok(r.out.includes("UNDOCUMENTED ENV"), "arm 1 reds on a read that neither .env.example nor docs/ mentions");
    ok(r.out.includes("process.env.OE_MODE"), "…naming the variable, so the author has somewhere to go");
    const q = lint(fixture(["OE_MODE"]));
    ok(!q.out.includes("UNDOCUMENTED ENV"), "…and stays silent once that read is documented");
  }
  {
    const r = lint(sourceFixture("export const v = 1;", ["OE_DOCUMENTED_BUT_UNREAD"]));
    ok(r.out.includes("STALE ROW"), "arm 2 reds on a documented variable nothing reads any more");
    ok(r.out.includes("OE_DOCUMENTED_BUT_UNREAD"), "…naming the row that outlived its read");
  }
}

try {
  main();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  console.error(`  (${passed} assertion(s) passed before the failure)`);
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });

console.log(`\n✓ env-read allowlist ratchet: ${passed} assertions passed (${ENV_READ_ALLOWLIST.size} names allowed)\n`);
