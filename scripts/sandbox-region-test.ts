import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SANDBOX_REGION,
  KNOWN_SANDBOX_REGIONS,
  SANDBOX_REGION_GAP,
  SANDBOX_REGION_PASSTHROUGH_SUPPORTED,
  normalizeSandboxRegion,
  resolveSandboxRegionPlan,
  sandboxRegionProblem,
  vercelSandboxCreateOptions,
} from "@open-everywhere/core/agent/sandbox/vercel-create.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

ok(normalizeSandboxRegion("") === "", "empty stays empty");
ok(normalizeSandboxRegion("  CDG1 ") === "cdg1", "a region is trimmed and lowercased");

ok(sandboxRegionProblem("") === undefined, "empty is valid — it means 'pin nothing'");
ok(sandboxRegionProblem("   ") === undefined, "whitespace-only is valid, same as empty");
for (const region of KNOWN_SANDBOX_REGIONS) {
  ok(sandboxRegionProblem(region) === undefined, `${region} is a valid region id`);
}
ok(sandboxRegionProblem("lhr1") === undefined, "a region Vercel adds later validates on SHAPE, not on a hard-coded list");
ok(sandboxRegionProblem("cdg") !== undefined, "no digit → rejected");
ok(sandboxRegionProblem("cdg-1") !== undefined, "a dash → rejected");
ok(sandboxRegionProblem("paris") !== undefined, "a place name → rejected");
ok(sandboxRegionProblem("eu-west-3") !== undefined, "an AWS-shaped id → rejected");
ok(sandboxRegionProblem("cdg12") !== undefined, "two digits → rejected");
ok(sandboxRegionProblem(42 as unknown as string) !== undefined, "a non-string → rejected");

ok(resolveSandboxRegionPlan({ region: "", onVercel: true }).kind === "unset", "no region set → unset (nothing pinned)");
ok(resolveSandboxRegionPlan({ region: "  ", onVercel: false }).kind === "unset", "whitespace-only → unset");

const invalid = resolveSandboxRegionPlan({ region: "paris", onVercel: true });
ok(invalid.kind === "invalid", "a malformed region → invalid (the boot fails, it does not guess)");
ok(invalid.kind === "invalid" && invalid.error.includes("paris"), "the invalid error quotes the value the operator wrote");

const refused = resolveSandboxRegionPlan({ region: "cdg1", onVercel: true, passthroughSupported: false });
ok(refused.kind === "refused", "region set on Vercel + no eve passthrough → refused, never a silent default region");
ok(refused.kind === "refused" && refused.error.includes(SANDBOX_REGION_GAP), "the refusal states the eve gap that causes it");
ok(refused.kind === "refused" && refused.error.includes(DEFAULT_SANDBOX_REGION), "the refusal names the region it is refusing to run in");
ok(
  resolveSandboxRegionPlan({ region: "cdg1", onVercel: true }).kind ===
    (SANDBOX_REGION_PASSTHROUGH_SUPPORTED ? "pinned" : "refused"),
  "omitting passthroughSupported follows the shipped constant",
);

const inert = resolveSandboxRegionPlan({ region: "cdg1", onVercel: false, passthroughSupported: false });
ok(inert.kind === "inert", "region set off Vercel → inert (the operator's own host is the residency fact)");
ok(inert.kind === "inert" && inert.warn.includes("does nothing here"), "the inert warning is unambiguous");
ok(resolveSandboxRegionPlan({ region: "paris", onVercel: false }).kind === "invalid", "off Vercel, a malformed region is still invalid");

const pinned = resolveSandboxRegionPlan({ region: " CDG1 ", onVercel: true, passthroughSupported: true });
ok(pinned.kind === "pinned", "region + Vercel + passthrough → pinned");
ok(pinned.kind === "pinned" && pinned.region === "cdg1", "the pinned region is the normalized value");

const unpinnedOpts = vercelSandboxCreateOptions({
  timeoutMs: 1800000,
  snapshotExpirationMs: 604800000,
  regionPlan: { kind: "unset" },
});
ok(unpinnedOpts.timeout === 1800000, "the timeout is forwarded");
ok(unpinnedOpts.snapshotExpiration === 604800000, "the snapshot expiration is forwarded");
ok(unpinnedOpts.keepLastSnapshots.count === 1 && unpinnedOpts.keepLastSnapshots.deleteEvicted, "keepLastSnapshots is unchanged");
ok(!("region" in unpinnedOpts), "an unpinned build carries NO region key — byte-identical to the pre-OPE-1257 object");
ok(
  JSON.stringify(Object.keys(unpinnedOpts).sort()) === JSON.stringify(["keepLastSnapshots", "snapshotExpiration", "timeout"]),
  "an unpinned build's options object has exactly the three historical keys",
);

const pinnedOpts = vercelSandboxCreateOptions({
  timeoutMs: 1800000,
  snapshotExpirationMs: 604800000,
  regionPlan: { kind: "pinned", region: "cdg1", info: "" },
});
ok(pinnedOpts.region === "cdg1", "a pinned plan puts the region in the object eve receives");
ok(!("failoverRegions" in pinnedOpts), "failoverRegions is NEVER set — a silent cross-zone failover would void the pin");
for (const plan of [{ kind: "inert", warn: "" }, { kind: "refused", error: "" }, { kind: "invalid", error: "" }] as const) {
  const opts = vercelSandboxCreateOptions({ timeoutMs: 1, snapshotExpirationMs: 2, regionPlan: plan });
  ok(!("region" in opts), `a ${plan.kind} plan contributes no region`);
}

