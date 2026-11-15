import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PATCH_DIR = "patches";
const reds: string[] = [];

type Patch = { file: string; packageName: string; version: string; body: string };

function parsePatchFilename(name: string): { packageName: string; version: string } | undefined {
  const base = name.replace(/\.patch$/, "");
  const parts = base.split("+");
  if (parts.length < 2) return undefined;
  const version = parts[parts.length - 1];
  const nameParts = parts.slice(0, -1);
  const packageName = nameParts[0].startsWith("@") ? `${nameParts[0]}/${nameParts.slice(1).join("/")}` : nameParts.join("/");
  return { packageName, version };
}

const patches: Patch[] = [];
for (const file of readdirSync(PATCH_DIR).filter((f) => f.endsWith(".patch"))) {
  const parsed = parsePatchFilename(file);
  if (!parsed) {
    reds.push(`UNPARSEABLE PATCH NAME: ${join(PATCH_DIR, file)} does not look like patch-package's <pkg>+<version>.patch.`);
    continue;
  }
  patches.push({ file, ...parsed, body: readFileSync(join(PATCH_DIR, file), "utf8") });
}
if (patches.length === 0) reds.push(`NO PATCHES: ${PATCH_DIR}/ holds no .patch files — this gate is checking the wrong tree.`);

let hookChecks = 0;
for (const patch of patches) {
  const added = patch.body
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  const hooks = new Set([...added.matchAll(/__oe[A-Za-z0-9_]+/g)].map((m) => m[0]));
  if (hooks.size === 0) continue;

  const targets = [...patch.body.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1].trim());
  if (targets.length === 0) {
    reds.push(`UNREADABLE PATCH: ${patch.file} declares no target files (no "+++ b/…" header).`);
    continue;
  }
  const installed = targets
    .map((target) => {
      try {
        return readFileSync(target, "utf8");
      } catch {
        reds.push(
          `MISSING TARGET: ${patch.file} patches ${target}, which is not installed. Run \`npm install\` ` +
            `(postinstall applies the tree's patches); if the path moved in a dependency bump, re-roll the patch.`,
        );
        return "";
      }
    })
    .join("\n");

  for (const hook of [...hooks].sort()) {
    hookChecks++;
    if (installed.includes(hook)) continue;
    reds.push(
      `PATCH NOT APPLIED: ${patch.file} adds "${hook}" but the installed bytes do not contain it. ` +
        `patch-package's postinstall did not take (its failure is a WARNING, not an error — CI scrolls past it), ` +
        `so the deployed behaviour silently differs from the reviewed source. Fix: rm -rf node_modules/${patch.packageName} && npm install.`,
    );
  }
}

const TOOL_LOOP = "node_modules/eve/dist/src/harness/tool-loop.js";
try {
  if (readFileSync(TOOL_LOOP, "utf8").includes("__oeForceContinue")) {
    reds.push(
      `RETIRED HOOK PRESENT: "__oeForceContinue" is back in ${TOOL_LOOP}. It was retired in OPE-172; its return ` +
        `means the patch was regenerated against a stale node_modules and has clobbered the committed one. ` +
        `Restore patches/ from git and re-run \`rm -rf node_modules/eve && npm install\`.`,
    );
  }
} catch {
  reds.push(`MISSING: ${TOOL_LOOP} is not installed — run \`npm install\`.`);
}

const WEB_FETCH_REQUEST = "node_modules/eve/dist/src/execution/web-fetch/request.js";
try {
  if (readFileSync(WEB_FETCH_REQUEST, "utf8").includes("__oeWebFetchHop")) {
    reds.push(
      `RETIRED HOOK PRESENT: "__oeWebFetchHop" is back in ${WEB_FETCH_REQUEST}. Patch part 7 was dropped at OPE-2688, ` +
        `and its helper refuses every redirect when no guard is installed. ` +
        `Restore patches/ from git and re-run \`rm -rf node_modules/eve && npm install\`.`,
    );
  }
} catch {
  reds.push(`MISSING: ${WEB_FETCH_REQUEST} is not installed — run \`npm install\`.`);
}

