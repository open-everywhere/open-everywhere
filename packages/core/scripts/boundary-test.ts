import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const VENDOR_SDK = /^(@vercel\/|@neondatabase\/|pg$|pg-pool$|mysql2?$|better-sqlite3$|@aws-sdk\/|aws-sdk$)/;
const ADAPTERS_PKG = /^@open-everywhere\/adapters(\/|$)/;
const CORE_PKG = /^@open-everywhere\/core(\/|$)/;

const CORE_ADAPTER_BARREL = /^@open-everywhere\/core\/agent\/adapter-api\.(js|ts)$/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function specifiers(file: string): string[] {
  let src = readFileSync(file, "utf-8");
  src = src.replace(/\/\*[\s\S]*?\*\//g, "");
  src = src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) specs.push(m[1]);
  return specs;
}

const rel = (f: string) => f.slice(REPO_ROOT.length + 1);

const PROVIDER_PKG = /^@open-everywhere\/provider-([a-z0-9-]+)(\/|$)/;

const PROVIDER_VENDOR_STRINGS: Record<string, string[]> = {
  notion: ["api.notion.com", "NOTION_CHANNEL_API_KEY"],
  linear: ["api.linear.app", "LINEAR_CLIENT_ID", "LINEAR_ACCESS_TOKEN"],
  slack: ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"],
  discord: ["discord.com/api"],
  github: ["x-hub-signature-256"],
  teams: ["graph.microsoft.com"],
  telegram: ["api.telegram.org", "TELEGRAM_BOT_TOKEN"],
};

