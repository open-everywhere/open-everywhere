import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVE_RUNTIME_VERSION } from "@open-everywhere/core/agent/channels/runtime-rotation.js";

const ROOT = process.cwd();
const BUNDLE_PATH = join(ROOT, ".output", "server", "index.mjs");

if (process.env.VERCEL) {
  console.log(
    "agent-version-seam-bundle: SKIP — Vercel builder shape writes no .output/ (OPE-1055); " +
      "this gate rides the eve-build output in CI and local builds.",
  );
  process.exit(0);
}

const problems: string[] = [];

if (!existsSync(BUNDLE_PATH)) {
  console.error(
    `✗ agent-version-seam-bundle: ${BUNDLE_PATH} does not exist. This script reads BUILD OUTPUT — ` +
      `run \`npm run build\` first (or just \`npm run build\`, which already chains this script).`,
  );
  process.exit(1);
}

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

for (const name of ["readAppVersion", "readEvePin"] as const) {
  const body = extractFunctionBody(bundle, name);
  if (body === undefined) {
    problems.push(
      `${name}: no \`function ${name}(\` found in ${BUNDLE_PATH}. Either the function was renamed/inlined ` +
        `away (update this script to match), or agent.ts no longer defines it — check registerAppInfo's call site.`,
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
  problems.push(
    `readEvePin: the compiled body does not contain the pinned eve version ${JSON.stringify(EVE_RUNTIME_VERSION)} ` +
      `— the value did not survive bundling. Body: ${evePinBody}`,
  );
}

const appPackageJsonPath = join(ROOT, "package.json");
const appVersion = (JSON.parse(readFileSync(appPackageJsonPath, "utf8")) as { version?: unknown }).version;
if (typeof appVersion !== "string" || appVersion.length === 0) {
  problems.push(`could not read a string "version" from ${appPackageJsonPath} — nothing to check the bundle against.`);
} else {
  const versionBindingPattern = new RegExp(`\\bversion\\d*\\s*=\\s*["']?${appVersion.replace(/\./gu, "\\.")}["']?[;,)]`, "u");
  if (!versionBindingPattern.test(bundle)) {
    problems.push(
      `the bundle contains no \`version = "${appVersion}"\`-shaped binding — the app's package.json version ` +
        `did not survive bundling as a static value. Expected the static JSON import (\`appPackageJson\` in ` +
        `agent.ts) to hoist it to a module-level binding.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`✗ agent-version-seam-bundle: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(
  "✓ agent-version-seam-bundle: readAppVersion/readEvePin compile with no runtime filesystem read, and both " +
    "baked literals (eve pin, app version) survive bundling.",
);
