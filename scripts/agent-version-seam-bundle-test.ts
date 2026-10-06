import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVE_RUNTIME_VERSION } from "@open-everywhere/core/agent/channels/runtime-rotation.js";
import { CORE_PACKAGE_VERSION } from "@open-everywhere/core/agent/ops/package-info.js";

const ROOT = process.cwd();
const BUNDLE_DIR = join(ROOT, ".output", "server");
const SEAM_MARKER = "function readAppVersion(";

function findSeamBundles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const path = join(dir, entry);
    if (!entry.endsWith(".mjs") && !entry.endsWith(".js")) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (text.includes(SEAM_MARKER)) found.push(path);
  }
  return found.sort();
}

if (process.env.VERCEL) {
  console.log(
    "agent-version-seam-bundle: SKIP — Vercel builder shape writes no .output/ (OPE-1055); " +
      "this gate rides the eve-build output in CI and local builds.",
  );
  process.exit(0);
}

const problems: string[] = [];

if (!existsSync(BUNDLE_DIR)) {
  console.error(
    `✗ agent-version-seam-bundle: ${BUNDLE_DIR} does not exist. This script reads BUILD OUTPUT — ` +
      `run \`npm run build\` first (or just \`npm run build\`, which already chains this script).`,
  );
  process.exit(1);
}

const seamBundles = findSeamBundles(BUNDLE_DIR);
if (seamBundles.length !== 1) {
  console.error(
    `✗ agent-version-seam-bundle: expected exactly ONE build-output module containing \`${SEAM_MARKER}\`, ` +
      `found ${seamBundles.length}${seamBundles.length === 0 ? "" : ` (${seamBundles.join(", ")})`} under ${BUNDLE_DIR}. ` +
      `Zero means \`readAppVersion\` was renamed, inlined or deleted — check registerAppInfo's call site in ` +
      `agent/agent.ts. More than one means the bundler emitted the seam twice, and checking one copy would ` +
      `leave the other unchecked. Read the output and re-derive this resolver; do not widen it.`,
  );
  process.exit(1);
}
const BUNDLE_PATH = seamBundles[0] as string;

const bundle = readFileSync(BUNDLE_PATH, "utf8");

function extractFunctionBody(source: string, name: string): string | undefined {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) return undefined;
  const braceStart = source.indexOf("{", start);
  if (braceStart === -1) return undefined;
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  return undefined;
}

const RUNTIME_FS_PRIMITIVES = ["readFileSync", "require.resolve", "fileURLToPath", "createRequire"];

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function bakedBindingName(body: string, read: RegExp): string | undefined {
  return read.exec(body)?.[1];
}

function declaresBinding(bundle: string, name: string, literal: string): boolean {
  return new RegExp(`(?:const|let|var)\\s+${escapeForRegExp(name)}\\s*=\\s*["']${escapeForRegExp(literal)}["']`, "u").test(bundle);
}

for (const name of ["readAppVersion", "readEvePin", "corePackageVersion"] as const) {
  const body = extractFunctionBody(bundle, name);
  if (body === undefined) {
    problems.push(
      `${name}: no \`function ${name}(\` found in ${BUNDLE_PATH}. Either the function was renamed/inlined ` +
        `away (update this script to match), or the module no longer defines it — check registerAppInfo's call ` +
        `site for the two app-side readers, and \`ops/package-info.ts\` for corePackageVersion.`,
    );
    continue;
  }
  for (const primitive of RUNTIME_FS_PRIMITIVES) {
    if (body.includes(primitive)) {
      problems.push(
        `${name}: the compiled body still calls \`${primitive}\` — this is a RUNTIME filesystem read, which ` +
          `throws in the hosted Vercel bundle (OPE-1041; no node_modules/eve, no app package.json at the function ` +
          `root). Body: ${body}`,
      );
    }
  }
}

const evePinBody = extractFunctionBody(bundle, "readEvePin");
if (evePinBody !== undefined && !evePinBody.includes(EVE_RUNTIME_VERSION)) {
  const readIdentifier = bakedBindingName(evePinBody, /\b([A-Za-z_$][\w$]*)\s*\.trim\(\)/u);
  if (readIdentifier === undefined) {
    problems.push(
      `readEvePin: the compiled body neither contains the pinned eve version ${JSON.stringify(EVE_RUNTIME_VERSION)} ` +
        `nor reads it off a module-scope binding this check can name. Body: ${evePinBody}`,
    );
  } else if (!declaresBinding(bundle, readIdentifier, EVE_RUNTIME_VERSION)) {
    problems.push(
      `readEvePin: the compiled body reads the pin off \`${readIdentifier}\`, but the bundle declares no ` +
        `\`${readIdentifier} = ${JSON.stringify(EVE_RUNTIME_VERSION)}\` — the value did not survive bundling. ` +
        `Body: ${evePinBody}`,
    );
  }
}

const coreVersionBody = extractFunctionBody(bundle, "corePackageVersion");
if (coreVersionBody !== undefined && !coreVersionBody.includes(CORE_PACKAGE_VERSION)) {
  const readIdentifier = bakedBindingName(coreVersionBody, /\breturn\s+([A-Za-z_$][\w$]*)\s*;/u);
  if (readIdentifier === undefined) {
    problems.push(
      `corePackageVersion: the compiled body neither contains core's version ${JSON.stringify(CORE_PACKAGE_VERSION)} ` +
        `nor reads it off a module-scope binding this check can name. Body: ${coreVersionBody}`,
    );
  } else if (!declaresBinding(bundle, readIdentifier, CORE_PACKAGE_VERSION)) {
    problems.push(
      `corePackageVersion: the compiled body reads the version off \`${readIdentifier}\`, but the bundle declares ` +
        `no \`${readIdentifier} = ${JSON.stringify(CORE_PACKAGE_VERSION)}\` — the value did not survive bundling. ` +
        `Body: ${coreVersionBody}`,
    );
  }
}

const appPackageJsonPath = join(ROOT, "package.json");
const appVersion = (JSON.parse(readFileSync(appPackageJsonPath, "utf8")) as { version?: unknown }).version;
if (typeof appVersion !== "string" || appVersion.length === 0) {
  problems.push(`could not read a string "version" from ${appPackageJsonPath} — nothing to check the bundle against.`);
} else {
  const appVersionBody = extractFunctionBody(bundle, "readAppVersion");
  if (appVersionBody === undefined) {
  } else if (!appVersionBody.includes(appVersion)) {
    const readIdentifier = bakedBindingName(
      appVersionBody,
      /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*([A-Za-z_$][\w$]*)\s*;/u,
    );
    if (readIdentifier === undefined) {
      problems.push(
        `readAppVersion: the compiled body neither contains the app version ${JSON.stringify(appVersion)} nor ` +
          `reads it off a module-scope binding this check can name. Body: ${appVersionBody}`,
      );
    } else if (!declaresBinding(bundle, readIdentifier, appVersion)) {
      problems.push(
        `readAppVersion: the compiled body reads the version off \`${readIdentifier}\`, but the bundle declares ` +
          `no \`${readIdentifier} = ${JSON.stringify(appVersion)}\` — the app's package.json version did not ` +
          `survive bundling as a static value. Expected the static JSON import (\`appPackageJson\` in agent.ts) ` +
          `to bake it in. Body: ${appVersionBody}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ agent-version-seam-bundle: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(
  "✓ agent-version-seam-bundle: readAppVersion/readEvePin/corePackageVersion compile with no runtime " +
    "filesystem read, and all three baked literals (eve pin, app version, core version) survive bundling.",
);
