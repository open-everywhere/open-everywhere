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

const CORE_OPS_BARREL = /^@open-everywhere\/core\/agent\/adapter-api-ops\.(js|ts)$/;

const EVENT_PLANE_DEEP = /routines\/event-(model|authz)(\.[jt]s)?$/;

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
  return specifiersOfSource(readFileSync(file, "utf-8"));
}

function runtimeSpecifiers(file: string): string[] {
  const src = stripComments(readFileSync(file, "utf-8")).replace(
    /^\s*(?:import|export)\s+type\s+(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)\s+from\s+["'][^"']+["']/gm,
    "",
  );
  return specifiersOfSource(src);
}

function stripComments(source: string): string {
  let src = source;
  src = src.replace(/\/\*[\s\S]*?\*\//g, "");
  src = src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  return src;
}

function specifiersOfSource(source: string): string[] {
  const src = stripComments(source);
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
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
  teams: ["graph.microsoft.com", "smba.trafficmanager.net"],
  email: ["api.agentmail.to", "AGENTMAIL_API_KEY"],
  "google-chat": ["chat.googleapis.com", "GOOGLE_CHAT_SERVICE_ACCOUNT_KEY"],
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
  if (CORE_PKG.test(spec)) return !CORE_ADAPTER_BARREL.test(spec) && !CORE_OPS_BARREL.test(spec);
  return climbsOutsideBundle(fileAbs, spec, bundleRoot);
}

function bundleForeignImportViolation(spec: string, bundleName: string): boolean {
  const m = PROVIDER_PKG.exec(spec);
  if (m && m[1] !== bundleName) return true;
  if (ADAPTERS_PKG.test(spec)) return true;
  if (!spec.startsWith(".") && /(^|\/)agent\/(tools|channels|hooks)\//.test(spec)) return true;
  return false;
}

function opsArmMainBarrelChain(opsFile: string, bundleRoot: string, bundleName: string): string[] | undefined {
  const ownPkg = `@open-everywhere/provider-${bundleName}/`;
  const parent = new Map<string, string | undefined>([[opsFile, undefined]]);
  const queue = [opsFile];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const spec of runtimeSpecifiers(file)) {
      if (CORE_ADAPTER_BARREL.test(spec)) {
        const chain: string[] = [];
        for (let f: string | undefined = file; f !== undefined; f = parent.get(f)) chain.unshift(relative(bundleRoot, f).replaceAll("\\", "/"));
        return chain;
      }
      let target: string;
      if (spec.startsWith(ownPkg)) target = join(bundleRoot, spec.slice(ownPkg.length).replace(/\.js$/, ".ts"));
      else if (spec.startsWith(".") && !climbsOutsideBundle(file, spec, bundleRoot)) target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      else continue;
      if (!target.endsWith(".ts") || !existsSync(target) || parent.has(target)) continue;
      parent.set(target, file);
      queue.push(target);
    }
  }
  return undefined;
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
      const climbsIntoCore = /\.\.\/.*\/(memory|operational|access|routines)\//.test(spec) && !CORE_PKG.test(spec);
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
  const barrel = readFileSync(join(REPO_ROOT, "packages/core/agent/adapter-api.ts"), "utf-8");
  for (const sym of ["registerEventNormalizer", "registerEventScopeGrant"]) {
    ok(
      new RegExp(`^\\s*${sym},?\\s*$`, "m").test(barrel) || barrel.includes(`{ ${sym}`),
      `adapter-api re-exports ${sym} — a provider bundle can register its own event plane`,
    );
  }

  const outsideCore = [
    ...tsFiles(join(REPO_ROOT, "packages/adapters/agent")),
    ...tsFiles(join(REPO_ROOT, "packages/adapters/scripts")),
    join(REPO_ROOT, "agent/lib/register-adapters.ts"),
    ...discoverBundles().flatMap((name) => bundleSourceFiles(join(REPO_ROOT, "packages/providers", name))),
  ];
  ok(outsideCore.length > 10, `scanned the non-core surface for event-plane deep imports (${outsideCore.length} files)`);
  for (const f of outsideCore) {
    for (const spec of specifiers(f)) {
      ok(
        !EVENT_PLANE_DEEP.test(spec),
        `the event plane is reached ONLY via the adapter-api barrel: ${rel(f)} imports "${spec}"`,
      );
    }
  }
}