function createParamsBlock(dts: string): string {
  const start = dts.indexOf("interface BaseCreateSandboxParams");
  if (start === -1) return "";
  const end = dts.indexOf("\n}", start);
  return end === -1 ? dts.slice(start) : dts.slice(start, end);
}

function createBody(js: string): string {
  const start = js.indexOf("static async create(");
  if (start === -1) return "";
  const end = js.indexOf("static async fork(", start);
  return end === -1 ? js.slice(start, start + 2000) : js.slice(start, end);
}

export interface RegionPassthrough {
  readonly typed: boolean;
  readonly forwarded: boolean;
  readonly supported: boolean;
}

function detectRegionPassthrough(input: { readonly createParamsDts: string; readonly vendoredJs: string }): RegionPassthrough {
  const typed = /^\s*region\?:/m.test(createParamsBlock(input.createParamsDts));
  const forwarded = /\bregion:/.test(createBody(input.vendoredJs));
  return { typed, forwarded, supported: typed && forwarded };
}

const SYNTHETIC_WITH = {
  createParamsDts: "interface BaseCreateSandboxParams {\n  tags?: Record<string, string>;\n  region?: SandboxRegion;\n}\n",
  vendoredJs: "static async create(e){let i=await n.createSandbox({ports:e?.ports,region:e?.region});return i}static async fork(e){}",
};
const SYNTHETIC_WITHOUT = {
  createParamsDts: "interface BaseCreateSandboxParams {\n  tags?: Record<string, string>;\n}\n",
  vendoredJs: "static async create(e){let i=await n.createSandbox({ports:e?.ports});return i}static async fork(e){}",
};
ok(detectRegionPassthrough(SYNTHETIC_WITH).supported, "detector: sees a region that is both typed and forwarded");
ok(!detectRegionPassthrough(SYNTHETIC_WITHOUT).supported, "detector: sees no region when there is none");
ok(
  !detectRegionPassthrough({ createParamsDts: SYNTHETIC_WITH.createParamsDts, vendoredJs: SYNTHETIC_WITHOUT.vendoredJs }).supported,
  "detector: typed but NOT forwarded is NOT support — that is the silent-drop shape",
);
ok(
  !detectRegionPassthrough({ createParamsDts: SYNTHETIC_WITHOUT.createParamsDts, vendoredJs: SYNTHETIC_WITH.vendoredJs }).supported,
  "detector: forwarded but not typed is not support either",
);
ok(!detectRegionPassthrough({ createParamsDts: "", vendoredJs: "" }).supported, "detector: nothing to read is not support");
ok(
  !detectRegionPassthrough({
    createParamsDts: "interface BaseCreateSandboxParams {\n  tags?: Record<string, string>;\n}\ndeclare class Sandbox {\n  region?: string;\n}\n",
    vendoredJs: SYNTHETIC_WITH.vendoredJs,
  }).typed,
  "detector: a region OUTSIDE the create params does not count",
);

const EVE_DIST = join(REPO_ROOT, "node_modules", "eve", "dist", "src");
const VENDORED = join(EVE_DIST, "compiled", "@vercel", "sandbox");
const BINDING = join(EVE_DIST, "execution", "sandbox", "bindings", "vercel.js");

function recheck(what: string): never {
  console.error(
    `✗ sandbox-region: ${what}\n` +
      "  This guard keeps SANDBOX_REGION_PASSTHROUGH_SUPPORTED honest across eve bumps, so an eve that\n" +
      "  moved is a RE-CHECK, not a skip: find where the pinned eve creates sandboxes, read whether that\n" +
      "  module forwards a region, then update this file's anchors and the constant together.",
  );
  process.exit(1);
}

let createParamsDts: string;
let vendoredJs: string;
let bindingJs: string;
try {
  createParamsDts = readFileSync(join(VENDORED, "sandbox.d.ts"), "utf8");
  vendoredJs = readFileSync(join(VENDORED, "index.js"), "utf8");
  bindingJs = readFileSync(BINDING, "utf8");
} catch (err) {
  recheck(`cannot read eve's vendored SDK or its Vercel binding (${String(err)}).`);
}

if (createParamsBlock(createParamsDts) === "") recheck("eve's vendored SDK no longer declares `interface BaseCreateSandboxParams`.");
if (createBody(vendoredJs) === "") recheck("eve's vendored SDK no longer declares `static async create(`.");
if (!bindingJs.includes("#compiled/@vercel/sandbox/index.js")) {
  recheck("eve's Vercel binding no longer loads `#compiled/@vercel/sandbox/index.js` — sandbox creation moved to another vendored copy.");
}

const live: RegionPassthrough = detectRegionPassthrough({ createParamsDts, vendoredJs });

ok(
  live.supported === SANDBOX_REGION_PASSTHROUGH_SUPPORTED,
  `SANDBOX_REGION_PASSTHROUGH_SUPPORTED=${SANDBOX_REGION_PASSTHROUGH_SUPPORTED} matches eve ` +
    `(typed=${live.typed}, forwarded=${live.forwarded}). eve moved: flip the constant in ` +
    "packages/core/agent/sandbox/vercel-create.ts, drop the refusal wording from the setting summary, " +
    "and correct the residency coverage in docs/extending/models-and-gateway.md.",
);

console.log(
  `✓ sandbox-region: ${passed} assertions passed (validate, fail-closed plan, composed opts, ` +
    `eve passthrough=${live.supported})`,
);