function packageJsonPaths(): string[] {
  const out = ["package.json"];
  for (const group of ["packages", join("packages", "providers")]) {
    let entries: string[];
    try {
      entries = readdirSync(group);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(group, entry, "package.json");
      try {
        readFileSync(candidate, "utf8");
        out.push(candidate);
      } catch {
      }
    }
  }
  return out;
}

const patchedVersions = new Map(patches.map((p) => [p.packageName, p.version]));
const pins = new Map<string, Map<string, string[]>>();
for (const path of packageJsonPaths()) {
  const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, string> | undefined>;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (!patchedVersions.has(name)) continue;
      if (!pins.has(name)) pins.set(name, new Map());
      const byVersion = pins.get(name);
      if (!byVersion) continue;
      if (!byVersion.has(range)) byVersion.set(range, []);
      byVersion.get(range)?.push(path);
    }
  }
}

let pinChecks = 0;
for (const [name, byVersion] of pins) {
  const expected = patchedVersions.get(name);
  pinChecks += [...byVersion.values()].reduce((n, files) => n + files.length, 0);
  if (byVersion.size > 1) {
    const detail = [...byVersion].map(([version, files]) => `${version} (${files.join(", ")})`).join("; ");
    reds.push(
      `SPLIT PIN: "${name}" is pinned at more than one version — ${detail}. patch-package keys its patch on the ` +
        `version, so the odd one out resolves an UNPATCHED copy, and which import gets which copy is a hoisting ` +
        `detail no test asserts. Bump every package.json together.`,
    );
    continue;
  }
  const [actual] = [...byVersion.keys()];
  if (actual !== expected) {
    reds.push(
      `PIN/PATCH MISMATCH: "${name}" is pinned at "${actual}" but the committed patch is for "${expected}" ` +
        `(patches/${name.replace("/", "+").replace("@", "@")}+${expected}.patch). patch-package will not apply it — ` +
        `re-roll the patch for the new version (see the \`eve-upgrade-check\` skill) or revert the bump.`,
    );
  }
}

const RUNTIME_ROTATION_MODULE = join("packages", "core", "agent", "channels", "runtime-rotation.ts");
let runtimeVersionChecked = false;
{
  const expected = patchedVersions.get("eve");
  if (expected === undefined) {
    reds.push(`NO EVE PATCH: patches/ holds no patch for "eve", so RULE 3 cannot learn the expected version.`);
  } else {
    let source: string;
    try {
      source = readFileSync(RUNTIME_ROTATION_MODULE, "utf8");
    } catch {
      reds.push(`MISSING MODULE: ${RUNTIME_ROTATION_MODULE} does not exist — it carries EVE_RUNTIME_VERSION, which this rule pins.`);
      source = "";
    }
    if (source !== "") {
      const match = /export const EVE_RUNTIME_VERSION\s*=\s*"([^"]*)"/u.exec(source);
      if (!match) {
        reds.push(
          `UNREADABLE CONSTANT: ${RUNTIME_ROTATION_MODULE} does not export a literal \`EVE_RUNTIME_VERSION = "…"\`. ` +
            `It must stay a plain string literal — this gate reads the SOURCE, and a computed value would make the ` +
            `pre-dispatch rotation unverifiable.`,
        );
      } else if (match[1] !== expected) {
        reds.push(
          `RUNTIME VERSION STALE: ${RUNTIME_ROTATION_MODULE} declares EVE_RUNTIME_VERSION "${match[1]}" but this tree ` +
            `pins eve at "${expected}". The pre-dispatch rotation (OPE-599) keys on that constant, so a stale value ` +
            `means the eve bump strands every standing session and NOTHING rotates — silently, with no audit row. ` +
            `Set it to "${expected}" in the same commit as the pin bump.`,
        );
      } else {
        runtimeVersionChecked = true;
      }
    }
  }
}

if (reds.length > 0) {
  console.error(`✗ eve-patch: ${reds.length} problem(s):\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

console.log(
  `✓ eve-patch: ${patches.length} committed patch(es); ${hookChecks} hook(s) present in the installed bytes; ` +
    `${pinChecks} pin(s) agree with the patched version; retired __oeForceContinue absent; ` +
    `EVE_RUNTIME_VERSION ${runtimeVersionChecked ? "agrees with the pin" : "UNCHECKED"}`,
);