{
  const light = (await import("@open-everywhere/core/agent/adapter-api-ops.js")) as Record<string, unknown>;
  const main = (await import("@open-everywhere/core/agent/adapter-api.js")) as Record<string, unknown>;
  const names = Object.keys(light);
  ok(names.length >= 4, `the light ops door exports its registrars (${names.length})`);
  for (const name of names) {
    ok(name in main, `adapter-api also exports "${name}" — the light ops door opens nothing new`);
    ok(main[name] === light[name], `"${name}" is the same binding through both doors (one registry, not two)`);
  }
}

{
  const bundles = discoverBundles();
  let arms = 0;
  for (const name of bundles) {
    const bundleRoot = join(REPO_ROOT, "packages/providers", name);
    const opsFile = join(bundleRoot, "agent", "ops.ts");
    if (!existsSync(opsFile)) continue;
    arms++;
    const chain = opsArmMainBarrelChain(opsFile, bundleRoot, name);
    ok(
      chain === undefined,
      `provider "${name}"'s ops arm never loads the main adapter-api barrel` +
        (chain ? ` — ${chain.join(" → ")} imports it; use adapter-api-ops.js, or move the pure part out` : ""),
    );
  }
  ok(bundles.length === 0 || arms > 0, `rule 4d found the bundles' ops arms (${arms})`);
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
  const manualDir = join(REPO_ROOT, "packages/core/agent/docs/generated");
  const isManualPage = (f: string): boolean => dirname(f) === manualDir && !f.endsWith("index.ts");
  const coreAgentFiles = tsFiles(join(REPO_ROOT, "packages/core/agent"));
  if (bundles.length > 0) {
    const manualText = coreAgentFiles.filter(isManualPage).map((f) => readFileSync(f, "utf-8")).join("\n");
    ok(
      bundles.some((name) => (PROVIDER_VENDOR_STRINGS[name] ?? []).some((s) => manualText.includes(s))),
      "precondition: a universal manual page names a provider fingerprint (without it the exclusion below is dead and must go)",
    );
  }
  const coreAgentText =
    bundles.length > 0
      ? coreAgentFiles
          .filter((f) => !isManualPage(f))
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

    const eventPlaneBundle = join(agentDir, "register-events.ts");
    writeFileSync(
      eventPlaneBundle,
      importLine("@open-everywhere/core/agent/adapter-api.js") +
        `registerEventNormalizer({} as never);\nregisterEventScopeGrant({} as never);\n`,
    );
    ok(
      specsOf(eventPlaneBundle).every((s) => !bundleCoreImportViolation(eventPlaneBundle, s, bundleRoot)),
      "self-test: a bundle registering an event normalizer + scope grant THROUGH the barrel passes rule 4",
    );
    ok(
      specsOf(eventPlaneBundle).every((s) => !bundleForeignImportViolation(s, bundleName)),
      "self-test: …and rule 5 does not flag it either",
    );
    ok(
      specsOf(eventPlaneBundle).every((s) => !EVENT_PLANE_DEEP.test(s)),
      "self-test: …and the barrel specifier is not mistaken for an event-plane deep import",
    );

    const deepEventPlane = join(agentDir, "bad-deep-event-plane.ts");
    writeFileSync(deepEventPlane, importLine("@open-everywhere/core/agent/routines/event-model.js"));
    ok(
      specsOf(deepEventPlane).some((s) => bundleCoreImportViolation(deepEventPlane, s, bundleRoot)),
      "self-test: rule 4 flags a DEEP import of routines/event-model past the barrel",
    );
    ok(
      specsOf(deepEventPlane).some((s) => EVENT_PLANE_DEEP.test(s)),
      "self-test: section 4b's event-plane matcher catches the same specifier by name",
    );
    ok(
      EVENT_PLANE_DEEP.test("../../../core/agent/routines/event-authz.js"),
      "self-test: the event-plane matcher is path-shaped, so a RELATIVE climb to event-authz is caught too",
    );

    const opsDir = join(agentDir, "channels");
    mkdirSync(opsDir, { recursive: true });
    const opsArm = join(agentDir, "ops.ts");
    const heavy = join(opsDir, "heavy.ts");
    writeFileSync(opsArm, importLine("@open-everywhere/core/agent/adapter-api-ops.js") + importLine("./channels/heavy.js"));
    writeFileSync(heavy, importLine("@open-everywhere/core/agent/adapter-api.js"));
    ok(
      opsArmMainBarrelChain(opsArm, bundleRoot, bundleName)?.join(" → ") === "agent/ops.ts → agent/channels/heavy.ts",
      "self-test: rule 4d flags an ops arm that reaches the main barrel through a relative import",
    );
    writeFileSync(heavy, `import type { x } from ${Q}@open-everywhere/core/agent/adapter-api.js${Q};\n`);
    ok(
      opsArmMainBarrelChain(opsArm, bundleRoot, bundleName) === undefined,
      "self-test: rule 4d passes a TYPE-ONLY import of the main barrel (TypeScript erases it)",
    );
    writeFileSync(
      heavy,
      `// we import type names only from the light door\n` + importLine("@open-everywhere/core/agent/adapter-api.js"),
    );
    ok(
      opsArmMainBarrelChain(opsArm, bundleRoot, bundleName)?.join(" → ") === "agent/ops.ts → agent/channels/heavy.ts",
      "self-test: rule 4d is not masked by comment prose that reads like a type-only import",
    );
    writeFileSync(
      heavy,
      `const n = 1; // we import type names only from the light door\n` + importLine("@open-everywhere/core/agent/adapter-api.js"),
    );
    ok(
      opsArmMainBarrelChain(opsArm, bundleRoot, bundleName)?.join(" → ") === "agent/ops.ts → agent/channels/heavy.ts",
      "self-test: rule 4d is not masked by the same prose in a TRAILING comment",
    );
    writeFileSync(heavy, `export type Opts = {\n  a: string,\n}\n` + importLine("@open-everywhere/core/agent/adapter-api.js"));
    ok(
      opsArmMainBarrelChain(opsArm, bundleRoot, bundleName)?.join(" → ") === "agent/ops.ts → agent/channels/heavy.ts",
      "self-test: rule 4d is not masked by a type alias with no semicolon",
    );
    writeFileSync(heavy, `import type {\n  x,\n  y,\n} from ${Q}@open-everywhere/core/agent/adapter-api.js${Q};\n`);
    ok(
      opsArmMainBarrelChain(opsArm, bundleRoot, bundleName) === undefined,
      "self-test: rule 4d passes a MULTI-LINE type-only import of the main barrel",
    );
    writeFileSync(heavy, importLine("@open-everywhere/core/agent/adapter-api.js"));
    writeFileSync(opsArm, `import ${Q}./channels/heavy.js${Q};\n`);
    ok(
      opsArmMainBarrelChain(opsArm, bundleRoot, bundleName)?.join(" → ") === "agent/ops.ts → agent/channels/heavy.ts",
      "self-test: rule 4d follows a side-effect import",
    );
    writeFileSync(opsArm, importLine(`@open-everywhere/provider-${bundleName}/agent/channels/heavy.js`));
    ok(
      opsArmMainBarrelChain(opsArm, bundleRoot, bundleName)?.join(" → ") === "agent/ops.ts → agent/channels/heavy.ts",
      "self-test: rule 4d follows an import through the bundle's own package name",
    );
    writeFileSync(opsArm, importLine("@open-everywhere/core/agent/adapter-api.js"));
    ok(
      opsArmMainBarrelChain(opsArm, bundleRoot, bundleName)?.join(" → ") === "agent/ops.ts",
      "self-test: rule 4d flags an ops arm that imports the main barrel directly",
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