function discoverBundles(): string[] {
  const root = join(REPO_ROOT, "packages/providers");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

function bundleSourceFiles(bundleRoot: string): string[] {
  return ["agent", "scripts"].flatMap((sub) => {
    const d = join(bundleRoot, sub);
    return existsSync(d) ? tsFiles(d) : [];
  });
}

function climbsOutsideBundle(fileAbs: string, spec: string, bundleRoot: string): boolean {
  if (!spec.startsWith(".")) return false;
  const target = resolve(dirname(fileAbs), spec);
  const relToBundle = relative(bundleRoot, target);
  return relToBundle.startsWith("..") || isAbsolute(relToBundle);
}

function bundleCoreImportViolation(fileAbs: string, spec: string, bundleRoot: string): boolean {
  if (CORE_PKG.test(spec)) return !CORE_ADAPTER_BARREL.test(spec);
  return climbsOutsideBundle(fileAbs, spec, bundleRoot);
}

function bundleForeignImportViolation(spec: string, bundleName: string): boolean {
  const m = PROVIDER_PKG.exec(spec);
  if (m && m[1] !== bundleName) return true;
  if (ADAPTERS_PKG.test(spec)) return true;
  if (!spec.startsWith(".") && /(^|\/)agent\/(tools|channels|hooks)\//.test(spec)) return true;
  return false;
}

function firstStringPresent(text: string, strings: string[]): string | undefined {
  return strings.find((s) => text.includes(s));
}

{
  const coreDirs = [join(REPO_ROOT, "packages/core/agent"), join(REPO_ROOT, "packages/core/scripts")];
  const files = coreDirs.flatMap(tsFiles);
  ok(files.length > 50, `scanned core (${files.length} files)`);

  for (const f of files) {
    for (const spec of specifiers(f)) {
      ok(!VENDOR_SDK.test(spec), `core is vendor-SDK-free: ${rel(f)} imports "${spec}"`);
      ok(!ADAPTERS_PKG.test(spec), `core does not import adapters: ${rel(f)} imports "${spec}"`);
      ok(
        !/^@open-everywhere\//.test(spec) || CORE_PKG.test(spec),
        `core does not depend on a sibling package: ${rel(f)} imports "${spec}"`,
      );
    }
  }
}

{
  const bindingPr = join(REPO_ROOT, "packages/core/agent/credentials/binding-pr.ts");
  const src = readFileSync(bindingPr, "utf-8");
  ok(!/api\.github\.com/.test(src), "binding-pr.ts references no api.github.com host (GitHub coupling lives in config-pr-github.ts)");
  ok(!/GITHUB_TOKEN/.test(src), "binding-pr.ts references no GITHUB_TOKEN (write-credential custody lives in scm/credential.ts)");
  const scmCredential = readFileSync(join(REPO_ROOT, "packages/core/agent/scm/credential.ts"), "utf-8");
  ok(/"GITHUB_TOKEN"/.test(scmCredential), "scm/credential.ts owns the GITHUB_TOKEN read");
  const ghAdapter = readFileSync(join(REPO_ROOT, "packages/core/agent/credentials/config-pr-github.ts"), "utf-8");
  ok(/api\.github\.com/.test(ghAdapter), "config-pr-github.ts owns the GitHub API host");
}

{
  const files = tsFiles(join(REPO_ROOT, "packages/adapters/agent"));
  ok(files.length > 0, `scanned adapters (${files.length} files)`);

  for (const f of files) {
    for (const spec of specifiers(f)) {
      const climbsIntoCore = /\.\.\/.*\/(memory|operational|access)\//.test(spec) && !CORE_PKG.test(spec);
      ok(!climbsIntoCore, `adapters reach core via package name: ${rel(f)} imports "${spec}"`);
      ok(!/(^|\/)agent\/(tools|channels|hooks)\//.test(spec), `adapters do not import the app: ${rel(f)} imports "${spec}"`);
    }
  }
}

{
  const files = [
    ...tsFiles(join(REPO_ROOT, "packages/adapters/agent")),
    ...tsFiles(join(REPO_ROOT, "packages/adapters/scripts")),
    join(REPO_ROOT, "agent/lib/register-adapters.ts"),
  ];
  ok(files.length > 10, `scanned adapter surface for barrel-only core imports (${files.length} files)`);

  for (const f of files) {
    for (const spec of specifiers(f)) {
      if (!CORE_PKG.test(spec)) continue;
      ok(
        CORE_ADAPTER_BARREL.test(spec),
        `adapters import core ONLY via the adapter-api barrel: ${rel(f)} imports "${spec}"`,
      );
    }
  }
}

{
  const files = tsFiles(join(REPO_ROOT, "agent"));
  ok(files.length > 0, `scanned app (${files.length} files)`);

  for (const f of files) {
    for (const spec of specifiers(f)) {
      ok(!VENDOR_SDK.test(spec), `app stays vendor-SDK-free: ${rel(f)} imports "${spec}"`);
    }
  }
}

{
  const bundles = discoverBundles();
  for (const name of bundles) {
    const bundleRoot = join(REPO_ROOT, "packages/providers", name);
    const files = bundleSourceFiles(bundleRoot);
    ok(files.length > 0, `provider bundle "${name}" has agent/scripts sources (${files.length} files)`);
    for (const f of files) {
      for (const spec of specifiers(f)) {
        ok(
          !bundleCoreImportViolation(f, spec, bundleRoot),
          `provider "${name}" reaches core ONLY via the adapter-api barrel: ${rel(f)} imports "${spec}"`,
        );
      }
    }
  }
}

{
  const bundles = discoverBundles();
  for (const name of bundles) {
    const bundleRoot = join(REPO_ROOT, "packages/providers", name);
    for (const f of bundleSourceFiles(bundleRoot)) {
      for (const spec of specifiers(f)) {
        ok(
          !bundleForeignImportViolation(spec, name),
          `provider "${name}" imports no sibling bundle / adapters / app tree: ${rel(f)} imports "${spec}"`,
        );
      }
    }
  }
}

{
  const bundles = discoverBundles();
  const coreAgentText =
    bundles.length > 0
      ? tsFiles(join(REPO_ROOT, "packages/core/agent"))
          .map((f) => readFileSync(f, "utf-8"))
          .join("\n")
      : "";
  for (const name of bundles) {
    const strings = PROVIDER_VENDOR_STRINGS[name] ?? [];
    ok(strings.length > 0, `provider "${name}" has a vendor-fingerprint entry in PROVIDER_VENDOR_STRINGS`);
    const bundleRoot = join(REPO_ROOT, "packages/providers", name);
    const bundleText = tsFiles(bundleRoot)
      .map((f) => readFileSync(f, "utf-8"))
      .join("\n");
    ok(
      !!firstStringPresent(bundleText, strings),
      `provider "${name}" carries its vendor coupling (≥1 of ${JSON.stringify(strings)} present under the bundle)`,
    );
    for (const s of strings) {
      ok(
        !coreAgentText.includes(s),
        `provider "${name}" left NO vendor residue in core: "${s}" absent from packages/core/agent`,
      );
    }
  }
}

{
  const fixtureRoot = mkdtempSync(join(tmpdir(), "oe-bundle-boundary-"));
  try {
    const bundleName = "fixture";
    const bundleRoot = join(fixtureRoot, "packages/providers", bundleName);
    const agentDir = join(bundleRoot, "agent");
    mkdirSync(agentDir, { recursive: true });

    const Q = '"';
    const importLine = (spec: string) => `import { x } from ${Q}${spec}${Q};\n`;

    const deepCore = join(agentDir, "bad-deep-core.ts");
    writeFileSync(deepCore, importLine("@open-everywhere/core/agent/memory/store.js"));
    const climbCore = join(agentDir, "bad-climb-core.ts");
    writeFileSync(climbCore, importLine("../../../../core/agent/thing.js"));
    const crossBundle = join(agentDir, "bad-cross-bundle.ts");
    writeFileSync(crossBundle, importLine("@open-everywhere/provider-other/agent/y.js"));
    const residue = join(agentDir, "vendor-residue.ts");
    writeFileSync(residue, `export const HOST = ${Q}api.notion.com${Q};\n`);

    const specsOf = (f: string) => specifiers(f);

    ok(
      specsOf(deepCore).some((s) => bundleCoreImportViolation(deepCore, s, bundleRoot)),
      "self-test: rule 4 flags a deep past-the-barrel core import",
    );
    ok(
      specsOf(climbCore).some((s) => bundleCoreImportViolation(climbCore, s, bundleRoot)),
      "self-test: rule 4 flags a relative climb out of the bundle",
    );
    ok(
      !bundleCoreImportViolation(deepCore, "@open-everywhere/core/agent/adapter-api.js", bundleRoot),
      "self-test: rule 4 permits the adapter-api barrel specifier",
    );

    ok(
      specsOf(crossBundle).some((s) => bundleForeignImportViolation(s, bundleName)),
      "self-test: rule 5 flags a sibling-bundle import",
    );
    ok(
      !bundleForeignImportViolation(`@open-everywhere/provider-${bundleName}/agent/z.js`, bundleName),
      "self-test: rule 5 permits an intra-bundle package specifier",
    );
    ok(
      !bundleForeignImportViolation("../agent/channels/x.js", bundleName),
      "self-test: rule 5 exempts relative specifiers (intra-bundle agent/channels layout)",
    );
    const scriptsFile = join(bundleRoot, "scripts", "some-test.ts");
    ok(
      !bundleCoreImportViolation(scriptsFile, "../agent/channels/x.js", bundleRoot),
      "self-test: rule 4 permits a relative import that stays inside the bundle",
    );
    ok(
      bundleCoreImportViolation(scriptsFile, "../../../../agent/channels/x.js", bundleRoot),
      "self-test: rule 4 still flags a relative agent-tree reach that climbs out of the bundle",
    );

    ok(
      firstStringPresent(readFileSync(residue, "utf-8"), PROVIDER_VENDOR_STRINGS.notion) === "api.notion.com",
      "self-test: rule 6 detects a present vendor fingerprint",
    );
    ok(
      firstStringPresent(`export const NOTHING = 1;\n`, PROVIDER_VENDOR_STRINGS.notion) === undefined,
      "self-test: rule 6 reports absence when no fingerprint is present",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

console.log(
  `✓ boundary: ${n} assertions passed (core portable; adapters via package name; app vendor-free; provider bundles barrel-only + vendor-owned)`,
);
