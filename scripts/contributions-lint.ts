import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseContributionManifest } from "@open-everywhere/core/agent/scaffold/roster-plan.js";
import { SLOT_DIR, type ContributionKind } from "@open-everywhere/core/agent/scaffold/roster-config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reds: string[] = [];

const SLUG: Record<ContributionKind, RegExp> = {
  tool: /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u,
  channel: /^(\.?[a-z][a-z0-9-]{0,63}|\[[a-zA-Z][a-zA-Z0-9_]{0,63}\])$/u,
  hook: /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u,
  schedule: /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u,
  skill: /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u,
  connection: /^[a-z][a-z0-9-]{0,63}$/u,
};

function manifestDirs(): string[] {
  const out: string[] = [];
  const roots = [join(root, "packages"), join(root, "packages", "providers")];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "providers") continue;
      const pkgDir = join(dir, entry.name);
      if (existsSync(join(pkgDir, "agent", "contributions.ts"))) out.push(pkgDir);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function checkErasable(label: string, source: string): void {
  const stripped = source
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  for (const [pattern, what] of [
    [/\benum\s+[A-Za-z_$]/u, "an `enum`"],
    [/\bnamespace\s+[A-Za-z_$]/u, "a `namespace`"],
    [/constructor\s*\([^)]*\b(private|public|protected|readonly)\s/u, "a parameter property"],
  ] as const) {
    if (pattern.test(stripped)) {
      reds.push(`${label} contains ${what}. Node's type stripping only ERASES — this file must be erasable syntax only.`);
    }
  }
}

let manifests = 0;
let contributions = 0;

for (const pkgDir of manifestDirs()) {
  const rel = pkgDir.slice(root.length + 1);
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name?: string };
  const manifestPath = join(pkgDir, "agent", "contributions.ts");
  const label = `${rel}/agent/contributions.ts`;
  checkErasable(label, readFileSync(manifestPath, "utf8"));

  const mod = (await import(pathToFileURL(manifestPath).href)) as { CONTRIBUTIONS?: unknown };
  const parsed = parseContributionManifest(mod.CONTRIBUTIONS, pkgJson.name ?? rel);
  if (parsed.manifest === undefined) {
    reds.push(...parsed.reds);
    continue;
  }
  manifests++;
  const manifest = parsed.manifest;
  if (manifest.package !== pkgJson.name) {
    reds.push(`${label} declares package "${manifest.package}" but package.json says "${pkgJson.name}".`);
  }

  for (const c of manifest.contributions) {
    contributions++;
    if (!SLUG[c.kind].test(c.name)) {
      reds.push(`${label}: ${c.kind} "${c.name}" is not a legal eve ${c.kind} slug — it would be discovered as invalid, not mounted.`);
    }
    const source = join(pkgDir, c.module.replace(/\.js$/u, ".ts"));
    if (!existsSync(source)) {
      reds.push(`${label}: ${c.kind} "${c.name}" names module "${c.module}", but ${source.slice(root.length + 1)} does not exist.`);
    }
  }

  if (rel.startsWith("packages/providers/")) {
    if (manifest.register === undefined) {
      reds.push(`${label}: a provider bundle must declare \`register\` ("<module>#<exportName>") — nothing would wire it at boot.`);
    } else {
      const [module, exportName] = manifest.register.split("#");
      const source = join(pkgDir, (module ?? "").replace(/\.js$/u, ".ts"));
      if (!existsSync(source)) reds.push(`${label}: register names module "${module}", which does not exist.`);
      else if (!new RegExp(`export\\s+(async\\s+)?(function|const|let)\\s+${exportName}\\b`, "u").test(readFileSync(source, "utf8"))) {
        reds.push(`${label}: register names "${exportName}", which ${module} does not export.`);
      }
    }
  }

  for (const kind of ["tool", "hook"] as const) {
    const slotDir = join(pkgDir, "agent", SLOT_DIR[kind]);
    if (!existsSync(slotDir)) continue;
    const predicate = (src: string): boolean =>
      kind === "tool" ? true : /\bdefineHook\s*\(/u.test(src) && /export default\b/u.test(src);
    const onDisk = readdirSync(slotDir)
      .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
      .filter((f) => predicate(readFileSync(join(slotDir, f), "utf8")))
      .map((f) => f.replace(/\.ts$/u, ""))
      .sort();
    const declared = manifest.contributions
      .filter((c) => c.kind === kind && c.module.startsWith(`agent/${SLOT_DIR[kind]}/`))
      .map((c) => c.name)
      .sort();
    for (const name of onDisk) {
      if (!declared.includes(name)) {
        reds.push(
          `${label}: ${rel}/agent/${SLOT_DIR[kind]}/${name}.ts exists but the manifest does not offer it — ` +
            `an unlisted contribution can never be mounted by any app.`,
        );
      }
    }
    for (const name of declared) {
      if (!onDisk.includes(name)) {
        reds.push(`${label}: offers ${kind} "${name}" but ${rel}/agent/${SLOT_DIR[kind]}/${name}.ts is not a ${kind}.`);
      }
    }
  }
}

const configPath = join(root, "roster.config.ts");
if (existsSync(configPath)) checkErasable("roster.config.ts", readFileSync(configPath, "utf8"));

if (manifests === 0) {
  reds.push("no packages/**/agent/contributions.ts found — refusing to report a roster clean against an empty catalogue.");
}

if (reds.length > 0) {
  console.error(`✗ contributions-lint: ${reds.length} problem(s):`);
  for (const r of reds) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(
  `✓ contributions-lint: ${manifests} manifest(s), ${contributions} contribution(s) — every module resolves, every ` +
    `name is slug-legal, tools+hooks are 1:1 with their directories. ` +
    `(channels/connections/schedules/skills are curated-only and UNGUARDED — see this file's header.)`,
);
