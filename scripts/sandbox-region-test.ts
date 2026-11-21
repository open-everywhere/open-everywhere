import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { citedDeclaration } from "../packages/core/scripts/_eve-pruned-declaration.js";
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

const shippedPlan = resolveSandboxRegionPlan({ region: " CDG1 ", onVercel: true });
ok(shippedPlan.kind === "pinned", "the SHIPPED default pins a set region on Vercel — the boot passes no passthroughSupported");
const shippedOpts = vercelSandboxCreateOptions({ timeoutMs: 1, snapshotExpirationMs: 2, regionPlan: shippedPlan });
ok(shippedOpts.region === "cdg1", "the operator's raw value reaches eve's create options, normalized, with no override anywhere in the path");
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

function forwardedParams(body: string): string {
  const anchor = /createSandbox\(\{/u.exec(body);
  if (anchor === null) return "";
  const open = anchor.index + anchor[0].length - 1;
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return body.slice(open + 1, i);
    }
  }
  return "";
}

export interface RegionPassthrough {
  readonly typed: boolean;
  readonly forwarded: boolean;
  readonly supported: boolean;
}

function detectRegionPassthrough(input: { readonly createParamsDts: string; readonly vendoredJs: string }): RegionPassthrough {
  const typed = /^\s*region\?:/m.test(createParamsBlock(input.createParamsDts));
  const forwarded = /(?<![\w$.])region:/u.test(forwardedParams(createBody(input.vendoredJs)));
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
const SYNTHETIC_REGION_OUTSIDE_ENUMERATION = {
  createParamsDts: SYNTHETIC_WITH.createParamsDts,
  vendoredJs:
    "static async create(e){let i=await n.createSandbox({ports:e?.ports,tags:e?.tags});return new S({sandbox:i.sandbox,region:i.json.region})}static async fork(e){}",
};
ok(
  !detectRegionPassthrough(SYNTHETIC_REGION_OUTSIDE_ENUMERATION).forwarded,
  "detector: a `region:` outside the forwarded-params enumeration is NOT a forward",
);
ok(
  !detectRegionPassthrough(SYNTHETIC_REGION_OUTSIDE_ENUMERATION).supported,
  "detector: typed + a region only outside the enumeration is NOT support — that is the silent drop",
);
ok(
  detectRegionPassthrough({ createParamsDts: SYNTHETIC_WITH.createParamsDts, vendoredJs: SYNTHETIC_WITH.vendoredJs }).forwarded,
  "detector: a `region:` INSIDE the enumeration is a forward",
);

const EVE_DIST = join(REPO_ROOT, "node_modules", "eve", "dist", "src");
const BINDING = join(EVE_DIST, "execution", "sandbox", "bindings", "vercel.js");

function createCopyOf(binding: string): string | undefined {
  return /loadSandboxModule\?\?\(async\(\)=>await import\(`#compiled\/@vercel\/([A-Za-z0-9._-]+)\/index\.js`\)\)/u.exec(binding)?.[1];
}

function recheck(what: string): never {
  console.error(
    `✗ sandbox-region: ${what}\n` +
      "  This guard keeps SANDBOX_REGION_PASSTHROUGH_SUPPORTED honest across eve bumps, so an eve that\n" +
      "  moved is a RE-CHECK, not a skip: find where the pinned eve creates sandboxes, read whether that\n" +
      "  module forwards a region, then update this file's anchors and the constant together.",
  );
  process.exit(1);
}

ok(
  createCopyOf("let t=e.loadSandboxModule??(async()=>await import(`#compiled/@vercel/sandbox-drives/index.js`)),n=e.loadDeleteSandboxModule??(async()=>await import(`#compiled/@vercel/sandbox/index.js`))") === "sandbox-drives",
  "create-loader reader: picks the copy `loadSandboxModule` defaults to, not the one beside it",
);
ok(
  createCopyOf("let n=e.loadDeleteSandboxModule??(async()=>await import(`#compiled/@vercel/sandbox/index.js`))") === undefined,
  "create-loader reader: the DELETE loader alone does not answer — the copy that mints is the only one that decides",
);

let bindingJs: string;
try {
  bindingJs = readFileSync(BINDING, "utf8");
} catch (err) {
  recheck(`cannot read eve's Vercel sandbox binding (${String(err)}).`);
}

const createCopy = createCopyOf(bindingJs);
if (createCopy === undefined) {
  recheck("eve's Vercel binding no longer defaults `loadSandboxModule` to a `#compiled/@vercel/<copy>/index.js` import — the create path moved, and this guard cannot tell which module to read.");
}
const VENDORED = join(EVE_DIST, "compiled", "@vercel", createCopy);

let createParamsDts: string | undefined;
let vendoredJs: string;
try {
  // eve 1.0.1 stopped shipping the vendored SDK's declarations. While `sandbox.d.ts` is absent,
  // citedDeclaration requires the vendored @vercel/sandbox version whose declaration typed `region?:`,
  // and throws when it moved. The forwarded half below still reads the shipped `index.js`.
  const declaration = citedDeclaration(EVE_DIST, join("compiled", "@vercel", createCopy, "sandbox.d.ts"));
  createParamsDts = declaration.shipped ? declaration.text : undefined;
  vendoredJs = readFileSync(join(VENDORED, "index.js"), "utf8");
} catch (err) {
  recheck(`cannot read eve's vendored SDK copy \`${createCopy}\`, the one its binding creates through (${String(err)}).`);
}

if (createParamsDts !== undefined && createParamsBlock(createParamsDts) === "")
  recheck(`eve's vendored \`${createCopy}\` no longer declares \`interface BaseCreateSandboxParams\`.`);
if (createBody(vendoredJs) === "") recheck(`eve's vendored \`${createCopy}\` no longer declares \`static async create(\`.`);
if (forwardedParams(createBody(vendoredJs)) === "")
  recheck(`eve's vendored \`${createCopy}\` create no longer posts a \`createSandbox({ … })\` enumeration — this guard cannot see which fields it forwards.`);

// An absent declaration is the typed half carried by the version pin above: the declaration it
// was last read on (eve 1.0.0) typed `region?:` in BaseCreateSandboxParams. The pin sees the vendored
// version, not the declaration's text, so re-read it at the eve source tag on every bump.
const live: RegionPassthrough = detectRegionPassthrough({
  createParamsDts: createParamsDts ?? "interface BaseCreateSandboxParams {\n  region?: SandboxRegion;\n}\n",
  vendoredJs,
});

ok(
  live.supported === SANDBOX_REGION_PASSTHROUGH_SUPPORTED,
  `SANDBOX_REGION_PASSTHROUGH_SUPPORTED=${SANDBOX_REGION_PASSTHROUGH_SUPPORTED} matches eve ` +
    `(typed=${live.typed}, forwarded=${live.forwarded}). eve moved: set the constant in ` +
    "packages/core/agent/sandbox/vercel-create.ts to what eve now does, then make the setting summary, " +
    "docs/extending/sandbox.md and docs/extending/models-and-gateway.md say the same thing. Setting it " +
    "to `false` re-arms the refusal, so a set `sandbox.region` starts refusing the boot — write that " +
    "down rather than leaving a residency claim eve cannot honour.",
);

console.log(
  `✓ sandbox-region: ${passed} assertions passed (validate, fail-closed plan, composed opts, ` +
    `eve create copy=${createCopy}, passthrough=${live.supported})`,
);

// proves: AP-MOD-core-sandbox-vercel-create

// proves: SET-043, SET-044, SET-046
